/**
 * Wave-2 report package: catalog/registry, name-based ledger reports, sales/purchase detail,
 * open orders, list reports, income tax (mapper), jobs/time/mileage, budgets by Customer:Job and
 * balance-sheet budgets, combined (multi-company) reports, memorized groups + Process Multiple
 * Reports + scheduled exports, pivot, Advanced Find and graphs. Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  billLines,
  bills,
  billPayments,
  billPaymentApplications,
  companies,
  customers,
  estimateLines,
  estimates,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  jobs,
  mileageLogs,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  timeEntries,
  employees,
  userCompanies,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { balanceSheet, profitAndLoss } from './reports';
import { REPORT_CATALOG } from '@/lib/reports/catalog';
import { catalogKeysWithoutRunner, runStandardReport } from './reportRegistry';
import { incomeTaxReport, incomeTaxPreparation } from './reportsLists';
import { createBudget, setBudgetLine } from './budgets';
import {
  createMemorizedGroup,
  createReportSchedule,
  deleteMemorizedGroup,
  listMemorizedReports,
  nextRunAfter,
  processMultipleReports,
  runDueSchedules,
  runMemorizedReport,
  saveMemorizedReport,
  updateMemorizedReport,
} from './memorizedReports';
import { findTransactions, graphData, pivotReport } from './reportsAnalysis';
import { reportableCompanies } from './consolidation';
import type { StdReport } from '@/lib/reports/types';
import { fullAccess } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2');
const OUT_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2-exports');
let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext;
const A: Record<string, string> = {};
const ids: Record<string, string> = {};

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const row = (r: StdReport, label: string) => r.rows.find((x) => x.cells.label === label);
const run = (key: string, p: Record<string, string> = {}) => runStandardReport(ctx, key, p);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'w2@rep.test', name: 'Owner', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'Wave Two Co', ownerId: user.id }).returning();
  const [company2] = await db.insert(companies).values({ name: 'Sister Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
  ctx2 = { db, companyId: company2.id, userId: user.id };
  await db.insert(userCompanies).values([{ userId: user.id, companyId: company.id, role: 'owner' }, { userId: user.id, companyId: company2.id, role: 'owner' }]);

  const mk = async (c: ServiceContext, key: string, code: string, name: string, type: string, subtype: string) => {
    const r = await createAccount(c, { code, name, type: type as never, subtype });
    A[key] = r.id;
  };
  await mk(ctx, 'bank', '1000', 'Checking', 'asset', 'checking');
  await mk(ctx, 'ar', '1200', 'Accounts Receivable', 'asset', 'accounts_receivable');
  await mk(ctx, 'ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable');
  await mk(ctx, 'equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk(ctx, 'sales', '4000', 'Sales', 'revenue', 'sales');
  await mk(ctx, 'cogs', '5000', 'Job Materials', 'expense', 'cost_of_goods_sold');
  await mk(ctx, 'rent', '6000', 'Rent', 'expense', 'operating_expenses');
  await mk(ctx2, 'bank2', '1000', 'Checking', 'asset', 'checking');
  await mk(ctx2, 'equity2', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk(ctx2, 'sales2', '4000', 'Sales', 'revenue', 'sales');

  const c = company.id;
  const [cust] = await db.insert(customers).values({ companyId: c, displayName: 'Acme', phone: '555-1000', email: 'a@acme.test' }).returning();
  const [sub] = await db.insert(customers).values({ companyId: c, displayName: 'Kitchen', parentId: cust.id }).returning();
  const [cust2] = await db.insert(customers).values({ companyId: c, displayName: 'Beta LLC' }).returning();
  const [vend] = await db.insert(vendors).values({ companyId: c, displayName: 'Lumber Yard', phone: '555-2000' }).returning();
  const [item] = await db.insert(items).values({ companyId: c, name: 'Install', type: 'service', salesPrice: '100' }).returning();
  const [emp] = await db.insert(employees).values({ companyId: c, firstName: 'Pat', lastName: 'Lee' }).returning();
  const [job] = await db.insert(jobs).values({ companyId: c, customerId: cust.id, name: 'Remodel' }).returning();
  Object.assign(ids, { cust: cust.id, sub: sub.id, cust2: cust2.id, vend: vend.id, item: item.id, emp: emp.id, job: job.id });

  await postJournalEntry(ctx, { date: d('2026-01-02'), description: 'Capital', lines: [{ accountId: A.bank, debit: '5000' }, { accountId: A.equity, credit: '5000' }] });
  await postJournalEntry(ctx2, { date: d('2026-01-02'), description: 'Capital', lines: [{ accountId: A.bank2, debit: '700' }, { accountId: A.equity2, credit: '700' }] });
  await postJournalEntry(ctx2, { date: d('2026-02-02'), description: 'Sale', lines: [{ accountId: A.bank2, debit: '80' }, { accountId: A.sales2, credit: '80' }] });

  // Invoice 1 (job Remodel) and invoice 2 (sub-customer Kitchen).
  const [inv1] = await db.insert(invoices).values({ companyId: c, customerId: cust.id, jobId: job.id, invoiceNumber: 1, date: d('2026-02-01'), total: '300', balanceDue: '100', amountPaid: '200', status: 'partial' }).returning();
  await db.insert(invoiceLines).values({ invoiceId: inv1.id, itemId: item.id, jobId: job.id, quantity: '3', rate: '100', amount: '300' });
  await postJournalEntry(ctx, { date: d('2026-02-01'), description: 'Invoice 1', sourceRef: `invoice:${inv1.id}`, lines: [{ accountId: A.ar, debit: '300', controlLine: true }, { accountId: A.sales, credit: '300' }] });
  const [inv2] = await db.insert(invoices).values({ companyId: c, customerId: sub.id, invoiceNumber: 2, date: d('2026-02-10'), total: '150', balanceDue: '150' }).returning();
  await db.insert(invoiceLines).values({ invoiceId: inv2.id, itemId: item.id, quantity: '1.5', rate: '100', amount: '150' });
  await postJournalEntry(ctx, { date: d('2026-02-10'), description: 'Invoice 2', sourceRef: `invoice:${inv2.id}`, lines: [{ accountId: A.ar, debit: '150', controlLine: true }, { accountId: A.sales, credit: '150' }] });
  await postJournalEntry(ctx, { date: d('2026-03-01'), description: 'Payment', sourceRef: `customer:${cust.id}`, lines: [{ accountId: A.bank, debit: '200' }, { accountId: A.ar, credit: '200', controlLine: true }] });

  // Bill with a job-costed line, partly paid.
  const [bill] = await db.insert(bills).values({ companyId: c, vendorId: vend.id, billNumber: 'L-1', date: d('2026-02-05'), dueDate: d('2026-03-05'), total: '120', balanceDue: '70', amountPaid: '50', status: 'partial' }).returning();
  await db.insert(billLines).values({ billId: bill.id, accountId: A.cogs, jobId: job.id, customerId: cust.id, amount: '120', description: 'Cabinets' });
  await postJournalEntry(ctx, { date: d('2026-02-05'), description: 'Bill L-1', sourceRef: `bill:${bill.id}`, lines: [{ accountId: A.cogs, debit: '120' }, { accountId: A.ap, credit: '120', controlLine: true }] });
  const [bp] = await db.insert(billPayments).values({ companyId: c, vendorId: vend.id, date: d('2026-03-02'), amount: '50', reference: '1001' }).returning();
  await db.insert(billPaymentApplications).values({ billPaymentId: bp.id, billId: bill.id, amountApplied: '50' });
  await postJournalEntry(ctx, { date: d('2026-03-02'), description: 'Bill pmt', sourceRef: `vendor:${vend.id}`, lines: [{ accountId: A.ap, debit: '50', controlLine: true }, { accountId: A.bank, credit: '50' }] });

  // Direct expense (rent) to the vendor.
  const [exp] = await db.insert(expenses).values({ companyId: c, vendorId: vend.id, date: d('2026-03-03'), paymentAccountId: A.bank, total: '400', reference: '1002' }).returning();
  await db.insert(expenseLines).values({ expenseId: exp.id, accountId: A.rent, amount: '400' });
  await postJournalEntry(ctx, { date: d('2026-03-03'), description: 'Rent', sourceRef: `expense:${exp.id}`, lines: [{ accountId: A.rent, debit: '400' }, { accountId: A.bank, credit: '400' }] });

  // Open sales order / purchase order / estimate (non-posting).
  const [so] = await db.insert(salesOrders).values({ companyId: c, customerId: cust2.id, orderNumber: 7, date: d('2026-03-10'), total: '500' }).returning();
  await db.insert(salesOrderLines).values({ salesOrderId: so.id, itemId: item.id, quantity: '5', quantityInvoiced: '2', rate: '100', amount: '500' });
  const [po] = await db.insert(purchaseOrders).values({ companyId: c, vendorId: vend.id, poNumber: 9, date: d('2026-03-11'), total: '200' }).returning();
  await db.insert(purchaseOrderLines).values({ purchaseOrderId: po.id, itemId: item.id, quantity: '4', quantityBilled: '1', rate: '50', amount: '200' });
  const [est] = await db.insert(estimates).values({ companyId: c, customerId: cust.id, estimateNumber: 3, date: d('2026-01-15'), total: '400', status: 'accepted' }).returning();
  await db.insert(estimateLines).values({ estimateId: est.id, itemId: item.id, quantity: '4', rate: '100', amount: '400' });

  // Time and mileage.
  await db.insert(timeEntries).values([
    { companyId: c, employeeId: emp.id, customerId: cust.id, jobId: job.id, serviceItemId: item.id, date: d('2026-02-03'), hours: '6', billable: true, rate: '80' },
    { companyId: c, employeeId: emp.id, customerId: cust2.id, serviceItemId: item.id, date: d('2026-02-04'), hours: '2', billable: false },
  ]);
  await db.insert(mileageLogs).values([
    { companyId: c, customerId: cust.id, jobId: job.id, date: d('2026-02-03'), miles: '30', ratePerMile: '0.70', vehicle: 'Truck' },
    { companyId: c, customerId: cust2.id, date: d('2026-02-04'), miles: '10', ratePerMile: '0.70', vehicle: 'Van' },
  ]);
}, 180_000);

afterAll(async () => {
  await closeDb();
  for (const dir of [TEST_DIR, OUT_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold files briefly */
    }
  }
});

