/**
 * Independent adversarial QA for the cash-basis rebuild (PARITY.md P0: cash-basis P&L).
 *
 * The principle under test: on a cash basis, income / expense is recognized only when cash (or a
 * settling credit / discount) moves, on the date it moves. Every scenario also re-checks the
 * structural invariants: cash TB and cash BS balance at each as-of date, and cash-basis earnings
 * on the BS equal the cash P&L to date; the summary, detail, by-class and by-month reports agree.
 *
 * Each scenario runs in its own company inside one throwaway PGlite dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, classes, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice, updateInvoice } from './invoices';
import { receivePayment } from './payments';
import { createBill, voidBill } from './bills';
import { payBills } from './billPayments';
import { createCreditMemo } from './creditMemos';
import { applyToBill, createVendorCredit } from './vendorCredits';
import { profitAndLoss } from './reports';
import { profitAndLossCashBasis } from './cashBasisReports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { cashBasisLedger } from './cashBasisLedger';
import {
  balanceSheetReport,
  profitAndLossByClassReport,
  profitAndLossDetail,
  profitAndLossReport,
  trialBalanceReport,
} from './reportsStandard';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-cash-basis-adversarial');
let db: DB;
let userId: string;
let n = 0;

interface Co {
  ctx: ServiceContext;
  code: Record<string, string>;
  customer: string;
  vendor: string;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const ALL = { from: d('2000-01-01'), to: d('2030-12-31') };

async function newCompany(): Promise<Co> {
  const company = await createCompany(db, { name: `Cash Adv Co ${++n}`, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const code: Record<string, string> = {};
  for (const r of rows) code[r.code] = r.id;
  const customer = (await createCustomer(ctx, { displayName: 'Acme' })).id;
  const vendor = (await createVendor(ctx, { displayName: 'Supplier' })).id;
  return { ctx, code, customer, vendor };
}

const line = (co: Co, c: string, amount: string) => ({ accountId: co.code[c], quantity: 1, rate: amount, taxable: false });
const amt = (lines: { accountId: string; amount: string }[], id: string) =>
  lines.find((l) => l.accountId === id)?.amount ?? '0.00';
const netRow = (r: StdReport, col = 'total') => r.rows.find((x) => x.id === 'pl:net')!.cells[col];

async function cashNet(co: Co, from: Date, to: Date) {
  return (await profitAndLossCashBasis(co.ctx, { from, to })).netIncome;
}

async function pay(co: Co, invoiceId: string, date: string, amount: string, extra: Record<string, unknown> = {}) {
  return receivePayment(co.ctx, {
    customerId: co.customer,
    date: d(date),
    amount,
    method: 'check',
    depositAccountId: co.code['1000'],
    applications: [{ invoiceId, amountApplied: amount }],
    ...extra,
  });
}

/** Structural invariants on a cash basis as of `asOf` (end of that day). */
async function assertCashInvariants(co: Co, asOf: string) {
  const at = eod(asOf);
  const bs = await balanceSheetCashBasis(co.ctx, at);
  expect(bs.balanced, `cash BS balanced @${asOf}`).toBe(true);
  expect(Money.add(bs.totals.totalLiabilities, bs.totals.totalEquity).toFixed(2)).toBe(bs.totals.totalAssets);
  const pl = await profitAndLossCashBasis(co.ctx, { from: ALL.from, to: at });
  expect(bs.retainedEarnings, `cash BS earnings == cash P&L to date @${asOf}`).toBe(pl.netIncome);
  const tb = await trialBalanceReport(co.ctx, { asOf, basis: 'cash' });
  expect(tb.balanced, `cash TB balanced @${asOf}`).toBe(true);
  const total = tb.rows.find((r) => r.id === 'tb:total')!.cells;
  expect(total.debit).toBe(total.credit);
  const std = await balanceSheetReport(co.ctx, { asOf, basis: 'cash' });
  expect(std.balanced, `std cash BS balanced @${asOf}`).toBe(true);
  // Every adjustment is a balanced pair: they must net to exactly zero.
  const { adjustments } = await cashBasisLedger(co.ctx, { to: at });
  const s = adjustments.filter((a) => a.date <= at).reduce((x, a) => x.plus(a.net), Money.zero());
  expect(s.toFixed(2)).toBe('0.00');
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'cash-adv@test.local', name: 'Adv', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('auditor repro: $100 + $8 tax unpaid invoice, fixed-asset bill', () => {
  it('cash income is 0 (never negative) and lines add up; fixed-asset bill never reduces cash expenses', async () => {
    const co = await newCompany();
    const { createTaxRate } = await import('./salesTax');
    const rate = await createTaxRate(co.ctx, { name: 'Tax 8%', rate: '0.08' });
    await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-03-01'),
      taxRateId: rate.id,
      lines: [{ accountId: co.code['4000'], quantity: 1, rate: '100.00', taxable: true }],
    });
    await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-03-02'), lines: [{ accountId: co.code['1500'], amount: '5000.00' }] });
    // A cash expense the lump-sum method would have netted against A/P growth.
    await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-03-03'), lines: [{ accountId: co.code['6000'], amount: '70.00' }] });
    const pl = await profitAndLossCashBasis(co.ctx, ALL);
    expect(pl.totalIncome).toBe('0.00');
    expect(pl.totalExpenses).toBe('0.00');
    expect(pl.netIncome).toBe('0.00');
    await assertCashInvariants(co, '2026-03-31');
  });
});

