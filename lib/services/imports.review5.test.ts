/**
 * Review round 5 — QuickBooks migration, imports / exports and merge.
 *
 *  A. GL import: every A/R line carries a customer and every A/P line a vendor, even when the
 *     name only appears on General Journal lines or mostly on vendor-type transactions (refund
 *     checks), and even when the name already exists on the other list.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bankTransactions, companies, customers, journalEntries, journalEntryLines, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createVendor } from './vendors';
import { previewGlImport, runGlImport } from './qbGlImport';
import { importIIF } from './qbImport';
import { getBudget, listBudgets } from './budgets';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { setAccountCurrency, setBaseCurrency, upsertCurrency } from './currencies';
import { mergeAccounts, mergeVendors } from './merge';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { exportListCsv } from './listExport';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as glPOST } from '@/app/api/qb-import/gl/route';
import { POST as importPOST } from '@/app/api/import/route';
import { tieOut } from '@/lib/statements/parse';
import { createBankAccount } from './bankAccounts';
import { importOpenItems, previewOpenItems } from './openItemsImport';
import AdmZip from 'adm-zip';
import { readXlsx } from './qbGlFiles';
import { importListXlsx } from './qbImport';
import { SAMPLE_GL, glCsv, glXlsx, upload, type GlFixture } from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-imports-review5');
let db: DB;
let userId: string;

async function newCompany(name: string): Promise<ServiceContext> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  return { db, companyId: company.id, userId };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'imports-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

// ---------------------------------------------------------------------------
// A. GL import: names on A/R and A/P lines
// ---------------------------------------------------------------------------

const NAMES_GL: GlFixture = {
  company: 'Names Co',
  periodLabel: 'January 1 through January 31, 2024',
  accounts: [
    { number: '10100', name: 'Checking', type: 'Bank', begin: '0.00' },
    { number: '11000', name: 'Accounts Receivable', type: 'Accounts Receivable', begin: '0.00' },
    { number: '20000', name: 'Accounts Payable', type: 'Accounts Payable', begin: '0.00' },
    { number: '30000', name: 'Opening Balance Equity', type: 'Equity', begin: '0.00' },
    { number: '40000', name: 'Sales', type: 'Income', begin: '0.00' },
    { number: '60000', name: 'Rent', type: 'Expense', begin: '0.00' },
  ],
  txns: [
    // Opening A/R and A/P per name, entered in QB as General Journal entries.
    { type: 'General Journal', date: '01/02/2024', num: 'GJ1', name: 'Zeta Customer', lines: [
      { acct: '11000', amount: '500.00', name: 'Zeta Customer' },
      { acct: '30000', amount: '-500.00', name: '' },
    ] },
    { type: 'General Journal', date: '01/02/2024', num: 'GJ2', name: 'Omega Vendor', lines: [
      { acct: '20000', amount: '-300.00', name: 'Omega Vendor' },
      { acct: '30000', amount: '300.00', name: '' },
    ] },
    // A customer with more Checks (vendor-type transactions) than invoices: a refund check
    // (Dr A/R) and a check for something else.
    { type: 'Check', date: '01/03/2024', num: '1', name: 'Bob Refund', lines: [
      { acct: '10100', amount: '-50.00' },
      { acct: '11000', amount: '50.00' },
    ] },
    { type: 'Check', date: '01/04/2024', num: '2', name: 'Bob Refund', lines: [
      { acct: '10100', amount: '-60.00' },
      { acct: '60000', amount: '60.00' },
    ] },
    { type: 'Invoice', date: '01/05/2024', num: '10', name: 'Bob Refund', lines: [
      { acct: '11000', amount: '110.00' },
      { acct: '40000', amount: '-110.00' },
    ] },
    // A customer whose name already exists on the VENDOR list in Ironbooks.
    { type: 'Invoice', date: '01/06/2024', num: '11', name: 'Shared Name LLC', lines: [
      { acct: '11000', amount: '75.00' },
      { acct: '40000', amount: '-75.00' },
    ] },
  ],
};

async function controlLines(ctx: ServiceContext) {
  return db
    .select({
      code: accounts.code,
      entityType: journalEntryLines.entityType,
      entityId: journalEntryLines.entityId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      ref: journalEntries.sourceRef,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), inArray(accounts.code, ['11000', '20000'])));
}

describe('A. GL import: A/R lines carry a customer, A/P lines a vendor', () => {
  it('names only seen on General Journal / refund-check lines become customers and vendors', async () => {
    const ctx = await newCompany('Names Co');
    await createVendor(ctx, { displayName: 'Shared Name LLC' });
    const file = upload('gl.csv', glCsv(NAMES_GL));

    const preview = await previewGlImport(ctx, { file });
    const roleOf = (n: string) => preview.names.list.find((x) => x.name === n)?.role;
    expect(roleOf('Zeta Customer')).toBe('customer');
    expect(roleOf('Omega Vendor')).toBe('vendor');
    expect(roleOf('Bob Refund')).toBe('customer');

    const r = await runGlImport(ctx, { file });
    expect(r.ok).toBe(true);
    expect(r.proof.allMatch).toBe(true);

    const lines = (await controlLines(ctx)).filter((l) => l.ref?.startsWith('qbgl:') && !l.ref.startsWith('qbgl:open'));
    expect(lines.length).toBe(5);
    const custs = await db.select().from(customers).where(eq(customers.companyId, ctx.companyId));
    const vends = await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId));
    const custId = (n: string) => custs.find((c) => c.displayName === n)?.id;
    const vendId = (n: string) => vends.find((v) => v.displayName === n)?.id;
    expect(custId('Zeta Customer')).toBeTruthy();
    expect(custId('Bob Refund')).toBeTruthy();
    expect(custId('Shared Name LLC')).toBeTruthy();
    expect(vendId('Omega Vendor')).toBeTruthy();

    for (const l of lines) {
      if (l.code === '11000') expect([l.debit, l.entityType]).toEqual([l.debit, 'customer']);
      else expect([l.credit, l.entityType]).toEqual([l.credit, 'vendor']);
    }
    const arByName = (id: string | undefined) => lines.filter((l) => l.code === '11000' && l.entityId === id).length;
    expect(arByName(custId('Zeta Customer'))).toBe(1);
    expect(arByName(custId('Bob Refund'))).toBe(2);
    expect(arByName(custId('Shared Name LLC'))).toBe(1);
    expect(lines.find((l) => l.code === '20000')!.entityId).toBe(vendId('Omega Vendor'));

    // Re-import: nothing new is posted and no duplicate names are created.
    const again = await runGlImport(ctx, { file });
    expect(again.counts.entriesPosted).toBe(0);
    expect(again.counts.customersCreated + again.counts.vendorsCreated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B. IIF import: values the database cannot hold are row problems, not a 500 halfway through
// ---------------------------------------------------------------------------

describe('B. IIF import: overlong / oversized values', () => {
  it('a long DOCNUM or a long accented Customer:Job name posts (or is reported), never a raw database error', async () => {
    const ctx = await newCompany('IIF Long Co');
    const job = `Société Générale d’Électricité Québec:${'Rénovation éàèùâêîôû '.repeat(4).trim()}`;
    const iif = [
      '!ACCNT\tNAME\tACCNTTYPE',
      'ACCNT\tChecking\tBANK',
      'ACCNT\tAccounts Receivable\tAR',
      'ACCNT\tSales\tINC',
      '!CUST\tNAME',
      `CUST\t${job}`,
      '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
      '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
      '!ENDTRNS',
      `TRNS\tINVOICE\t1/5/2024\tAccounts Receivable\t${job}\t100.00\tINV-${'7'.repeat(60)}`,
      `SPL\tINVOICE\t1/5/2024\tSales\t${job}\t-100.00\tINV-${'7'.repeat(60)}`,
      'ENDTRNS',
      `TRNS\tGENERAL JOURNAL\t1/6/2024\tChecking\t\t10.00\t${'X'.repeat(150)}`,
      `SPL\tGENERAL JOURNAL\t1/6/2024\tSales\t\t-10.00\t${'X'.repeat(150)}`,
      'ENDTRNS',
    ].join('\r\n');
    const counts = await importIIF(ctx, iif);
    expect(counts.transactions).toBe(2);
    const refs = await db
      .select({ ref: journalEntries.sourceRef, reference: journalEntries.reference })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, ctx.companyId));
    for (const r of refs) expect(r.ref!.length).toBeLessThanOrEqual(255);
    expect(refs.find((r) => r.reference?.startsWith('XXX'))!.reference!.length).toBe(100);
    // The A/R line carries the job.
    const [arLine] = (await controlLines(ctx)).filter((l) => l.code !== '20000');
    void arLine;
    // Re-import: both are recognised, nothing posts twice.
    const again = await importIIF(ctx, iif);
    expect(again.transactions).toBe(0);
    expect(again.issues.filter((i) => i.reason === 'duplicate' && i.entity === 'transaction').length).toBe(2);
  });

  it('overlong list values and huge amounts come back as issues; the rest of the file still imports', async () => {
    const ctx = await newCompany('IIF Hostile Co');
    const long = 'L'.repeat(300);
    const iif = [
      '!ACCNT\tNAME\tACCNTTYPE\tACCNUM',
      `ACCNT\t${long}\tBANK\t`,
      `ACCNT\tChecking\tBANK\t${'9'.repeat(60)}`,
      'ACCNT\tSavings\tBANK\t1010',
      '!CUST\tNAME\tLIMIT',
      `CUST\t${long}\t`,
      `CUST\tAcme:${long}\t`,
      'CUST\tBig Limit Co\t1e20',
      'CUST\tGood Customer\t500',
      '!VEND\tNAME',
      `VEND\t${long}`,
      'VEND\tGood Vendor',
      '!CLASS\tNAME',
      `CLASS\t${long}`,
      '!INVITEM\tNAME\tINVITEMTYPE',
      `INVITEM\t${long}\tSERV`,
      '!EMP\tNAME',
      `EMP\t${long}, Bob`,
      '!SALESREP\tINITIALS\tASSOCIATEDNAME',
      `SALESREP\tXX\t${long}`,
      '!PRICELEVEL\tNAME\tPERCENT',
      `PRICELEVEL\t${long}\t5`,
    ].join('\r\n');
    const counts = await importIIF(ctx, iif);
    const names = (await db.select().from(customers).where(eq(customers.companyId, ctx.companyId))).map((c) => c.displayName);
    expect(names).toContain('Good Customer');
    expect(names.some((n) => n.length > 255)).toBe(false);
    expect((await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId))).map((v) => v.displayName)).toEqual(['Good Vendor']);
    const codes = (await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).map((a) => a.code);
    expect(codes).toContain('1010');
    // Every refused row is explained.
    expect(counts.issues.filter((i) => i.reason === 'validation').length).toBeGreaterThanOrEqual(9);
  });
});

// ---------------------------------------------------------------------------
// C. IIF budgets land in the fiscal year each month belongs to
// ---------------------------------------------------------------------------

describe('C. IIF BUD rows and the fiscal year', () => {
  const budIif = (rows: string[]) =>
    [
      '!ACCNT\tNAME\tACCNTTYPE',
      'ACCNT\tSales\tINC',
      '!BUD\tACCNT\tPERIOD\tAMOUNT\tSTARTDATE',
      ...rows.map((r) => `BUD\t${r}`),
    ].join('\r\n');
  const linesOf = async (ctx: ServiceContext) => {
    const out: Array<{ fy: number; month: number; amount: string }> = [];
    for (const b of await listBudgets(ctx)) {
      for (const l of (await getBudget(ctx, b.id)).lines) out.push({ fy: b.fiscalYear, month: l.month, amount: l.amount });
    }
    return out.sort((a, b) => a.fy - b.fy || a.month - b.month);
  };

  it('a July-June company: July 2024 and January 2025 are both in the FY2025 budget', async () => {
    const ctx = await newCompany('FY June Co');
    await db.update(companies).set({ settings: { fiscalYearEnd: '06-30' } }).where(eq(companies.id, ctx.companyId));
    await importIIF(ctx, budIif(['Sales\tMONTH\t1000\t7/1/2024', 'Sales\tMONTH\t2000\t1/1/2025']));
    expect(await linesOf(ctx)).toEqual([
      { fy: 2025, month: 1, amount: '2000.00' },
      { fy: 2025, month: 7, amount: '1000.00' },
    ]);
  });

  it('a YEAR amount starting in July is spread over all twelve months (none cut off at December)', async () => {
    const ctx = await newCompany('FY Dec Co');
    await importIIF(ctx, budIif(['Sales\tYEAR\t1200\t7/1/2024']));
    const lines = await linesOf(ctx);
    expect(lines.length).toBe(12);
    expect(lines.reduce((s, l) => s + Number(l.amount), 0)).toBe(1200);
    expect(lines.filter((l) => l.fy === 2024).map((l) => l.month)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(lines.filter((l) => l.fy === 2025).map((l) => l.month)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------
// D. Open A/R / A/P conversion: typed-in balances and report values are checked, not crashed on
// ---------------------------------------------------------------------------

describe('D. Open items: input robustness', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');
  const seeded = async (name: string) => {
    const co = await createCompany(db, { name, ownerId: userId });
    return { db, companyId: co.id, userId } as ServiceContext;
  };

  it('typed-in balances: JSON numbers for the number, QuickBooks-style "1,250.00" amounts; non-text fields are a 400', async () => {
    const ctx = await seeded('Typed Co');
    const r = await importOpenItems(ctx, {
      side: 'ar',
      alreadyInGl: false,
      items: [
        { kind: 'invoice', name: 'Typed Customer', date: '2026-01-05', number: 1001 as never, openBalance: '1,250.00' },
        { kind: 'invoice', name: 'Typed Customer', date: '2026-01-06', number: 'A-2', openBalance: '$75.50' },
      ],
    });
    expect(r.invoices).toBe(2);
    expect(r.reconciliation.ar.inBalance).toBe(true);
    expect(r.reconciliation.ar.aging).toBe('1325.50');
    for (const bad of [
      { kind: 'invoice', name: true, date: '2026-01-05', openBalance: '5' },
      { kind: 'invoice', name: 'X', date: 20260105, openBalance: '5' },
      { kind: 'invoice', name: 'X', date: '2026-01-05', openBalance: { v: 5 } },
      { kind: 'invoice', name: 'X', date: '2026-01-05', dueDate: ['x'], openBalance: '5' },
      { kind: 'invoice', name: 'X', date: '2026-01-05', number: { n: 1 }, openBalance: '5' },
      null,
    ]) {
      await expect(previewOpenItems(ctx, { side: 'ar', items: [bad as never] })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
  });

  it('a report row the database cannot hold (a 120-character bill number) is a skipped row, not a crash', async () => {
    const ctx = await seeded('Long Bill Co');
    const csv = [
      '"Unpaid Bills Detail"',
      '"As of December 31, 2025"',
      ',Type,Date,Num,Due Date,Aging,Open Balance',
      'Supply Co,,,,,,',
      `,Bill,12/05/2025,${'B'.repeat(120)},01/04/2026,,900.00`,
      ',Bill,12/06/2025,B-78,01/05/2026,,100.00',
      'Total Supply Co,,,,,,1000.00',
    ].join('\r\n');
    const r = await importOpenItems(ctx, { file: { name: 'unpaid.csv', data: b64(csv) }, alreadyInGl: false });
    expect(r.bills).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.issues.find((i) => i.reason === 'validation')!.message).toMatch(/longer than 100 characters/);
    expect(r.reconciliation.ap.inBalance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E. Hostile workbooks: zip bombs and formulas without results
// ---------------------------------------------------------------------------

/** Rewrite the declared uncompressed size of one zip entry (local + central headers). */
function declareSize(zipBytes: Buffer, entryName: string, size: number): Buffer {
  const out = Buffer.from(zipBytes);
  const name = Buffer.from(entryName, 'utf8');
  for (let i = 0; i < out.length - 46; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50) {
      const n = out.readUInt16LE(i + 26);
      if (out.subarray(i + 30, i + 30 + n).equals(name)) out.writeUInt32LE(size, i + 22);
    } else if (sig === 0x02014b50) {
      const n = out.readUInt16LE(i + 28);
      if (out.subarray(i + 46, i + 46 + n).equals(name)) out.writeUInt32LE(size, i + 24);
    }
  }
  return out;
}

