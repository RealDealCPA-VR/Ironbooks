/**
 * Independent QA, re-test round 2 of the cash-basis fixes (house-monotone divisor split, vendor
 * credits recognized on the application day). Every scenario re-checks the structural
 * invariants: cash BS / TB balanced, cash BS earnings == cash P&L to date, adjustments net to zero.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createAccount } from './accounts';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { applyToBill, createVendorCredit, unapplyFromBill } from './vendorCredits';
import { profitAndLossCashBasis } from './cashBasisReports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { cashBasisLedger, splitCumulative } from './cashBasisLedger';
import { trialBalanceReport } from './reportsStandard';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-cash-basis-retest2');
let db: DB;
let userId: string;
let n = 0;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const ALL = { from: d('2000-01-01'), to: d('2030-12-31') };

async function newCompany() {
  const company = await createCompany(db, { name: `Cash Retest2 Co ${++n}`, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const code: Record<string, string> = {};
  for (const r of rows) code[r.code] = r.id;
  const customer = (await createCustomer(ctx, { displayName: 'Acme' })).id;
  const vendor = (await createVendor(ctx, { displayName: 'Supplier' })).id;
  return { ctx, code, customer, vendor };
}
type Co = Awaited<ReturnType<typeof newCompany>>;

const line = (co: Co, c: string, amount: string) => ({ accountId: co.code[c], quantity: 1, rate: amount, taxable: false });
const cashPL = (co: Co, from: string, to: string) => profitAndLossCashBasis(co.ctx, { from: d(from), to: eod(to) });
const cashNet = async (co: Co, from: string, to: string) => (await cashPL(co, from, to)).netIncome;
async function snapshot(co: Co, from: string, to: string) {
  const pl = await cashPL(co, from, to);
  const out: Record<string, string> = { net: pl.netIncome };
  for (const l of [...pl.income, ...pl.expenses]) if (!Money.of(l.amount).isZero()) out[l.accountId] = l.amount;
  return out;
}

async function pay(co: Co, invoiceId: string, date: string, amount: string) {
  return receivePayment(co.ctx, {
    customerId: co.customer,
    date: d(date),
    amount,
    method: 'check',
    depositAccountId: co.code['1000'],
    applications: [{ invoiceId, amountApplied: amount }],
  });
}
async function payBill(co: Co, billId: string, date: string, amount: string) {
  return payBills(co.ctx, {
    vendorId: co.vendor,
    date: d(date),
    method: 'check',
    paymentAccountId: co.code['1000'],
    applications: [{ billId, amountApplied: amount }],
  });
}

async function invariants(co: Co, asOf: string) {
  const at = eod(asOf);
  const bs = await balanceSheetCashBasis(co.ctx, at);
  expect(bs.balanced, `cash BS balanced @${asOf}`).toBe(true);
  const pl = await profitAndLossCashBasis(co.ctx, { from: ALL.from, to: at });
  expect(bs.retainedEarnings, `cash BS earnings == cash P&L @${asOf}`).toBe(pl.netIncome);
  const tb = await trialBalanceReport(co.ctx, { asOf, basis: 'cash' });
  expect(tb.balanced, `cash TB balanced @${asOf}`).toBe(true);
  const { adjustments } = await cashBasisLedger(co.ctx, { to: at });
  expect(adjustments.reduce((s, a) => s.plus(a.net), Money.zero()).toFixed(2)).toBe('0.00');
}

const today = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
};

/** Move a credit's application audit rows to noon UTC of `day`, i.e. "it was applied that day". */
async function backdate(creditId: string, day: string, action: 'applied_to_bill' | 'unapplied_from_bill') {
  await db
    .update(auditLogs)
    .set({ createdAt: new Date(`${day}T12:00:00.000Z`) })
    .where(and(eq(auditLogs.entityId, creditId), sql`${auditLogs.newValues}->>'action' = ${action}`));
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'cash-retest2@test.local', name: 'Retest2', passwordHash: 'x' }).returning();
  userId = u.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('splitCumulative: pro-rata to the penny (re-test 2)', () => {
  it('house-monotone over many lines with mixed signs (income + COGS), up and down', () => {
    let s = 99;
    const r = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    for (let t = 0; t < 300; t++) {
      const k = 2 + Math.floor(r() * 14);
      const nets = Array.from({ length: k }, (_, i) => {
        const c = 1 + Math.floor(r() * (r() < 0.5 ? 200 : 2_000_000));
        return Money.of((i === 0 || r() < 0.7 ? -c : c) / 100);
      });
      const net = nets.reduce((a, x) => a.plus(x), Money.zero());
      if (net.isZero()) continue;
      const base = net.abs();
      const bc = Math.round(base.toNumber() * 100);
      let prev = nets.map(() => Money.zero());
      let prevCum = 0;
      for (let step = 0; step < 12; step++) {
        const cum = step === 11 ? bc : Math.floor(r() * bc);
        const cur = splitCumulative(nets, Money.div(cum / 100, base), prev);
        cur.forEach((x, i) => {
          const inc = x.minus(prev[i]);
          if (inc.isZero()) return;
          const dir = cum >= prevCum ? nets[i].s : -nets[i].s;
          expect(inc.s, `trial ${t} line ${i} cum ${prevCum}->${cum}: ${inc.toFixed(2)}`).toBe(dir);
        });
        prev = cur;
        prevCum = cum;
      }
      prev.forEach((x, i) => expect(x.toFixed(2)).toBe(nets[i].toFixed(2)));
    }
  });

  it('no line is a cent or more away from its exact pro-rata share (quota)', () => {
    // $10,000 consulting + ten (forty) $0.50 fee lines on different accounts, one third paid.
    // The exact share of the big line is 3,333.33(3); the Webster split recognizes 3,333.30
    // (further off with forty lines) and pushes the extra cents onto the $0.50 lines (0.17 each
    // instead of 0.1667). Divisor methods violate quota; a quota-respecting house-monotone
    // method (e.g. Balinski-Young quota method) exists.
    for (const k of [10, 40]) {
      const nets = [Money.of('-10000.00'), ...Array.from({ length: k }, () => Money.of('-0.50'))];
      const frac = Money.div('1', '3');
      const cur = splitCumulative(nets, frac);
      cur.forEach((x, i) => {
        const exact = Money.mul(nets[i], frac);
        expect(
          x.minus(exact).abs().lessThan('0.01'),
          `k=${k} line ${i}: ${x.toFixed(2)} vs exact ${exact.toFixed(4)}`,
        ).toBe(true);
      });
    }
  });

  it('integration: a one-third payment recognizes the main income account at its pro-rata share', async () => {
    const co = await newCompany();
    const small: string[] = [];
    for (let i = 0; i < 10; i++) {
      const a = await createAccount(co.ctx, { code: `47${String(i).padStart(2, '0')}`, name: `Fee ${i}`, type: 'revenue', subtype: 'other_income' });
      small.push(a.id);
    }
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-05'),
      lines: [line(co, '4000', '10000.00'), ...small.map((id) => ({ accountId: id, quantity: 1, rate: '0.50', taxable: false }))],
    });
    await pay(co, inv.id, '2026-02-10', '3335.00'); // exactly one third of 10,005.00
    const pl = await cashPL(co, '2026-02-01', '2026-02-28');
    expect(pl.netIncome).toBe('3335.00');
    const main = pl.income.find((l) => l.accountId === co.code['4000']);
    expect(main?.amount, 'Sales Income for a one-third payment of $10,000').toBe('3333.33');
    await invariants(co, '2026-02-28');
  });
});

