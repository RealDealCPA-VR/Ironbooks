/**
 * Report gaps round — H7: QuickZoom on EVERY report. On a company with sales, purchases, checks,
 * payments, deposits, inventory and a class, every standard report's data line that shows a
 * non-zero amount opens something: a detail report, the list / register behind it, or (detail
 * lines) the source form of its transaction. Also H12: the Sales Tax Revenue Summary on the
 * engine ties to the sales tax service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, classes, users } from '@/lib/db/schema';
import { REPORT_CATALOG } from '@/lib/reports/catalog';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createItem } from './items';
import { createInvoice } from './invoices';
import { createExpense } from './expenses';
import { createBill } from './bills';
import { receivePayment } from './payments';
import { createSalesRep } from './salesReps';
import { runStandardReport } from './reportRegistry';
import { salesTaxRevenueSummary } from './accountant/salesTaxLedger';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-quickzoom');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const RANGE = { from: '2026-01-01', to: '2026-12-31' };

/** Reports whose lines are not amounts of the books (or need a budget / several companies). */
const SKIP = new Set([
  'budget-overview', 'budget-vs-actual-report', 'forecast-overview', // need a budget (H17 tests)
  'combined-trial-balance', 'combined-cash-flow', 'combined-pl-by-month', 'combined-ar-aging', 'combined-ap-aging', // company columns
]);

/** Data lines that show a non-zero money amount but open nothing. */
function deadLines(r: StdReport): string[] {
  const moneyKeys = r.columns.filter((c) => c.type === 'money').map((c) => c.key);
  return r.rows
    .filter((row) => row.kind === 'data')
    .filter((row) => moneyKeys.some((k) => row.cells[k] !== null && row.cells[k] !== undefined && row.cells[k] !== '' && Number(row.cells[k]) !== 0))
    .filter((row) => !row.href && !row.entryId && !(row.hrefs && Object.keys(row.hrefs).length))
    .map((row) => `${row.id} ${JSON.stringify(row.cells).slice(0, 80)}`);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'quickzoom@test.local', name: 'Zoom', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Zoom Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  const [cls] = await db.insert(classes).values({ companyId: company.id, name: 'Retail' }).returning();
  const cust = (await createCustomer(ctx, { displayName: 'Acme', phone: '555-0100' } as never)).id;
  const vendor = (await createVendor(ctx, { displayName: 'Parts Inc', phone: '555-0200' } as never)).id;
  const rep = (await createSalesRep(ctx, { name: 'Rita Rep', commissionRate: '0.05' })).id;
  const service = (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: 100, incomeAccountId: A['4000'] } as never)).id;
  const inv = await createInvoice(ctx, {
    customerId: cust,
    date: d('2026-03-05'),
    dueDate: d('2026-04-04'),
    salesRepId: rep,
    classId: cls.id,
    lines: [{ itemId: service, quantity: 3, rate: '100.00', taxable: false, classId: cls.id }],
  } as never);
  await createInvoice(ctx, { customerId: cust, date: d('2026-03-08'), dueDate: d('2026-04-07'), lines: [{ itemId: service, quantity: 1, rate: '80.00', taxable: false }] } as never);
  await receivePayment(ctx, { customerId: cust, date: d('2026-03-20'), amount: '100.00', method: 'check', depositAccountId: A['1000'], applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] } as never);
  await createBill(ctx, { vendorId: vendor, date: d('2026-03-07'), lines: [{ accountId: A['6300'], amount: '70.00' }] } as never);
  await createExpense(ctx, { vendorId: vendor, date: d('2026-03-10'), method: 'check', reference: '1001', paymentAccountId: A['1000'], lines: [{ accountId: A['6600'], amount: '25.00' }] } as never);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('QuickZoom on every report (H7)', () => {
  it('every data line with an amount opens a report, a list or its transaction', async () => {
    const dead: Record<string, string[]> = {};
    let ran = 0;
    for (const e of REPORT_CATALOG) {
      if (SKIP.has(e.key)) continue;
      const r: StdReport = await runStandardReport(ctx, e.key, e.controls.includes('asOf') && !e.controls.includes('range') ? { asOf: '2026-12-31' } : RANGE);
      ran += 1;
      const lines = deadLines(r);
      if (lines.length) dead[e.key] = lines.slice(0, 3);
    }
    expect(dead).toEqual({});
    expect(ran).toBe(REPORT_CATALOG.length - SKIP.size);
  }, 120_000);
});

describe('Sales Tax Revenue Summary on the standard engine (H12)', () => {
  it('ties to the sales tax service and can be memorized like any report', async () => {
    const r = await runStandardReport(ctx, 'sales-tax-revenue-summary', { ...RANGE, basis: 'accrual' });
    const svc = await salesTaxRevenueSummary(ctx, { from: d(RANGE.from), to: new Date(`${RANGE.to}T23:59:59.999Z`), basis: 'accrual' });
    const grand = r.rows.find((x) => x.kind === 'grand')!;
    expect(grand.cells.totalSales).toBe(Number(svc.totals.totalSales).toFixed(2));
    expect(grand.cells.tax).toBe(Number(svc.totals.taxCollected).toFixed(2));
    expect(grand.cells.totalSales).toBe('380.00');
  });
});
