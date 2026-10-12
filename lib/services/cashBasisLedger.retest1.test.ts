/**
 * Independent QA, re-test round 1 of the cash-basis fixes (largest-remainder split, dated vendor
 * credits, bounced checks). Every scenario re-checks the structural invariants: cash BS / TB
 * balanced, cash BS earnings == cash P&L to date, adjustments net to zero.
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
import { payBills } from './billPayments';
import { applyToBill, createVendorCredit, unapplyFromBill } from './vendorCredits';
import { profitAndLoss } from './reports';
import { profitAndLossCashBasis } from './cashBasisReports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { cashBasisLedger, splitCumulative } from './cashBasisLedger';
import { trialBalanceReport } from './reportsStandard';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-cash-basis-retest1');
let db: DB;
let userId: string;
let n = 0;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const ALL = { from: d('2000-01-01'), to: d('2030-12-31') };

async function newCompany() {
  const company = await createCompany(db, { name: `Cash Retest Co ${++n}`, ownerId: userId });
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
/** Per-account snapshot of a cash P&L (income + expenses), for "did this period change?" checks. */
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

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'cash-retest1@test.local', name: 'Retest', passwordHash: 'x' }).returning();
  userId = u.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('largest-remainder split', () => {
  it('a positive payment never reverses income on any line (per-line increments keep the line sign)', () => {
    // Found by a randomized search: three income lines, cumulative settlements 17.14 then 17.15.
    // The $0.01 payment moves +0.01 onto one income line and -0.02 onto another, i.e. the
    // payment DEBITS an income account. Net is right, but a P&L Detail / by-account report for
    // that period shows negative income on an account from a customer payment.
    const nets = ['-36.74', '-12.46', '-20.28'].map((x) => Money.of(x));
    const base = Money.of('69.48');
    let prev = nets.map(() => Money.zero());
    for (const cum of ['0.05', '17.14', '17.15', '29.43', '67.33', '69.48']) {
      const cur = splitCumulative(nets, Money.div(cum, base));
      cur.forEach((x, i) => {
        const inc = x.minus(prev[i]);
        expect(inc.greaterThan(0), `line ${i} income reversed by a positive payment at cum ${cum}: ${inc.toFixed(2)}`).toBe(false);
      });
      prev = cur;
    }
  });

  it('bill side: three $10 expense lines paid $10 at a time recognize exactly $10.00 each month', async () => {
    const co = await newCompany();
    const bill = await createBill(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-01-10'),
      lines: [
        { accountId: co.code['6000'], amount: '10.00' },
        { accountId: co.code['6100'], amount: '10.00' },
        { accountId: co.code['6300'], amount: '10.00' },
      ],
    });
    await payBill(co, bill.id, '2026-02-10', '10.00');
    await payBill(co, bill.id, '2026-03-10', '10.00');
    await payBill(co, bill.id, '2026-04-10', '10.00');
    expect(await cashNet(co, '2026-01-01', '2026-01-31')).toBe('0.00');
    expect(await cashNet(co, '2026-02-01', '2026-02-28')).toBe('-10.00');
    expect(await cashNet(co, '2026-03-01', '2026-03-31')).toBe('-10.00');
    expect(await cashNet(co, '2026-04-01', '2026-04-30')).toBe('-10.00');
    expect((await profitAndLossCashBasis(co.ctx, ALL)).netIncome).toBe((await profitAndLoss(co.ctx, ALL)).netIncome);
    for (const m of ['2026-02-28', '2026-03-31', '2026-04-30']) await invariants(co, m);
  });

  it('many $0.01..$7 payments on an awkward invoice: every month recognizes exactly the cash, cycle ties to accrual', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-02'),
      lines: [line(co, '4000', '7.77'), line(co, '4100', '3.33'), line(co, '4900', '1.01')],
    });
    const payments: [string, string][] = [
      ['2026-01-15', '0.01'],
      ['2026-02-15', '0.01'],
      ['2026-03-15', '3.00'],
      ['2026-04-15', '0.02'],
      ['2026-05-15', '7.00'],
      ['2026-06-15', '2.07'],
    ];
    for (const [dt, a] of payments) {
      await pay(co, inv.id, dt, a);
      const m = dt.slice(0, 7);
      const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
      expect(await cashNet(co, `${m}-01`, last), `cash recognized in ${m}`).toBe(a);
    }
    const cash = await profitAndLossCashBasis(co.ctx, ALL);
    expect(cash.netIncome).toBe('12.11');
    await invariants(co, '2026-06-30');
  });
});

