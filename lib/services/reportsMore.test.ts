/**
 * Report gaps round — the legacy-page reports and the missing QuickBooks reports on the standard
 * engine (reportsMore.ts): they run through runStandardReport (so they can be memorized, grouped,
 * scheduled and formatted), tie to the services the legacy pages used, and QuickZoom.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, companies, employees, items, users } from '@/lib/db/schema';
import { CATALOG_BY_KEY, REPORT_CATALOG, relatedReports } from '@/lib/reports/catalog';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createItem } from './items';
import { createInvoice } from './invoices';
import { createExpense, voidExpense } from './expenses';
import { createBill } from './bills';
import { createSalesRep } from './salesReps';
import { createEmployee } from './payroll';
import { catalogKeysWithoutRunner, runStandardReport } from './reportRegistry';
import { checkDetail, missingChecks } from './reportsExtra';
import { saveMemorizedReport, processMultipleReports } from './memorizedReports';
import { forecastPeriods } from './reportsMore';
import { normalizeGrant, type EffectiveAccess } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-more');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const S: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const data = (r: StdReport) => r.rows.filter((x) => x.kind === 'data');
const grand = (r: StdReport) => r.rows.find((x) => x.kind === 'grand')!;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'more@test.local', name: 'More', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'More Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  S.cust = (await createCustomer(ctx, { displayName: 'Acme' } as never)).id;
  S.vendor = (await createVendor(ctx, { displayName: 'Parts Inc' } as never)).id;
  S.rep = (await createSalesRep(ctx, { name: 'Rita Rep', commissionRate: '0.05' })).id;
  S.service = (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: 100, incomeAccountId: A['4000'] } as never)).id;
  S.widget = (await createItem(ctx, { name: 'Widget', type: 'inventory', salesPrice: 50, purchaseCost: 20, incomeAccountId: A['4000'], expenseAccountId: A['5000'], assetAccountId: A['1300'], reorderPoint: 10, preferredVendorId: S.vendor } as never)).id;
  // Two invoices: one with a rep, one without.
  await createInvoice(ctx, { customerId: S.cust, date: d('2026-03-05'), dueDate: d('2026-04-04'), salesRepId: S.rep, lines: [{ itemId: S.service, quantity: 2, rate: '100.00', taxable: false }] } as never);
  await createInvoice(ctx, { customerId: S.cust, date: d('2026-03-06'), dueDate: d('2026-04-05'), lines: [{ itemId: S.service, quantity: 1, rate: '100.00', taxable: false }] } as never);
  // Checks 1001, 1002, 1005 (1003-1004 missing); 1002 voided.
  for (const [num, amt] of [['1001', '10.00'], ['1002', '20.00'], ['1005', '30.00']] as const) {
    const e = await createExpense(ctx, { vendorId: S.vendor, date: d('2026-03-10'), method: 'check', reference: num, paymentAccountId: A['1000'], lines: [{ accountId: A['6000'], amount: amt }] } as never);
    if (num === '1002') await voidExpense(ctx, e.id);
  }
  S.emp = (await createEmployee(ctx, { firstName: 'Eve', lastName: 'Ewing', payType: 'hourly', payRate: 20 } as never)).id;
  await db.update(employees).set({ ssn: '123-45-6789', phone: '555-0100' }).where(eq(employees.id, S.emp));
  await db.update(items).set({ reorderPoint: '10', preferredVendorId: S.vendor }).where(eq(items.id, S.widget));
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('catalog', () => {
  it('every catalog report has a runner, including the reports that only had legacy pages', () => {
    expect(catalogKeysWithoutRunner()).toEqual([]);
    for (const k of [
      'sales-by-rep-summary', 'sales-by-rep-detail', 'check-detail', 'deposit-detail', 'missing-checks',
      'inventory-valuation-summary', 'inventory-valuation-detail', 'quantity-on-hand-by-site', 'payroll-summary',
      'voided-deleted-summary', 'voided-deleted-detail', 'closing-date-exceptions', 'sales-tax-revenue-summary',
      'cash-flow-forecast', 'inventory-stock-status-by-item', 'inventory-stock-status-by-vendor',
      'physical-inventory-worksheet', 'employee-contact-list',
    ]) {
      expect(CATALOG_BY_KEY[k], k).toBeDefined();
      expect(CATALOG_BY_KEY[k].hidden, k).toBeFalsy();
    }
    expect(relatedReports('payroll-summary').map((r) => r.key)).toContain('payroll-liability-balances');
  });

  it('every catalog report runs with no options', async () => {
    for (const e of REPORT_CATALOG) {
      if (!['Inventory', 'Employees & Payroll', 'Banking'].includes(e.group) && !e.key.startsWith('sales-by-rep') && !['cash-flow-forecast', 'voided-deleted-summary', 'voided-deleted-detail', 'closing-date-exceptions', 'sales-tax-revenue-summary', 'employee-contact-list'].includes(e.key)) continue;
      const r = await runStandardReport(ctx, e.key, {});
      expect(Array.isArray(r.rows), e.key).toBe(true);
      expect(r.key, e.key).toBe(e.key);
    }
  }, 60_000);
});

describe('Sales by Rep', () => {
  it('summary: sales and commission per rep, the rest under "No sales rep"; it ties to Sales by Customer', async () => {
    const r = await runStandardReport(ctx, 'sales-by-rep-summary', { from: '2026-03-01', to: '2026-03-31', basis: 'accrual' });
    expect(data(r).map((x) => [x.cells.label, x.cells.sales, x.cells.rate, x.cells.commission])).toEqual([
      ['Rita Rep', '200.00', '5.00', '10.00'],
      ['No sales rep', '100.00', null, null],
    ]);
    expect(grand(r).cells.sales).toBe('300.00');
    const byCust = await runStandardReport(ctx, 'sales-by-customer-summary', { from: '2026-03-01', to: '2026-03-31', basis: 'accrual' });
    expect(JSON.stringify(byCust.rows)).toContain('300.00');
    // QuickZoom: the rep's row opens the detail for that rep, which adds up to the same amount.
    const href = data(r)[0].href!;
    const q = Object.fromEntries(new URL(`http://x${href}`).searchParams);
    expect(q.repId).toBe(S.rep);
    const detail = await runStandardReport(ctx, 'sales-by-rep-detail', q);
    expect(grand(detail).cells.amount).toBe('200.00');
    expect(data(detail).every((x) => !!x.entryId)).toBe(true);
    const none = await runStandardReport(ctx, 'sales-by-rep-detail', { ...q, repId: 'none' });
    expect(grand(none).cells.amount).toBe('100.00');
  });
});

describe('Banking reports', () => {
  it('Check Detail lists every check with its split, a voided check at zero, total = the service total', async () => {
    const r = await runStandardReport(ctx, 'check-detail', { from: '2026-03-01', to: '2026-03-31' });
    const heads = r.rows.filter((x) => x.kind === 'section');
    expect(heads.map((h) => [h.cells.num, h.cells.amount, h.cells.memo])).toEqual([
      ['1001', '10.00', ''],
      ['1002', '0.00', 'VOID'],
      ['1005', '30.00', ''],
    ]);
    expect(heads.every((h) => !!h.entryId)).toBe(true);
    const svc = await checkDetail(ctx, { from: d('2026-03-01'), to: new Date('2026-03-31T23:59:59.999Z') });
    expect(grand(r).cells.amount).toBe(svc.total);
    expect(svc.total).toBe('40.00');
    // Account filter.
    const other = await runStandardReport(ctx, 'check-detail', { from: '2026-03-01', to: '2026-03-31', accountId: A['1300'] });
    expect(other.rows.filter((x) => x.kind === 'section')).toEqual([]);
  });

  it('Missing Checks shows the gap 1003-1004 (a voided check uses its number)', async () => {
    const r = await runStandardReport(ctx, 'missing-checks', {});
    const missing = r.rows.filter((x) => String(x.cells.label).startsWith('*** Missing'));
    expect(missing.map((m) => [m.cells.first, m.cells.last, m.cells.count])).toEqual([[1003, 1004, 2]]);
    expect(grand(r).cells.count).toBe((await missingChecks(ctx)).accounts.reduce((s, a) => s + a.missingCount, 0));
  });
});

describe('Inventory reports', () => {
  it('stock status by item / by vendor and the physical inventory worksheet list the item', async () => {
    const byItem = await runStandardReport(ctx, 'inventory-stock-status-by-item', { from: '2026-01-01', to: '2026-12-31' });
    const w = data(byItem).find((x) => x.cells.label === 'Widget')!;
    expect(w.cells.vendor).toBe('Parts Inc');
    expect(w.cells.reorder).toBe('10.0000');
    expect(w.cells.order).toBe('✓'); // nothing on hand, below the reorder point
    const byVendor = await runStandardReport(ctx, 'inventory-stock-status-by-vendor', { from: '2026-01-01', to: '2026-12-31' });
    expect(byVendor.rows.find((x) => x.kind === 'section')?.cells.label).toBe('Parts Inc');
    const piw = await runStandardReport(ctx, 'physical-inventory-worksheet', {});
    expect(data(piw).map((x) => [x.cells.label, x.cells.count])).toEqual([['Widget', '______']]);
  });

  it('inventory reports are refused while inventory is turned off in Preferences', async () => {
    const [c] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
    await db.update(companies).set({ settings: { ...(c.settings ?? {}), inventoryEnabled: false } }).where(eq(companies.id, ctx.companyId));
    try {
      await expect(runStandardReport(ctx, 'inventory-valuation-summary', {})).rejects.toThrow(/turned off/);
    } finally {
      await db.update(companies).set({ settings: c.settings }).where(eq(companies.id, ctx.companyId));
    }
  });
});

describe('Lists and payroll', () => {
  it('Employee Contact List shows only the last four digits of the SS No. to a user without sensitive payroll access', async () => {
    const trusted = await runStandardReport(ctx, 'employee-contact-list', {});
    expect(data(trusted)[0].cells.ssn).toBe('123-45-6789');
    const access: EffectiveAccess = {
      roleKeys: ['custom'],
      permissions: normalizeGrant({ reports_payroll: ['view'] }),
      flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
      isAdmin: false,
    };
    const limited = await runStandardReport({ ...ctx, access }, 'employee-contact-list', {});
    expect(data(limited)[0].cells.ssn).toBe('***-**-6789');
    // Without payroll report access the list is refused.
    const noPayroll = { ...access, permissions: normalizeGrant({ reports_sales: ['view'] }) };
    await expect(runStandardReport({ ...ctx, access: noPayroll }, 'employee-contact-list', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('Cash Flow Forecast', () => {
  it('weeks run Sunday to Saturday; months are calendar months', () => {
    const w = forecastPeriods(d('2026-03-04'), new Date('2026-03-21T23:59:59.999Z'), 'week');
    expect(w.map((p) => [p.from.toISOString().slice(0, 10), p.to.toISOString().slice(0, 10)])).toEqual([
      ['2026-03-04', '2026-03-07'],
      ['2026-03-08', '2026-03-14'],
      ['2026-03-15', '2026-03-21'],
    ]);
    const m = forecastPeriods(d('2026-03-15'), new Date('2026-05-10T23:59:59.999Z'), 'month');
    expect(m.map((p) => p.to.toISOString().slice(0, 10))).toEqual(['2026-03-31', '2026-04-30', '2026-05-10']);
  });

  it('expects open invoices and bills on their due dates; the projected balance adds up', async () => {
    await createBill(ctx, { vendorId: S.vendor, billNumber: 'FB-1', date: d('2026-03-01'), dueDate: d('2026-04-15'), lines: [{ accountId: A['6000'], amount: '75.00' }] } as never);
    const r = await runStandardReport(ctx, 'cash-flow-forecast', { from: '2026-04-01', to: '2026-04-30', period: 'month' });
    const april = data(r)[0];
    expect(april.cells.ar).toBe('300.00'); // both invoices are due in April
    expect(april.cells.ap).toBe('-75.00');
    const begin = r.rows.find((x) => x.id === 'cff:begin')!;
    const bankStart = Number(begin.cells.bank);
    expect(Number(begin.cells.proj)).toBeCloseTo(bankStart, 2);
    expect(Number(april.cells.proj)).toBeCloseTo(bankStart + 300 - 75 + Number(april.cells.bank), 2);
    expect(grand(r).cells.proj).toBe(april.cells.proj);
  });
});

describe('memorize and Process Multiple Reports', () => {
  it('the former legacy-page reports can be memorized and processed with a group', async () => {
    const ids: string[] = [];
    for (const k of ['check-detail', 'missing-checks', 'sales-by-rep-summary', 'sales-tax-revenue-summary', 'voided-deleted-summary', 'closing-date-exceptions', 'inventory-valuation-summary', 'payroll-summary', 'quantity-on-hand-by-site']) {
      ids.push((await saveMemorizedReport(ctx, { name: `Mem ${k}`, reportType: k, config: { params: { from: '2026-03-01', to: '2026-03-31' } } })).id);
    }
    const out = await processMultipleReports(ctx, { ids });
    expect(out.filter((o) => o.error)).toEqual([]);
    expect(out.map((o) => o.report?.title).sort()).toEqual(ids.map((_, i) => `Mem ${['check-detail', 'missing-checks', 'sales-by-rep-summary', 'sales-tax-revenue-summary', 'voided-deleted-summary', 'closing-date-exceptions', 'inventory-valuation-summary', 'payroll-summary', 'quantity-on-hand-by-site'][i]}`).sort());
  });
});
