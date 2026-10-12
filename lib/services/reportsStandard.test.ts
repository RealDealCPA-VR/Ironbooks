/**
 * Report engine + standard statements: QB P&L sections, sub-account roll-up, balance sheet
 * Retained Earnings / Net Income split (balanced), trial balance roll-up, detail filters and
 * the number formats. Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { classes, companies, customers, invoices, users, vendors, bills } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { balanceSheet, profitAndLoss, trialBalance } from './reports';
import { sectionForAccount, splitPeriods } from './reportEngine';
import {
  balanceSheetDetail,
  balanceSheetReport,
  journalReport,
  profitAndLossByClassReport,
  profitAndLossDetail,
  profitAndLossReport,
  profitAndLossYtdComparison,
  transactionDetailByAccount,
  transactionList,
  trialBalanceReport,
} from './reportsStandard';
import type { StdReport } from '@/lib/reports/types';
import { formatAmount, DEFAULT_NUMBER_FORMAT, roundDecimalString } from '@/lib/reports/format';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-standard');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
let classA: string;
let customerId: string;
let vendorId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const row = (r: StdReport, label: string) => r.rows.find((x) => x.cells.label === label);
const cell = (r: StdReport, label: string, key = 'total') => row(r, label)?.cells[key];

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'std@rep.test', name: 'Owner', passwordHash: 'x' }).returning();
  const [company] = await db
    .insert(companies)
    .values({ name: 'Std Reports Co', ownerId: user.id, settings: { fiscalYearEnd: '12-31' } })
    .returning();
  ctx = { db, companyId: company.id, userId: user.id };

  const mk = async (key: string, code: string, name: string, type: string, subtype: string, parent?: string) => {
    const r = await createAccount(ctx, { code, name, type: type as never, subtype, parentId: parent ? A[parent] : null });
    A[key] = r.id;
  };
  await mk('bank', '1000', 'Checking', 'asset', 'checking');
  await mk('ar', '1200', 'Accounts Receivable', 'asset', 'accounts_receivable');
  await mk('ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable');
  await mk('equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk('re', '3900', 'Retained Earnings', 'equity', 'retained_earnings');
  await mk('sales', '4000', 'Sales', 'revenue', 'sales');
  await mk('salesWeb', '4010', 'Web Sales', 'revenue', 'sales', 'sales');
  await mk('salesStore', '4020', 'Store Sales', 'revenue', 'sales', 'sales');
  await mk('interest', '7000', 'Interest Income', 'revenue', 'other_income');
  await mk('cogs', '5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold');
  await mk('rent', '6000', 'Rent', 'expense', 'operating_expenses');
  await mk('util', '6100', 'Utilities', 'expense', 'operating_expenses');

  const [cls] = await db.insert(classes).values({ companyId: company.id, name: 'East' }).returning();
  classA = cls.id;
  const [cust] = await db.insert(customers).values({ companyId: company.id, displayName: 'Acme Corp' }).returning();
  customerId = cust.id;
  const [vend] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Landlord LLC' }).returning();
  vendorId = vend.id;

  const post = (date: string, description: string, lines: { a: string; dr?: string; cr?: string; memo?: string; classId?: string }[], sourceRef?: string, reference?: string) =>
    postJournalEntry(ctx, {
      date: d(date),
      description,
      sourceRef,
      reference,
      // A document's own A/R / A/P line is its control line (wave2 foundation posting guard).
      lines: lines.map((l) => ({
        accountId: A[l.a],
        debit: l.dr,
        credit: l.cr,
        memo: l.memo,
        classId: l.classId,
        ...(sourceRef && (l.a === 'ar' || l.a === 'ap') ? { controlLine: true } : {}),
      })),
    });

  // Prior fiscal year (2025): owner investment + income that stays unclosed.
  await post('2025-01-02', 'Owner investment', [{ a: 'bank', dr: '10000' }, { a: 'equity', cr: '10000' }]);
  await post('2025-06-01', 'Prior-year sale', [{ a: 'bank', dr: '1000' }, { a: 'salesWeb', cr: '1000' }]);
  await post('2025-06-02', 'Prior-year rent', [{ a: 'rent', dr: '400' }, { a: 'bank', cr: '400' }]);

  // Current year (2026).
  const [inv] = await db
    .insert(invoices)
    .values({ companyId: company.id, customerId, invoiceNumber: 1001, date: d('2026-02-01'), total: '500', balanceDue: '500' })
    .returning();
  await post('2026-02-01', 'Invoice 1001', [{ a: 'ar', dr: '500' }, { a: 'salesWeb', cr: '300', classId: classA }, { a: 'salesStore', cr: '200' }], `invoice:${inv.id}`);
  await post('2026-02-15', 'Parent-level sale', [{ a: 'bank', dr: '50' }, { a: 'sales', cr: '50' }]);
  await post('2026-03-01', 'Payment', [{ a: 'bank', dr: '200', memo: 'deposit ref ABC' }, { a: 'ar', cr: '200' }], `customer:${customerId}`, 'CHK-77');
  await post('2026-03-05', 'COGS', [{ a: 'cogs', dr: '120' }, { a: 'bank', cr: '120' }]);
  const [bill] = await db
    .insert(bills)
    .values({ companyId: company.id, vendorId, billNumber: 'R-9', date: d('2026-03-10'), total: '700', balanceDue: '700' })
    .returning();
  await post('2026-03-10', 'Rent bill', [{ a: 'rent', dr: '600' }, { a: 'util', dr: '100' }, { a: 'ap', cr: '700' }], `bill:${bill.id}`);
  await post('2026-04-01', 'Interest', [{ a: 'bank', dr: '30' }, { a: 'interest', cr: '30' }]);
}, 120_000);

afterAll(async () => {
  await closeDb();
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the PGlite files briefly */
  }
});

