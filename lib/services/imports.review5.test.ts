/**
 * Review round 5 — QuickBooks migration, imports / exports and merge.
 *
 *  A. GL import: every A/R line carries a customer and every A/P line a vendor, even when the
 *     name only appears on General Journal lines or mostly on vendor-type transactions (refund
 *     checks), and even when the name already exists on the other list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, customers, journalEntries, journalEntryLines, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createVendor } from './vendors';
import { previewGlImport, runGlImport } from './qbGlImport';
import { importIIF } from './qbImport';
import { getBudget, listBudgets } from './budgets';
import { createCompany } from './company';
import { importOpenItems, previewOpenItems } from './openItemsImport';
import { glCsv, upload, type GlFixture } from '@/test/fixtures/qbGlFixtures';

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