describe('catalog / registry', () => {
  it('every catalog report has a runner and runs without error', async () => {
    expect(catalogKeysWithoutRunner()).toEqual([]);
    const budget = await createBudget(ctx, { name: 'Smoke', fiscalYear: 2026 });
    for (const e of REPORT_CATALOG) {
      const p: Record<string, string> = { from: '2026-01-01', to: '2026-12-31' };
      if (e.controls.includes('budget')) p.budgetId = budget.id;
      if (e.controls.includes('asOf') && !e.controls.includes('range')) {
        delete p.from;
        p.asOf = '2026-12-31';
      }
      const r = await runStandardReport(ctx, e.key, p);
      expect(r.columns.length, e.key).toBeGreaterThan(0);
      expect(Array.isArray(r.rows), e.key).toBe(true);
    }
  }, 120_000);

  it('rejects unknown reports, bad params, and callers without the report area', async () => {
    await expect(run('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run('profit-loss', { from: '2026-13-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(run('profit-loss', { from: '2026-05-01', to: '2026-01-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const noSales = fullAccess();
    noSales.permissions.reports_sales = [];
    await expect(runStandardReport({ ...ctx, access: noSales }, 'customer-balance-summary', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runStandardReport({ ...ctx, access: noSales }, 'profit-loss', {})).resolves.toBeTruthy();
  });
});

describe('customer / vendor ledgers', () => {
  it('Customer Balance Summary ties to A/R on the balance sheet and nests jobs', async () => {
    const r = await run('customer-balance-summary', { asOf: '2026-12-31' });
    const bs = await balanceSheet(ctx, new Date('2026-12-31T23:59:59.999Z'));
    const ar = bs.assets.find((a) => a.accountId === A.ar)!;
    expect(row(r, 'TOTAL')!.cells.balance).toBe(ar.amount);
    expect(row(r, 'Acme')!.cells.balance).toBe('100.00');
    expect(row(r, 'Acme:Kitchen')!.cells.balance).toBe('150.00');
    expect(row(r, 'Acme')!.href).toContain('customer-balance-detail');
    const detail = await run('customer-balance-detail', { customerId: ids.cust });
    expect(detail.rows.filter((x) => x.entryId)).toHaveLength(2);
    expect(row(detail, 'Total Acme')!.cells.balance).toBe('100.00');
  });

  it('Vendor balances, Unpaid Bills Detail and Bills & Applied Payments', async () => {
    const v = await run('vendor-balance-summary', { asOf: '2026-12-31' });
    expect(row(v, 'Lumber Yard')!.cells.balance).toBe('70.00');
    const ub = await run('unpaid-bills-detail', { asOf: '2026-12-31' });
    expect(row(ub, 'TOTAL')!.cells.open).toBe('70.00');
    expect(ub.rows.find((x) => x.cells.type === 'Bill')!.entryId).toBeTruthy();
    const bap = await run('bills-applied-payments', { from: '2026-01-01', to: '2026-12-31' });
    expect(bap.rows.find((x) => x.cells.type === 'Bill Pmt')!.cells.amount).toBe('-50.00');
  });

  it('Expenses by Vendor totals equal P&L expenses', async () => {
    const r = await run('expenses-by-vendor-summary', { from: '2026-01-01', to: '2026-12-31' });
    expect(row(r, 'Lumber Yard')!.cells.amount).toBe('520.00');
    const pl = await profitAndLoss(ctx, { from: d('2026-01-01'), to: d('2026-12-31') });
    expect(row(r, 'TOTAL')!.cells.amount).toBe(pl.totalExpenses);
    const det = await run('expenses-by-vendor-detail', { from: '2026-01-01', to: '2026-12-31', vendorId: ids.vend });
    expect(det.rows.filter((x) => x.entryId)).toHaveLength(2);
  });
});

describe('sales & purchases detail, open orders, lists', () => {
  it('Sales by Customer / Item Detail', async () => {
    const c = await run('sales-by-customer-detail', { from: '2026-01-01', to: '2026-12-31' });
    expect(row(c, 'Total Acme')!.cells.amount).toBe('300.00');
    expect(row(c, 'Total Acme:Kitchen')!.cells.amount).toBe('150.00');
    const i = await run('sales-by-item-detail', { from: '2026-01-01', to: '2026-12-31' });
    expect(row(i, 'Total Install')!.cells.qty).toBe('4.5000');
    expect(i.rows.find((x) => x.cells.type === 'Invoice')!.entryId).toBeTruthy();
  });

  it('Open sales orders and purchase orders show only what is still open', async () => {
    const so = await run('open-sales-orders-by-customer');
    expect(row(so, 'Total Beta LLC')!.cells.open).toBe('300.00');
    const soi = await run('open-sales-orders-by-item');
    expect(row(soi, 'Install')).toBeTruthy();
    const po = await run('open-purchase-orders');
    expect(row(po, 'Total Lumber Yard')!.cells.open).toBe('150.00');
  });

  it('list reports', async () => {
    const cl = await run('customer-contact-list');
    expect(row(cl, 'Acme')!.cells.phone).toBe('555-1000');
    expect(row(cl, 'Acme')!.cells.balance).toBe('100.00');
    const vp = await run('vendor-phone-list');
    expect(row(vp, 'Lumber Yard')!.cells.phone).toBe('555-2000');
    const ip = await run('item-price-list');
    expect(row(ip, 'Install')!.cells.price).toBe('100.00');
    const il = await run('item-listing');
    expect(row(il, 'Install')!.cells.type).toBe('Service');
    const al = await run('account-listing', { asOf: '2026-12-31' });
    expect(al.rows.find((x) => x.cells.code === '1000')!.cells.balance).toBe('4750.00');
  });

  it('income tax reports group accounts by the mapped tax line', async () => {
    const mapper = (a: { section: string }) =>
      a.section === 'income' ? { id: 'l1', name: 'Gross receipts' } : a.section === 'expense' || a.section === 'cogs' ? { id: 'l2', name: 'Deductions' } : null;
    const s = await incomeTaxReport(ctx, { from: '2026-01-01', to: '2026-12-31' }, false, mapper as never);
    expect(row(s, 'Gross receipts')!.cells.amount).toBe('450.00');
    expect(row(s, 'Deductions')!.cells.amount).toBe('520.00');
    const prep = await incomeTaxPreparation(ctx, {}, mapper as never);
    expect(prep.rows.find((x) => x.cells.label === 'Sales')!.cells.taxLine).toBe('Gross receipts');
    const dflt = await incomeTaxPreparation(ctx, {});
    expect(dflt.rows.every((x) => String(x.cells.taxLine).startsWith('Tax Line Unassigned'))).toBe(true);
  });
});

describe('jobs, time & mileage', () => {
  it('Job Profitability Summary / Detail, estimates vs actuals, unbilled costs', async () => {
    const s = await run('job-profitability-summary');
    const remodel = row(s, 'Acme:Remodel')!;
    expect(remodel.cells).toMatchObject({ cost: '120.00', revenue: '300.00', diff: '180.00' });
    expect(row(s, 'Acme:Kitchen')!.cells.revenue).toBe('150.00');
    const det = await run('job-profitability-detail', { jobId: ids.job });
    expect(row(det, 'Total Acme:Remodel')!.cells.diff).toBe('180.00');
    const eva = await run('job-estimates-vs-actuals');
    expect(row(eva, 'Acme')!.cells).toMatchObject({ est: '400.00', rev: '300.00' });
    const ieva = await run('item-estimates-vs-actuals');
    expect(row(ieva, 'Install')!.cells).toMatchObject({ estQty: '4.0000', actQty: '4.5000' });
    const ub = await run('unbilled-costs-by-job');
    expect(row(ub, 'Total Acme:Remodel')!.cells.amount).toBe('600.00'); // 120 bill + 6h × 80
  });

  it('time and mileage reports', async () => {
    const tj = await run('time-by-job', { from: '2026-01-01', to: '2026-12-31' });
    expect(row(tj, 'Total Acme:Remodel')!.cells.hours).toBe('6.00');
    const tn = await run('time-by-name', { from: '2026-01-01', to: '2026-12-31', view: 'detail' });
    expect(row(tn, 'Total Pat Lee')!.cells.hours).toBe('8.00');
    const ti = await run('time-by-item', { from: '2026-01-01', to: '2026-12-31' });
    expect(row(ti, 'Total Install')!.cells.hours).toBe('8.00');
    const mv = await run('mileage-by-vehicle', { from: '2026-01-01', to: '2026-12-31' });
    expect(row(mv, 'Truck')!.cells).toMatchObject({ miles: '30.00', amount: '21.00' });
    const mj = await run('mileage-by-job', { from: '2026-01-01', to: '2026-12-31', view: 'detail' });
    expect(row(mj, 'Total Acme:Remodel')!.cells.miles).toBe('30.00');
  });
});

describe('budgets & forecasts', () => {
  it('budget by Customer:Job vs actual, overview, and no mixing', async () => {
    const b = await createBudget(ctx, { name: 'By customer', fiscalYear: 2026 });
    await setBudgetLine(ctx, { budgetId: b.id, accountId: A.sales, month: 2, amount: '250', customerId: ids.cust });
    await expect(setBudgetLine(ctx, { budgetId: b.id, accountId: A.sales, month: 3, amount: '1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const bva = await run('budget-vs-actual-report', { budgetId: b.id, customerId: ids.cust });
    const sales = row(bva, 'Sales')!;
    expect(sales.cells).toMatchObject({ total_act: '300.00', total_bud: '250.00', total_over: '50.00', total_pct: '120.00' });
    const ov = await run('budget-overview', { budgetId: b.id });
    expect(row(ov, 'Sales')!.cells.m2).toBe('250.00');
    expect(row(ov, 'Net Income')!.cells.total).toBe('250.00');
  });

  it('balance-sheet budgets and forecasts', async () => {
    const b = await createBudget(ctx, { name: 'Cash plan', fiscalYear: 2026, kind: 'balance_sheet' });
    await expect(setBudgetLine(ctx, { budgetId: b.id, accountId: A.sales, month: 1, amount: '1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await setBudgetLine(ctx, { budgetId: b.id, accountId: A.bank, month: 12, amount: '4000' });
    const bva = await run('budget-vs-actual-report', { budgetId: b.id });
    expect(row(bva, 'Checking')!.cells).toMatchObject({ total_act: '4750.00', total_bud: '4000.00' });
    const f = await createBudget(ctx, { name: 'Forecast', fiscalYear: 2026, isForecast: true });
    await setBudgetLine(ctx, { budgetId: f.id, accountId: A.rent, month: 1, amount: '100' });
    const fo = await run('forecast-overview', { budgetId: f.id });
    expect(fo.title).toBe('Forecast Overview');
    expect(row(fo, 'Rent')!.cells.m1).toBe('100.00');
  });
});

describe('combined reports', () => {
  it('trial balance, P&L by month, cash flow and aging across companies', async () => {
    const tb = await run('combined-trial-balance', { asOf: '2026-12-31' });
    expect(tb.balanced).toBe(true);
    const checking = row(tb, 'Checking')!;
    expect(checking.cells.total_dr).toBe('5530.00'); // 4750 + 780
    const pl = await run('combined-pl-by-month', { from: '2026-01-01', to: '2026-03-31' });
    expect(row(pl, 'Sales')!.cells.total).toBe('530.00');
    const cf = await run('combined-cash-flow', { from: '2026-01-01', to: '2026-12-31' });
    expect(row(cf, 'Net cash increase for period')!.cells.total).toBe('5530.00');
    const ag = await run('combined-ar-aging', { asOf: '2026-12-31' });
    expect(row(ag, 'TOTAL')).toBeTruthy();
  });

  it('only combines companies the user may report on', async () => {
    const all = await reportableCompanies(ctx);
    expect(all).toHaveLength(2);
    const outsider = { ...ctx, userId: '00000000-0000-0000-0000-000000000001', access: fullAccess() };
    const mine = await reportableCompanies(outsider);
    expect(mine.map((c) => c.id)).toEqual([ctx.companyId]);
    void ctx2;
  });
});

describe('memorized reports, groups, Process Multiple Reports, schedules', () => {
  it('memorize, rename, replace settings, group and process', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'Month end' });
    const pl = await saveMemorizedReport(ctx, {
      name: 'Q1 P&L',
      reportType: 'profit-loss',
      config: { params: { from: '2026-01-01', to: '2026-03-31' }, display: { numberFormat: { negative: 'parens' } } },
      groupId: g.id,
    });
    const bs = await saveMemorizedReport(ctx, { name: 'BS', reportType: 'balance-sheet', config: { params: { asOf: '2026-03-31' } }, groupId: g.id });
    await expect(saveMemorizedReport(ctx, { name: 'x', reportType: 'bogus', config: {} })).rejects.toMatchObject({ code: 'VALIDATION' });
    const r1 = await runMemorizedReport(ctx, pl.id);
    expect(r1.title).toBe('Q1 P&L');
    expect(row(r1, 'Net Income')!.cells.total).toBe('-70.00');
    await updateMemorizedReport(ctx, pl.id, { name: 'Feb P&L', config: { params: { from: '2026-02-01', to: '2026-02-28' } } });
    const r2 = await runMemorizedReport(ctx, pl.id);
    expect(r2.title).toBe('Feb P&L');
    expect(row(r2, 'Net Income')!.cells.total).toBe('330.00');
    const processed = await processMultipleReports(ctx, { groupId: g.id });
    expect(processed.map((x) => x.name)).toEqual(['BS', 'Feb P&L']);
    expect(processed.every((x) => x.report && !x.error)).toBe(true);
    // A report the caller cannot run is reported, not fatal.
    const noFin = fullAccess();
    noFin.permissions.reports_financial = [];
    const limited = await processMultipleReports({ ...ctx, access: noFin }, { ids: [pl.id, bs.id] });
    expect(limited.every((x) => x.error)).toBe(true);
    // Deleting the group keeps its reports.
    await deleteMemorizedGroup(ctx, g.id);
    const left = await listMemorizedReports(ctx);
    expect(left.filter((x) => x.id === pl.id || x.id === bs.id).every((x) => x.groupId === null)).toBe(true);
  });

  it('runs due schedules into the export folder and advances the next run', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Trial Balance', reportType: 'trial-balance', config: { params: { asOf: '2026-12-31' } } });
    const s = await createReportSchedule(ctx, { name: 'Nightly TB', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-04-01', folder: 'Nightly' });
    const now = new Date('2026-04-03T12:00:00.000Z');
    const res = await runDueSchedules(ctx, { now, outDir: OUT_DIR });
    const mine = res.find((x) => x.scheduleId === s.id)!;
    expect(mine.status).toBe('ok');
    expect(mine.files).toHaveLength(1);
    const csv = fs.readFileSync(mine.files[0], 'utf8');
    expect(csv).toContain('Trial Balance');
    expect(path.dirname(mine.files[0])).toBe(path.join(OUT_DIR, 'Nightly'));
    // Not due again until after `now`.
    const again = await runDueSchedules(ctx, { now, outDir: OUT_DIR });
    expect(again.find((x) => x.scheduleId === s.id)).toBeUndefined();
    expect(nextRunAfter(new Date('2026-01-31T06:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T06:00:00.000Z');
  });
});

describe('pivot, find, graphs', () => {
  it('pivots ledger lines by account × month and item sales by customer × item', async () => {
    const p = await pivotReport(ctx, { rows: 'account', cols: 'month', measure: 'amount', source: 'gl', from: '2026-01-01', to: '2026-03-31', section: 'income,expense,cogs' });
    expect(row(p, 'Sales')!.cells.total).toBe('450.00');
    expect(p.columns.map((c) => c.header)).toEqual(['Account', '2026-02', '2026-03', 'TOTAL']);
    const s = await pivotReport(ctx, { rows: 'customer', cols: 'item', measure: 'quantity', source: 'sales', from: '2026-01-01', to: '2026-12-31' });
    expect(row(s, 'TOTAL')!.cells.total).toBe('4.5');
    await expect(pivotReport(ctx, { rows: 'item', measure: 'amount', source: 'gl' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('Advanced Find filters by type, name, amount and number', async () => {
    const byType = await findTransactions(ctx, { txnType: 'invoice' });
    expect(byType.rows.filter((x) => x.entryId)).toHaveLength(2);
    const byName = await findTransactions(ctx, { vendorId: ids.vend });
    expect(byName.rows.filter((x) => x.entryId)).toHaveLength(3);
    const byAmt = await findTransactions(ctx, { amountMin: '150', amountMax: '300' });
    expect(byAmt.rows.filter((x) => x.entryId).map((x) => x.cells.amount).sort()).toEqual(['150.00', '200.00', '300.00']);
    const byNum = await findTransactions(ctx, { number: 'L-1' });
    expect(byNum.rows.filter((x) => x.entryId)).toHaveLength(1);
  });

  it('graph series', async () => {
    const ie = await graphData(ctx, 'income-expense', { from: '2026-01-01', to: '2026-03-31' });
    expect(ie.labels).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026']);
    expect(ie.series[0].values).toEqual([0, 450, 0]);
    expect(ie.series[1].values).toEqual([0, 120, 400]);
    const nw = await graphData(ctx, 'net-worth', { from: '2026-01-01', to: '2026-03-31' });
    expect(nw.series[2].values[2]).toBe(5000 - 70 + 450 - 520 + 70);
    const ar = await graphData(ctx, 'ar', { asOf: '2026-12-31' });
    expect(ar.series[0].values.reduce((a, b) => a + b, 0)).toBe(250);
    const sales = await graphData(ctx, 'sales', { from: '2026-01-01', to: '2026-03-31' });
    expect(sales.breakdown?.[0].value).toBe(300);
  });
});

describe('relative dates, purchases detail, filter options', () => {
  it('resolves QB relative date ranges (fiscal-year aware)', async () => {
    const { resolveDateMacro } = await import('./reportEngine');
    const now = new Date('2026-05-15T12:00:00Z');
    expect(resolveDateMacro('this_month', now)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(resolveDateMacro('last_month', now)).toEqual({ from: '2026-04-01', to: '2026-04-30' });
    expect(resolveDateMacro('last_quarter', now)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(resolveDateMacro('this_fiscal_year', now, '06-30')).toEqual({ from: '2025-07-01', to: '2026-06-30' });
    expect(resolveDateMacro('last_fiscal_year', now, '06-30')).toEqual({ from: '2024-07-01', to: '2025-06-30' });
    // A memorized report with relative dates runs for the period at run time.
    const r = await runStandardReport(ctx, 'profit-loss', { dates: 'last_month' }, { now: new Date('2026-03-10T12:00:00Z') });
    expect(r.subtitle).toContain('02/01/2026');
    expect(row(r, 'Total Income')!.cells.total).toBe('450.00');
  });

  it('Purchases by Item Detail', async () => {
    const [b] = await db
      .insert(bills)
      .values({ companyId: ctx.companyId, vendorId: ids.vend, billNumber: 'L-2', date: d('2026-04-01'), total: '75', balanceDue: '75' })
      .returning();
    await db.insert(billLines).values({ billId: b.id, accountId: A.cogs, itemId: ids.item, quantity: '3', amount: '75' });
    const r = await run('purchases-by-item-detail', { from: '2026-01-01', to: '2026-12-31' });
    expect(row(r, 'Total Install')!.cells).toMatchObject({ qty: '3.0000', amount: '75.00' });
  });

  it('filter options list names and require some report access', async () => {
    const { reportFilterOptions } = await import('./reportsAnalysis');
    const o = await reportFilterOptions(ctx);
    expect(o.customers.map((c) => c.name)).toContain('Acme:Kitchen');
    expect(o.vehicles).toEqual(['Truck', 'Van']);
    const none = fullAccess();
    for (const k of Object.keys(none.permissions) as (keyof typeof none.permissions)[]) none.permissions[k] = [];
    await expect(reportFilterOptions({ ...ctx, access: none })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
