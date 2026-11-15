/**
 * Tests for estimateExpiry.ts
 *
 * Creates estimates with past / future expirationDates, runs
 * expireOverdueEstimates, and asserts the correct rows are rejected while
 * non-expirable rows are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, estimates, estimateLines } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { expireOverdueEstimates, listExpiringEstimates } from './estimateExpiry';

const TEST_DIR = path.resolve(
  process.cwd(),
  '.bookkeeper-data',
  'test-estimate-expiry-svc',
);

let ctx: ServiceContext;
let db: DB;
let customerId: string;

describe('estimateExpiry service', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'expiry-owner@test.local', name: 'Expiry Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Expiry Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    const [customer] = await db
      .insert(customers)
      .values({
        companyId: company.id,
        displayName: 'Expiry Customer',
        email: 'customer@expiry.test',
      })
      .returning();
    customerId = customer.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /** Helper: insert a bare estimate row (no lines needed for status tests). */
  async function insertEstimate(opts: {
    status: 'draft' | 'open' | 'accepted' | 'rejected' | 'closed';
    expirationDate: Date | null;
    estimateNumber: number;
    convertedInvoiceId?: string | null;
  }) {
    const [row] = await db
      .insert(estimates)
      .values({
        companyId: ctx.companyId,
        customerId,
        estimateNumber: opts.estimateNumber,
        date: new Date('2025-01-01'),
        expirationDate: opts.expirationDate,
        status: opts.status,
        convertedInvoiceId: opts.convertedInvoiceId ?? null,
        subtotal: '500.00',
        taxAmount: '0.00',
        total: '500.00',
      })
      .returning();
    return row;
  }

  it('expires overdue draft/open estimates (not accepted ones) and returns count', async () => {
    const past = new Date('2024-01-01'); // clearly in the past
    const future = new Date('2099-12-31'); // clearly in the future
    const asOf = new Date('2025-06-01');

    // Should be expired
    const overdueDraft = await insertEstimate({
      status: 'draft',
      expirationDate: past,
      estimateNumber: 10,
    });
    const overdueOpen = await insertEstimate({
      status: 'open',
      expirationDate: past,
      estimateNumber: 11,
    });
    const overdueAccepted = await insertEstimate({
      status: 'accepted',
      expirationDate: past,
      estimateNumber: 12,
    });

    // Should NOT be expired — already rejected
    await insertEstimate({
      status: 'rejected',
      expirationDate: past,
      estimateNumber: 13,
    });

    // Should NOT be expired — already closed
    await insertEstimate({
      status: 'closed',
      expirationDate: past,
      estimateNumber: 14,
    });

    // Should NOT be expired — expiration is in the future
    await insertEstimate({
      status: 'draft',
      expirationDate: future,
      estimateNumber: 15,
    });

    // Should NOT be expired — no expiration date
    await insertEstimate({
      status: 'open',
      expirationDate: null,
      estimateNumber: 16,
    });

    const count = await expireOverdueEstimates(ctx, asOf);
    expect(count).toBe(2);

    // Confirm the two overdue ones are now rejected.
    const [r1] = await db
      .select({ status: estimates.status })
      .from(estimates)
      .where(
        // drizzle eq import
        (await import('drizzle-orm')).eq(estimates.id, overdueDraft.id),
      );
    expect(r1.status).toBe('rejected');

    const [r2] = await db
      .select({ status: estimates.status })
      .from(estimates)
      .where((await import('drizzle-orm')).eq(estimates.id, overdueOpen.id));
    expect(r2.status).toBe('rejected');

    const [r3] = await db
      .select({ status: estimates.status })
      .from(estimates)
      .where((await import('drizzle-orm')).eq(estimates.id, overdueAccepted.id));
    // Review loop 7: the customer accepted it — the work is under way, it does not expire.
    expect(r3.status).toBe('accepted');
  });

  it('does not expire a converted estimate even if overdue', async () => {
    const { eq } = await import('drizzle-orm');
    const fakeInvoiceId = '00000000-0000-0000-0000-000000000001';
    const past = new Date('2024-01-01');
    const asOf = new Date('2025-06-01');

    // converted = has convertedInvoiceId set (should be closed in reality but
    // our guard is on convertedInvoiceId being non-null)
    const converted = await db
      .insert(estimates)
      .values({
        companyId: ctx.companyId,
        customerId,
        estimateNumber: 99,
        date: new Date('2024-01-01'),
        expirationDate: past,
        status: 'accepted',
        convertedInvoiceId: fakeInvoiceId,
        subtotal: '100.00',
        taxAmount: '0.00',
        total: '100.00',
      })
      .returning()
      .then((r) => r[0]);

    await expireOverdueEstimates(ctx, asOf);

    const [check] = await db
      .select({ status: estimates.status })
      .from(estimates)
      .where(eq(estimates.id, converted.id));
    // Status should remain accepted — it was already "converted" and
    // expireOverdueEstimates must not touch it.
    expect(check.status).toBe('accepted');
  });

  it('returns 0 when nothing is overdue', async () => {
    // Isolated ctx to avoid cross-test pollution.
    const [user2] = await db
      .insert(users)
      .values({ email: 'expiry-owner2@test.local', name: 'No Expiry', passwordHash: 'x' })
      .returning();
    const [co2] = await db
      .insert(companies)
      .values({ name: 'Clean Co', ownerId: user2.id })
      .returning();
    const ctx2: ServiceContext = { db, companyId: co2.id, userId: user2.id };

    const count = await expireOverdueEstimates(ctx2, new Date());
    expect(count).toBe(0);
  });

  it('listExpiringEstimates returns estimates expiring within the window', async () => {
    const { eq } = await import('drizzle-orm');

    // Create a fresh isolated company for this test.
    const [user3] = await db
      .insert(users)
      .values({ email: 'expiry-owner3@test.local', name: 'Soon Expiry', passwordHash: 'x' })
      .returning();
    const [co3] = await db
      .insert(companies)
      .values({ name: 'Soon Expiry Co', ownerId: user3.id })
      .returning();
    const ctx3: ServiceContext = { db, companyId: co3.id, userId: user3.id };

    const [cust3] = await db
      .insert(customers)
      .values({
        companyId: co3.id,
        displayName: 'Soon Customer',
        email: 'soon@test.local',
      })
      .returning();

    // Expiring in 3 days — within a 7-day window
    const soonDate = new Date();
    soonDate.setDate(soonDate.getDate() + 3);

    // Expiring in 30 days — outside a 7-day window
    const laterDate = new Date();
    laterDate.setDate(laterDate.getDate() + 30);

    await db.insert(estimates).values({
      companyId: co3.id,
      customerId: cust3.id,
      estimateNumber: 1,
      date: new Date(),
      expirationDate: soonDate,
      status: 'open',
      subtotal: '200.00',
      taxAmount: '0.00',
      total: '200.00',
    });

    await db.insert(estimates).values({
      companyId: co3.id,
      customerId: cust3.id,
      estimateNumber: 2,
      date: new Date(),
      expirationDate: laterDate,
      status: 'open',
      subtotal: '300.00',
      taxAmount: '0.00',
      total: '300.00',
    });

    const expiring = await listExpiringEstimates(ctx3, 7);
    expect(expiring).toHaveLength(1);
    expect(expiring[0].estimateNumber).toBe(1);
    expect(expiring[0].customerName).toBe('Soon Customer');
  });
});