describe('sectionForAccount', () => {
  it('maps current types/subtypes and the QB names the foundation package adds', () => {
    expect(sectionForAccount('revenue', 'sales')).toBe('income');
    expect(sectionForAccount('revenue', 'other_income')).toBe('other_income');
    expect(sectionForAccount('expense', 'cost_of_goods_sold')).toBe('cogs');
    expect(sectionForAccount('expense', 'other_expense')).toBe('other_expense');
    expect(sectionForAccount('expense', 'operating_expenses')).toBe('expense');
    expect(sectionForAccount('cost_of_goods_sold', null)).toBe('cogs');
    expect(sectionForAccount('other_income', null)).toBe('other_income');
    expect(sectionForAccount('Other Expense', null)).toBe('other_expense');
    expect(sectionForAccount('asset', 'checking')).toBe('bank');
    expect(sectionForAccount('asset', 'inventory')).toBe('other_current_asset');
    expect(sectionForAccount('asset', 'fixed_assets')).toBe('fixed_asset');
    expect(sectionForAccount('liability', 'credit_card')).toBe('credit_card');
    expect(sectionForAccount('liability', 'long_term_liability')).toBe('long_term_liability');
    expect(sectionForAccount('liability', 'payroll_liabilities')).toBe('other_current_liability');
    expect(sectionForAccount('equity', 'retained_earnings')).toBe('equity');
  });
});

