/**
 * Tests for the extended QuickBooks import surface (lib/services/qbImport.ts):
 *   - IIF sections CLASS, INVITEM, EMP and TRNS/SPL/ENDTRNS transactions
 *   - unmatched TRNS accounts auto-created under the "QB Import (review)" bucket
 *   - duplicate-safe re-import via journal entry sourceRef
 *   - items + chart-of-accounts CSV imports with column mapping
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  classes,
  companies,
  employees,
  items,
  journalEntries,
  journalEntryLines,
  users,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import {
  QB_IMPORT_BUCKET,
  importAccountsCSV,
  importIIF,
  importItemsCSV,
  mapIifItemType,
  parseIIF,
  parseIifAmount,
  parseIifDate,
} from './qbImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbimport-ext');

let db: DB;
let ctx: ServiceContext;

const SAMPLE_IIF = [
  '!ACCNT\tNAME\tACCNTTYPE\tDESC\tACCNUM',
  'ACCNT\tChecking\tBANK\tMain checking\t1000',
  'ACCNT\tSales Income\tINCOME\t\t4000',
  '!CLASS\tNAME',
  'CLASS\tEast Region',
  'CLASS\tWest Region',
  '!INVITEM\tNAME\tINVITEMTYPE\tDESC\tPRICE\tCOST\tACCNT\tCOGSACCNT\tASSETACCNT',
  'INVITEM\tConsulting Hour\tSERV\tHourly consulting\t150.00\t\tSales Income\t\t',
  'INVITEM\tWidget\tINVPART\tBlue widget\t25.00\t10.00\tSales Income\tMissing COGS\t',
  '!EMP\tNAME\tINIT\tSSNO\tEMAIL',
  'EMP\tDoe, Jane\tJD\t\tjane@example.com',
  'EMP\tBob Stone\tBS\t\t',
  '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLASS',
  '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLASS',
  '!ENDTRNS',
  // Check written from Checking against an account that does NOT exist —
  // must be auto-created under the QB Import bucket, never dropped.
  'TRNS\t\tCHECK\t1/15/2024\tChecking\tOffice Depot\t-150.00\t1001\tOffice supplies\t',
  'SPL\t\tCHECK\t1/15/2024\tOffice Supplies Exp\t\t150.00\t1001\t\tEast Region',
  'ENDTRNS',
  // Balanced general journal between two known accounts.
  'TRNS\t\tGENERAL JOURNAL\t2/01/2024\tChecking\t\t500.00\tGJ-7\tFebruary sale\t',
  'SPL\t\tGENERAL JOURNAL\t2/01/2024\tSales Income\t\t-500.00\tGJ-7\t\t',
  'ENDTRNS',
  // Unbalanced block — must be reported per-row and skipped, not thrown.
  'TRNS\t\tCHECK\t3/01/2024\tChecking\t\t-90.00\t1002\tBad block\t',
  'SPL\t\tCHECK\t3/01/2024\tSales Income\t\t75.00\t1002\t\t',
  'ENDTRNS',
].join('\n');

describe('qbImport — extended IIF + CSV', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qbext@test.local', name: 'QbExt', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'QB Ext Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Pure parsing
  // -------------------------------------------------------------------------

  it('parseIIF extracts classes, items, employees, and transactions', () => {
    const parsed = parseIIF(SAMPLE_IIF);
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.classes.map((c) => c.name)).toEqual(['East Region', 'West Region']);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]).toMatchObject({
      name: 'Widget',
      itemType: 'INVPART',
      price: '25.00',
      cost: '10.00',
      incomeAccount: 'Sales Income',
      cogsAccount: 'Missing COGS',
    });
    expect(parsed.employees.map((e) => e.name)).toEqual(['Doe, Jane', 'Bob Stone']);
    expect(parsed.transactions).toHaveLength(3);
    expect(parsed.transactions[0].type).toBe('CHECK');
    expect(parsed.transactions[0].lines).toHaveLength(2);
    expect(parsed.transactions[0].lines[1].className).toBe('East Region');
  });

  it('parseIifAmount handles commas, dollar signs, and parens negatives', () => {
    expect(parseIifAmount('1,234.5')).toBe('1234.50');
    expect(parseIifAmount('($50.00)')).toBe('-50.00');
    expect(parseIifAmount('-3')).toBe('-3.00');
    expect(parseIifAmount('abc')).toBeNull();
    expect(parseIifAmount('')).toBeNull();
  });

  it('parseIifDate handles M/D/YYYY, M/D/YY, and ISO dates', () => {
    expect(parseIifDate('1/15/2024')?.toISOString().slice(0, 10)).toBe('2024-01-15');
    expect(parseIifDate('12/31/99')?.toISOString().slice(0, 10)).toBe('1999-12-31');
    expect(parseIifDate('03/04/05')?.toISOString().slice(0, 10)).toBe('2005-03-04');
    expect(parseIifDate('2024-02-01')?.toISOString().slice(0, 10)).toBe('2024-02-01');
    expect(parseIifDate('not-a-date')).toBeNull();
  });

  it('mapIifItemType maps QB item types to our enum', () => {
    expect(mapIifItemType('SERV')).toBe('service');
    expect(mapIifItemType('INVPART')).toBe('inventory');
    expect(mapIifItemType('NONINVPART')).toBe('non_inventory');
    expect(mapIifItemType('OTHC')).toBe('other_charge');
    expect(mapIifItemType('DISC')).toBe('discount');
    expect(mapIifItemType('PMT')).toBe('payment');
    expect(mapIifItemType('STAX')).toBe('sales_tax');
    expect(mapIifItemType('COMPTAX')).toBe('sales_tax');
    expect(mapIifItemType('GRP')).toBe('bundle');
    expect(mapIifItemType('SUBT')).toBe('subtotal');
    expect(mapIifItemType('ASSEMBLY')).toBe('inventory');
    expect(mapIifItemType('')).toBe('service');
  });

  // -------------------------------------------------------------------------
  // Full IIF import
  // -------------------------------------------------------------------------

  it('importIIF imports classes, items, employees, and posts balanced transactions', async () => {
    const counts = await importIIF(ctx, SAMPLE_IIF);

    expect(counts.accounts).toBeGreaterThanOrEqual(2); // 2 declared (+ auto-created bucket rows count too)
    expect(counts.classes).toBe(2);
    expect(counts.items).toBe(2);
    expect(counts.employees).toBe(2);
    expect(counts.transactions).toBe(2); // third block is unbalanced

    // Unbalanced block reported as a per-row issue, not an exception.
    const unbalancedIssue = counts.issues.find(
      (i) => i.entity === 'transaction' && /do not balance/i.test(i.message),
    );
    expect(unbalancedIssue).toBeTruthy();

    // Classes exist.
    const classRows = await ctx.db
      .select()
      .from(classes)
      .where(eq(classes.companyId, ctx.companyId));
    expect(classRows.map((c) => c.name).sort()).toEqual(['East Region', 'West Region']);

    // Items: service item linked to income account; widget imported with COGS link skipped + issue.
    const itemRows = await ctx.db.select().from(items).where(eq(items.companyId, ctx.companyId));
    const consulting = itemRows.find((i) => i.name === 'Consulting Hour')!;
    expect(consulting.type).toBe('service');
    expect(consulting.incomeAccountId).not.toBeNull();
    const widget = itemRows.find((i) => i.name === 'Widget')!;
    expect(widget.type).toBe('inventory');
    expect(widget.expenseAccountId).toBeNull();
    expect(
      counts.issues.some((i) => i.entity === 'item' && /Missing COGS/.test(i.message)),
    ).toBe(true);

    // Employees: "Last, First" split correctly.
    const empRows = await ctx.db
      .select()
      .from(employees)
      .where(eq(employees.companyId, ctx.companyId));
    expect(empRows.some((e) => e.firstName === 'Jane' && e.lastName === 'Doe')).toBe(true);
    expect(empRows.some((e) => e.firstName === 'Bob' && e.lastName === 'Stone')).toBe(true);
  });

  it('unmatched TRNS account is auto-created under the QB Import bucket', async () => {
    const [bucket] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, QB_IMPORT_BUCKET.code)));
    expect(bucket).toBeTruthy();
    expect(bucket.name).toBe(QB_IMPORT_BUCKET.name);

    const [created] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Office Supplies Exp')));
    expect(created).toBeTruthy();
    expect(created.parentId).toBe(bucket.id);
  });

  it('posted transactions are balanced journal entries with iif sourceRefs', async () => {
    const entries = await ctx.db
      .select()
      .from(journalEntries)
      .where(
        and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'iif:%')),
      );
    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      expect(entry.status).toBe('posted');
      const lines = await ctx.db
        .select()
        .from(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, entry.id));
      const debit = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
      const credit = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
      expect(debit).toBeCloseTo(credit, 2);
    }
  });

  it('re-importing the same IIF file skips every transaction as a duplicate', async () => {
    const counts = await importIIF(ctx, SAMPLE_IIF);
    expect(counts.transactions).toBe(0);
    const dupes = counts.issues.filter(
      (i) => i.entity === 'transaction' && i.reason === 'duplicate',
    );
    expect(dupes).toHaveLength(2);

    // No extra entries appeared.
    const entries = await ctx.db
      .select()
      .from(journalEntries)
      .where(
        and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'iif:%')),
      );
    expect(entries).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // CSV imports — items + chart of accounts
  // -------------------------------------------------------------------------

  it('importAccountsCSV imports a chart of accounts with our types AND QB type names', async () => {
    const csv = [
      'Number,Account,Kind,Sub,Memo',
      '1500,Equipment,asset,fixed_assets,Machines',
      '5100,Freight Costs,COGS,,Inbound freight',
      '1000,Checking,BANK,,duplicate row',
    ].join('\n');

    const counts = await importAccountsCSV(ctx, csv, {
      code: 'Number',
      name: 'Account',
      type: 'Kind',
      subtype: 'Sub',
      description: 'Memo',
    });

    expect(counts.accounts).toBe(2);
    expect(counts.skipped).toBe(1); // Checking already exists from the IIF import
    expect(counts.issues.some((i) => i.entity === 'account' && i.reason === 'duplicate')).toBe(true);

    const [equipment] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1500')));
    expect(equipment.type).toBe('asset');
    expect(equipment.subtype).toBe('fixed_assets');

    const [freight] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '5100')));
    expect(freight.type).toBe('expense');
    expect(freight.subtype).toBe('cost_of_goods_sold');
  });

  it('importItemsCSV imports items with account links resolved by name or code', async () => {
    const csv = [
      'Item,SKU,Kind,Price,Cost,Income,COGS',
      'Gold Plan,GP-1,service,99.00,,Sales Income,',
      'Gizmo,GZ-9,inventory,40.00,15.00,4000,5100',
      'Widget,,inventory,1.00,,,', // duplicate of the IIF-imported Widget
      ',missing-name,service,,,,',
    ].join('\n');

    const counts = await importItemsCSV(ctx, csv, {
      name: 'Item',
      sku: 'SKU',
      type: 'Kind',
      salesPrice: 'Price',
      purchaseCost: 'Cost',
      incomeAccount: 'Income',
      expenseAccount: 'COGS',
    });

    expect(counts.items).toBe(2);
    expect(counts.skipped).toBe(2); // duplicate Widget + blank name
    expect(counts.issues.some((i) => i.entity === 'item' && i.reason === 'duplicate')).toBe(true);
    expect(counts.issues.some((i) => i.entity === 'item' && i.reason === 'validation')).toBe(true);

    const rows = await ctx.db.select().from(items).where(eq(items.companyId, ctx.companyId));
    const gizmo = rows.find((i) => i.name === 'Gizmo')!;
    expect(gizmo.type).toBe('inventory');
    expect(gizmo.salesPrice).toBe('40.00');
    expect(gizmo.incomeAccountId).not.toBeNull(); // resolved by CODE 4000
    expect(gizmo.expenseAccountId).not.toBeNull(); // resolved by CODE 5100 (COGS)
  });

  it('item CSV rows with unresolvable account links still import, with an issue', async () => {
    const csv = ['Item,Income', 'Silver Plan,No Such Account'].join('\n');
    const counts = await importItemsCSV(ctx, csv, { name: 'Item', incomeAccount: 'Income' });
    expect(counts.items).toBe(1);
    expect(
      counts.issues.some((i) => i.reason === 'unmatched-account' && /No Such Account/.test(i.message)),
    ).toBe(true);
  });
});
