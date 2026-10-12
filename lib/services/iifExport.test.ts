/**
 * J2 / J3 / J4 — IIF export round trip (lists + general journal) through our own importer,
 * Excel list import, and the list export formats (csv / xlsx / iif / all).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, assemblyComponents, classes, customers, employees, items, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { importIIF, importListXlsx, xlsxRows } from './qbImport';
import { exportJournalIif, exportListsIif, qbAccountType } from './iifExport';
import { EXPORTABLE_LISTS, exportList } from './listExport';
import { readXlsx } from './qbGlFiles';
import { buildXlsx } from '@/lib/export/xlsx';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-iif-export-w2');
let db: DB;
let a: ServiceContext; // source company
let b: ServiceContext; // empty company the export is imported into

const t = (...c: string[]) => c.join('\t');
const SOURCE_IIF = [
  t('!ACCNT', 'NAME', 'ACCNTTYPE', 'ACCNUM'),
  t('ACCNT', 'Automobile', 'EXP', '6150'),
  t('ACCNT', 'Automobile:Fuel', 'EXP', '6151'),
  t('ACCNT', 'Truck', 'EXP', '6160'),
  t('ACCNT', 'Truck:Fuel', 'EXP', '6161'),
  t('!CLASS', 'NAME'),
  t('CLASS', 'East'),
  t('CLASS', 'East:Boston'),
  t('!CTYPE', 'NAME'),
  t('CTYPE', 'Wholesale'),
  t('!CUSTNAMEDICT', 'INDEX', 'LABEL', 'CUSTOMER', 'VENDOR', 'EMPLOYEE'),
  t('CUSTNAMEDICT', '0', 'Region', 'Y', 'N', 'N'),
  t('!CUST', 'NAME', 'BADDR1', 'BADDR2', 'CTYPE', 'TERMS', 'TAXABLE', 'LIMIT', 'CUSTFLD1', 'HIDDEN', 'CONT1'),
  t('CUST', 'Acme', '1 Main St', 'Springfield, IL 62701', 'Wholesale', 'Net 15', 'N', '2500.00', 'Midwest', 'N', 'Pat'),
  t('CUST', 'Acme:Phase 2', '', '', '', '', 'Y', '', '', 'N', ''),
  t('CUST', 'Old Client', '', '', '', '', 'Y', '', '', 'Y', ''),
  t('!VEND', 'NAME', 'ADDR1', 'ADDR2', 'TERMS', '1099', 'TAXID'),
  t('VEND', 'Contractor Joe', '9 Side St', 'Dayton, OH 45402', 'Net 30', 'Y', '98-7654321'),
  t('!INVITEM', 'NAME', 'INVITEMTYPE', 'DESC', 'PRICE', 'COST', 'ACCNT'),
  t('INVITEM', 'Bolt', 'PART', 'Bolt', '1.00', '0.40', 'Sales Income'),
  t('INVITEM', 'Nut', 'PART', 'Nut', '0.50', '0.10', 'Sales Income'),
  t('INVITEM', 'Hardware Kit', 'GRP', 'Kit', '', '', ''),
  t('INVITEM', 'Setup Fee', 'OTHC', 'Setup', '50.00', '', 'Sales Income'),
  t('INVITEM', 'County Tax', 'STAX', 'County', '7.5%', '', ''),
  t('!INVITEMCOMP', 'PARENT', 'COMPONENT', 'QNTY'),
  t('INVITEMCOMP', 'Hardware Kit', 'Bolt', '4'),
  t('INVITEMCOMP', 'Hardware Kit', 'Nut', '4'),
  t('!EMP', 'NAME', 'ADDR1', 'CITY', 'STATE', 'ZIP', 'SSNO', 'HIREDATE', 'PAYTYPE', 'PAYRATE', 'FILINGSTATUS'),
  t('EMP', 'Doe, Jane', '5 Elm', 'Austin', 'TX', '78701', '123-45-6789', '3/1/2020', 'Hourly', '31.25', 'Married'),
].join('\r\n');

async function accountPaths(ctx: ServiceContext) {
  const rows = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const p = (id: string): string => {
    const r = byId.get(id)!;
    return r.parentId ? `${p(r.parentId)}:${r.name}` : r.name;
  };
  return new Map(rows.map((r) => [p(r.id), r]));
}

describe('IIF export round trip + list exports', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'iifexport@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const ca = await createCompany(db, { name: 'Source Co', ownerId: user.id });
    const cb = await createCompany(db, { name: 'Target Co', ownerId: user.id, seedCoa: false });
    a = { db, companyId: ca.id, userId: user.id };
    b = { db, companyId: cb.id, userId: user.id };
    await importIIF(a, SOURCE_IIF);

    // A few posted entries (with a class) to export as a general journal.
    const paths = await accountPaths(a);
    const [boston] = await a.db.select().from(classes).where(and(eq(classes.companyId, a.companyId), eq(classes.name, 'Boston')));
    await postJournalEntry(a, {
      date: new Date('2026-01-10T00:00:00Z'),
      description: 'Fuel run',
      lines: [
        { accountId: paths.get('Automobile:Fuel')!.id, debit: '40.00', classId: boston.id },
        { accountId: paths.get('Truck:Fuel')!.id, debit: '60.00' },
        { accountId: paths.get('Checking')!.id, credit: '100.00' },
      ],
    });
    await postJournalEntry(a, {
      date: new Date('2026-02-01T00:00:00Z'),
      description: 'Cash sale',
      lines: [
        { accountId: paths.get('Checking')!.id, debit: '250.00' },
        { accountId: paths.get('Sales Income')!.id, credit: '250.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('writes QuickBooks account / item type codes', () => {
    expect(qbAccountType('asset', 'accounts_receivable')).toBe('AR');
    expect(qbAccountType('liability', 'accounts_payable')).toBe('AP');
    expect(qbAccountType('revenue', 'sales')).toBe('INC');
    expect(qbAccountType('expense', 'cost_of_goods_sold')).toBe('COGS');
  });

  it('lists round-trip through our importer', async () => {
    const iif = await exportListsIif(a);
    expect(iif).toMatch(/^!ACCNT\t/m);
    expect(iif).toContain('Automobile:Fuel');
    const counts = await importIIF(b, iif);
    expect(counts.skipped).toBe(0);

    // Accounts: same full paths, same types and codes.
    const pa = await accountPaths(a);
    const pb = await accountPaths(b);
    for (const [p, row] of pa) {
      const other = pb.get(p);
      expect(other, `account ${p}`).toBeTruthy();
      expect(other!.type).toBe(row.type);
      expect(other!.code).toBe(row.code);
      expect(other!.isActive).toBe(row.isActive);
    }

    // Customers incl. job, custom field, type, terms, limit, inactive flag.
    const cb = await b.db.select().from(customers).where(eq(customers.companyId, b.companyId));
    const acme = cb.find((c) => c.displayName === 'Acme')!;
    expect(acme.terms).toBe('net_15');
    expect(acme.taxable).toBe(false);
    expect(acme.creditLimit).toBe('2500.00');
    expect(acme.billingAddress).toMatchObject({ line1: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701' });
    expect(acme.customFields).toMatchObject({ Region: 'Midwest', Contact: 'Pat' });
    expect(acme.customerTypeId).not.toBeNull();
    expect(cb.find((c) => c.displayName === 'Acme:Phase 2')?.parentId).toBe(acme.id);
    expect(cb.find((c) => c.displayName === 'Old Client')?.isActive).toBe(false);

    const [joe] = await b.db.select().from(vendors).where(eq(vendors.companyId, b.companyId));
    expect(joe.is1099).toBe(true);
    expect(joe.taxId).toBe('98-7654321'); // trusted context may export the TIN
    expect(joe.terms).toBe('net_30');

    const ib = await b.db.select().from(items).where(eq(items.companyId, b.companyId));
    const type = (n: string) => ib.find((i) => i.name === n)?.type;
    expect(type('Bolt')).toBe('inventory');
    expect(type('Hardware Kit')).toBe('bundle');
    expect(type('Setup Fee')).toBe('other_charge');
    expect(type('County Tax')).toBe('sales_tax');
    const kitId = ib.find((i) => i.name === 'Hardware Kit')!.id;
    const bom = await b.db.select().from(assemblyComponents).where(eq(assemblyComponents.assemblyItemId, kitId));
    expect(bom).toHaveLength(2);

    const [jane] = await b.db.select().from(employees).where(eq(employees.companyId, b.companyId));
    expect(jane.firstName).toBe('Jane');
    expect(jane.ssn).toBe('123-45-6789');
    expect(jane.payRate).toBe('31.25');
    expect(jane.hireDate?.toISOString().slice(0, 10)).toBe('2020-03-01');
    expect(jane.w4).toMatchObject({ filingStatus: 'married' });

    const clsB = await b.db.select().from(classes).where(eq(classes.companyId, b.companyId));
    expect(clsB.find((c) => c.name === 'Boston')?.parentId).toBe(clsB.find((c) => c.name === 'East')?.id);
  });

  it('the general journal round-trips with the same account balances and classes', async () => {
    const iif = await exportJournalIif(a, { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-12-31T23:59:59Z') });
    expect(iif.match(/^TRNS\t/gm)).toHaveLength(2);
    const counts = await importIIF(b, iif);
    expect(counts.transactions).toBe(2);
    expect(counts.skipped).toBe(0);
    const pa = await accountPaths(a);
    const pb = await accountPaths(b);
    for (const p of ['Automobile:Fuel', 'Truck:Fuel', 'Checking', 'Sales Income']) {
      expect(pb.get(p)!.balance, p).toBe(pa.get(p)!.balance);
    }
    expect((await trialBalance(b)).balanced).toBe(true);
  });

  it('exports every list as csv, xlsx and (where QB has a section) iif', async () => {
    for (const list of EXPORTABLE_LISTS) {
      const csv = await exportList(a, list, 'csv');
      expect(typeof csv.body).toBe('string');
      const x = await exportList(a, list, 'xlsx');
      expect(Buffer.isBuffer(x.body)).toBe(true);
      expect(readXlsx(new Uint8Array(x.body as Buffer))[0].rows.length).toBeGreaterThan(0);
    }
    const iif = await exportList(a, 'customers', 'iif');
    expect(String(iif.body)).toContain('!CUST');
    await expect(exportList(a, 'jobs', 'iif')).rejects.toMatchObject({ code: 'VALIDATION' });
    const all = await exportList(a, 'all', 'xlsx');
    expect(readXlsx(new Uint8Array(all.body as Buffer)).length).toBe(EXPORTABLE_LISTS.length);
    const allIif = await exportList(a, 'all', 'iif');
    expect(String(allIif.body)).toContain('!INVITEMCOMP');
    const terms = await exportList(a, 'terms', 'csv');
    expect(String(terms.body)).toContain('net_15');
  });

  it('J3: imports customers / items / accounts from an Excel workbook (and re-imports our own export)', async () => {
    const wb = buildXlsx({
      sheetName: 'Customers',
      columns: [{ header: 'Customer' }, { header: 'E-mail' }, { header: 'City' }],
      rows: [
        ['Xlsx One', 'one@x.test', 'Reno'],
        ['Xlsx Two', '', 'Boise'],
      ],
    });
    const { headers } = xlsxRows(new Uint8Array(wb));
    expect(headers).toEqual(['Customer', 'E-mail', 'City']);
    const c = await importListXlsx(b, 'customers', new Uint8Array(wb), { displayName: 'Customer', email: 'E-mail', billingAddress_city: 'City' });
    expect(c.customers).toBe(2);
    const [one] = await b.db.select().from(customers).where(and(eq(customers.companyId, b.companyId), eq(customers.displayName, 'Xlsx One')));
    expect(one.email).toBe('one@x.test');

    const acctWb = buildXlsx({
      columns: [{ header: 'Number' }, { header: 'Account' }, { header: 'Type' }],
      rows: [
        ['7000', 'Travel', 'EXP'],
        ['7010', 'Travel:Airfare', 'EXP'],
      ],
    });
    const ac = await importListXlsx(b, 'accounts', new Uint8Array(acctWb), { code: 'Number', name: 'Account', type: 'Type' });
    expect(ac.accounts).toBe(2);
    const pb = await accountPaths(b);
    expect(pb.get('Travel:Airfare')?.code).toBe('7010');

    // Our own items export re-imports cleanly into a company that lacks those items.
    const itemsX = await exportList(a, 'items', 'xlsx');
    const [user2] = await db.insert(users).values({ email: 'iifexport2@test.local', name: 'Owner2', passwordHash: 'x' }).returning();
    const cc = await createCompany(db, { name: 'Third Co', ownerId: user2.id });
    const c3: ServiceContext = { db, companyId: cc.id, userId: user2.id };
    const ir = await importListXlsx(c3, 'items', new Uint8Array(itemsX.body as Buffer), { name: 'Name', type: 'Type', salesPrice: 'Sales Price', description: 'Description' });
    expect(ir.items).toBeGreaterThanOrEqual(5);
  });
});