describe('Profit & Loss (QB sections + roll-up)', () => {
  it('lays out Income, COGS, Gross Profit, Expense, Net Ordinary, Other Income, Net Income', async () => {
    const r = await profitAndLossReport(ctx, { from: '2026-01-01', to: '2026-12-31' });
    const labels = r.rows.map((x) => x.cells.label);
    for (const l of [
      'Ordinary Income/Expense',
      'Income',
      'Total Income',
      'Cost of Goods Sold',
      'Total Cost of Goods Sold',
      'Gross Profit',
      'Expense',
      'Total Expense',
      'Net Ordinary Income',
      'Other Income/Expense',
      'Other Income',
      'Total Other Income',
      'Net Other Income',
      'Net Income',
    ]) {
      expect(labels).toContain(l);
    }
    expect(cell(r, 'Total Income')).toBe('550.00');
    expect(cell(r, 'Gross Profit')).toBe('430.00');
    expect(cell(r, 'Total Expense')).toBe('700.00');
    expect(cell(r, 'Net Ordinary Income')).toBe('-270.00');
    expect(cell(r, 'Net Other Income')).toBe('30.00');
    expect(cell(r, 'Net Income')).toBe('-240.00');
    // Same bottom line as the legacy P&L service.
    const legacy = await profitAndLoss(ctx, { from: d('2026-01-01'), to: new Date('2026-12-31T23:59:59.999Z') });
    expect(legacy.netIncome).toBe('-240.00');
  });

  it('rolls sub-accounts up under the parent with "<Parent> - Other" and "Total <Parent>"', async () => {
    const r = await profitAndLossReport(ctx, { from: '2026-01-01', to: '2026-12-31' });
    const parent = row(r, 'Sales')!;
    expect(parent.kind).toBe('section');
    expect(parent.collapsedCells?.total).toBe('550.00');
    const web = row(r, 'Web Sales')!;
    expect(web.parentId).toBe(parent.id);
    expect(web.depth).toBe(parent.depth + 1);
    expect(web.cells.total).toBe('300.00');
    expect(cell(r, 'Sales - Other')).toBe('50.00');
    expect(cell(r, 'Total Sales')).toBe('550.00');
    expect(row(r, 'Total Sales')!.totalOf).toBe(parent.id);
    expect(web.href).toContain('/reports/std/transaction-detail-by-account');
  });

  it('supports monthly columns whose total equals the single-column report', async () => {
    const r = await profitAndLossReport(ctx, { from: '2026-01-01', to: '2026-06-30', columns: 'month' });
    expect(r.columns.map((c) => c.header)).toEqual(['', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'TOTAL']);
    expect(cell(r, 'Net Income', 'total')).toBe('-240.00');
    expect(cell(r, 'Total Income', 'p1')).toBe('550.00'); // February
    expect(cell(r, 'Net Income', 'p3')).toBe('30.00'); // April
  });

  it('quarter columns follow the fiscal year', () => {
    const q = splitPeriods(d('2026-01-01'), d('2026-12-31'), 'quarter', '06-30');
    expect(q.map((x) => x.label)).toEqual(['Q3 FY2026', 'Q4 FY2026', 'Q1 FY2027', 'Q2 FY2027']);
  });

  it('compares with the previous year ($ and % change)', async () => {
    const r = await profitAndLossReport(ctx, { from: '2026-01-01', to: '2026-12-31', compare: 'prev_year' });
    const rent = row(r, 'Rent')!;
    expect(rent.cells.cur).toBe('600.00');
    expect(rent.cells.prev).toBe('400.00');
    expect(rent.cells.chg).toBe('200.00');
    expect(rent.cells.pctchg).toBe('50.00');
  });

  it('% of income, YTD comparison and by-class columns', async () => {
    const pctR = await profitAndLossReport(ctx, { from: '2026-01-01', to: '2026-12-31' }, { percentOfIncome: true });
    expect(row(pctR, 'Total Income')!.cells.total_pct).toBe('100.00');
    const ytd = await profitAndLossYtdComparison(ctx, { from: '2026-03-01', to: '2026-03-31' });
    expect(cell(ytd, 'Total Income', 'ytd')).toBe('550.00');
    expect(cell(ytd, 'Total Income', 'cur')).toBe('0.00');
    const byClass = await profitAndLossByClassReport(ctx, { from: '2026-01-01', to: '2026-12-31' });
    expect(byClass.columns.map((c) => c.header)).toEqual(['', 'East', 'Unclassified', 'TOTAL']);
    expect(cell(byClass, 'Web Sales', 'c0')).toBe('300.00');
    expect(cell(byClass, 'Net Income', 'total')).toBe('-240.00');
  });
});

