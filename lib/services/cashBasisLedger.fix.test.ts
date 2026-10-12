/**
 * Cash-basis ledger, fix round 1:
 *  - each settlement recognizes exactly its share (largest remainder; no 9.99 for 10.00);
 *  - a vendor credit applied to a bill counts on max(credit date, bill date), never earlier;
 *  - a bounced check reverses recognition on the bounce date, the payment date keeps its share;
 *  - 'not yet paid' lines carry the document's own entry for QuickZoom.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { receivePayment, recordBouncedCheck } from './payments';
import { createBill } from './bills';
import { applyToBill, createVendorCredit, unapplyFromBill } from './vendorCredits';
import { profitAndLossCashBasis } from './cashBasisReports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { cashBasisLedger, splitCumulative } from './cashBasisLedger';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-cash-basis-fix1');
let db: DB;
let userId: string;
let n = 0;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);

async function newCompany() {
  const company = await createCompany(db, { name: `Cash Fix Co ${++n}`, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const code: Record<string, string> = {};
  for (const r of rows) code[r.code] = r.id;
  const customer = (await createCustomer(ctx, { displayName: 'Acme' })).id;
  const vendor = (await createVendor(ctx, { displayName: 'Supplier' })).id;
  return { ctx, code, customer, vendor };
}
type Co = Awaited<ReturnType<typeof newCompany>>;
const cashNet = async (co: Co, from: string, to: string) =>
  (await profitAndLossCashBasis(co.ctx, { from: d(from), to: eod(to) })).netIncome;

async function invariants(co: Co, asOf: string) {
  const bs = await balanceSheetCashBasis(co.ctx, eod(asOf));
  expect(bs.balanced, `cash BS balanced @${asOf}`).toBe(true);
  const pl = await profitAndLossCashBasis(co.ctx, { from: d('2000-01-01'), to: eod(asOf) });
  expect(bs.retainedEarnings, `cash BS earnings == cash P&L @${asOf}`).toBe(pl.netIncome);
  const { adjustments } = await cashBasisLedger(co.ctx, { to: eod(asOf) });
  expect(adjustments.reduce((s, a) => s.plus(a.net), Money.zero()).toFixed(2)).toBe('0.00');
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'cash-fix1@test.local', name: 'Fix', passwordHash: 'x' }).returning();
  userId = u.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('splitCumulative (largest remainder)', () => {
  const m = (xs: string[]) => xs.map((x) => Money.of(x));
  const sum = (xs: ReturnType<typeof m>) => xs.reduce((a, x) => a.plus(x), Money.zero());

  it('three equal lines at one third sum exactly to the rounded share', () => {
    const r = splitCumulative(m(['-10.00', '-10.00', '-10.00']), Money.div(10, 30));
    expect(sum(r).toFixed(2)).toBe('-10.00');
    for (const x of r) expect(x.minus('-3.3333').abs().lessThan('0.01')).toBe(true);
  });

  it('mixed signs (income and COGS) stay exact, and fraction 1 returns every line', () => {
    const nets = m(['-100.01', '-50.03', '40.07']);
    for (const f of ['0.1', '0.333333', '0.5', '0.77']) {
      const r = splitCumulative(nets, Money.of(f));
      expect(sum(r).toFixed(2)).toBe(Money.round2(Money.mul('-109.97', f)).toFixed(2));
      r.forEach((x, i) => expect(x.minus(Money.mul(nets[i], f)).abs().lessThan('0.01')).toBe(true));
    }
    expect(splitCumulative(nets, Money.of(1)).map((x) => x.toFixed(2))).toEqual(['-100.01', '-50.03', '40.07']);
  });

  it('never drifts across many small payments', () => {
    const nets = m(['-7.01', '-7.01', '-7.01', '-0.02']);
    let prev = Money.zero();
    for (let paid = 1; paid <= 21; paid++) {
      const s = sum(splitCumulative(nets, Money.div(paid, '21.05')));
      // Each $1 settlement recognizes exactly $1.00 of income.
      expect(s.minus(prev).toFixed(2)).toBe('-1.00');
      prev = s;
    }
  });
});

describe('settlement dates', () => {
  it('a vendor credit dated BEFORE the bill counts on the bill date, never before', async () => {
    const co = await newCompany();
    const vc = await createVendorCredit(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-01-05'),
      lines: [{ accountId: co.code['6000'], amount: '40.00' }],
    });
    const bill = await createBill(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-02-10'),
      lines: [{ accountId: co.code['6000'], amount: '100.00' }],
    });
    expect(await cashNet(co, '2026-01-01', '2026-02-28')).toBe('0.00');
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    // January is untouched; the bill's 40 share and the credit's -40 settle together on Feb 10.
    expect(await cashNet(co, '2026-01-01', '2026-01-31')).toBe('0.00');
    const { adjustments } = await cashBasisLedger(co.ctx);
    const rec = adjustments.filter((a) => a.kind === 'recognize');
    expect(rec.length).toBeGreaterThan(0);
    for (const a of rec) expect(a.date.toISOString().slice(0, 10)).toBe('2026-02-10');
    expect(await cashNet(co, '2026-02-01', '2026-02-28')).toBe('0.00');
    for (const day of ['2026-01-31', '2026-02-28']) await invariants(co, day);
  });

  it('unapplying a vendor credit removes its recognition', async () => {
    const co = await newCompany();
    const bill = await createBill(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-01-10'),
      lines: [{ accountId: co.code['6000'], amount: '100.00' }],
    });
    const vc = await createVendorCredit(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-03-01'),
      lines: [{ accountId: co.code['6000'], amount: '40.00' }],
    });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    expect(await cashNet(co, '2026-01-01', '2026-02-28')).toBe('0.00');
    expect(await cashNet(co, '2026-03-01', '2026-03-31')).toBe('0.00');
    await unapplyFromBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    const { adjustments } = await cashBasisLedger(co.ctx);
    expect(adjustments.filter((a) => a.kind === 'recognize')).toHaveLength(0);
    await invariants(co, '2026-03-31');
  });

  it('a bounced check keeps its recognition on the payment date and reverses it on the bounce date', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-05'),
      lines: [{ accountId: co.code['4000'], quantity: 1, rate: '100.00', taxable: false }],
    });
    const pay = await receivePayment(co.ctx, {
      customerId: co.customer,
      date: d('2026-02-10'),
      amount: '60.00',
      method: 'check',
      depositAccountId: co.code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '60.00' }],
    });
    expect(await cashNet(co, '2026-02-01', '2026-02-28')).toBe('60.00');
    await recordBouncedCheck(co.ctx, { paymentId: pay.payment.id, date: d('2026-03-15') });
    // February (possibly closed) is unchanged; March carries the reversal.
    expect(await cashNet(co, '2026-02-01', '2026-02-28')).toBe('60.00');
    expect(await cashNet(co, '2026-03-01', '2026-03-31')).toBe('-60.00');
    expect(await cashNet(co, '2026-01-01', '2026-12-31')).toBe('0.00');
    for (const day of ['2026-02-28', '2026-03-31']) await invariants(co, day);
  });
});

describe('QuickZoom', () => {
  it("'not yet paid' lines point at the document's own entry", async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-05'),
      lines: [{ accountId: co.code['4000'], quantity: 1, rate: '100.00', taxable: false }],
    });
    const { adjustments } = await cashBasisLedger(co.ctx);
    const defer = adjustments.filter((a) => a.kind === 'defer');
    expect(defer.length).toBeGreaterThan(0);
    for (const a of defer) expect(a.doc.entryId).toBe(inv.postedEntryId);
  });
});
