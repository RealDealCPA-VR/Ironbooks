/**
 * Integration tests for listExport.ts (list-to-CSV exports).
 *
 * Uses an isolated PGlite throwaway directory. Verifies:
 *  - each exportable list produces a CSV with the right header + rows
 *  - RFC-4180 escaping (commas, quotes, newlines)
 *  - sensitive fields (SSN) are never exported
 *  - unknown list names throw VALIDATION
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  vendors,
  items,
  employees,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { buildCsv, csvEscape, exportListCsv } from './listExport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-listexport-c4d1');
let ctx: ServiceContext;
let db: DB;

/** Strip the BOM and split into lines for assertions. */
function rows(csv: string): string[] {
  return csv.replace(/^﻿/, '').split('\r\n').filter((l) => l.length > 0);
}

describe('listExport service (integration)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@listexport.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'List Export Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Another company whose data must NOT leak into exports.
    const [otherCo] = await db
      .insert(companies)
      .values({ name: 'Other Co', ownerId: user.id })
      .returning();
    await db.insert(customers).values({ companyId: otherCo.id, displayName: 'Foreign Customer' });

    // ---- Accounts (parent + child) ----
    const [parentAcct] = await db
      .insert(accounts)
      .values({
        companyId: company.id,
        code: '1000',
        name: 'Checking',
        type: 'asset',
        subtype: 'checking',
        // accounts.balance is ledger-derived (DB trigger) — new accounts start at zero.
      })
      .returning();
    await db.insert(accounts).values({
      companyId: company.id,
      code: '1010',
      name: 'Petty Cash',
      type: 'asset',
      subtype: 'checking',
      parentId: parentAcct.id,
    });
    const [incomeAcct] = await db
      .insert(accounts)
      .values({
        companyId: company.id,
        code: '4000',
        name: 'Sales Income',
        type: 'revenue',
        subtype: 'sales',
      })
      .returning();

    // ---- Customers (one with CSV-hostile name) ----
    await db.insert(customers).values([
      {
        companyId: company.id,
        displayName: 'Acme, Inc. "The Best"',
        companyName: 'Acme',
        email: 'a@acme.test',
        terms: 'net_30',
        balance: '250.00',
        billingAddress: { line1: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701' },
      },
      { companyId: company.id, displayName: 'Beta LLC', isActive: false },
    ]);

    // ---- Vendors ----
    await db.insert(vendors).values({
      companyId: company.id,
      displayName: 'Vendor One',
      is1099: true,
      taxId: '12-3456789',
      balance: '99.00',
    });

    // ---- Items ----
    await db.insert(items).values({
      companyId: company.id,
      name: 'Widget',
      sku: 'W-1',
      type: 'inventory',
      salesPrice: '25.00',
      purchaseCost: '10.00',
      incomeAccountId: incomeAcct.id,
      quantityOnHand: '12',
    });

    // ---- Employees ----
    await db.insert(employees).values({
      companyId: company.id,
      firstName: 'Pat',
      lastName: 'Doe',
      email: 'pat@listexport.test',
      payType: 'hourly',
      payRate: '22.50',
      ssn: '123-45-6789',
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // csv primitives
  // -------------------------------------------------------------------------

  it('csvEscape quotes commas, quotes and newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('buildCsv emits BOM + CRLF lines', () => {
    const csv = buildCsv(['A', 'B'], [['1', '2']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('A,B\r\n1,2\r\n');
  });

  // -------------------------------------------------------------------------
  // per-list exports
  // -------------------------------------------------------------------------

  it('exports customers with escaping, both active and inactive, company-scoped', async () => {
    const { filename, csv } = await exportListCsv(ctx, 'customers');
    expect(filename).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = rows(csv);
    expect(lines[0]).toBe(
      'Name,Company,Email,Phone,Billing Address,Shipping Address,Terms,Credit Limit,Taxable,Balance,Notes,Active',
    );
    expect(lines).toHaveLength(3); // header + 2 customers
    // CSV-hostile name correctly escaped
    expect(csv).toContain('"Acme, Inc. ""The Best"""');
    // Address flattened
    expect(csv).toContain('"1 Main St, Springfield, IL, 62701"');
    // Inactive customer included, flagged N
    const beta = lines.find((l) => l.startsWith('Beta LLC'));
    expect(beta).toBeDefined();
    expect(beta!.endsWith(',N')).toBe(true);
    // No cross-company leakage
    expect(csv).not.toContain('Foreign Customer');
  });

  it('exports vendors with the 1099 flag but never the tax id', async () => {
    const { csv } = await exportListCsv(ctx, 'vendors');
    const lines = rows(csv);
    expect(lines[0]).toBe(
      'Name,Company,Email,Phone,Address,Terms,1099 Vendor,Balance,Notes,Active',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Vendor One');
    expect(lines[1]).toContain('Y'); // 1099 flag
    expect(csv).not.toContain('12-3456789'); // encrypted-at-rest tax id stays private
  });

  it('exports items with resolved account labels', async () => {
    const { csv } = await exportListCsv(ctx, 'items');
    const lines = rows(csv);
    expect(lines[0].startsWith('Name,SKU,Type,Description,Sales Price,Purchase Cost')).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Widget');
    expect(lines[1]).toContain('4000 Sales Income'); // income account resolved to code+name
    expect(lines[1]).toContain('25.00');
  });

  it('exports the chart of accounts with parent codes', async () => {
    const { filename, csv } = await exportListCsv(ctx, 'accounts');
    expect(filename).toMatch(/^chart-of-accounts-/);
    const lines = rows(csv);
    expect(lines[0]).toBe('Code,Name,Type,Subtype,Parent Code,Balance,Description,Active');
    const child = lines.find((l) => l.startsWith('1010'));
    expect(child).toBeDefined();
    expect(child).toContain('1000'); // parent resolved to its code
  });

  it('exports employees WITHOUT the SSN', async () => {
    const { csv } = await exportListCsv(ctx, 'employees');
    const lines = rows(csv);
    expect(lines[0]).toBe('First Name,Last Name,Email,Pay Type,Pay Rate,Address,Active');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Pat');
    expect(lines[1]).toContain('22.50');
    expect(csv).not.toContain('123-45-6789');
  });

  it('throws VALIDATION on an unknown list', async () => {
    await expect(exportListCsv(ctx, 'paychecks')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