describe('Balance Sheet', () => {
  it('shows Retained Earnings (prior years) and Net Income (current year) separately and balances', async () => {
    const r = await balanceSheetReport(ctx, { asOf: '2026-12-31' });
    const base = await balanceSheet(ctx, new Date('2026-12-31T23:59:59.999Z'));
    expect(r.balanced).toBe(true);
    // Retained earnings account carries the unclosed prior-year income (1000 - 400).
    expect(cell(r, 'Retained Earnings')).toBe('600.00');
    expect(cell(r, 'Net Income')).toBe('-240.00');
    expect(cell(r, 'TOTAL ASSETS')).toBe(base.totalAssets);
    expect(cell(r, 'TOTAL LIABILITIES & EQUITY')).toBe(base.totalAssets);
    expect(cell(r, 'Total Checking/Savings')).toBe('10760.00');
    expect(cell(r, 'Total Accounts Receivable')).toBe('300.00');
    expect(cell(r, 'Total Current Liabilities')).toBe('700.00');
  });

  it('summary, comparative and quarterly variants balance too', async () => {
    const s = await balanceSheetReport(ctx, { asOf: '2026-12-31' }, { summary: true });
    expect(s.balanced).toBe(true);
    expect(cell(s, 'Checking/Savings')).toBe('10760.00');
    const c = await balanceSheetReport(ctx, { asOf: '2026-12-31', compare: 'prev_year' });
    expect(row(c, 'TOTAL ASSETS')!.cells.prev).toBe('10600.00');
    const q = await balanceSheetReport(ctx, { from: '2026-01-01', to: '2026-12-31', columns: 'quarter' });
    expect(q.columns).toHaveLength(5);
  });
});

describe('Trial Balance roll-up', () => {
  it('nests sub-accounts and keeps the ledger totals', async () => {
    const r = await trialBalanceReport(ctx, { asOf: '2026-12-31' });
    const tb = await trialBalance(ctx, new Date('2026-12-31T23:59:59.999Z'));
    expect(row(r, 'TOTAL')!.cells.debit).toBe(tb.totalDebit);
    expect(row(r, 'TOTAL')!.cells.credit).toBe(tb.totalCredit);
    expect(row(r, 'Total Sales')!.cells.credit).toBe('1550.00');
    expect(r.balanced).toBe(true);
  });
});