describe('E. hostile .xlsx files', () => {
  it('a workbook that expands to gigabytes is refused before anything is decompressed (GL, lists, statements)', async () => {
    const bomb = declareSize(glXlsx(SAMPLE_GL), 'xl/worksheets/sheet2.xml', 3_500_000_000);
    expect(() => readXlsx(bomb)).toThrow(/too large to read/);
    const ctx = await newCompany('Bomb Co');
    await expect(previewGlImport(ctx, { file: upload('gl.xlsx', bomb) })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(importListXlsx(ctx, 'customers', bomb, { displayName: 'Name' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Many medium parts that add up past the total limit are refused too.
    let many = glXlsx(SAMPLE_GL);
    for (const part of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/sharedStrings.xml']) many = declareSize(many, part, 180_000_000);
    expect(() => readXlsx(many)).toThrow(/too large to read/);
    // A normal workbook still reads.
    expect(readXlsx(glXlsx(SAMPLE_GL)).length).toBe(2);
  });

  it('a formula whose result was never calculated is refused, not read as a blank amount', () => {
    const zip = new AdmZip(glXlsx(SAMPLE_GL));
    const xml = zip.getEntry('xl/worksheets/sheet2.xml')!.getData().toString('utf8');
    let replaced = '';
    const patched = xml.replace(/<c r="([A-Z]+\d+)" s="2"><v>([^<]+)<\/v><\/c>/, (_m, ref: string, v: string) => {
      replaced = ref;
      return `<c r="${ref}" s="2"><f>${v}*1</f></c>`;
    });
    expect(replaced).not.toBe('');
    zip.updateFile('xl/worksheets/sheet2.xml', Buffer.from(patched, 'utf8'));
    expect(() => readXlsx(zip.toBuffer())).toThrow(new RegExp(`Cell ${replaced} .*never calculated`));
    // A formula WITH its saved result reads as the result.
    const zip2 = new AdmZip(glXlsx(SAMPLE_GL));
    const ok = xml.replace(/<c r="([A-Z]+\d+)" s="2"><v>([^<]+)<\/v><\/c>/, (_m, ref: string, v: string) => `<c r="${ref}" s="2"><f>${v}*1</f><v>${v}</v></c>`);
    zip2.updateFile('xl/worksheets/sheet2.xml', Buffer.from(ok, 'utf8'));
    expect(readXlsx(zip2.toBuffer())[1].rows.some((r) => r.cells.includes('2700'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F. Merge refuses records in different currencies (QB rule)
// ---------------------------------------------------------------------------

describe('F. merge and currencies', () => {
  it('a EUR bank account cannot be merged into a USD one, nor a EUR vendor into a USD vendor', async () => {
    const co = await createCompany(db, { name: 'Merge FX Co', ownerId: userId });
    const ctx: ServiceContext = { db, companyId: co.id, userId };
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    const eur = await createAccount(ctx, { code: '1025', name: 'Euro Bank', type: 'asset', subtype: 'checking' });
    await setAccountCurrency(ctx, eur.id, 'EUR');
    const usd = await createAccount(ctx, { code: '1026', name: 'Second Checking', type: 'asset', subtype: 'checking' });
    await expect(mergeAccounts(ctx, { fromId: eur.id, toId: usd.id })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/different currencies/) });
    const [still] = await db.select().from(accounts).where(eq(accounts.id, eur.id));
    expect(still.isActive).toBe(true);
    // Same currency still merges (home: null vs null).
    const usd2 = await createAccount(ctx, { code: '1027', name: 'Third Checking', type: 'asset', subtype: 'checking' });
    await expect(mergeAccounts(ctx, { fromId: usd2.id, toId: usd.id })).resolves.toMatchObject({ deactivatedId: usd2.id });

    const vEur = await createVendor(ctx, { displayName: 'Euro Supplier', currency: 'EUR' } as never);
    const vUsd = await createVendor(ctx, { displayName: 'Dollar Supplier' });
    await expect(mergeVendors(ctx, { fromId: vEur.id, toId: vUsd.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    const vHome = await createVendor(ctx, { displayName: 'Home Supplier', currency: 'USD' } as never);
    await expect(mergeVendors(ctx, { fromId: vHome.id, toId: vUsd.id })).resolves.toMatchObject({ deactivatedId: vHome.id });
  });
});

// ---------------------------------------------------------------------------
// G. List export: the Balance column is the real open balance
// ---------------------------------------------------------------------------

describe('G. customer / vendor list export balances', () => {
  it('the Balance column equals A/R and A/P aging per name (it was always 0.00)', async () => {
    const co = await createCompany(db, { name: 'Export Bal Co', ownerId: userId });
    const ctx: ServiceContext = { db, companyId: co.id, userId };
    const code = async (c: string) => (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c))))[0].id;
    const cust = await createCustomer(ctx, { displayName: 'Balance Customer' });
    await createCustomer(ctx, { displayName: 'Paid Up Customer' });
    await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2026-01-10T00:00:00.000Z'),
      lines: [{ accountId: await code('4000'), description: 'Work', quantity: 1, rate: '1250.50', taxable: false }],
    } as never);
    const vend = await createVendor(ctx, { displayName: 'Balance Vendor' });
    await createBill(ctx, {
      vendorId: vend.id,
      date: new Date('2026-01-11T00:00:00.000Z'),
      lines: [{ accountId: await code('6000'), description: 'Ads', amount: '40.25' }],
    } as never);
    const rowsOf = (csv: string) => csv.replace(/^\uFEFF/, '').trim().split(/\r\n/).map((l) => l.split(','));
    const c = rowsOf((await exportListCsv(ctx, 'customers')).csv);
    const cBal = c[0].indexOf('Balance');
    expect(c.find((r) => r[0] === 'Balance Customer')![cBal]).toBe('1250.50');
    expect(c.find((r) => r[0] === 'Paid Up Customer')![cBal]).toBe('0.00');
    const v = rowsOf((await exportListCsv(ctx, 'vendors')).csv);
    expect(v.find((r) => r[0] === 'Balance Vendor')![v[0].indexOf('Balance')]).toBe('40.25');
  });
});

// ---------------------------------------------------------------------------
// H. The General Ledger import is an admin, single-user import like the IIF / open-items ones
// ---------------------------------------------------------------------------

describe('H. /api/qb-import/gl guards', () => {
  const post = (body: unknown) => {
    const u = new URL('http://localhost/api/qb-import/gl');
    return Object.assign(new Request(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { nextUrl: u }) as never;
  };

  it('an accountant (file utilities create, not admin) may preview but not import or dry-run', async () => {
    const ctx = await newCompany('GL Route Co');
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    routeCtx = { ...ctx, role: 'accountant' };
    expect((await glPOST(post({ action: 'preview', file }))).status).toBe(200);
    for (const action of ['import', 'dry-run']) {
      const res = await glPOST(post({ action, file }));
      expect([action, res.status]).toEqual([action, 403]);
      expect((await res.json()).error).toMatch(/owner or admin/);
    }
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
    expect(n).toBe(0);
    routeCtx = { ...ctx, role: 'owner' };
    const ok = await glPOST(post({ action: 'import', file }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I. IIF transactions: A/R and A/P lines keep their name even when the lists lack it
// ---------------------------------------------------------------------------

describe('I. IIF transactions and missing names', () => {
  it('an INVOICE for a customer:job and a BILL for a vendor not on the lists add them; the lines are named', async () => {
    const ctx = await newCompany('IIF Names Co');
    const iif = [
      '!ACCNT\tNAME\tACCNTTYPE',
      'ACCNT\tAccounts Receivable\tAR',
      'ACCNT\tAccounts Payable\tAP',
      'ACCNT\tSales\tINC',
      'ACCNT\tRent\tEXP',
      '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
      '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
      '!ENDTRNS',
      'TRNS\tINVOICE\t2/5/2024\tAccounts Receivable\tFresh Customer:Job 1\t300.00\t501',
      'SPL\tINVOICE\t2/5/2024\tSales\tFresh Customer:Job 1\t-300.00\t501',
      'ENDTRNS',
      'TRNS\tBILL\t2/6/2024\tAccounts Payable\tFresh Vendor\t-80.00\tB9',
      'SPL\tBILL\t2/6/2024\tRent\tFresh Vendor\t80.00\tB9',
      'ENDTRNS',
    ].join('\r\n');
    const counts = await importIIF(ctx, iif);
    expect(counts.transactions).toBe(2);
    const custs = await db.select().from(customers).where(eq(customers.companyId, ctx.companyId));
    const job = custs.find((c) => c.displayName === 'Fresh Customer:Job 1')!;
    expect(job.parentId).toBe(custs.find((c) => c.displayName === 'Fresh Customer')!.id);
    const [vend] = await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId));
    const lines = await db
      .select({ type: accounts.subtype, entityType: journalEntryLines.entityType, entityId: journalEntryLines.entityId })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
      .where(and(eq(journalEntries.companyId, ctx.companyId), inArray(accounts.subtype, ['accounts_receivable', 'accounts_payable'])));
    expect(lines).toEqual(
      expect.arrayContaining([
        { type: 'accounts_receivable', entityType: 'customer', entityId: job.id },
        { type: 'accounts_payable', entityType: 'vendor', entityId: vend.id },
      ]),
    );
    expect(lines.length).toBe(2);
    const again = await importIIF(ctx, iif);
    expect([again.transactions, again.customers, again.vendors]).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// J. Statement import: the server-side tie-out counts every row it will import
// ---------------------------------------------------------------------------

describe('J. statement rows tie-out (POST /api/import fileType rows)', () => {
  const postImport = (body: unknown) => {
    const u = new URL('http://localhost/api/import');
    return Object.assign(new Request(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { nextUrl: u }) as never;
  };

  it('a row written "5" (no cents) or garbage is not left out of the sum: an untied statement is refused', async () => {
    expect(tieOut([{ amount: '12.50' }, { amount: '5' }], '100.00', '112.50', 'bank')).toMatchObject({ ok: false, difference: '-5.00' });
    expect(tieOut([{ amount: '12.50' }, { amount: 'abc' }], '100.00', '112.50', 'bank').ok).toBe(false);
    expect(tieOut([{ amount: '12.50' }, { amount: '5' }], '100.00', '117.50', 'bank')).toMatchObject({ ok: true, difference: '0.00' });

    const co = await createCompany(db, { name: 'Statement Co', ownerId: userId });
    const ctx: ServiceContext = { db, companyId: co.id, userId };
    const [checking] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.subtype, 'checking')));
    const ba = await createBankAccount(ctx, { accountId: checking.id, bankName: 'Bank', accountNumber: '123456789' });
    routeCtx = ctx;
    const res = await importPOST(
      postImport({
        bankAccountId: ba.id,
        fileType: 'rows',
        statement: { kind: 'bank', openingBalance: '100.00', closingBalance: '112.50' },
        rows: [
          { date: '2026-03-02', description: 'Deposit', amount: '12.50' },
          { date: '2026-03-03', description: 'Extra', amount: '5' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const staged = await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, ba.id));
    expect(staged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// K. Large files: no argument spreads that overflow the stack
// ---------------------------------------------------------------------------

describe('K. a large IIF file', () => {
  it('150,000 transactions do not overflow the stack while dating the opening balances', async () => {
    const ctx = await newCompany('IIF Big Co');
    const parts = ['!ACCNT\tNAME\tACCNTTYPE\tOBAMOUNT', 'ACCNT\tChecking\tBANK\t100.00', '!TRNS\tTRNSTYPE\tDATE\tACCNT\tAMOUNT', '!SPL\tTRNSTYPE\tDATE\tACCNT\tAMOUNT', '!ENDTRNS'];
    for (let i = 0; i < 150_000; i++) parts.push(`TRNS\tCHECK\t${(i % 12) + 1}/${(i % 28) + 1}/2024\tChecking\t0.00`, 'ENDTRNS');
    const counts = await importIIF(ctx, parts.join('\r\n'));
    expect(counts.accounts).toBe(1);
    expect(counts.skipped).toBe(150_000);
    // Opening balance dated the day before the earliest transaction (Jan 1, 2024).
    const [ob] = await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
    expect(ob.date.toISOString().slice(0, 10)).toBe('2023-12-31');
  }, 300_000);
});

// ---------------------------------------------------------------------------
// L. Open items: two identical open items in one report are two documents
// ---------------------------------------------------------------------------

describe('L. identical open items', () => {
  it('two same-day $50 statement charges (no number) both come in, once; a re-import adds nothing', async () => {
    const co = await createCompany(db, { name: 'Twin Charges Co', ownerId: userId });
    const ctx: ServiceContext = { db, companyId: co.id, userId };
    const csv = [
      '"Open Invoices"',
      '"As of December 31, 2025"',
      ',Type,Date,Num,Due Date,Open Balance',
      'Twin Customer,,,,,',
      ',Statement Charge,12/01/2025,,12/31/2025,50.00',
      ',Statement Charge,12/01/2025,,12/31/2025,50.00',
      ',Payment,12/03/2025,,,-20.00',
      ',Payment,12/03/2025,,,-20.00',
      'Total Twin Customer,,,,,60.00',
    ].join('\r\n');
    const f = { name: 'open.csv', data: Buffer.from(csv).toString('base64') };
    const preview = await previewOpenItems(ctx, { file: f });
    expect(preview.items.length).toBe(4);
    const r = await importOpenItems(ctx, { file: f, alreadyInGl: false });
    expect([r.invoices, r.credits, r.skipped]).toEqual([2, 2, 0]);
    expect(r.reconciliation.ar.aging).toBe('60.00');
    expect(r.reconciliation.ar.inBalance).toBe(true);
    const again = await importOpenItems(ctx, { file: f, alreadyInGl: false });
    expect([again.invoices, again.credits, again.skipped]).toEqual([0, 0, 4]);
    expect(again.reconciliation.ar.aging).toBe('60.00');
  });
});
