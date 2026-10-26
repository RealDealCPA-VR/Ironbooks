/**
 * Round-5 review regressions (jobs):
 *  A. The Jobs list (jobsSummary) and a job's profitability (jobProfitability) count revenue and
 *     cost the way the Job Profitability reports do: foreign-currency invoices / bills in home
 *     currency (EUR 100 at 1.20 is 120.00, not 100.00) and an invoice discount reduces the job's
 *     revenue. They used to add raw document-currency amounts and ignore discounts, so the Jobs
 *     page disagreed with the reports for the same job.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, accounts, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createJob, jobProfitability, jobsSummary } from './jobs';
import { jobProfitabilitySummary } from './reportsJobsTime';
import { setBaseCurrency, upsertCurrency } from './currencies';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-jobs');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('jobs (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@jobs.test', name: 'Jay', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Review5 Jobs', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: job revenue / cost are in home currency and net of invoice discounts, like the Job Profitability report', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Kitchen Client' } as never);
    const job = await createJob(ctx, { name: 'Kitchen remodel', customerId: cust.id });

    // EUR 100 at 1.20 = USD 120 of revenue.
    await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-02'),
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00', jobId: job.id }],
    } as never);
    // USD 200 less a 30.00 discount = USD 170 of revenue.
    await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-03'),
      jobId: job.id,
      discount: '30.00',
      discountType: 'amount',
      lines: [{ accountId: acct['4100'], quantity: 1, rate: '200.00' }],
    } as never);
    // EUR 50 bill at 1.20 = USD 60 of cost.
    const v = await createVendor(ctx, { displayName: 'EU Supplier' } as never);
    await db.update(vendors).set({ currency: 'EUR' }).where(eq(vendors.id, v.id));
    await createBill(ctx, {
      vendorId: v.id,
      date: d('2026-03-04'),
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [{ accountId: acct['6300'], amount: '50.00', jobId: job.id }],
    } as never);

    const report = await jobProfitabilitySummary(ctx, {} as never);
    const row = report.rows.find((r) => r.id === `jps:job:${job.id}`)!;
    expect(row.cells.revenue).toBe('290.00');
    expect(row.cells.cost).toBe('60.00');

    const summary = (await jobsSummary(ctx)).find((j) => j.id === job.id)!;
    expect(summary.revenue).toBe('290.00');
    expect(summary.cost).toBe('60.00');
    expect(summary.profit).toBe('230.00');

    const detail = await jobProfitability(ctx, job.id);
    expect(detail.revenue).toBe('290.00');
    expect(detail.cost).toBe('60.00');
    expect(detail.profit).toBe('230.00');
    // The line breakdown adds up to the totals.
    const lineSum = detail.lines.reduce((s, l) => s + (l.source === 'invoice_line' ? Number(l.amount) : -Number(l.amount)), 0);
    expect(lineSum.toFixed(2)).toBe('230.00');
  });
});
