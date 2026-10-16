/**
 * Review round 2 (reports): sales and job reports count only sales lines. Subtotal items
 * (non-posting; their amount repeats the lines above), payment items (money received) and manual
 * sales-tax items (owed to the agency) are not sales; discount lines still reduce sales.
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
import { createInvoice } from './invoices';
import { createItem } from './items';
import { createSalesReceipt } from './salesReceipts';
import { createEstimate, updateEstimateStatus } from './estimates';
import { createSalesOrder } from './salesOrders';
import { runStandardReport } from './reportRegistry';
import { salesByItem } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-reports');
let db: DB;
let ctx: ServiceContext;
let n = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const grand = (r: StdReport) => r.rows.find((x) => x.kind === 'grand')!;

async function newCompany() {
  const [user] = await db.insert(users).values({ email: `r2-reports-${++n}@test.local`, name: 'R2', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: `R2 Reports Co ${n}`, ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const code: Record<string, string> = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) code[r.code] = r.id;
  const svc = await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: 100, incomeAccountId: code['4000'] } as never);
  const disc = await createItem(ctx, { name: 'Discount', type: 'discount' } as never);
  const sub = await createItem(ctx, { name: 'Subtotal', type: 'subtotal' } as never);
  const pay = await createItem(ctx, { name: 'Deposit Received', type: 'payment' } as never);
  const tax = await createItem(ctx, { name: 'Manual Tax', type: 'sales_tax' } as never);
  const custId = (await createCustomer(ctx, { displayName: 'Sub Co' })).id;
  return { svc, disc, sub, pay, tax, custId };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

const q = { from: '2026-05-01', to: '2026-05-31', basis: 'accrual' };
const legacyRange = { from: d('2026-05-01'), to: new Date('2026-05-31T23:59:59.999Z') };

async function expectSales(amount: string) {
  expect(grand(await runStandardReport(ctx, 'sales-by-customer-summary', q)).cells.amount).toBe(amount);
  expect(grand(await runStandardReport(ctx, 'sales-by-customer-detail', q)).cells.amount).toBe(amount);
  expect(grand(await runStandardReport(ctx, 'sales-by-item-summary', q)).cells.amount).toBe(amount);
  expect(grand(await runStandardReport(ctx, 'sales-by-item-detail', q)).cells.amount).toBe(amount);
  expect(grand(await runStandardReport(ctx, 'job-profitability-summary', q)).cells.revenue).toBe(amount);
  expect(grand(await runStandardReport(ctx, 'job-profitability-detail', q)).cells.revenue).toBe(amount);
  expect((await salesByItem(ctx, legacyRange)).totals.revenue).toBe(amount);
}

describe('subtotal item lines are not counted twice', () => {
  it('invoice: $100 service + subtotal = $100 of sales everywhere', async () => {
    const it = await newCompany();
    const inv = await createInvoice(ctx, {
      customerId: it.custId,
      date: d('2026-05-10'),
      dueDate: d('2026-06-10'),
      lines: [
        { itemId: it.svc.id, quantity: 1, rate: '100.00', taxable: false },
        { itemId: it.sub.id, quantity: 1, rate: '0', taxable: false },
      ],
    } as never);
    expect(inv.total).toBe('100.00');
    await expectSales('100.00');
  });

  it('sales receipt with a subtotal and a discount: sales = net of the discount', async () => {
    const it = await newCompany();
    await createSalesReceipt(ctx, {
      customerId: it.custId,
      date: d('2026-05-12'),
      lines: [
        { itemId: it.svc.id, quantity: 1, rate: 100, taxable: false },
        { itemId: it.sub.id, quantity: 1, rate: 0, taxable: false },
        { itemId: it.disc.id, quantity: 1, rate: 10, taxable: false },
      ],
    } as never);
    await expectSales('90.00');
  });
});

describe('payment-item and manual sales-tax lines are not sales', () => {
  it('invoice: $100 service + $30 payment line + $8 manual tax line = $100 of sales', async () => {
    const it = await newCompany();
    const inv = await createInvoice(ctx, {
      customerId: it.custId,
      date: d('2026-05-10'),
      dueDate: d('2026-06-10'),
      lines: [
        { itemId: it.svc.id, quantity: 1, rate: '100.00', taxable: false },
        { itemId: it.pay.id, quantity: 1, rate: '30.00', taxable: false },
        { itemId: it.tax.id, quantity: 1, rate: '8.00', taxable: false },
      ],
    } as never);
    expect(inv.total).toBe('108.00');
    await expectSales('100.00');
  });
});

describe('estimates and sales orders ignore subtotal lines', () => {
  it('Job Estimates vs. Actuals: estimated revenue excludes the subtotal line', async () => {
    const it = await newCompany();
    const est = await createEstimate(ctx, {
      customerId: it.custId,
      date: d('2026-05-05'),
      lines: [
        { itemId: it.svc.id, quantity: 1, rate: 100, taxable: false },
        { itemId: it.sub.id, quantity: 1, rate: 0, taxable: false },
      ],
    } as never);
    await updateEstimateStatus(ctx, (est as { id: string }).id, 'accepted');
    const r = await runStandardReport(ctx, 'job-estimates-vs-actuals', q);
    expect(grand(r).cells.est).toBe('100.00');
  });

  it('Open Sales Orders: the open amount excludes the subtotal line', async () => {
    const it = await newCompany();
    await createSalesOrder(ctx, {
      customerId: it.custId,
      date: d('2026-05-05'),
      lines: [
        { itemId: it.svc.id, quantity: 1, rate: '100', taxable: false },
        { itemId: it.sub.id, quantity: 1, rate: '0', taxable: false },
      ],
    } as never);
    const r = await runStandardReport(ctx, 'open-sales-orders-by-customer', q);
    expect(grand(r).cells.open).toBe('100.00');
  });
});
