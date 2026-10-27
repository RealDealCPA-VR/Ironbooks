/**
 * Review round 5 — QuickBooks imports run twice at once (a double click on "Run Import", two
 * windows, the same file sent again while the first is still posting).
 *
 * Every import checks "is this already in the books?" and then writes, in separate steps. Two
 * runs of the same file interleaved between those steps: an IIF file with open bills as documents
 * created every bill twice (A/P doubled), IIF transactions posted twice, and typed-in opening
 * balances failed with "Account code 3901 already exists" (both runs created Opening Balance
 * Equity). Imports into one company now run one at a time; the second run finds the first one's
 * work and adds nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, invoices, items, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { importIIF, importItemsCSV } from './qbImport';
import { importOpenItems } from './openItemsImport';
import { runGlImport } from './qbGlImport';
import { glCsv, upload, SAMPLE_GL, type GlFixture } from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbimport-review5');
let db: DB;
let userId: string;

async function newCo(name: string): Promise<ServiceContext> {
  const co = await createCompany(db, { name, ownerId: userId });
  return { db, companyId: co.id, userId };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qbimport-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
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

const BILLS_IIF = [
  '!VEND\tNAME',
  'VEND\tLandlord',
  '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
  '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
  '!ENDTRNS',
  'TRNS\tBILL\t2/6/2024\tAccounts Payable\tLandlord\t-80.00\tB9',
  'SPL\tBILL\t2/6/2024\tRent\tLandlord\t80.00\tB9',
  'ENDTRNS',
  'TRNS\tBILL\t2/7/2024\tAccounts Payable\tLandlord\t-90.00\tB10',
  'SPL\tBILL\t2/7/2024\tRent\tLandlord\t90.00\tB10',
  'ENDTRNS',
  'TRNS\tCHECK\t2/8/2024\tChecking\tLandlord\t-15.00\t1001',
  'SPL\tCHECK\t2/8/2024\tRent\tLandlord\t15.00\t1001',
  'ENDTRNS',
].join('\r\n');

describe('IIF transactions on accounts the books do not have yet', () => {
  it('an unknown 300-character account is a review account, not a raw database error halfway through', async () => {
    const ctx = await newCo('Long Account Co');
    const iif = [
      '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
      '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
      '!ENDTRNS',
      'TRNS\tGENERAL JOURNAL\t2/6/2024\tChecking\t\t80.00\t1',
      `SPL\tGENERAL JOURNAL\t2/6/2024\t${'Z'.repeat(300)}\t\t-80.00\t1`,
      'ENDTRNS',
      'TRNS\tGENERAL JOURNAL\t2/7/2024\tChecking\t\t10.00\t2',
      'SPL\tGENERAL JOURNAL\t2/7/2024\tRent\t\t-10.00\t2',
      'ENDTRNS',
    ].join('\r\n');
    const counts = await importIIF(ctx, iif);
    expect(counts.transactions).toBe(2);
    expect(counts.issues.some((i) => i.reason === 'unmatched-account')).toBe(true);
    const acctCount = async () => (await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).length;
    const before = await acctCount();
    const again = await importIIF(ctx, iif);
    expect(again.transactions).toBe(0);
    expect(await acctCount()).toBe(before); // the re-import finds the review account again
  });

  it('a payment on an account whose name has no Latin letters is posted, so the invoice it paid is not short', async () => {
    const ctx = await newCo('Cyrillic Account Co');
    const iif = [
      '!CUST\tNAME',
      'CUST\tAcme',
      '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
      '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
      '!ENDTRNS',
      'TRNS\tINVOICE\t2/6/2024\tAccounts Receivable\tAcme\t100.00\t501',
      'SPL\tINVOICE\t2/6/2024\tSales Income\tAcme\t-100.00\t501',
      'ENDTRNS',
      'TRNS\tPAYMENT\t2/7/2024\tКасса\tAcme\t40.00\t',
      'SPL\tPAYMENT\t2/7/2024\tAccounts Receivable\tAcme\t-40.00\t',
      'ENDTRNS',
    ].join('\r\n');
    const counts = await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    // The payment's 40.00 is applied to the invoice (open 60.00) — so the payment itself must be
    // in the books (Dr Касса 40), or the 40.00 has vanished.
    expect(counts.transactions).toBe(1);
    const [inv] = await db.select({ balanceDue: invoices.balanceDue }).from(invoices).where(eq(invoices.companyId, ctx.companyId));
    expect(inv.balanceDue).toBe('60.00');
    const [kassa] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Касса')));
    expect(kassa.balance).toBe('40.00');
  });
});

describe('item quantities after the General Ledger import', () => {
  const INV_GL: GlFixture = {
    company: 'Stock Co',
    periodLabel: 'January 1 through January 31, 2024',
    accounts: [
      { number: '10100', name: 'Checking', type: 'Bank', begin: '500.00' },
      { number: '13000', name: 'Inventory Asset', type: 'Other Current Asset', begin: '1000.00' },
      { number: '30000', name: 'Opening Balance Equity', type: 'Equity', begin: '-1500.00' },
      { number: '60000', name: 'Rent', type: 'Expense', begin: '0.00' },
    ],
    txns: [
      { type: 'Check', date: '01/04/2024', num: '1', name: 'Landlord', lines: [
        { acct: '10100', amount: '-100.00' },
        { acct: '60000', amount: '100.00' },
      ] },
    ],
  };
  const inventoryBalance = async (ctx: ServiceContext) =>
    (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1300'))))[0].balance;

  it('a CSV item list with quantities on hand does not post the inventory a second time', async () => {
    const ctx = await newCo('Stock CSV Co');
    const gl = await runGlImport(ctx, { file: upload('gl.csv', glCsv(INV_GL)) });
    expect(gl.ok).toBe(true);
    expect(await inventoryBalance(ctx)).toBe('1000.00');
    const csv = ['Name,Type,Cost,Qty,Value,Asset', 'Widget,inventory,25.00,40,1000.00,1300'].join('\n');
    const r = await importItemsCSV(ctx, csv, { name: 'Name', type: 'Type', purchaseCost: 'Cost', quantityOnHand: 'Qty', totalValue: 'Value', assetAccount: 'Asset' });
    expect(r.items).toBe(1);
    expect(r.openingStock).toMatchObject({ items: 1, value: '1000.00', unposted: 1 });
    // The General Ledger import already holds the 1,000.00: the stock comes in without a journal entry.
    expect(await inventoryBalance(ctx)).toBe('1000.00');
    const [w] = await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Widget')));
    expect(Number(w.quantityOnHand)).toBe(40);
  });

  it('an IIF item list with QNTY imported after the General Ledger does not either', async () => {
    const ctx = await newCo('Stock IIF Co');
    expect((await runGlImport(ctx, { file: upload('gl.csv', glCsv(INV_GL)) })).ok).toBe(true);
    const iif = ['!INVITEM\tNAME\tINVITEMTYPE\tCOST\tASSETACCNT\tQNTY\tVALUE', 'INVITEM\tGadget\tPART\t10.00\tInventory Asset\t100\t1000.00'].join('\r\n');
    const r = await importIIF(ctx, iif);
    expect(r.items).toBe(1);
    expect(await inventoryBalance(ctx)).toBe('1000.00');
  });
});

describe('"today" for an item list without an as-of date is the company\'s day', () => {
  it('at 9 pm in New York the opening stock is dated today, not tomorrow (UTC)', async () => {
    const ctx = await newCo('Evening Stock Co');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-10T02:00:00.000Z')); // Mar 9, 9:00 pm in New York
      const csv = ['Name,Type,Cost,Qty', 'Evening Widget,inventory,2.00,5'].join('\n');
      const r = await importItemsCSV(ctx, csv, { name: 'Name', type: 'Type', purchaseCost: 'Cost', quantityOnHand: 'Qty' });
      expect(r.items).toBe(1);
      const [w] = await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Evening Widget')));
      const [je] = await db.select().from(journalEntries).where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `item:${w.id}`)));
      expect(je.date.toISOString().slice(0, 10)).toBe('2026-03-09');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the same QuickBooks file imported twice at once', () => {
  it('IIF with open bills as documents: each bill and transaction comes in once', async () => {
    const ctx = await newCo('Double IIF Co');
    const settled = await Promise.allSettled([1, 2].map(() => importIIF(ctx, BILLS_IIF, { openItems: { asDocuments: true, alreadyInGl: false } })));
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
    const runs = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof importIIF>>>).value);
    expect(runs.reduce((n, r) => n + (r.openItems?.bills ?? 0), 0)).toBe(2);
    expect(runs.reduce((n, r) => n + r.transactions, 0)).toBe(1);
    expect((await db.select().from(bills).where(eq(bills.companyId, ctx.companyId))).length).toBe(2);
    const iifEntries = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'iif:%')));
    expect(iifEntries.length).toBe(1);
  });

  it('IIF transactions posted as journal entries: each one once', async () => {
    const ctx = await newCo('Double IIF JE Co');
    const runs = await Promise.allSettled([1, 2, 3].map(() => importIIF(ctx, BILLS_IIF)));
    expect(runs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const iifEntries = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'iif:%')));
    expect(iifEntries.length).toBe(3);
  });

  it('typed-in opening balances: no "account code already exists" error, each invoice once', async () => {
    const ctx = await newCo('Double Typed Co');
    const items = [1, 2, 3].map((n) => ({ kind: 'invoice' as const, name: `Customer ${n}`, date: '2025-12-01', number: `${n}`, openBalance: `${n}0.00` }));
    const runs = await Promise.allSettled([1, 2, 3].map(() => importOpenItems(ctx, { side: 'ar', alreadyInGl: false, items })));
    expect(runs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect((await db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId))).length).toBe(3);
  });

  it('General Ledger import: the second run posts nothing new instead of failing on an account number', async () => {
    const ctx = await newCo('Double GL Co');
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    // allSettled: a run that fails must not leave the other still writing after the test ends.
    const settled = await Promise.allSettled([runGlImport(ctx, { file }), runGlImport(ctx, { file })]);
    expect(settled.map((s) => (s.status === 'fulfilled' ? 'ok' : String(s.reason)))).toEqual(['ok', 'ok']);
    const [a, b] = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof runGlImport>>>).value);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(a.counts.entriesPosted + b.counts.entriesPosted).toBe(Math.max(a.counts.entriesPosted, b.counts.entriesPosted));
    expect(Math.min(a.counts.entriesPosted, b.counts.entriesPosted)).toBe(0);
  });
});