describe('Detail reports and filters', () => {
  it('Transaction Detail by Account resolves Type / Num / Name / Split and filters', async () => {
    const r = await transactionDetailByAccount(ctx, { accountId: A.ar, from: '2026-01-01', to: '2026-12-31' });
    const inv = r.rows.find((x) => x.cells.type === 'Invoice')!;
    expect(inv.cells.num).toBe('1001');
    expect(inv.cells.name).toBe('Acme Corp');
    expect(inv.cells.split).toBe('-SPLIT-');
    expect(inv.entryId).toBeTruthy();
    const pay = r.rows.find((x) => x.cells.type === 'Payment')!;
    expect(pay.cells.num).toBe('CHK-77');
    expect(pay.cells.split).toBe('Checking');
    expect(pay.cells.balance).toBe('300.00');

    const byName = await transactionDetailByAccount(ctx, { customerId, subtotalBy: 'name', from: '2026-01-01', to: '2026-12-31' });
    expect(byName.rows.filter((x) => x.entryId).length).toBe(5);
    const byType = await transactionDetailByAccount(ctx, { txnType: 'bill', from: '2026-01-01', to: '2026-12-31' });
    expect(byType.rows.filter((x) => x.entryId).every((x) => x.cells.type === 'Bill')).toBe(true);
    const byAmt = await transactionDetailByAccount(ctx, { amountMin: '500', amountMax: '600', from: '2026-01-01', to: '2026-12-31' });
    expect(byAmt.rows.filter((x) => x.entryId).map((x) => x.cells.amount).sort()).toEqual(['500.00', '600.00']);
    const byMemo = await transactionDetailByAccount(ctx, { memo: 'ref ABC' });
    expect(byMemo.rows.filter((x) => x.entryId)).toHaveLength(1);
    const byNum = await transactionDetailByAccount(ctx, { number: 'R-9' });
    expect(byNum.rows.filter((x) => x.entryId)).toHaveLength(3);
    const byClass = await transactionDetailByAccount(ctx, { classId: classA });
    expect(byClass.rows.filter((x) => x.entryId)).toHaveLength(1);
    const uncleared = await transactionDetailByAccount(ctx, { cleared: 'cleared' });
    expect(uncleared.rows.filter((x) => x.entryId)).toHaveLength(0);
    const sorted = await transactionDetailByAccount(ctx, { accountId: A.bank, sortBy: 'amount', sortDir: 'desc', subtotalBy: 'none' });
    const amts = sorted.rows.filter((x) => x.entryId).map((x) => Number(x.cells.amount));
    expect(amts).toEqual([...amts].sort((a, b) => b - a));
  });

  it('P&L Detail nets to Net Income, Balance Sheet Detail carries beginning balances', async () => {
    const r = await profitAndLossDetail(ctx, { from: '2026-01-01', to: '2026-12-31' });
    expect(row(r, 'Net Income')!.cells.amount).toBe('-240.00');
    const bsd = await balanceSheetDetail(ctx, { from: '2026-01-01', to: '2026-12-31' });
    const open = bsd.rows.find((x) => x.id.endsWith(':open') && x.parentId?.includes(A.bank));
    expect(open?.cells.balance).toBe('10600.00');
    expect(row(bsd, 'Total Checking')!.cells.balance).toBe('10760.00');
  });

  it('Journal shows whole balanced entries; transaction lists group by name', async () => {
    const j = await journalReport(ctx, { from: '2026-01-01', to: '2026-12-31', txnType: 'invoice' });
    expect(j.balanced).toBe(true);
    expect(j.rows.filter((x) => x.kind === 'data')).toHaveLength(3);
    const byCust = await transactionList(ctx, { from: '2026-01-01', to: '2026-12-31' }, 'customer');
    expect(byCust.rows.find((x) => x.kind === 'section')?.cells.label).toBe('Acme Corp');
    expect(byCust.rows.filter((x) => x.entryId)).toHaveLength(2);
    const byVend = await transactionList(ctx, { from: '2026-01-01', to: '2026-12-31' }, 'vendor');
    const billRow = byVend.rows.find((x) => x.entryId)!;
    expect(billRow.cells.amount).toBe('700.00');
    expect(billRow.cells.account).toBe('Accounts Payable');
  });
});

describe('number formats', () => {
  it('formats thousands, parentheses, trailing minus, without cents and red negatives flag', () => {
    const f = { ...DEFAULT_NUMBER_FORMAT };
    expect(formatAmount('1234567.5', f).text).toBe('1,234,567.50');
    expect(formatAmount('-1234.5', { ...f, negative: 'parens' })).toEqual({ text: '(1,234.50)', negative: true });
    expect(formatAmount('-1234.5', { ...f, negative: 'trailing', thousands: false }).text).toBe('1234.50-');
    expect(formatAmount('1234.50', { ...f, withoutCents: true }).text).toBe('1,235');
    expect(formatAmount('1234567.00', { ...f, divideBy1000: true }).text).toBe('1,234.57');
    expect(formatAmount('0.00', { ...f, hideZero: true }).text).toBe('');
    expect(formatAmount('12.5', f, 'percent').text).toBe('12.5%');
    expect(roundDecimalString('9.995', 2)).toBe('10.00');
    expect(roundDecimalString('-0.004', 2)).toBe('0.00');
    expect(formatAmount('99999999999999.99', f).text).toBe('99,999,999,999,999.99');
  });
});
