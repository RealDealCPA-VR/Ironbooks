/**
 * Tests for the combined/multi-component sales-tax service.
 *
 * Verifies:
 *  - setComponents replaces components and recomputes the parent rate
 *  - 3 components (6% + 1% + 0.5%) sum to 7.5% on the parent taxRates row
 *  - listComponents returns the written rows
 *  - validation rejects rates outside [0, 1]
 *  - salesTaxByAgency splits collected tax proportionally across agencies
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, taxAgencies, taxRates } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { listComponents, setComponents, salesTaxByAgency } from './combinedTax';
import { createInvoice } from './invoices';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-combined-tax');

let db: DB;
let ctx: ServiceContext;
let taxRateId: string;
let agencyStateId: string;
let agencyCountyId: string;
let agencyCityId: string;

describe('combinedTax service', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@combinedtax.test', name: 'Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Combined Tax Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Minimal accounts needed for invoices.
    await db.insert(accounts).values([
      { companyId: company.id, code: '1200', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
      { companyId: company.id, code: '2200', name: 'Sales Tax Payable', type: 'liability', subtype: 'long_term_liability' },
      { companyId: company.id, code: '4000', name: 'Sales Income', type: 'revenue', subtype: 'sales' },
    ]);

    // Tax agencies for state / county / city.
    const [agState] = await db
      .insert(taxAgencies)
      .values({ companyId: company.id, name: 'State Revenue Dept' })
      .returning();
    const [agCounty] = await db
      .insert(taxAgencies)
      .values({ companyId: company.id, name: 'County Tax Authority' })
      .returning();
    const [agCity] = await db
      .insert(taxAgencies)
      .values({ companyId: company.id, name: 'City Tax Office' })
      .returning();

    agencyStateId = agState.id;
    agencyCountyId = agCounty.id;
    agencyCityId = agCity.id;

    // A combined tax rate (starts at 0 — components will drive the rate).
    const [tr] = await db
      .insert(taxRates)
      .values({ companyId: company.id, name: 'CA Combined 7.5%', rate: '0.000000' })
      .returning();
    taxRateId = tr.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // setComponents — 3 components -> parent rate = 0.075
  // -------------------------------------------------------------------------
  it('sets 3 components (6%+1%+0.5%) and recomputes parent rate to 0.075', async () => {
    const rows = await setComponents(ctx, taxRateId, [
      { name: 'State', agencyId: agencyStateId, rate: 0.06 },
      { name: 'County', agencyId: agencyCountyId, rate: 0.01 },
      { name: 'City', agencyId: agencyCityId, rate: 0.005 },
    ]);

    expect(rows).toHaveLength(3);

    // Verify parent taxRates.rate was recomputed.
    const [updated] = await db
      .select({ rate: taxRates.rate })
      .from(taxRates)
      .where(eq(taxRates.id, taxRateId));
    expect(parseFloat(updated.rate)).toBeCloseTo(0.075, 6);
  });

  // -------------------------------------------------------------------------
  // listComponents — returns the rows just written
  // -------------------------------------------------------------------------
  it('listComponents returns 3 rows matching what was set', async () => {
    const comps = await listComponents(ctx, taxRateId);
    expect(comps).toHaveLength(3);
    const names = comps.map((c) => c.name).sort();
    expect(names).toEqual(['City', 'County', 'State']);
  });

  // -------------------------------------------------------------------------
  // setComponents — replacing with new set clears old ones
  // -------------------------------------------------------------------------
  it('replaces components when called again', async () => {
    // Reduce to 2 components.
    const rows = await setComponents(ctx, taxRateId, [
      { name: 'State', agencyId: agencyStateId, rate: 0.06 },
      { name: 'County', agencyId: agencyCountyId, rate: 0.01 },
    ]);
    expect(rows).toHaveLength(2);

    const [updated] = await db
      .select({ rate: taxRates.rate })
      .from(taxRates)
      .where(eq(taxRates.id, taxRateId));
    expect(parseFloat(updated.rate)).toBeCloseTo(0.07, 6);

    // Restore 3-component set for subsequent tests.
    await setComponents(ctx, taxRateId, [
      { name: 'State', agencyId: agencyStateId, rate: 0.06 },
      { name: 'County', agencyId: agencyCountyId, rate: 0.01 },
      { name: 'City', agencyId: agencyCityId, rate: 0.005 },
    ]);
  });

  // -------------------------------------------------------------------------
  // setComponents — validation
  // -------------------------------------------------------------------------
  it('throws VALIDATION for a component rate > 1', async () => {
    await expect(
      setComponents(ctx, taxRateId, [{ name: 'Bad', rate: 1.5 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('throws VALIDATION for a negative component rate', async () => {
    await expect(
      setComponents(ctx, taxRateId, [{ name: 'Negative', rate: -0.01 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('throws VALIDATION for a component with no name', async () => {
    await expect(
      setComponents(ctx, taxRateId, [{ name: '', rate: 0.06 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('throws NOT_FOUND for an unknown tax rate', async () => {
    await expect(
      setComponents(ctx, '00000000-0000-0000-0000-000000000000', [{ name: 'X', rate: 0.05 }]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // salesTaxByAgency — proportional split across agencies
  // -------------------------------------------------------------------------
  it('salesTaxByAgency splits collected tax proportionally', async () => {
    // Seed a customer + invoice with $100 subtotal and the combined 7.5% rate.
    // taxAmount = 7.50; state share = 6/7.5 = 0.8 -> 6.00;
    // county share = 1/7.5 -> 1.00; city share = 0.5/7.5 -> 0.50
    const [cust] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Tax Split Customer' })
      .returning();

    // Posted through the invoice service: the sales-tax engine reads the GL (Sales Tax
    // Payable lines), not invoice headers.
    await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2026-01-15'),
      taxRateId,
      lines: [{ description: 'Taxable sale', quantity: 1, rate: '100.00' }],
    });

    const result = await salesTaxByAgency(ctx, {
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    });

    expect(result.total).toBe('7.50');
    expect(result.rows).toHaveLength(3);

    const stateRow = result.rows.find((r) => r.componentName === 'State');
    const countyRow = result.rows.find((r) => r.componentName === 'County');
    const cityRow = result.rows.find((r) => r.componentName === 'City');

    expect(stateRow).toBeDefined();
    expect(countyRow).toBeDefined();
    expect(cityRow).toBeDefined();

    // state: 6/7.5 * 7.50 = 6.00
    expect(parseFloat(stateRow!.taxCollected)).toBeCloseTo(6.0, 1);
    // county: 1/7.5 * 7.50 = 1.00
    expect(parseFloat(countyRow!.taxCollected)).toBeCloseTo(1.0, 1);
    // city: 0.5/7.5 * 7.50 = 0.50
    expect(parseFloat(cityRow!.taxCollected)).toBeCloseTo(0.5, 1);
  });

  it('salesTaxByAgency returns empty rows when no invoices in range', async () => {
    const result = await salesTaxByAgency(ctx, {
      from: new Date('2020-01-01'),
      to: new Date('2020-12-31'),
    });
    expect(result.total).toBe('0.00');
    expect(result.rows).toHaveLength(0);
  });
});