describe('rounding to the penny', () => {
  it('each partial payment on a no-tax invoice recognizes exactly the cash received (no penny drift)', async () => {
    const co = await newCompany();
    // Three equal lines: 1/3 of each line is 3.333… — naive per-line rounding books 9.99 for $10.00 received.
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-10'),
      lines: [line(co, '4000', '10.00'), line(co, '4100', '10.00'), line(co, '4900', '10.00')],
    });
    await pay(co, inv.id, '2026-02-10', '10.00');
    await pay(co, inv.id, '2026-03-10', '10.00');
    await pay(co, inv.id, '2026-04-10', '10.00');
    expect(await cashNet(co, d('2026-01-01'), eod('2026-01-31'))).toBe('0.00');
    expect(await cashNet(co, d('2026-02-01'), eod('2026-02-28'))).toBe('10.00');
    expect(await cashNet(co, d('2026-03-01'), eod('2026-03-31'))).toBe('10.00');
    expect(await cashNet(co, d('2026-04-01'), eod('2026-04-30'))).toBe('10.00');
    const all = await profitAndLossCashBasis(co.ctx, ALL);
    expect(amt(all.income, co.code['4000'])).toBe('10.00');
    expect(amt(all.income, co.code['4100'])).toBe('10.00');
    expect(amt(all.income, co.code['4900'])).toBe('10.00');
    for (const m of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']) await assertCashInvariants(co, m);
  });

  it('awkward odd-cent lines and payments: full cycle lands exactly on accrual, every month balances', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-03'),
      lines: [line(co, '4000', '0.01'), line(co, '4100', '0.02'), line(co, '4900', '99.98')],
    });
    expect(inv.total).toBe('100.01');
    for (const [dt, a] of [
      ['2026-01-20', '0.01'],
      ['2026-02-20', '33.33'],
      ['2026-03-20', '0.07'],
      ['2026-04-20', '66.60'],
    ] as const) {
      await pay(co, inv.id, dt, a);
      await assertCashInvariants(co, dt);
    }
    const cash = await profitAndLossCashBasis(co.ctx, ALL);
    const acc = await profitAndLoss(co.ctx, ALL);
    expect(cash.netIncome).toBe(acc.netIncome);
    for (const l of acc.income) expect(amt(cash.income, l.accountId)).toBe(l.amount);
    // By-month columns add to the total and to the flat report.
    const byMonth = await profitAndLossReport(co.ctx, { from: '2026-01-01', to: '2026-04-30', basis: 'cash', columns: 'month' });
    const net = byMonth.rows.find((r) => r.id === 'pl:net')!.cells;
    const months = Object.entries(net).filter(([k]) => k !== 'label' && k !== 'total').map(([, v]) => String(v));
    expect(Money.add(...months).toFixed(2)).toBe(String(net.total));
    expect(net.total).toBe('100.01');
  });
});