describe('vendor credits applied to bills', () => {
  it('a January credit applied to a January bill later does not change January (per account)', async () => {
    // QB: a bill credit is recognized on a cash basis when it is APPLIED (the Pay Bills date).
    // max(credit date, bill date) still back-dates the application into January here.
    const co = await newCompany();
    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '100.00' }] });
    const vc = await createVendorCredit(co.ctx, { vendorId: co.vendor, date: d('2026-01-20'), lines: [{ accountId: co.code['6300'], amount: '40.00' }] });
    const before = await snapshot(co, '2026-01-01', '2026-01-31');
    expect(before).toEqual({ net: '0.00' });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    // No cash moved in January and the application happened later: January must read the same.
    expect(await snapshot(co, '2026-01-01', '2026-01-31')).toEqual(before);
    await invariants(co, '2026-01-31');
  });

  it('one credit split across two bills, partly unapplied, then cash pays the rest: ties to accrual, books balance', async () => {
    const co = await newCompany();
    const b1 = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '100.00' }] });
    const b2 = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-12'), lines: [{ accountId: co.code['6100'], amount: '33.33' }] });
    const vc = await createVendorCredit(co.ctx, { vendorId: co.vendor, date: d('2026-02-01'), lines: [{ accountId: co.code['6000'], amount: '50.00' }] });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: b1.id, amount: '30.00' });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: b2.id, amount: '20.00' });
    await unapplyFromBill(co.ctx, { vendorCreditId: vc.id, billId: b1.id, amount: '10.00' });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: b2.id, amount: '10.00' });
    expect(await cashNet(co, '2026-01-01', '2026-01-31')).toBe('0.00');
    // Credits are not cash: what is recognized through credits nets to zero.
    expect(await cashNet(co, '2026-01-01', '2026-02-28')).toBe('0.00');
    await payBill(co, b1.id, '2026-03-05', '80.00');
    await payBill(co, b2.id, '2026-03-06', '3.33');
    expect(await cashNet(co, '2026-03-01', '2026-03-31')).toBe('-83.33');
    expect((await profitAndLossCashBasis(co.ctx, ALL)).netIncome).toBe((await profitAndLoss(co.ctx, ALL)).netIncome);
    for (const m of ['2026-01-31', '2026-02-28', '2026-03-31']) await invariants(co, m);
  });

  it('a failed apply (over the balance) leaves no trace in the cash basis', async () => {
    const co = await newCompany();
    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '10.00' }] });
    const vc = await createVendorCredit(co.ctx, { vendorId: co.vendor, date: d('2026-02-01'), lines: [{ accountId: co.code['6000'], amount: '40.00' }] });
    await expect(applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' })).rejects.toThrow();
    const { adjustments } = await cashBasisLedger(co.ctx);
    expect(adjustments.filter((a) => a.kind === 'recognize')).toHaveLength(0);
    await invariants(co, '2026-02-28');
  });
});

describe('bounced checks', () => {
  it('pay Feb, bounce Mar, re-pay Apr: Feb unchanged, Mar reversed, Apr recognized, cycle ties to accrual', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-05'),
      lines: [line(co, '4000', '70.00'), line(co, '4100', '30.00')],
    });
    const p = await pay(co, inv.id, '2026-02-10', '60.00');
    const feb = await snapshot(co, '2026-02-01', '2026-02-28');
    expect(feb.net).toBe('60.00');
    await recordBouncedCheck(co.ctx, { paymentId: p.payment.id, date: d('2026-03-15') });
    expect(await snapshot(co, '2026-02-01', '2026-02-28')).toEqual(feb);
    expect(await cashNet(co, '2026-03-01', '2026-03-31')).toBe('-60.00');
    await pay(co, inv.id, '2026-04-02', '100.00');
    expect(await cashNet(co, '2026-04-01', '2026-04-30')).toBe('100.00');
    const all = await profitAndLossCashBasis(co.ctx, ALL);
    expect(all.netIncome).toBe('100.00');
    expect(all.netIncome).toBe((await profitAndLoss(co.ctx, ALL)).netIncome);
    for (const m of ['2026-02-28', '2026-03-31', '2026-04-30']) await invariants(co, m);
  });

  it('one bounced check that paid two invoices reverses both, on the bounce date only', async () => {
    const co = await newCompany();
    const a = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-01-05'), lines: [line(co, '4000', '50.00')] });
    const b = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-01-06'), lines: [line(co, '4100', '25.00')] });
    const p = await receivePayment(co.ctx, {
      customerId: co.customer,
      date: d('2026-02-10'),
      amount: '75.00',
      method: 'check',
      depositAccountId: co.code['1000'],
      applications: [
        { invoiceId: a.id, amountApplied: '50.00' },
        { invoiceId: b.id, amountApplied: '25.00' },
      ],
    });
    await recordBouncedCheck(co.ctx, { paymentId: p.payment.id, date: d('2026-02-20') });
    expect(await cashNet(co, '2026-02-01', '2026-02-19')).toBe('75.00');
    expect(await cashNet(co, '2026-02-20', '2026-02-28')).toBe('-75.00');
    expect(await cashNet(co, '2026-01-01', '2026-12-31')).toBe('0.00');
    for (const m of ['2026-02-19', '2026-02-28']) await invariants(co, m);
  });
});
