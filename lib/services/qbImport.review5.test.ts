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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, invoices, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { importIIF } from './qbImport';
import { importOpenItems } from './openItemsImport';
import { runGlImport } from './qbGlImport';
import { glCsv, upload, SAMPLE_GL } from '@/test/fixtures/qbGlFixtures';

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