describe('vendor credits and discounts settle on the date cash moves', () => {
  it('a vendor credit applied in March does not create January cash expense for a bill dated January', async () => {
    const co = await newCompany();
    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '100.00' }] });
    const janBefore = await cashNet(co, d('2026-01-01'), eod('2026-01-31'));
    expect(janBefore).toBe('0.00');
    const vc = await createVendorCredit(co.ctx, { vendorId: co.vendor, date: d('2026-03-01'), lines: [{ accountId: co.code['6000'], amount: '40.00' }] });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    await payBills(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-03-05'),
      method: 'check',
      paymentAccountId: co.code['1000'],
      applications: [{ billId: bill.id, amountApplied: '60.00' }],
    });
    // No cash left the business in January — January's cash P&L must not change after the fact.
    expect(await cashNet(co, d('2026-01-01'), eod('2026-01-31'))).toBe(janBefore);
    // Total cash expense = 60 (cash paid), all in Q1.
    expect(await cashNet(co, d('2026-01-01'), eod('2026-03-31'))).toBe('-60.00');
    for (const m of ['2026-01-31', '2026-02-28', '2026-03-31']) await assertCashInvariants(co, m);
  });

  it('bill paid with an early-payment discount: nothing recognized before the payment date', async () => {
    const co = await newCompany();
    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '100.00' }] });
    await payBills(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-03-05'),
      method: 'check',
      paymentAccountId: co.code['1000'],
      discountAccountId: co.code['4900'],
      applications: [{ billId: bill.id, amountApplied: '98.00', discountTaken: '2.00' }],
    });
    expect(await cashNet(co, d('2026-01-01'), eod('2026-02-28'))).toBe('0.00');
    const mar = await profitAndLossCashBasis(co.ctx, { from: d('2026-03-01'), to: eod('2026-03-31') });
    expect(amt(mar.expenses, co.code['6000'])).toBe('100.00');
    expect(mar.netIncome).toBe('-98.00');
    await assertCashInvariants(co, '2026-03-31');
  });

  it('credit memo applied together with a later payment: both recognized on the payment date, net = cash', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-01-05'), lines: [line(co, '4000', '100.00')] });
    const cm = await createCreditMemo(co.ctx, { customerId: co.customer, date: d('2026-01-15'), lines: [line(co, '4000', '30.00')] });
    await receivePayment(co.ctx, {
      customerId: co.customer,
      date: d('2026-03-10'),
      amount: '70.00',
      method: 'check',
      depositAccountId: co.code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '70.00' }],
      credits: [{ creditMemoId: cm.id, invoiceId: inv.id, amount: '30.00' }],
    });
    expect(await cashNet(co, d('2026-01-01'), eod('2026-02-28'))).toBe('0.00');
    expect(await cashNet(co, d('2026-03-01'), eod('2026-03-31'))).toBe('70.00');
    for (const m of ['2026-01-31', '2026-03-31']) await assertCashInvariants(co, m);
  });
});

describe('edits and voids', () => {
  it('editing a partly paid invoice re-allocates; paying the rest ties to accrual', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-01-05'), lines: [line(co, '4000', '100.00')] });
    await pay(co, inv.id, '2026-02-05', '50.00');
    expect(await cashNet(co, d('2026-02-01'), eod('2026-02-28'))).toBe('50.00');
    await updateInvoice(co.ctx, inv.id, {
      customerId: co.customer,
      date: d('2026-01-05'),
      lines: [line(co, '4000', '150.00'), line(co, '4100', '50.00')],
    });
    // 50 of 200 paid in Feb: 37.50 sales + 12.50 service.
    const feb = await profitAndLossCashBasis(co.ctx, { from: d('2026-02-01'), to: eod('2026-02-28') });
    expect(feb.netIncome).toBe('50.00');
    expect(amt(feb.income, co.code['4000'])).toBe('37.50');
    expect(amt(feb.income, co.code['4100'])).toBe('12.50');
    await assertCashInvariants(co, '2026-02-28');
    await pay(co, inv.id, '2026-03-05', '150.00');
    const cash = await profitAndLossCashBasis(co.ctx, ALL);
    expect(cash.netIncome).toBe((await profitAndLoss(co.ctx, ALL)).netIncome);
    expect(cash.netIncome).toBe('200.00');
    await assertCashInvariants(co, '2026-03-31');
  });

  it('a voided unpaid bill is zero on both bases in every period', async () => {
    const co = await newCompany();
    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '100.00' }] });
    await voidBill(co.ctx, bill.id);
    expect(await cashNet(co, d('2026-01-01'), eod('2026-01-31'))).toBe('0.00');
    expect(await cashNet(co, ALL.from, ALL.to)).toBe('0.00');
    await assertCashInvariants(co, '2026-12-31');
  });
});

