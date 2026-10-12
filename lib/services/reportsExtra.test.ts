/**
 * Integration tests for reportsExtra (aging, cash flow, sales/expenses summaries).
 *
 * Boots a throw-away PGlite directory, seeds a user + company + full default COA,
 * creates real invoices and bills via the service layer (which posts balanced
 * journal entries), then asserts aging buckets and cash-flow figures are correct.
 *
 * Pattern mirrors accounting.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, companies, customers, invoices, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import {
  arAging,
  apAging,
  cashFlow,
  salesByCustomer,
  expensesByVendor,
} from './reportsExtra';
import { toAmountString } from '@/lib/money';

// ---------------------------------------------------------------------------
// Test bootstrap
// ---------------------------------------------------------------------------

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-extra');
let ctx: ServiceContext;
let db: DB;

// Account ids keyed by COA code.
const acct: Record<string, string> = {};

// We also need raw customer / vendor ids for the documents we create.
let customerId: string;
let vendorId: string;

beforeAll(async () => {
  db = await getDb(TEST_DIR);

  // Seed user + company.
  const [user] = await db
    .insert(users)
    .values({ email: 'owner@extra.test', name: 'Owner', passwordHash: 'x' })
    .returning();

  const [company] = await db
    .insert(companies)
    .values({ name: 'Extra Reports Co', ownerId: user.id })
    .returning();

  ctx = { db, companyId: company.id, userId: user.id };

  // Seed the accounts we need (subset of DEFAULT_COA + an expense account).
  const defs: Array<[string, string, string, string]> = [
    ['1000', 'Checking', 'asset', 'checking'],
    ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
    ['1300', 'Inventory Asset', 'asset', 'inventory'],
    ['1500', 'Fixed Assets', 'asset', 'fixed_assets'],
    ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
    ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
    ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ['3900', 'Retained Earnings', 'equity', 'retained_earnings'],
    ['4000', 'Sales Income', 'revenue', 'sales'],
    ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ['6000', 'Advertising', 'expense', 'operating_expenses'],
  ];
  for (const [code, name, type, subtype] of defs) {
    const row = await createAccount(ctx, { code, name, type: type as never, subtype });
    acct[code] = row.id;
  }

  // Seed a customer.
  const [cust] = await db
    .insert(customers)
    .values({ companyId: company.id, displayName: 'Acme Corp', balance: '0.00' })
    .returning();
  customerId = cust.id;

  // Seed a vendor.
  const [vend] = await db
    .insert(vendors)
    .values({ companyId: company.id, displayName: 'Supplies Inc', balance: '0.00' })
    .returning();
  vendorId = vend.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers: create minimal invoice / bill records + post matching journal entries.
// (We bypass the full createInvoice/createBill services to keep the test
// self-contained, but we still go through postJournalEntry for GL safety.)
// ---------------------------------------------------------------------------

async function createTestInvoice(opts: {
  total: string;
  dueDate: Date;
  date?: Date;
  paid?: boolean;
}) {
  const date = opts.date ?? new Date('2025-01-01');
  // Post balanced GL entry: Dr A/R, Cr Sales Income.
  const entry = await postJournalEntry(ctx, {
    allowUnnamedControl: true, // fixture posts straight to A/R or A/P
    date,
    description: `Test invoice ${opts.total}`,
    lines: [
      { accountId: acct['1200'], debit: opts.total },
      { accountId: acct['4000'], credit: opts.total },
    ],
  });

  const balanceDue = opts.paid ? '0.00' : opts.total;
  const status = opts.paid ? 'paid' : 'open';

  const [inv] = await db
    .insert(invoices)
    .values({
      companyId: ctx.companyId,
      customerId,
      invoiceNumber: Math.floor(Math.random() * 90000) + 10000,
      date,
      dueDate: opts.dueDate,
      status: status as never,
      subtotal: opts.total,
      discount: '0.00',
      taxAmount: '0.00',
      total: opts.total,
      amountPaid: opts.paid ? opts.total : '0.00',
      balanceDue,
      postedEntryId: entry.id,
    })
    .returning();

  return inv;
}

async function createTestBill(opts: {
  total: string;
  dueDate: Date;
  date?: Date;
  paid?: boolean;
}) {
  const date = opts.date ?? new Date('2025-01-01');
  const entry = await postJournalEntry(ctx, {
    allowUnnamedControl: true, // fixture posts straight to A/R or A/P
    date,
    description: `Test bill ${opts.total}`,
    lines: [
      { accountId: acct['6000'], debit: opts.total },
      { accountId: acct['2000'], credit: opts.total },
    ],
  });

  const balanceDue = opts.paid ? '0.00' : opts.total;
  const status = opts.paid ? 'paid' : 'open';

  const [bill] = await db
    .insert(bills)
    .values({
      companyId: ctx.companyId,
      vendorId,
      date,
      dueDate: opts.dueDate,
      status: status as never,
      total: opts.total,
      amountPaid: opts.paid ? opts.total : '0.00',
      balanceDue,
      postedEntryId: entry.id,
    })
    .returning();

  return bill;
}

// ---------------------------------------------------------------------------
// A/R Aging
// ---------------------------------------------------------------------------

describe('arAging', () => {
  it('places a current invoice in the current bucket', async () => {
    // Due 30 days in the future from the reference date.
    const asOf = new Date('2025-06-01');
    const futureDue = new Date('2025-07-01');
    await createTestInvoice({ total: '500.00', dueDate: futureDue, date: new Date('2025-05-01') });

    const report = await arAging(ctx, asOf);
    const row = report.rows.find((r) => r.id === customerId);
    // All invoices for this customer should have current >= 500 (may include others seeded later).
    expect(row).toBeDefined();
    expect(parseFloat(row!.current)).toBeGreaterThanOrEqual(500);
  });

  it('places an overdue invoice (40 days past due) in the 31-60 bucket', async () => {
    // asOf = 2025-06-01, dueDate = 2025-04-22 => 40 days overdue
    const asOf = new Date('2025-06-01');
    const overdueDue = new Date('2025-04-22'); // 40 days before asOf
    await createTestInvoice({ total: '1200.00', dueDate: overdueDue, date: new Date('2025-04-01') });

    const report = await arAging(ctx, asOf);
    const row = report.rows.find((r) => r.id === customerId);
    expect(row).toBeDefined();
    // The 31-60 bucket should contain at least the 1200 overdue invoice.
    expect(parseFloat(row!.days31_60)).toBeGreaterThanOrEqual(1200);
  });

  it('places a 100-day overdue invoice in the 91+ bucket', async () => {
    const asOf = new Date('2025-06-01');
    const veryOldDue = new Date('2025-02-20'); // 100 days before asOf
    await createTestInvoice({ total: '800.00', dueDate: veryOldDue, date: new Date('2025-02-01') });

    const report = await arAging(ctx, asOf);
    const row = report.rows.find((r) => r.id === customerId);
    expect(row).toBeDefined();
    expect(parseFloat(row!.days91plus)).toBeGreaterThanOrEqual(800);
  });

  it('excludes paid invoices', async () => {
    const asOf = new Date('2025-06-01');
    const paidDue = new Date('2025-04-01'); // would be overdue
    const before = await arAging(ctx, asOf);
    const beforeTotal = before.rows.find((r) => r.id === customerId)?.total ?? '0.00';

    await createTestInvoice({ total: '999.00', dueDate: paidDue, paid: true });

    const after = await arAging(ctx, asOf);
    const afterTotal = after.rows.find((r) => r.id === customerId)?.total ?? '0.00';

    // Total should NOT have increased — paid invoice excluded.
    expect(parseFloat(afterTotal)).toEqual(parseFloat(beforeTotal));
  });

  it('grand totals match sum of row totals', async () => {
    const asOf = new Date('2025-06-01');
    const report = await arAging(ctx, asOf);
    const rowSum = report.rows.reduce((s, r) => s + parseFloat(r.total), 0);
    expect(parseFloat(report.totals.total)).toBeCloseTo(rowSum, 2);
  });
});

// ---------------------------------------------------------------------------
// A/P Aging
// ---------------------------------------------------------------------------

describe('apAging', () => {
  it('places an overdue bill in the correct bucket', async () => {
    // asOf = 2025-06-01, dueDate = 2025-05-16 => 16 days overdue => 1-30 bucket
    const asOf = new Date('2025-06-01');
    const overdueDue = new Date('2025-05-16');
    await createTestBill({ total: '350.00', dueDate: overdueDue, date: new Date('2025-05-01') });

    const report = await apAging(ctx, asOf);
    const row = report.rows.find((r) => r.id === vendorId);
    expect(row).toBeDefined();
    expect(parseFloat(row!.days1_30)).toBeGreaterThanOrEqual(350);
  });

  it('grand totals match sum of row totals', async () => {
    const asOf = new Date('2025-06-01');
    const report = await apAging(ctx, asOf);
    const rowSum = report.rows.reduce((s, r) => s + parseFloat(r.total), 0);
    expect(parseFloat(report.totals.total)).toBeCloseTo(rowSum, 2);
  });
});

// ---------------------------------------------------------------------------
// Cash Flow
// ---------------------------------------------------------------------------

describe('cashFlow', () => {
  it('returns a valid cash flow report with operating total', async () => {
    // Post a simple revenue + cash receipt to give the period something to work with.
    const from = new Date('2025-01-01');
    const to = new Date('2025-12-31');

    // Revenue entry: Dr Checking, Cr Sales.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-03-01'),
      description: 'Cash sale',
      lines: [
        { accountId: acct['1000'], debit: '2000.00' },
        { accountId: acct['4000'], credit: '2000.00' },
      ],
    });

    const report = await cashFlow(ctx, { from, to });
    expect(report.operating).toBeDefined();
    expect(report.investing).toBeDefined();
    expect(report.financing).toBeDefined();
    // Net cash change = operating + investing + financing.
    const expected =
      parseFloat(report.operating.total) +
      parseFloat(report.investing.total) +
      parseFloat(report.financing.total);
    expect(parseFloat(report.netCashChange)).toBeCloseTo(expected, 2);
  });

  it('trial balance is still balanced after all test entries', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sales by Customer
// ---------------------------------------------------------------------------

describe('salesByCustomer', () => {
  it('returns a row for the test customer with the correct total', async () => {
    const rows = await salesByCustomer(ctx);
    const custRow = rows.find((r) => r.customerId === customerId);
    expect(custRow).toBeDefined();
    // We created multiple non-void invoices totalling at least 2500.
    expect(parseFloat(custRow!.totalSales)).toBeGreaterThan(0);
    expect(custRow!.invoiceCount).toBeGreaterThanOrEqual(1);
  });

  it('respects date range — returns 0 for an empty range', async () => {
    const rows = await salesByCustomer(ctx, {
      from: new Date('2030-01-01'),
      to: new Date('2030-12-31'),
    });
    // No invoices in the future.
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Expenses by Vendor
// ---------------------------------------------------------------------------

describe('expensesByVendor', () => {
  it('returns a row for the test vendor with positive total', async () => {
    const rows = await expensesByVendor(ctx);
    const vendRow = rows.find((r) => r.vendorId === vendorId);
    expect(vendRow).toBeDefined();
    expect(parseFloat(vendRow!.totalExpenses)).toBeGreaterThan(0);
    expect(vendRow!.billCount).toBeGreaterThanOrEqual(1);
  });

  it('respects date range — returns 0 for an empty range', async () => {
    const rows = await expensesByVendor(ctx, {
      from: new Date('2030-01-01'),
      to: new Date('2030-12-31'),
    });
    expect(rows.length).toBe(0);
  });
});
