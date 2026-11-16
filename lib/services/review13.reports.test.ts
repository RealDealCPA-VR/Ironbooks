/**
 * Review 13 — report fixes checked against QuickBooks Desktop:
 *  1. The Customer:Job filter on a customer takes in its jobs (any depth) on every report, like
 *     the A/R aging; a job is just that job; flat per-job summary rows open that job alone.
 *  2. Sales Tax Revenue Summary: the invoice header discount reduces Total Sales (a negative
 *     non-taxable sale — the tax was charged on the full taxable lines).
 *  3. Transaction Detail by Account for an income / expense account leaves out the year-end
 *     closing entry (the P&L / Trial Balance QuickZoom of a closed year).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createTaxRate } from './salesTax';
import { postJournalEntry } from './posting';
import { yearEndClose } from './fiscalClose';
import { runStandardReport } from './reportRegistry';
import { salesTaxRevenueSummary } from './accountant/salesTaxLedger';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review13-reports');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const S: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const range = { from: '2026-03-01', to: '2026-03-31' };

const cents = (v: unknown) => Math.round(Number(String(v ?? '0').replace(/,/g, '')) * 100);
/** Sum of the transaction lines' amounts of a detail report. */
const sumLines = (r: StdReport, key = 'amount') =>
  r.rows.filter((x) => x.kind === 'data' && x.entryId).reduce((s, x) => s + cents(x.cells[key]), 0) / 100;
