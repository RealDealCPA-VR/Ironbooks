/**
 * Integration tests for the Mileage service.
 *
 * Boots a throwaway PGlite database, seeds a user + company, then:
 *   1. logMiles 100 @ 0.67 → amount 67.00
 *   2. mileageSummary totals
 *   3. listMileage filter by customer
 *   4. deleteMileage
 *   5. validation guards (zero miles, negative rate)
 *   6. NOT_FOUND for unknown company-scoped ids
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCustomer } from './customers';
import {
  listMileage,
  logMiles,
  deleteMileage,
  mileageSummary,
} from './mileage';

// Unique dir per test run to avoid cross-test collisions.
const TEST_DIR = path.resolve(
  process.cwd(),
  '.bookkeeper-data',
  'test-mileage-svc-k9p3r',
);

let ctx: ServiceContext;
let db: DB;
let customerId: string;

describe('Mileage service (integration)', () => {
  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@mileage.local', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Mile High Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed one customer to test filtering.
    const cust = await createCustomer(ctx, { displayName: 'Acme Client' });
    customerId = cust.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // logMiles — core amount computation
  // -------------------------------------------------------------------------

  it('logs 100 miles @ 0.67 → amount 67.00', async () => {
    const log = await logMiles(ctx, {
      date: new Date('2025-01-15'),
      miles: 100,
      ratePerMile: 0.67,
      purpose: 'Client site visit',
      billable: true,
      customerId,
    });

    expect(log.companyId).toBe(ctx.companyId);
    expect(log.miles).toBe('100.00');
    expect(log.ratePerMile).toBe('0.6700');
    expect(log.amount).toBe('67.00');
    expect(log.billable).toBe(true);
    expect(log.customerName).toBe('Acme Client');
  });

  it('logs miles with the default rate (the IRS 2024 rate, 0.67, for a 2024 trip) when ratePerMile omitted', async () => {
    const log = await logMiles(ctx, {
      date: new Date('2024-01-20'),
      miles: 50,
      purpose: 'Supply run',
    });

    expect(log.miles).toBe('50.00');
    expect(log.ratePerMile).toBe('0.6700');
    expect(log.amount).toBe('33.50');
    expect(log.billable).toBe(false);
    expect(log.customerName).toBeNull();
  });

  // -------------------------------------------------------------------------
  // listMileage
  // -------------------------------------------------------------------------

  it('listMileage returns all logs scoped to company', async () => {
    const rows = await listMileage(ctx);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.companyId).toBe(ctx.companyId);
    }
  });

  it('listMileage filters by customerId', async () => {
    const rows = await listMileage(ctx, { customerId });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.customerId).toBe(customerId);
    }
  });

  // -------------------------------------------------------------------------
  // mileageSummary
  // -------------------------------------------------------------------------

  it('mileageSummary totals match sum of all logs', async () => {
    const summary = await mileageSummary(ctx);

    // We have logged 100 + 50 = 150 miles. Additional tests may add more.
    expect(parseFloat(summary.totalMiles)).toBeGreaterThanOrEqual(150);
    // 100*0.67 + 50*0.67 = 67 + 33.50 = 100.50
    expect(parseFloat(summary.totalAmount)).toBeGreaterThanOrEqual(100.5);
  });

  it('mileageSummary groups include customer-linked and unlinked entries', async () => {
    const summary = await mileageSummary(ctx);
    const withCustomer = summary.groups.filter((g) => g.customerId !== null);
    const withoutCustomer = summary.groups.filter((g) => g.customerId === null);
    expect(withCustomer.length).toBeGreaterThanOrEqual(1);
    expect(withoutCustomer.length).toBeGreaterThanOrEqual(1);
  });

  it('mileageSummary respects date range filter', async () => {
    // Log an entry outside the range.
    await logMiles(ctx, {
      date: new Date('2024-06-01'),
      miles: 999,
      purpose: 'Old trip',
    });

    const summary = await mileageSummary(ctx, {
      from: new Date('2025-01-01'),
      to: new Date('2025-12-31'),
    });

    // The 999-mile trip from 2024 must NOT appear.
    expect(parseFloat(summary.totalMiles)).toBeLessThan(999);
    expect(summary.from).toContain('2025-01-01');
    expect(summary.to).toContain('2025-12-31');
  });

  it('mileageSummary group totalMiles and totalAmount are consistent', async () => {
    const summary = await mileageSummary(ctx);
    let checkMiles = 0;
    let checkAmount = 0;
    for (const g of summary.groups) {
      checkMiles += parseFloat(g.totalMiles);
      checkAmount += parseFloat(g.totalAmount);
    }
    // Allow for floating-point rendering differences (<1 cent).
    expect(Math.abs(checkMiles - parseFloat(summary.totalMiles))).toBeLessThan(0.01);
    expect(Math.abs(checkAmount - parseFloat(summary.totalAmount))).toBeLessThan(0.01);
  });

  // -------------------------------------------------------------------------
  // deleteMileage
  // -------------------------------------------------------------------------

  it('deleteMileage removes the log', async () => {
    const log = await logMiles(ctx, {
      date: new Date('2025-02-01'),
      miles: 10,
      purpose: 'To be deleted',
    });

    const result = await deleteMileage(ctx, log.id);
    expect(result.deleted).toBe(true);

    // Verify it's gone.
    const rows = await listMileage(ctx);
    expect(rows.find((r) => r.id === log.id)).toBeUndefined();
  });

  it('deleteMileage throws NOT_FOUND for unknown id', async () => {
    await expect(
      deleteMileage(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // Validation guards
  // -------------------------------------------------------------------------

  it('rejects zero miles', async () => {
    await expect(
      logMiles(ctx, { date: new Date(), miles: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects negative miles', async () => {
    await expect(
      logMiles(ctx, { date: new Date(), miles: -5 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects negative ratePerMile', async () => {
    await expect(
      logMiles(ctx, { date: new Date(), miles: 10, ratePerMile: -1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects customerId that does not belong to company', async () => {
    await expect(
      logMiles(ctx, {
        date: new Date(),
        miles: 10,
        customerId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