describe('vendor credits recognized on the application day (re-test 2)', () => {
  it('applied in March, partly unapplied in April: Jan/Feb untouched, March recognizes, April reverses (per account)', async () => {
    const co = await newCompany();
    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '100.00' }] });
    const vc = await createVendorCredit(co.ctx, { vendorId: co.vendor, date: d('2026-01-20'), lines: [{ accountId: co.code['6300'], amount: '40.00' }] });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    await backdate(vc.id, '2026-03-05', 'applied_to_bill');
    await unapplyFromBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '15.00' });
    await backdate(vc.id, '2026-04-07', 'unapplied_from_bill');
    expect(await snapshot(co, '2026-01-01', '2026-02-28')).toEqual({ net: '0.00' });
    expect(await snapshot(co, '2026-03-01', '2026-03-31')).toEqual({ net: '0.00', [co.code['6000']]: '40.00', [co.code['6300']]: '-40.00' });
    expect(await snapshot(co, '2026-04-01', '2026-04-30')).toEqual({ net: '0.00', [co.code['6000']]: '-15.00', [co.code['6300']]: '15.00' });
    await payBill(co, bill.id, '2026-05-02', '75.00');
    expect(await cashNet(co, '2026-05-01', '2026-05-31')).toBe('-75.00');
    for (const m of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) await invariants(co, m);
  });

  it('apply and unapply on the same day leave no recognition at all', async () => {
    const co = await newCompany();
    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '100.00' }] });
    const vc = await createVendorCredit(co.ctx, { vendorId: co.vendor, date: d('2026-01-20'), lines: [{ accountId: co.code['6300'], amount: '40.00' }] });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    await unapplyFromBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    const { adjustments } = await cashBasisLedger(co.ctx);
    expect(adjustments.filter((a) => a.kind === 'recognize')).toHaveLength(0);
    await invariants(co, today());
  });

  it('a credit applied today to a bill dated after today counts on the bill date, never before', async () => {
    const co = await newCompany();
    const t = today();
    const future = `${Number(t.slice(0, 4)) + 1}-03-15`;
    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d(future), lines: [{ accountId: co.code['6000'], amount: '100.00' }] });
    const vc = await createVendorCredit(co.ctx, { vendorId: co.vendor, date: d('2026-01-20'), lines: [{ accountId: co.code['6300'], amount: '40.00' }] });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '25.00' });
    const rec = (await cashBasisLedger(co.ctx)).adjustments.filter((a) => a.kind === 'recognize');
    expect(rec.length).toBeGreaterThan(0);
    for (const a of rec) expect(a.date.toISOString().slice(0, 10)).toBe(future);
    expect(await snapshot(co, '2026-01-01', t)).toEqual({ net: '0.00' });
    await invariants(co, future);
  });

  it("another company's credit applications never touch this company's cash basis", async () => {
    const a = await newCompany();
    const b = await newCompany();
    await createBill(a.ctx, { vendorId: a.vendor, date: d('2026-01-10'), lines: [{ accountId: a.code['6000'], amount: '100.00' }] });
    const billB = await createBill(b.ctx, { vendorId: b.vendor, date: d('2026-01-10'), lines: [{ accountId: b.code['6000'], amount: '100.00' }] });
    const vcB = await createVendorCredit(b.ctx, { vendorId: b.vendor, date: d('2026-01-20'), lines: [{ accountId: b.code['6300'], amount: '40.00' }] });
    await applyToBill(b.ctx, { vendorCreditId: vcB.id, billId: billB.id, amount: '40.00' });
    expect((await cashBasisLedger(a.ctx)).adjustments.filter((x) => x.kind === 'recognize')).toHaveLength(0);
    expect((await cashBasisLedger(b.ctx)).adjustments.filter((x) => x.kind === 'recognize').length).toBeGreaterThan(0);
    await invariants(a, today());
    await invariants(b, today());
  });
});
