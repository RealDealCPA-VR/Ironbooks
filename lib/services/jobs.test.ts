/**
 * Integration tests for the Jobs / Project-Costing service.
 *
 * Boots a throwaway PGlite instance, seeds the minimum data (user, company, accounts,
 * customer, vendor), then:
 *   - Creates jobs (validate required fields).
 *   - Tags an invoice line and a bill line to the job via direct inserts.
 *   - Asserts jobProfitability returns correct revenue / cost / profit.
 *   - Asserts jobsSummary includes the job with matching totals.
 *   - Verifies updateJob and deactivateJob behave correctly.
 *   - Checks multi-tenant isolation: company B cannot see company A's jobs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  vendors,
  invoices,
  invoiceLines,
  bills,
  billLines,
  expenses,
  expenseLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { postJournalEntry } from './posting';
import {
  listJobs,
  getJob,
  createJob,
  updateJob,
  deactivateJob,
  jobProfitability,
  jobsSummary,
} from './jobs';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-jobs-unique-xk9m2');
let ctx: ServiceContext;
let ctx2: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;

describe('Jobs / Project-Costing service (integration)', () => {
  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    // ---- Company A ----
    const [user] = await db
      .insert(users)
      .values({ email: 'jobs-owner@test.local', name: 'Jobs Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Jobs Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed Chart of Accounts
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6000', 'Operating Expenses', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Seed a customer
    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Acme Corp', taxable: false })
      .returning();
    customerId = cust.id;

    // Seed a vendor
    const [vend] = await db
      .insert(vendors)
      .values({ companyId: company.id, displayName: 'Supplies Inc' })
      .returning();
    vendorId = vend.id;

    // ---- Company B (multi-tenant isolation) ----
    const [user2] = await db
      .insert(users)
      .values({ email: 'jobs-owner2@test.local', name: 'Other Owner', passwordHash: 'x' })
      .returning();
    const [company2] = await db
      .insert(companies)
      .values({ name: 'Other Co', ownerId: user2.id })
      .returning();
    ctx2 = { db, companyId: company2.id, userId: user2.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // createJob — validation
  // -------------------------------------------------------------------------
  it('throws VALIDATION when name is empty', async () => {
    await expect(createJob(ctx, { name: '' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createJob(ctx, { name: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('throws VALIDATION when startDate is after endDate', async () => {
    await expect(
      createJob(ctx, {
        name: 'Bad Dates Job',
        startDate: new Date('2025-12-01'),
        endDate: new Date('2025-01-01'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  // createJob — happy path
  // -------------------------------------------------------------------------
  let jobId: string;

  it('creates a job with all fields', async () => {
    const job = await createJob(ctx, {
      name: 'Roofing Project Alpha',
      customerId,
      budget: '5000.00',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-06-30'),
    });
    expect(job.name).toBe('Roofing Project Alpha');
    expect(job.companyId).toBe(ctx.companyId);
    expect(job.isActive).toBe(true);
    expect(job.status).toBe('active');
    expect(job.budget).toBe('5000.00');
    jobId = job.id;
  });

  it('getJob returns the created job', async () => {
    const job = await getJob(ctx, jobId);
    expect(job.id).toBe(jobId);
    expect(job.name).toBe('Roofing Project Alpha');
  });

  it('getJob throws NOT_FOUND for wrong company', async () => {
    await expect(getJob(ctx2, jobId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('listJobs returns the job for company A', async () => {
    const list = await listJobs(ctx);
    expect(list.some((j) => j.id === jobId)).toBe(true);
  });

  it('listJobs returns empty for company B', async () => {
    const list = await listJobs(ctx2);
    expect(list.every((j) => j.companyId !== ctx.companyId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // jobProfitability — with tagged invoice line + bill line + expense line
  // -------------------------------------------------------------------------
  it('jobProfitability: zero when no lines tagged', async () => {
    const p = await jobProfitability(ctx, jobId);
    expect(p.revenue).toBe('0.00');
    expect(p.cost).toBe('0.00');
    expect(p.profit).toBe('0.00');
    expect(p.lines).toHaveLength(0);
  });

  it('jobProfitability: aggregates revenue and cost correctly', async () => {
    // --- Post GL for invoice (AR + Sales) so trial balance stays balanced ---
    const je1 = await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-02-15'),
      description: 'Invoice 1 for Roofing Alpha',
      lines: [
        { accountId: acct['1200'], debit: '3000.00' },
        { accountId: acct['4000'], credit: '3000.00' },
      ],
    });

    // Insert invoice header
    const [inv] = await db
      .insert(invoices)
      .values({
        companyId: ctx.companyId,
        customerId,
        invoiceNumber: 1001,
        date: new Date('2025-02-15'),
        status: 'open',
        subtotal: '3000.00',
        total: '3000.00',
        balanceDue: '3000.00',
        postedEntryId: je1.id,
      })
      .returning();

    // Invoice line tagged to our job — $3,000 revenue
    await db.insert(invoiceLines).values({
      invoiceId: inv.id,
      description: 'Roofing materials + labour',
      quantity: '1',
      rate: '3000.00',
      amount: '3000.00',
      taxable: false,
      jobId,
      lineOrder: 0,
    });

    // --- Post GL for bill (Expenses + AP) so trial balance stays balanced ---
    const je2 = await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-02-20'),
      description: 'Bill 1 for Roofing Alpha materials',
      lines: [
        { accountId: acct['5000'], debit: '1200.00' },
        { accountId: acct['2000'], credit: '1200.00' },
      ],
    });

    // Insert bill header
    const [bill] = await db
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId,
        date: new Date('2025-02-20'),
        status: 'open',
        total: '1200.00',
        balanceDue: '1200.00',
        postedEntryId: je2.id,
      })
      .returning();

    // Bill line tagged to our job — $1,200 cost
    await db.insert(billLines).values({
      billId: bill.id,
      accountId: acct['5000'],
      description: 'Shingles and underlayment',
      quantity: '1',
      amount: '1200.00',
      jobId,
      lineOrder: 0,
    });

    // --- Direct expense (out-of-pocket) — $300 cost ---
    const je3 = await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-02-22'),
      description: 'Direct expense for Roofing Alpha',
      lines: [
        { accountId: acct['6000'], debit: '300.00' },
        { accountId: acct['1000'], credit: '300.00' },
      ],
    });

    const [exp] = await db
      .insert(expenses)
      .values({
        companyId: ctx.companyId,
        date: new Date('2025-02-22'),
        paymentAccountId: acct['1000'],
        total: '300.00',
        postedEntryId: je3.id,
      })
      .returning();

    await db.insert(expenseLines).values({
      expenseId: exp.id,
      accountId: acct['6000'],
      description: 'Petrol and site supplies',
      amount: '300.00',
      jobId,
      lineOrder: 0,
    });

    // ---- Assert profitability ----
    const p = await jobProfitability(ctx, jobId);
    expect(p.revenue).toBe('3000.00');
    expect(p.cost).toBe('1500.00');   // 1200 + 300
    expect(p.profit).toBe('1500.00'); // 3000 - 1500
    expect(p.budget).toBe('5000.00');
    // budgetVariance = profit - budget = 1500 - 5000 = -3500
    expect(p.budgetVariance).toBe('-3500.00');
    expect(p.lines).toHaveLength(3);
    expect(p.lines.filter((l) => l.source === 'invoice_line')).toHaveLength(1);
    expect(p.lines.filter((l) => l.source === 'bill_line')).toHaveLength(1);
    expect(p.lines.filter((l) => l.source === 'expense_line')).toHaveLength(1);

    // ---- Assert trial balance is balanced after all postings ----
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // jobsSummary
  // -------------------------------------------------------------------------
  it('jobsSummary returns active jobs with revenue/cost/profit', async () => {
    const summary = await jobsSummary(ctx);
    const row = summary.find((r) => r.id === jobId);
    expect(row).toBeDefined();
    expect(row!.revenue).toBe('3000.00');
    expect(row!.cost).toBe('1500.00');
    expect(row!.profit).toBe('1500.00');
    expect(row!.customerName).toBe('Acme Corp');
  });

  // -------------------------------------------------------------------------
  // updateJob
  // -------------------------------------------------------------------------
  it('updateJob mutates specified fields', async () => {
    const updated = await updateJob(ctx, jobId, { name: 'Roofing Project Alpha (revised)', budget: '6000.00' });
    expect(updated.name).toBe('Roofing Project Alpha (revised)');
    expect(updated.budget).toBe('6000.00');
  });

  // -------------------------------------------------------------------------
  // deactivateJob
  // -------------------------------------------------------------------------
  it('deactivateJob marks job inactive', async () => {
    const deactivated = await deactivateJob(ctx, jobId);
    expect(deactivated.isActive).toBe(false);
    expect(deactivated.status).toBe('inactive');
  });

  it('inactive job is excluded from default listJobs', async () => {
    const list = await listJobs(ctx);
    expect(list.some((j) => j.id === jobId)).toBe(false);
  });

  it('inactive job appears with includeInactive=true', async () => {
    const list = await listJobs(ctx, { includeInactive: true });
    expect(list.some((j) => j.id === jobId)).toBe(true);
  });

  it('deactivateJob throws NOT_FOUND for wrong company', async () => {
    await expect(deactivateJob(ctx2, jobId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
