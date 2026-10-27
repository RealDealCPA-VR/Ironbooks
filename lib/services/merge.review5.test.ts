/**
 * Review round 5 — merging GL accounts (lib/services/merge.ts).
 *
 * Ironbooks posts to some accounts by their number: invoices to 1200 Accounts Receivable, bills
 * to 2000 Accounts Payable, payments to 1050 Undeposited Funds, stock to 1300 Inventory Asset,
 * sales tax to 2200, … Merging one of them AWAY (into the QuickBooks duplicate the GL import
 * created, the usual clean-up after a conversion) deactivated it, and every later invoice / bill
 * kept posting into the hidden, inactive account — A/R and A/P split in two again.
 * The merge must keep such an account as the survivor.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { mergeAccounts } from './merge';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-merge-review5');
let db: DB;
let userId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'merge-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
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

describe('merging an account Ironbooks posts to by number', () => {
  it('1200 Accounts Receivable cannot be merged away; merging the duplicate into it works and invoices land on it', async () => {
    const co = await createCompany(db, { name: 'Merge AR Co', ownerId: userId });
    const ctx: ServiceContext = { db, companyId: co.id, userId };
    const byCode = async (code: string) =>
      (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code))))[0];
    const qbAr = await createAccount(ctx, { code: '11000', name: 'Accounts Receivable - Trade', type: 'asset', subtype: 'accounts_receivable' });
    const ar = await byCode('1200');

    await expect(mergeAccounts(ctx, { fromId: ar.id, toId: qbAr.id })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/1200 Accounts Receivable.*keep/i),
    });
    expect((await byCode('1200')).isActive).toBe(true);

    // The same goes for the other accounts the app posts to by number.
    const qbAp = await createAccount(ctx, { code: '20000', name: 'Accounts Payable - Trade', type: 'liability', subtype: 'accounts_payable' });
    await expect(mergeAccounts(ctx, { fromId: (await byCode('2000')).id, toId: qbAp.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    const qbUf = await createAccount(ctx, { code: '12000', name: 'Undeposited Funds (QB)', type: 'asset', subtype: 'undeposited_funds' });
    await expect(mergeAccounts(ctx, { fromId: (await byCode('1050')).id, toId: qbUf.id })).rejects.toMatchObject({ code: 'VALIDATION' });

    // The other way round is the supported clean-up: the QB duplicate folds into 1200.
    await mergeAccounts(ctx, { fromId: qbAr.id, toId: ar.id });
    const cust = await createCustomer(ctx, { displayName: 'After Merge Customer' });
    await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2026-01-10T00:00:00.000Z'),
      lines: [{ accountId: (await byCode('4000')).id, description: 'Work', quantity: 1, rate: '100.00', taxable: false }],
    } as never);
    const arLines = await db
      .select({ active: accounts.isActive, code: accounts.code })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(accounts.subtype, 'accounts_receivable')));
    expect(arLines).toEqual([{ active: true, code: '1200' }]);
  });
});
