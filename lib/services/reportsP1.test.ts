/**
 * P1 report round (PARITY.md "Area: reports"):
 *  - A/R and A/P aging on the std engine: Interval / Through, aging from due vs transaction date,
 *    customer:job / vendor / class filters, QuickZoom, memorize; Open Invoices, Collections;
 *  - basis=cash honoured by the sales reports, the Reports preference sets the default basis and
 *    memorized reports keep theirs;
 *  - Income Tax Preparation / Summary / Detail: form line names, form order, company form;
 *  - Adjusting Journal Entries, General Ledger, Statement of Cash Flows, P&L by Job,
 *    Balance Sheet Prev Year, purchases summaries, Sales Tax Liability in the catalog.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, classes, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import { CATALOG_BY_KEY, REPORT_CATALOG } from '@/lib/reports/catalog';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createBill } from './bills';
import { createCreditMemo } from './creditMemos';
import { createSalesReceipt } from './salesReceipts';
import { createItem } from './items';
import { postJournalEntry } from './posting';
import { setIncomeTaxForm } from './accounts';
import { catalogKeysWithoutRunner, runStandardReport } from './reportRegistry';
import { runMemorizedReport, saveMemorizedReport } from './memorizedReports';
import { agingColumns } from './reportsAging';
import { profitAndLossCashBasis } from './cashBasisReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-p1');
let db: DB;
let userId: string;
let n = 0;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const row = (r: StdReport, label: string) => r.rows.find((x) => x.cells.label === label);
const grand = (r: StdReport) => r.rows.find((x) => x.kind === 'grand')!;

interface Co {
  ctx: ServiceContext;
  code: Record<string, string>;
}

async function newCompany(): Promise<Co> {
  const company = await createCompany(db, { name: `P1 Reports Co ${++n}`, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const code: Record<string, string> = {};
  for (const r of rows) code[r.code] = r.id;
  return { ctx, code };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'p1-reports@test.local', name: 'P1', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('catalog', () => {
  it('lists the migrated reports, every key has a runner, income tax is no longer hidden', () => {
    expect(catalogKeysWithoutRunner()).toEqual([]);
    for (const k of [
      'ar-aging-summary', 'ar-aging-detail', 'ap-aging-summary', 'ap-aging-detail', 'open-invoices', 'collections-report',
      'unpaid-bills-detail', 'adjusting-journal-entries', 'general-ledger', 'statement-of-cash-flows', 'sales-by-customer-summary',
      'sales-by-item-summary', 'purchases-by-vendor-summary', 'purchases-by-item-summary', 'sales-tax-liability',
      'profit-loss-by-job', 'balance-sheet-prev-year', 'income-tax-preparation', 'income-tax-summary', 'income-tax-detail',
    ]) {
      expect(CATALOG_BY_KEY[k], k).toBeDefined();
      expect(CATALOG_BY_KEY[k].hidden, k).toBeFalsy();
    }
    expect(CATALOG_BY_KEY['adjusting-journal-entries'].group).toBe('Accountant & Taxes');
    expect(CATALOG_BY_KEY['income-tax-summary'].group).toBe('Accountant & Taxes');
    expect(CATALOG_BY_KEY['sales-tax-liability'].group).toBe('Vendors & Payables');
    expect(CATALOG_BY_KEY['ar-aging-summary'].controls).toEqual(expect.arrayContaining(['asOf', 'aging', 'customer', 'class']));
    expect(CATALOG_BY_KEY['ap-aging-detail'].controls).toEqual(expect.arrayContaining(['asOf', 'aging', 'vendor', 'class']));
    // Every report QB offers on both bases is flagged.
    for (const k of [
      'profit-loss', 'profit-loss-detail', 'profit-loss-by-month', 'pl-by-class', 'profit-loss-by-job', 'balance-sheet',
      'balance-sheet-detail', 'balance-sheet-summary', 'balance-sheet-prev-year', 'trial-balance', 'general-ledger',
      'sales-by-customer-summary', 'sales-by-customer-detail', 'sales-by-item-summary', 'sales-by-item-detail',
      'expenses-by-vendor-summary', 'expenses-by-vendor-detail', 'transaction-detail-by-account',
    ]) {
      expect(CATALOG_BY_KEY[k].basis, k).toBe(true);
    }
    expect(REPORT_CATALOG.filter((e) => e.hidden)).toEqual([]);
  });

  it('aging columns follow Interval and Through like QB', () => {
    expect(agingColumns().map((c) => c.label)).toEqual(['Current', '1 - 30', '31 - 60', '61 - 90', '> 90']);
    expect(agingColumns(15, 45).map((c) => c.label)).toEqual(['Current', '1 - 15', '16 - 30', '31 - 45', '> 45']);
    expect(agingColumns(30, 100).map((c) => c.label)).toEqual(['Current', '1 - 30', '31 - 60', '61 - 90', '91 - 100', '> 100']);
    expect(() => agingColumns(1, 90)).toThrow(/24 aging columns/);
  });
});

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

describe('A/R and A/P aging on the standard engine', () => {
  let co: Co;
  const ids: Record<string, string> = {};
  const AS_OF = '2026-06-30';

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    const [east] = await db.insert(classes).values({ companyId: ctx.companyId, name: 'East' }).returning();
    ids.east = east.id;
    ids.acme = (await createCustomer(ctx, { displayName: 'Acme', phone: '555-0100', email: 'ap@acme.test' })).id;
    ids.kitchen = (await createCustomer(ctx, { displayName: 'Kitchen', parentId: ids.acme })).id;
    ids.beta = (await createCustomer(ctx, { displayName: 'Beta' })).id;
    ids.supplier = (await createVendor(ctx, { displayName: 'Supplier' })).id;
    ids.other = (await createVendor(ctx, { displayName: 'Other Vendor' })).id;
    const line = (amount: string) => ({ accountId: code['4000'], quantity: 1, rate: amount, taxable: false });
    // 30 days past due on Jun 30.
    ids.invA = (await createInvoice(ctx, { customerId: ids.acme, date: d('2026-05-01'), dueDate: d('2026-05-31'), classId: east.id, lines: [line('100.00')] })).id;
    // 91 days past due; 80 paid → 120 open.
    ids.invB = (await createInvoice(ctx, { customerId: ids.kitchen, date: d('2026-03-01'), dueDate: d('2026-03-31'), lines: [line('200.00')] })).id;
    await receivePayment(ctx, { customerId: ids.kitchen, date: d('2026-04-15'), amount: '80.00', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: ids.invB, amountApplied: '80.00' }] });
    // Not yet due (10 days after the invoice date).
    ids.invC = (await createInvoice(ctx, { customerId: ids.beta, date: d('2026-06-20'), dueDate: d('2026-07-20'), lines: [line('50.00')] })).id;
    // Unapplied credit.
    await createCreditMemo(ctx, { customerId: ids.beta, date: d('2026-06-01'), lines: [line('10.00')] });
    // A/P: one bill 29 days past due.
    await createBill(ctx, { vendorId: ids.supplier, date: d('2026-05-02'), dueDate: d('2026-06-01'), lines: [{ accountId: code['6000'], amount: '300.00' }] });
  }, 120_000);

  const run = (key: string, p: Record<string, string> = {}) => runStandardReport(co.ctx, key, { asOf: AS_OF, ...p });

  it('A/R Aging Summary: QB columns, Customer:Job names, ties to A/R', async () => {
    const r = await run('ar-aging-summary');
    expect(r.columns.map((c) => c.header)).toEqual(['Customer', 'Current', '1 - 30', '31 - 60', '61 - 90', '> 90', 'TOTAL']);
    expect(row(r, 'Acme')!.cells).toMatchObject({ b0: '100.00', total: '100.00' });
    expect(row(r, 'Acme:Kitchen')!.cells).toMatchObject({ over: '120.00', total: '120.00' });
    expect(row(r, 'Beta')!.cells).toMatchObject({ current: '40.00', total: '40.00' });
    expect(grand(r).cells.total).toBe('260.00');
    const bal = await run('customer-balance-summary');
    expect(grand(bal).cells.balance).toBe('260.00');
    // QuickZoom: each amount opens the detail for that customer with the same options.
    expect(row(r, 'Acme:Kitchen')!.hrefs!.over).toMatch(/^\/reports\/std\/ar-aging-detail\?/);
    expect(row(r, 'Acme:Kitchen')!.hrefs!.over).toContain(`customerId=${ids.kitchen}`);
  });

  it('Interval / Through change the columns; aging from the transaction date moves items', async () => {
    const r = await run('ar-aging-summary', { interval: '15', through: '45' });
    expect(r.columns.map((c) => c.header)).toEqual(['Customer', 'Current', '1 - 15', '16 - 30', '31 - 45', '> 45', 'TOTAL']);
    expect(row(r, 'Acme')!.cells.b1).toBe('100.00');
    expect(row(r, 'Acme:Kitchen')!.cells.over).toBe('120.00');
    const t = await run('ar-aging-summary', { agingFrom: 'transaction_date' });
    // Invoice C is 10 days old: 1 - 30 from its date (still current by due date).
    expect(row(t, 'Beta')!.cells).toMatchObject({ current: '-10.00', b0: '50.00' });
    expect(t.subtitle).toContain('transaction date');
    // The Preferences > Reports setting is the default.
    await updateCompany(co.ctx, { settings: { agingFrom: 'transaction_date' } });
    try {
      const pref = await run('ar-aging-summary');
      expect(row(pref, 'Beta')!.cells.b0).toBe('50.00');
      const override = await run('ar-aging-summary', { agingFrom: 'due_date' });
      expect(row(override, 'Beta')!.cells.b0).toBe('0.00');
    } finally {
      await updateCompany(co.ctx, { settings: { agingFrom: 'due_date' } });
    }
  });

  it('customer filter includes the customer’s jobs; class filter keeps that class’s invoices', async () => {
    const r = await run('ar-aging-summary', { customerId: ids.acme });
    expect(r.rows.filter((x) => x.kind === 'data').map((x) => x.cells.label)).toEqual(['Acme', 'Acme:Kitchen']);
    expect(grand(r).cells.total).toBe('220.00');
    const c = await run('ar-aging-detail', { classId: ids.east });
    expect(grand(c).cells.open).toBe('100.00');
    expect(c.rows.filter((x) => x.kind === 'data')).toHaveLength(1);
  });

  it('A/R Aging Detail groups by aging column, shows aging days, and opens each transaction', async () => {
    const r = await run('ar-aging-detail');
    const sections = r.rows.filter((x) => x.kind === 'section').map((x) => x.cells.label);
    expect(sections).toEqual(['Current', '1 - 30 days past due', '> 90 days past due']);
    const a = r.rows.find((x) => x.kind === 'data' && x.cells.name === 'Acme')!;
    expect(a.cells).toMatchObject({ type: 'Invoice', aging: 30, open: '100.00', due: '2026-05-31' });
    expect(a.entryId).toBeTruthy();
    const credit = r.rows.find((x) => x.kind === 'data' && x.cells.type === 'Credit Memo')!;
    expect(credit.cells.open).toBe('-10.00');
    expect(credit.entryId).toBeTruthy();
    expect(grand(r).cells.open).toBe('260.00');
  });

  it('Open Invoices and the Collections Report', async () => {
    const o = await run('open-invoices');
    expect(grand(o).cells.open).toBe('260.00');
    expect(o.rows.filter((x) => x.kind === 'section').map((x) => x.cells.label)).toEqual(['Acme', 'Acme:Kitchen', 'Beta']);
    const c = await run('collections-report');
    expect(grand(c).cells.open).toBe('220.00');
    const heads = c.rows.filter((x) => x.kind === 'section').map((x) => String(x.cells.label));
    expect(heads[0]).toContain('555-0100');
    expect(heads).toHaveLength(2);
  });

  it('A/P Aging Summary / Detail with vendor filter', async () => {
    const s = await run('ap-aging-summary');
    expect(row(s, 'Supplier')!.cells).toMatchObject({ b0: '300.00', total: '300.00' });
    const none = await run('ap-aging-summary', { vendorId: ids.other });
    expect(grand(none).cells.total).toBe('0.00');
    const det = await run('ap-aging-detail', { vendorId: ids.supplier });
    const bill = det.rows.find((x) => x.kind === 'data')!;
    expect(bill.cells).toMatchObject({ type: 'Bill', aging: 29, open: '300.00' });
    expect(bill.entryId).toBeTruthy();
  });

  it('aging reports can be memorized with their options', async () => {
    const m = await saveMemorizedReport(co.ctx, { name: 'Aging 15', reportType: 'ar-aging-summary', config: { params: { asOf: AS_OF, interval: '15', through: '45' } } });
    const r = await runMemorizedReport(co.ctx, m.id);
    expect(r.columns.map((c) => c.header)).toContain('16 - 30');
  });

  it('rejects too many aging columns in plain language', async () => {
    await expect(run('ar-aging-summary', { interval: '1', through: '90' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
// Cash basis
// ---------------------------------------------------------------------------

describe('basis=cash on the sales reports and the default basis preference', () => {
  let co: Co;
  const ids: Record<string, string> = {};
  const R = { from: '2026-02-01', to: '2026-03-31' };

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    ids.acme = (await createCustomer(ctx, { displayName: 'Acme' })).id;
    ids.widget = (await createItem(ctx, { name: 'Widget', type: 'service', salesPrice: '100', incomeAccountId: code['4000'] } as never)).id;
    const inv = await createInvoice(ctx, { customerId: ids.acme, date: d('2026-02-01'), dueDate: d('2026-03-03'), lines: [{ itemId: ids.widget, quantity: 1, rate: '100.00', taxable: false }] });
    await receivePayment(ctx, { customerId: ids.acme, date: d('2026-03-10'), amount: '40.00', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '40.00' }] });
    await createSalesReceipt(ctx, { customerId: ids.acme, date: d('2026-03-05'), depositAccountId: code['1000'], lines: [{ itemId: ids.widget, quantity: 1, rate: '25.00', taxable: false }] });
  }, 120_000);

  const run = (key: string, p: Record<string, string> = {}) => runStandardReport(co.ctx, key, { ...R, ...p });

  it('Sales by Customer Summary: accrual counts the invoice, cash counts what was paid', async () => {
    const acc = await run('sales-by-customer-summary', { basis: 'accrual' });
    expect(row(acc, 'Acme')!.cells.amount).toBe('125.00');
    expect(acc.basis).toBe('accrual');
    const cash = await run('sales-by-customer-summary', { basis: 'cash' });
    expect(row(cash, 'Acme')!.cells.amount).toBe('65.00');
    expect(cash.subtitle).toContain('Cash Basis');
    // Ties to the cash-basis P&L income.
    const pl = await profitAndLossCashBasis(co.ctx, { from: d(R.from), to: new Date(`${R.to}T23:59:59.999Z`) });
    expect(pl.totalIncome).toBe('65.00');
  });

  it('Sales by Item Summary / Detail on a cash basis prorate the paid share (qty too)', async () => {
    const s = await run('sales-by-item-summary', { basis: 'cash' });
    expect(row(s, 'Widget')!.cells).toMatchObject({ amount: '65.00', qty: '1.4000' });
    const det = await run('sales-by-item-detail', { basis: 'cash' });
    const paid = det.rows.find((x) => x.kind === 'data' && x.cells.type === 'Payment')!;
    expect(paid.cells).toMatchObject({ date: '2026-03-10', amount: '40.00' });
    expect(paid.entryId).toBeTruthy();
    // Nothing of the invoice in February on a cash basis.
    const feb = await run('sales-by-item-summary', { basis: 'cash', from: '2026-02-01', to: '2026-02-28' });
    expect(grand(feb).cells.amount).toBe('0.00');
  });

  it('the Reports preference sets the default basis; an explicit basis and memorized reports win', async () => {
    const before = await run('profit-loss');
    expect(before.basis).toBe('accrual');
    await updateCompany(co.ctx, { settings: { reportBasis: 'cash' } });
    try {
      const pl = await run('profit-loss');
      expect(pl.basis).toBe('cash');
      expect(pl.subtitle).toContain('Cash Basis');
      expect((await run('sales-by-customer-summary')).basis).toBe('cash');
      expect((await run('profit-loss', { basis: 'accrual' })).basis).toBe('accrual');
      const m = await saveMemorizedReport(co.ctx, { name: 'Accrual P&L', reportType: 'profit-loss', config: { params: { ...R, basis: 'accrual' } } });
      expect((await runMemorizedReport(co.ctx, m.id)).basis).toBe('accrual');
      // Reports with only one basis are untouched.
      expect((await run('statement-of-cash-flows')).basis).toBeUndefined();
    } finally {
      await updateCompany(co.ctx, { settings: { reportBasis: 'accrual' } });
    }
  });

  it('General Ledger honours basis=cash (income counted when paid)', async () => {
    const acc = await run('general-ledger', { accountId: co.code['4000'], basis: 'accrual' });
    const cash = await run('general-ledger', { accountId: co.code['4000'], basis: 'cash' });
    const total = (r: StdReport) => r.rows.find((x) => x.kind === 'subtotal')!.cells.amount;
    expect(total(acc)).toBe('125.00');
    expect(total(cash)).toBe('65.00');
  });

  it('Statement of Cash Flows ends with the cash balance', async () => {
    const r = await run('statement-of-cash-flows');
    expect(row(r, 'Cash at end of period')!.cells.total).toBe('65.00');
    expect(row(r, 'Net Income')!.href).toContain('/reports/std/profit-loss');
    expect(r.balanced).toBe(true);
  });

  it('P&L by Job has a column per customer and ties to the P&L', async () => {
    const r = await run('profit-loss-by-job', { basis: 'accrual' });
    expect(r.columns.map((c) => c.header)).toContain('Acme');
    const pl = await run('profit-loss', { basis: 'accrual' });
    const net = (x: StdReport, col: string) => x.rows.find((y) => y.id === 'pl:net')!.cells[col];
    expect(net(r, 'total')).toBe(net(pl, 'total'));
  });
});

// ---------------------------------------------------------------------------
// Income tax, adjusting entries, other migrated reports
// ---------------------------------------------------------------------------

describe('income tax reports use form line names and form order', () => {
  it('Summary / Detail / Preparation', async () => {
    const co = await newCompany();
    const { ctx, code } = co;
    await setIncomeTaxForm(ctx, '1120S');
    await db.update(accounts).set({ taxLine: '1120S:1a' }).where(eq(accounts.id, code['4000']));
    await db.update(accounts).set({ taxLine: '1120S:11' }).where(eq(accounts.id, code['6000']));
    // A line of another form counts as unassigned for this company.
    await db.update(accounts).set({ taxLine: '1065:13' }).where(eq(accounts.id, code['6100']));
    await postJournalEntry(ctx, { date: d('2026-02-01'), description: 'Sale', lines: [{ accountId: code['1000'], debit: '500' }, { accountId: code['4000'], credit: '500' }] });
    await postJournalEntry(ctx, { date: d('2026-02-02'), description: 'Rent', lines: [{ accountId: code['6000'], debit: '120' }, { accountId: code['1000'], credit: '120' }] });
    await postJournalEntry(ctx, { date: d('2026-02-03'), description: 'Other', lines: [{ accountId: code['6100'], debit: '30' }, { accountId: code['1000'], credit: '30' }] });
    const s = await runStandardReport(ctx, 'income-tax-summary', { from: '2026-01-01', to: '2026-12-31' });
    const labels = s.rows.map((x) => String(x.cells.label));
    expect(labels.some((l) => /\d{4}S?:/.test(l))).toBe(false);
    expect(labels.indexOf('Gross receipts or sales')).toBeLessThan(labels.indexOf('Rents'));
    expect(row(s, 'Gross receipts or sales')!.cells.amount).toBe('500.00');
    expect(row(s, 'Rents')!.cells.amount).toBe('120.00');
    expect(row(s, 'Tax Line Unassigned (income/expense)')!.cells.amount).toBe('30.00');
    expect(labels.indexOf('Tax Line Unassigned (income/expense)')).toBeGreaterThan(labels.indexOf('Rents'));
    expect(s.subtitle).toContain('1120-S');
    const det = await runStandardReport(ctx, 'income-tax-detail', { from: '2026-01-01', to: '2026-12-31' });
    expect(det.rows.find((x) => x.cells.label === 'Total Rents')!.cells.amount).toBe('120.00');
    const prep = await runStandardReport(ctx, 'income-tax-preparation', {});
    const income = prep.rows.find((x) => x.id === `itp:${code['4000']}`)!;
    expect(income.cells.taxLine).toBe('Gross receipts or sales');
    expect(prep.rows.find((x) => x.id === `itp:${code['6100']}`)!.cells.taxLine).toBe('Tax Line Unassigned (income/expense)');
  });
});

describe('Adjusting Journal Entries, Balance Sheet Prev Year, purchases, sales tax', () => {
  it('Adjusting Journal Entries lists only adjusting entries', async () => {
    const co = await newCompany();
    const { ctx, code } = co;
    await postJournalEntry(ctx, { date: d('2026-03-01'), description: 'Regular', lines: [{ accountId: code['6000'], debit: '10' }, { accountId: code['1000'], credit: '10' }] });
    await postJournalEntry(ctx, { date: d('2026-03-31'), description: 'Accrue rent', isAdjusting: true, lines: [{ accountId: code['6000'], debit: '75' }, { accountId: code['1000'], credit: '75' }] });
    const r = await runStandardReport(ctx, 'adjusting-journal-entries', { from: '2026-01-01', to: '2026-12-31' });
    expect(r.title).toBe('Adjusting Journal Entries');
    const heads = r.rows.filter((x) => x.kind === 'section');
    expect(heads).toHaveLength(1);
    expect(heads[0].cells.memo).toBe('Accrue rent');
    expect(grand(r).cells).toMatchObject({ debit: '75.00', credit: '75.00' });
    expect(r.balanced).toBe(true);

    const bs = await runStandardReport(ctx, 'balance-sheet-prev-year', { asOf: '2026-12-31' });
    expect(bs.columns.map((c) => c.key)).toContain('prev');
    expect(bs.title).toBe('Balance Sheet Prev Year Comparison');

    const pv = await runStandardReport(ctx, 'purchases-by-vendor-summary', { from: '2026-01-01', to: '2026-12-31' });
    expect(grand(pv).cells.amount).toBe('0.00');
    const st = await runStandardReport(ctx, 'sales-tax-liability', { from: '2026-01-01', to: '2026-12-31' });
    expect(grand(st).cells.balance).toBe('0.00');
    expect(Money.of(String(grand(st).cells.collected)).isZero()).toBe(true);
  });
});