describe('report engines agree on the cash basis', () => {
  it('flat cash P&L, std P&L, P&L Detail, by class and class filter all agree; fiscal-year split is right', async () => {
    const co = await newCompany();
    const [east] = await db.insert(classes).values({ companyId: co.ctx.companyId, name: 'East' }).returning();
    const [west] = await db.insert(classes).values({ companyId: co.ctx.companyId, name: 'West' }).returning();
    // Invoice in Dec 2025, paid in Jan 2026: cash income belongs to FY2026, not FY2025.
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2025-12-20'),
      lines: [
        { ...line(co, '4000', '300.00'), classId: east.id },
        { ...line(co, '4100', '100.00'), classId: west.id },
      ],
    });
    await pay(co, inv.id, '2026-01-15', '100.00');
    const bill = await createBill(co.ctx, {
      vendorId: co.vendor,
      date: d('2025-12-01'),
      lines: [
        { accountId: co.code['6000'], amount: '80.00', classId: east.id },
        { accountId: co.code['6300'], amount: '20.00', classId: west.id },
      ],
    });
    await payBills(co.ctx, { vendorId: co.vendor, date: d('2026-02-01'), method: 'check', paymentAccountId: co.code['1000'], applications: [{ billId: bill.id, amountApplied: '50.00' }] });

    expect(await cashNet(co, d('2025-01-01'), eod('2025-12-31'))).toBe('0.00');
    const fy = { from: '2026-01-01', to: '2026-12-31' };
    const flat = await profitAndLossCashBasis(co.ctx, { from: d(fy.from), to: eod(fy.to) });
    expect(flat.totalIncome).toBe('100.00');
    expect(flat.totalExpenses).toBe('50.00');
    expect(flat.netIncome).toBe('50.00');
    const std = await profitAndLossReport(co.ctx, { ...fy, basis: 'cash' });
    expect(netRow(std)).toBe('50.00');
    const detail = await profitAndLossDetail(co.ctx, { ...fy, basis: 'cash' });
    expect(detail.rows.find((r) => r.id === 'pld:net')!.cells.amount).toBe('50.00');
    const byClass = await profitAndLossByClassReport(co.ctx, { ...fy, basis: 'cash' });
    expect(netRow(byClass)).toBe('50.00');
    const eastFlat = await profitAndLossCashBasis(co.ctx, { from: d(fy.from), to: eod(fy.to) }, { classId: east.id });
    const westFlat = await profitAndLossCashBasis(co.ctx, { from: d(fy.from), to: eod(fy.to) }, { classId: west.id });
    expect(eastFlat.netIncome).toBe('35.00'); // 75 income − 40 expense
    expect(westFlat.netIncome).toBe('15.00'); // 25 income − 10 expense
    const eastStd = await profitAndLossReport(co.ctx, { ...fy, basis: 'cash', classId: east.id });
    expect(netRow(eastStd)).toBe('35.00');

    const bs = await balanceSheetCashBasis(co.ctx, eod('2026-12-31'));
    expect(bs.balanced).toBe(true);
    expect(bs.priorYearsEarnings).toBe('0.00');
    expect(bs.currentYearNetIncome).toBe('50.00');
    const stdBs = await balanceSheetReport(co.ctx, { asOf: '2026-12-31', basis: 'cash' });
    expect(stdBs.rows.find((r) => r.id === 'bs:ni')!.cells.total).toBe('50.00');
    for (const m of ['2025-12-31', '2026-01-31', '2026-02-28', '2026-12-31']) await assertCashInvariants(co, m);
  });

  it("company isolation: one company's documents never enter another company's cash basis", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const inv = await createInvoice(b.ctx, { customerId: b.customer, date: d('2026-05-01'), lines: [line(b, '4000', '777.00')] });
    await pay(b, inv.id, '2026-05-02', '777.00');
    const { adjustments } = await cashBasisLedger(a.ctx);
    expect(adjustments).toHaveLength(0);
    expect(await cashNet(a, ALL.from, ALL.to)).toBe('0.00');
    expect(netRow(await profitAndLossReport(a.ctx, { from: '2026-01-01', to: '2026-12-31', basis: 'cash' }))).toBe('0.00');
  });
});
