/**
 * Cash-basis Profit & Loss / Balance Sheet — QuickBooks Desktop's per-transaction conversion.
 *
 * Regression for the P0 in PARITY.md: the old report took the accrual P&L and subtracted the
 * lump-sum change in A/R and A/P, so per-account lines did not add up to the totals, sales tax
 * on an unpaid invoice produced NEGATIVE cash income, and a bill for a fixed asset reduced cash
 * expenses. QB instead recognizes each income / expense line of an invoice or bill when it is
 * paid, pro-rata to the amount paid.
 *
 * Every scenario runs in its own company (default chart) inside one throwaway PGlite dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, classes, items, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { applyPayment, receivePayment, voidPayment } from './payments';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { createCreditMemo, applyToInvoice, refundCreditMemo } from './creditMemos';
import { applyToBill, createVendorCredit } from './vendorCredits';
import { createSalesReceipt } from './salesReceipts';
import { createExpense } from './expenses';
import { createTaxRate } from './salesTax';
import { balanceSheet, profitAndLoss } from './reports';
import { postJournalEntry } from './posting';
import { profitAndLossCashBasis } from './cashBasisReports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import {
  balanceSheetReport,
  profitAndLossByClassReport,
  profitAndLossDetail,
  profitAndLossReport,
  transactionDetailByAccount,
  trialBalanceReport,
} from './reportsStandard';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-cash-basis-reports');
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
const ALL = { from: d('2000-01-01'), to: d('2030-12-31') };

async function newCompany(): Promise<Co> {
  const company = await createCompany(db, { name: `Cash Basis Co ${++n}`, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const code: Record<string, string> = {};
  for (const r of rows) code[r.code] = r.id;
  const customer = (await createCustomer(ctx, { displayName: 'Acme' })).id;
  const vendor = (await createVendor(ctx, { displayName: 'Supplier' })).id;
  return { ctx, code, customer, vendor };
}

async function fixedAssetAccount(co: Co) {
  const [row] = await db
    .insert(accounts)
    .values({ companyId: co.ctx.companyId, code: '1700', name: 'Equipment', type: 'asset', subtype: 'fixed_assets' })
    .returning();
  return row.id;
}

const line = (co: Co, c: string, amount: string) => ({ accountId: co.code[c], quantity: 1, rate: amount, taxable: false });
const amt = (lines: { accountId: string; amount: string }[], id: string) =>
  lines.find((l) => l.accountId === id)?.amount ?? '0.00';
const sum = (lines: { amount: string }[]) => Money.add(...lines.map((l) => l.amount)).toFixed(2);
const netRow = (r: StdReport, col = 'total') => r.rows.find((x) => x.id === 'pl:net')!.cells[col];

async function cashNet(co: Co, from = ALL.from, to = ALL.to) {
  return (await profitAndLossCashBasis(co.ctx, { from, to })).netIncome;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'cash-basis@test.local', name: 'Cash', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('cash-basis P&L recognizes document lines when paid (P0 regression)', () => {
  it('unpaid $100 + $8 tax invoice: cash income is 0, not −8; lines add up; tax stays in A/R on the cash BS', async () => {
    const co = await newCompany();
    const rate = await createTaxRate(co.ctx, { name: 'State 8%', rate: '0.08' });
    await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-03-01'),
      taxRateId: rate.id,
      lines: [{ accountId: co.code['4000'], quantity: 1, rate: '100.00', taxable: true }],
    });
    const pl = await profitAndLossCashBasis(co.ctx, ALL);
    expect(pl.totalIncome).toBe('0.00');
    expect(pl.netIncome).toBe('0.00');
    expect(sum(pl.income)).toBe(pl.totalIncome);
    expect(sum(pl.expenses)).toBe(pl.totalExpenses);
    expect(pl.accrualNetIncome).toBe('100.00');

    const bs = await balanceSheetCashBasis(co.ctx);
    expect(bs.balanced).toBe(true);
    expect(amt(bs.assets, co.code['1200'])).toBe('8.00'); // only the sales-tax share remains
    expect(amt(bs.liabilities, co.code['2200'])).toBe('8.00');
    expect(bs.retainedEarnings).toBe('0.00');
    expect(bs.adjustments.arAdjustment).toBe('100.00');
  });

  it('partial payment allocates pro-rata across the invoice lines by account, on the payment date', async () => {
    const co = await newCompany();
    const rate = await createTaxRate(co.ctx, { name: 'Tax 10%', rate: '0.10' });
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-15'),
      taxRateId: rate.id,
      lines: [
        { accountId: co.code['4000'], quantity: 1, rate: '300.00', taxable: true },
        { accountId: co.code['4900'], quantity: 1, rate: '100.00', taxable: true },
      ],
    });
    expect(inv.total).toBe('440.00');
    // Pay half (220 of 440) in February.
    await receivePayment(co.ctx, {
      customerId: co.customer,
      date: d('2026-02-10'),
      amount: '220.00',
      method: 'check',
      depositAccountId: co.code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '220.00' }],
    });
    const jan = await profitAndLossCashBasis(co.ctx, { from: d('2026-01-01'), to: d('2026-01-31') });
    expect(jan.netIncome).toBe('0.00');
    const feb = await profitAndLossCashBasis(co.ctx, { from: d('2026-02-01'), to: d('2026-02-28') });
    expect(amt(feb.income, co.code['4000'])).toBe('150.00');
    expect(amt(feb.income, co.code['4900'])).toBe('50.00');
    expect(feb.totalIncome).toBe('200.00');

    // The standard engine agrees: P&L, P&L by month, P&L Detail, by class.
    const std = await profitAndLossReport(co.ctx, { from: '2026-01-01', to: '2026-03-31', basis: 'cash' });
    expect(netRow(std)).toBe('200.00');
    expect(std.subtitle).toContain('Cash Basis');
    const byMonth = await profitAndLossReport(co.ctx, { from: '2026-01-01', to: '2026-03-31', basis: 'cash', columns: 'month' });
    const net = byMonth.rows.find((r) => r.id === 'pl:net')!.cells;
    expect(Object.entries(net).filter(([k]) => k !== 'label' && k !== 'total').map(([, v]) => v)).toEqual(['0.00', '200.00', '0.00']);
    expect(net.total).toBe('200.00');
    const detail = await profitAndLossDetail(co.ctx, { from: '2026-01-01', to: '2026-03-31', basis: 'cash' });
    expect(detail.rows.find((r) => r.id === 'pld:net')!.cells.amount).toBe('200.00');
    const payRows = detail.rows.filter((r) => r.kind === 'data' && r.cells.type === 'Payment');
    expect(payRows.map((r) => r.cells.amount).sort()).toEqual(['150.00', '50.00']);
    expect(payRows.every((r) => r.cells.name === 'Acme' && r.cells.date === '2026-02-10')).toBe(true);
    const byClass = await profitAndLossByClassReport(co.ctx, { from: '2026-01-01', to: '2026-03-31', basis: 'cash' });
    expect(netRow(byClass)).toBe('200.00');
    // Accrual is unchanged.
    expect(netRow(await profitAndLossReport(co.ctx, { from: '2026-01-01', to: '2026-03-31' }))).toBe('400.00');

    // Cash BS: A/R = the unpaid half of the invoice's balance-sheet share (tax 20) — never income.
    const bs = await balanceSheetCashBasis(co.ctx, d('2026-03-31'));
    expect(bs.balanced).toBe(true);
    expect(amt(bs.assets, co.code['1200'])).toBe('20.00');
    expect(bs.retainedEarnings).toBe((await profitAndLossCashBasis(co.ctx, { to: d('2026-03-31') })).netIncome);
  });

  it('a bill for a fixed asset on A/P does not touch cash expenses; an expense bill counts when paid', async () => {
    const co = await newCompany();
    const equip = await fixedAssetAccount(co);
    await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-04-01'), lines: [{ accountId: equip, amount: '5000.00' }] });
    expect((await profitAndLossCashBasis(co.ctx, ALL)).totalExpenses).toBe('0.00');

    const bill = await createBill(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-04-02'),
      lines: [
        { accountId: co.code['6000'], amount: '300.00' },
        { accountId: co.code['6100'], amount: '100.00' },
      ],
    });
    let pl = await profitAndLossCashBasis(co.ctx, ALL);
    expect(pl.totalExpenses).toBe('0.00');
    await payBills(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-05-05'),
      method: 'check',
      paymentAccountId: co.code['1000'],
      applications: [{ billId: bill.id, amountApplied: '100.00' }],
    });
    pl = await profitAndLossCashBasis(co.ctx, ALL);
    expect(amt(pl.expenses, co.code['6000'])).toBe('75.00');
    expect(amt(pl.expenses, co.code['6100'])).toBe('25.00');
    expect(pl.totalExpenses).toBe('100.00');
    expect(sum(pl.expenses)).toBe(pl.totalExpenses);

    const bs = await balanceSheetCashBasis(co.ctx);
    expect(bs.balanced).toBe(true);
    // A/P keeps the fixed-asset bill; the unpaid expense share (300) is out of A/P and earnings.
    expect(amt(bs.liabilities, co.code['2000'])).toBe('5000.00');
    expect(bs.retainedEarnings).toBe('-100.00');
    expect(bs.adjustments.apAdjustment).toBe('300.00');
  });
});

describe('full cycle: when everything is paid, cash net income == accrual net income', () => {
  it('invoices, tax, early-payment discount, credit memo, bills, vendor credit, receipts, checks', async () => {
    const co = await newCompany();
    const [cls] = await db.insert(classes).values({ companyId: co.ctx.companyId, name: 'East' }).returning();
    const rate = await createTaxRate(co.ctx, { name: 'Tax 7.25%', rate: '0.0725' });
    const inv1 = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-05'),
      taxRateId: rate.id,
      classId: cls.id,
      lines: [
        { accountId: co.code['4000'], quantity: 3, rate: '33.33', taxable: true },
        { accountId: co.code['4900'], quantity: 1, rate: '17.01', taxable: false },
      ],
    });
    const inv2 = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-01-20'), lines: [line(co, '4000', '250.00')] });
    const cm = await createCreditMemo(co.ctx, { customerId: co.customer, date: d('2026-02-01'), lines: [line(co, '4000', '50.00')] });
    await applyToInvoice(co.ctx, { creditMemoId: cm.id, invoiceId: inv2.id, amount: '50.00', date: d('2026-02-02') });
    // Three uneven payments on invoice 1 (rounding must land exactly), one with a discount.
    const due1 = Money.of(inv1.total);
    const p1 = Money.round2(due1.dividedBy(3));
    await receivePayment(co.ctx, { customerId: co.customer, date: d('2026-02-03'), amount: p1.toFixed(2), method: 'check', depositAccountId: co.code['1000'], applications: [{ invoiceId: inv1.id, amountApplied: p1.toFixed(2) }] });
    await receivePayment(co.ctx, { customerId: co.customer, date: d('2026-03-03'), amount: p1.toFixed(2), method: 'check', depositAccountId: co.code['1000'], applications: [{ invoiceId: inv1.id, amountApplied: p1.toFixed(2) }] });
    const rest = due1.minus(p1.times(2));
    await receivePayment(co.ctx, {
      customerId: co.customer,
      date: d('2026-04-03'),
      amount: rest.minus('1.00').toFixed(2),
      method: 'check',
      depositAccountId: co.code['1000'],
      applications: [{ invoiceId: inv1.id, amountApplied: rest.minus('1.00').toFixed(2), discountAmount: '1.00' }],
    });
    await receivePayment(co.ctx, { customerId: co.customer, date: d('2026-02-20'), amount: '200.00', method: 'check', depositAccountId: co.code['1000'], applications: [{ invoiceId: inv2.id, amountApplied: '200.00' }] });

    const bill = await createBill(co.ctx, { vendorId: co.vendor, date: d('2026-01-10'), lines: [{ accountId: co.code['6000'], amount: '333.33' }, { accountId: co.code['5000'], amount: '66.67' }] });
    const vc = await createVendorCredit(co.ctx, { vendorId: co.vendor, date: d('2026-01-12'), lines: [{ accountId: co.code['6000'], amount: '40.00' }] });
    await applyToBill(co.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00' });
    await payBills(co.ctx, { vendorId: co.vendor, date: d('2026-02-15'), method: 'check', paymentAccountId: co.code['1000'], applications: [{ billId: bill.id, amountApplied: '123.45' }] });
    await payBills(co.ctx, { vendorId: co.vendor, date: d('2026-03-15'), method: 'check', paymentAccountId: co.code['1000'], applications: [{ billId: bill.id, amountApplied: '236.55' }] });

    await createSalesReceipt(co.ctx, { date: d('2026-02-11'), depositAccountId: co.code['1000'], lines: [{ accountId: co.code['4000'], quantity: 1, rate: '75.00', taxable: false }] });
    await createExpense(co.ctx, { vendorId: co.vendor, date: d('2026-02-12'), method: 'check', reference: '501', paymentAccountId: co.code['1000'], lines: [{ accountId: co.code['6100'], amount: '12.34' }] });

    const accrual = await profitAndLoss(co.ctx, ALL);
    const cash = await profitAndLossCashBasis(co.ctx, ALL);
    expect(cash.netIncome).toBe(accrual.netIncome);
    for (const l of accrual.income) expect(amt(cash.income, l.accountId)).toBe(l.amount);
    for (const l of accrual.expenses) expect(amt(cash.expenses, l.accountId)).toBe(l.amount);
    // Same on the standard engine, by class too.
    expect(netRow(await profitAndLossReport(co.ctx, { from: '2026-01-01', to: '2026-12-31', basis: 'cash' }))).toBe(accrual.netIncome);
    expect(netRow(await profitAndLossByClassReport(co.ctx, { from: '2026-01-01', to: '2026-12-31', basis: 'cash' }))).toBe(accrual.netIncome);
    // Fully settled: the cash balance sheet equals the accrual one.
    const bsCash = await balanceSheetCashBasis(co.ctx);
    const bsAcc = await balanceSheet(co.ctx);
    expect(bsCash.balanced).toBe(true);
    expect(bsCash.totals.totalAssets).toBe(bsAcc.totalAssets);
    expect(bsCash.retainedEarnings).toBe(bsAcc.retainedEarnings);
    expect(bsCash.retainedEarnings).toBe(cash.netIncome);

    // Mid-cycle (end of February): cash earnings on the BS == cash P&L to date, both engines.
    const feb = d('2026-02-28');
    const febEnd = new Date('2026-02-28T23:59:59.999Z');
    const bsFeb = await balanceSheetCashBasis(co.ctx, febEnd);
    const plFeb = await profitAndLossCashBasis(co.ctx, { from: ALL.from, to: febEnd });
    expect(bsFeb.balanced).toBe(true);
    expect(bsFeb.retainedEarnings).toBe(plFeb.netIncome);
    expect(plFeb.netIncome).not.toBe((await profitAndLoss(co.ctx, { from: ALL.from, to: febEnd })).netIncome);
    const stdBs = await balanceSheetReport(co.ctx, { asOf: '2026-02-28', basis: 'cash' });
    expect(stdBs.balanced).toBe(true);
    expect(stdBs.rows.find((r) => r.id === 'bs:ni')!.cells.total).toBe(plFeb.netIncome);
    const tb = await trialBalanceReport(co.ctx, { asOf: '2026-02-28', basis: 'cash' });
    expect(tb.balanced).toBe(true);
    void feb;
  });
});

describe('QB edge cases (documented choices)', () => {
  it('early-payment discount: invoice income recognized in full, discount on the payment date', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-06-01'), lines: [line(co, '4000', '100.00')] });
    await receivePayment(co.ctx, {
      customerId: co.customer,
      date: d('2026-06-05'),
      amount: '98.00',
      method: 'check',
      depositAccountId: co.code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '98.00', discountAmount: '2.00' }],
    });
    const pl = await profitAndLossCashBasis(co.ctx, ALL);
    expect(amt(pl.income, co.code['4000'])).toBe('100.00');
    expect(pl.netIncome).toBe('98.00');
  });

  it('unapplied payment (prepayment) recognizes nothing until applied; then it counts on the payment date', async () => {
    const co = await newCompany();
    const pay = await receivePayment(co.ctx, {
      customerId: co.customer,
      date: d('2026-07-01'),
      amount: '500.00',
      method: 'check',
      depositAccountId: co.code['1000'],
      applications: [],
    });
    const inv = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-07-10'), lines: [line(co, '4000', '400.00')] });
    expect(await cashNet(co)).toBe('0.00');
    const bs0 = await balanceSheetCashBasis(co.ctx);
    expect(bs0.balanced).toBe(true);
    expect(amt(bs0.assets, co.code['1200'])).toBe('-500.00'); // customer credit, like QB
    const paymentId = pay.payment.id;
    await applyPayment(co.ctx, { paymentId, applications: [{ invoiceId: inv.id, amountApplied: '400.00' }] });
    expect(await cashNet(co)).toBe('400.00');
    // Dated on the invoice (the payment came first; a document can't be paid before it exists).
    expect(await cashNet(co, d('2026-07-10'), d('2026-07-10'))).toBe('400.00');
  });

  it('an unapplied credit memo has no effect; refunding it counts on the refund date', async () => {
    const co = await newCompany();
    const cm = await createCreditMemo(co.ctx, { customerId: co.customer, date: d('2026-08-01'), lines: [line(co, '4000', '60.00')] });
    expect(await cashNet(co)).toBe('0.00');
    await refundCreditMemo(co.ctx, { creditMemoId: cm.id, bankAccountId: co.code['1000'], amount: '60.00', date: d('2026-08-20') });
    expect(await cashNet(co, d('2026-08-20'), d('2026-08-20'))).toBe('-60.00');
    expect(await cashNet(co)).toBe('-60.00');
  });

  it('retainage: paying the billed base recognizes the invoice (QB); Retainage Receivable stays on the cash BS', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-09-01'), lines: [line(co, '4000', '1000.00')], retainagePercent: 10 });
    expect(await cashNet(co)).toBe('0.00');
    const bs0 = await balanceSheetCashBasis(co.ctx);
    expect(bs0.balanced).toBe(true);
    expect(amt(bs0.assets, co.code['1250'])).toBe('100.00');
    expect(bs0.retainedEarnings).toBe(await cashNet(co));
    await receivePayment(co.ctx, { customerId: co.customer, date: d('2026-09-15'), amount: '450.00', method: 'check', depositAccountId: co.code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '450.00' }] });
    expect(await cashNet(co)).toBe('500.00');
    await receivePayment(co.ctx, { customerId: co.customer, date: d('2026-09-30'), amount: '450.00', method: 'check', depositAccountId: co.code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '450.00' }] });
    expect(await cashNet(co)).toBe('1000.00');
    const bs = await balanceSheetCashBasis(co.ctx);
    expect(bs.balanced).toBe(true);
    expect(bs.retainedEarnings).toBe('1000.00');
  });

  it('inventory: COGS on an unpaid invoice waits for the payment; inventory leaves the BS on the invoice date', async () => {
    const co = await newCompany();
    const [item] = await db
      .insert(items)
      .values({ companyId: co.ctx.companyId, name: 'Widget', type: 'inventory', assetAccountId: co.code['1300'], incomeAccountId: co.code['4000'], quantityOnHand: '0', averageCost: '0' })
      .returning();
    await createExpense(co.ctx, { vendorId: co.vendor, date: d('2026-10-01'), method: 'check', reference: '900', paymentAccountId: co.code['1000'], lines: [{ itemId: item.id, quantity: 10, unitCost: '6.00' }] });
    const inv = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-10-05'), lines: [{ itemId: item.id, quantity: 2, rate: '20.00', taxable: false }] });
    const acc = await profitAndLoss(co.ctx, ALL);
    expect(amt(acc.expenses, co.code['5000'])).toBe('12.00');
    let cash = await profitAndLossCashBasis(co.ctx, ALL);
    expect(amt(cash.expenses, co.code['5000'])).toBe('0.00');
    expect(cash.netIncome).toBe('0.00');
    const bs0 = await balanceSheetCashBasis(co.ctx);
    expect(bs0.balanced).toBe(true);
    expect(amt(bs0.assets, co.code['1300'])).toBe('48.00');
    await receivePayment(co.ctx, { customerId: co.customer, date: d('2026-10-20'), amount: '20.00', method: 'check', depositAccountId: co.code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '20.00' }] });
    cash = await profitAndLossCashBasis(co.ctx, ALL);
    expect(amt(cash.expenses, co.code['5000'])).toBe('6.00');
    expect(cash.netIncome).toBe('14.00');
  });

  it('voiding a payment takes its recognition back out', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-11-01'), lines: [line(co, '4000', '80.00')] });
    const pay = await receivePayment(co.ctx, { customerId: co.customer, date: d('2026-11-02'), amount: '80.00', method: 'check', depositAccountId: co.code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '80.00' }] });
    expect(await cashNet(co)).toBe('80.00');
    const paymentId = pay.payment.id;
    await voidPayment(co.ctx, paymentId);
    expect(await cashNet(co)).toBe('0.00');
    expect((await balanceSheetCashBasis(co.ctx)).balanced).toBe(true);
  });

  it('journal entries are reported the same on both bases (QB), and QuickZoom detail on cash ties to the P&L row', async () => {
    const co = await newCompany();
    const inv = await createInvoice(co.ctx, { customerId: co.customer, date: d('2026-12-01'), lines: [line(co, '4000', '90.00')] });
    await receivePayment(co.ctx, { customerId: co.customer, date: d('2026-12-10'), amount: '30.00', method: 'check', depositAccountId: co.code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '30.00' }] });
    const tda = await transactionDetailByAccount(co.ctx, { accountId: co.code['4000'], from: '2026-12-01', to: '2026-12-31', basis: 'cash' });
    const total = tda.rows.find((r) => r.kind === 'subtotal')!.cells.amount;
    expect(total).toBe('30.00');
    const accrualTda = await transactionDetailByAccount(co.ctx, { accountId: co.code['4000'], from: '2026-12-01', to: '2026-12-31' });
    expect(accrualTda.rows.find((r) => r.kind === 'subtotal')!.cells.amount).toBe('90.00');

    // A General Journal entry on A/R + income is not converted.
    await postJournalEntry(co.ctx, {
      date: d('2026-12-15'),
      description: 'Accrued fee',
      lines: [
        { accountId: co.code['1200'], debit: '25.00', entityType: 'customer', entityId: co.customer },
        { accountId: co.code['4000'], credit: '25.00' },
      ],
    });
    expect(await cashNet(co)).toBe('55.00');
    expect((await balanceSheetCashBasis(co.ctx)).retainedEarnings).toBe('55.00');
  });
});