const plRow = (r: StdReport, code: string) => r.rows.find((x) => x.kind === 'data' && x.id.endsWith(`:a:${A[code]}`));
/** Run the report a QuickZoom href points at. */
async function follow(href: string): Promise<StdReport> {
  const u = new URL(href, 'http://x');
  const key = u.pathname.split('/').pop()!;
  return runStandardReport(ctx, key, Object.fromEntries(u.searchParams.entries()));
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'review13@test.local', name: 'R13', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review 13 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  S.smith = (await createCustomer(ctx, { displayName: 'Smith' } as never)).id;
  S.kitchen = (await createCustomer(ctx, { displayName: 'Kitchen', parentId: S.smith } as never)).id;
  S.bath = (await createCustomer(ctx, { displayName: 'Bath', parentId: S.smith } as never)).id;
  S.tile = (await createCustomer(ctx, { displayName: 'Tile', parentId: S.bath } as never)).id;
  S.other = (await createCustomer(ctx, { displayName: 'Other Co' } as never)).id;
  S.vendor = (await createVendor(ctx, { displayName: 'Lumber Yard' } as never)).id;
  const inv = (customerId: string, date: string, amount: string) =>
    createInvoice(ctx, { customerId, date: d(date), dueDate: d('2026-04-30'), lines: [{ description: 'Work', quantity: 1, rate: amount, taxable: false }] } as never);
  await inv(S.kitchen, '2026-03-05', '5000.00');
  await inv(S.bath, '2026-03-06', '6000.00');
  await inv(S.tile, '2026-03-07', '1000.00'); // a sub-job of a job
  await inv(S.smith, '2026-03-08', '300.00'); // the customer's own
  await inv(S.other, '2026-03-09', '100.00');
  // A bill line job-costed to Kitchen.
  await createBill(ctx, { vendorId: S.vendor, date: d('2026-03-10'), lines: [{ accountId: A['6300'], amount: '400.00', customerId: S.kitchen }] } as never);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('1. Customer:Job filter takes in the customer’s jobs', () => {
  it('Customer Balance Detail: the customer and all its jobs (= A/R aging); a job alone', async () => {
    expect(sumLines(await runStandardReport(ctx, 'customer-balance-detail', { customerId: S.smith, to: '2026-03-31' }))).toBe(12300);
    expect(sumLines(await runStandardReport(ctx, 'customer-balance-detail', { customerId: S.bath, to: '2026-03-31' }))).toBe(7000);
    expect(sumLines(await runStandardReport(ctx, 'customer-balance-detail', { customerId: S.kitchen, to: '2026-03-31' }))).toBe(5000);
  });

  it('General Ledger and Transaction Detail by Account', async () => {
    const tda = await runStandardReport(ctx, 'transaction-detail-by-account', { ...range, customerId: S.smith, accountId: A['1200'] });
    expect(sumLines(tda)).toBe(12300);
    const gl = await runStandardReport(ctx, 'general-ledger', { ...range, customerId: S.smith, accountId: A['4000'] });
    expect(sumLines(gl)).toBe(12300);
  });

  it('Profit & Loss filtered by the customer: its jobs’ income and job costs; QuickZoom ties', async () => {
    const r = await runStandardReport(ctx, 'profit-loss', { ...range, customerId: S.smith });
    expect(plRow(r, '4000')?.cells.total).toBe('12300.00');
    expect(plRow(r, '6300')?.cells.total).toBe('400.00');
    expect(sumLines(await follow(plRow(r, '4000')!.href!))).toBe(12300);
    expect(sumLines(await follow(plRow(r, '6300')!.href!))).toBe(400);
    // A job alone.
    const k = await runStandardReport(ctx, 'profit-loss', { ...range, customerId: S.kitchen });
    expect(plRow(k, '4000')?.cells.total).toBe('5000.00');
    expect(plRow(k, '6300')?.cells.total).toBe('400.00');
  });

  it('Sales by Customer Summary / Detail', async () => {
    const sum = await runStandardReport(ctx, 'sales-by-customer-summary', { ...range, customerId: S.smith });
    expect(sum.rows.find((x) => x.id === 'sbc:grand')?.cells.amount).toBe('12300.00');
    const det = await runStandardReport(ctx, 'sales-by-customer-detail', { ...range, customerId: S.smith });
    expect(det.rows.filter((x) => x.id.startsWith('sd:l:')).reduce((s, x) => s + cents(x.cells.amount), 0) / 100).toBe(12300);
    const job = await runStandardReport(ctx, 'sales-by-customer-summary', { ...range, customerId: S.kitchen });
    expect(job.rows.find((x) => x.id === 'sbc:grand')?.cells.amount).toBe('5000.00');
  });

  it('flat per-job rows (summaries, P&L by Job) open that customer:job alone', async () => {
    // Sales by Customer Summary: the "Smith" row is Smith's own 300.
    const sum = await runStandardReport(ctx, 'sales-by-customer-summary', range);
    const own = sum.rows.find((x) => x.id === `sbc:${S.smith}`)!;
    expect(own.cells.amount).toBe('300.00');
    const det = await follow(own.href!);
    expect(det.rows.filter((x) => x.id.startsWith('sd:l:')).reduce((s, x) => s + cents(x.cells.amount), 0) / 100).toBe(300);
    // Customer Balance Summary.
    const bal = await runStandardReport(ctx, 'customer-balance-summary', { asOf: '2026-03-31' });
    const row = bal.rows.find((x) => x.id === `bal:${S.smith}`)!;
    expect(row.cells.balance).toBe('300.00');
    expect(sumLines(await follow(row.href!))).toBe(300);
    // P&L by Job: the Smith column is Smith's own income.
    const job = await runStandardReport(ctx, 'profit-loss-by-job', range);
    const col = job.columns.find((c) => c.header === 'Smith')!;
    const inc = plRow(job, '4000')!;
    expect(inc.cells[col.key]).toBe('300.00');
    expect(sumLines(await follow(inc.hrefs![col.key]))).toBe(300);
  });
});

describe('2. Sales Tax Revenue Summary and the invoice header discount', () => {
  it('Total Sales is net of the discount, taxable sales stay what the tax was charged on', async () => {
    const rate = (await createTaxRate(ctx, { name: 'R13 8%', rate: '0.08' })).id;
    const inv = await createInvoice(ctx, {
      customerId: S.other,
      date: d('2026-05-10'),
      dueDate: d('2026-06-10'),
      taxRateId: rate,
      discount: '100.00',
      lines: [{ description: 'Taxable goods', quantity: 1, rate: '1000.00' }],
    } as never);
    // The invoice charged tax on the full 1,000 (the header discount does not reduce the base).
    expect((inv as { taxAmount: string }).taxAmount).toBe('80.00');
    const s = await salesTaxRevenueSummary(ctx, { from: d('2026-05-01'), to: new Date('2026-05-31T23:59:59.999Z') });
    expect(s.totals.totalSales).toBe('900.00');
    expect(s.totals.taxableSales).toBe('1000.00');
    expect(s.totals.nonTaxableSales).toBe('-100.00');
    expect(s.totals.taxCollected).toBe('80.00');
    // Ties to the P&L income for the month.
    const pl = await runStandardReport(ctx, 'profit-loss', { from: '2026-05-01', to: '2026-05-31' });
    expect(plRow(pl, '4000')?.cells.total).toBe('900.00');
  });
});

describe('3. Transaction Detail by Account after a year-end close', () => {
  it('an income account of the closed year lists its activity without the closing entry', async () => {
    await postJournalEntry(ctx, {
      date: d('2025-04-01'),
      description: 'FY25 sale',
      lines: [
        { accountId: A['1000'], debit: '1000' },
        { accountId: A['4000'], credit: '1000' },
      ],
    });
    await yearEndClose(ctx, { fiscalYear: 2025 } as never);
    const pl = await runStandardReport(ctx, 'profit-loss', { from: '2025-01-01', to: '2025-12-31' });
    const sales = plRow(pl, '4000')!;
    expect(sales.cells.total).toBe('1000.00');
    const zoom = await follow(sales.href!);
    expect(sumLines(zoom)).toBe(1000);
    expect(zoom.rows.filter((x) => x.kind === 'data' && x.entryId)).toHaveLength(1);
    // Retained Earnings (a balance-sheet account) keeps the closing entry.
    const re = await runStandardReport(ctx, 'transaction-detail-by-account', { accountId: A['3900'], from: '2025-01-01', to: '2025-12-31' });
    expect(sumLines(re)).toBe(1000);
  });
});
