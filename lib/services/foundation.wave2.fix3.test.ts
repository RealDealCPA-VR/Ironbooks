/**
 * Wave-2 GL foundation — fix round 3 regression tests.
 *
 *  - I11 central guard (posting.ts assertControlAccountNames): any sourced posting that is not a
 *    customer / vendor document refuses an unnamed A/R or A/P line, with a plain-language error.
 *  - Transfer Funds into / out of A/R or A/P is refused by the database (0025 trigger).
 *  - Reversing a document's journal entry (unnamed A/R) is refused; a named manual entry
 *    still reverses.
 *  - Sub-accounts must share the parent's QuickBooks type on update too (parent change and
 *    type change of an account with sub-accounts).
 *  - A/R and A/P accounts take no opening balance.
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, transfers, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createAccount, updateAccount } from './accounts';
import { createManualEntry, reverseEntry } from './journal';
import { createInvoice } from './invoices';
import { createTransfer } from './transfers';
import { postJournalEntry, isSubledgerSource } from './posting';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-fix3');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const DAY = new Date(2026, 6, 15);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-fix3@test.local', name: 'Fix3', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation Fix3 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '4000', '6000']) {
    const [row] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
    code[c] = row!.id;
  }
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('I11 central guard on A/R and A/P lines', () => {
  it('classifies customer/vendor document sources as subledger sources', () => {
    for (const s of ['invoice:x', 'payment:x', 'credit_memo:x', 'bill:x', 'vendor:x', 'vendor_credit:x', 'customer:x', 'refund:x']) {
      expect(isSubledgerSource(s)).toBe(true);
    }
    for (const s of ['manual', 'expense:x', 'deposit:pending', 'account:x', 'bank_transaction:x', 'reversal:x', 'fx_adjustment', null]) {
      expect(isSubledgerSource(s)).toBe(false);
    }
  });

  it('a sourced non-document posting with an unnamed A/R line is refused in plain language', async () => {
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'categorized bank line',
        sourceRef: 'bank_transaction:00000000-0000-0000-0000-000000000001',
        lines: [
          { accountId: code['1000'], debit: '10.00' },
          { accountId: code['1200'], credit: '10.00' },
        ],
      }),
    ).rejects.toThrow(/Accounts Receivable account.*customer name/);
  });

  it('an A/P line naming a customer (not a vendor) is refused too', async () => {
    const c = (await createCustomer(ctx, { displayName: 'Fix3 Wrong Kind' })).id;
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'wrong kind of name',
        sourceRef: 'expense:x',
        lines: [
          { accountId: code['2000'], debit: '10.00', entityType: 'customer', entityId: c },
          { accountId: code['1000'], credit: '10.00' },
        ],
      }),
    ).rejects.toThrow(/Accounts Payable account.*vendor name/);
  });

  it('a transfer into A/R is refused (posting guard first, database trigger behind it)', async () => {
    // Fix round 4: a posting with no source is no longer exempt, so the posting guard refuses it
    // before the transfers row is written.
    await expect(
      createTransfer(ctx, { date: DAY, fromAccountId: code['1000'], toAccountId: code['1200'], amount: '5.00' }),
    ).rejects.toThrow(/Accounts Receivable/);
    // The database trigger still refuses a transfers row on A/R written by any other path.
    await expect(
      db.insert(transfers).values({
        companyId: ctx.companyId,
        date: DAY,
        fromAccountId: code['1000'],
        toAccountId: code['1200'],
        amount: '5.00',
      }),
    ).rejects.toThrow(/cannot be transferred into or out of it/);
  });

  it('reversing an invoice entry (unnamed A/R) is refused; a named journal entry still reverses', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Fix3 Reversal' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: DAY,
      dueDate: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '25.00' }],
    });
    expect(inv.postedEntryId).toBeTruthy();
    await expect(reverseEntry(ctx, inv.postedEntryId!, DAY)).rejects.toThrow(/customer name/);

    const je = await createManualEntry(ctx, {
      date: DAY,
      description: 'Fix3 named charge',
      lines: [
        { accountId: code['1200'], debit: '12.00', entityType: 'customer', entityId: cust },
        { accountId: code['4000'], credit: '12.00' },
      ],
    });
    const rev = await reverseEntry(ctx, (je as { id: string }).id, DAY);
    expect(rev.id).toBeTruthy();
  });
});

describe('Chart of accounts: A/R / A/P opening balances and sub-account types', () => {
  it('refuses an opening balance on new A/R and A/P accounts; zero is fine', async () => {
    await expect(
      createAccount(ctx, { code: '9301', name: 'Fix3 AR', qbType: 'accounts_receivable', openingBalance: '1.00' }),
    ).rejects.toThrow(/cannot have an opening balance/);
    await expect(
      createAccount(ctx, { code: '9302', name: 'Fix3 AP', qbType: 'accounts_payable', openingBalance: '-1.00' }),
    ).rejects.toThrow(/cannot have an opening balance/);
    const ok = await createAccount(ctx, { code: '9303', name: 'Fix3 AR ok', qbType: 'accounts_receivable', openingBalance: '0' });
    expect(ok.id).toBeTruthy();
  });

  it('refuses moving an account under a parent of another QB type', async () => {
    const exp = await createAccount(ctx, { code: '9310', name: 'Fix3 Expense', qbType: 'expense' });
    await expect(updateAccount(ctx, exp.id, { parentId: code['1200'] })).rejects.toThrow(/same type as its parent/);
    // Same type is fine.
    const exp2 = await createAccount(ctx, { code: '9311', name: 'Fix3 Expense child', qbType: 'expense', parentId: exp.id });
    expect(exp2.parentId).toBe(exp.id);
  });

  it('refuses changing the type of a sub-account away from its parent, or of a parent with sub-accounts', async () => {
    const parent = await createAccount(ctx, { code: '9320', name: 'Fix3 Parent', qbType: 'expense' });
    const child = await createAccount(ctx, { code: '9321', name: 'Fix3 Child', qbType: 'expense', parentId: parent.id });
    await expect(updateAccount(ctx, child.id, { qbType: 'other_expense' })).rejects.toThrow(/same type as its parent/);
    await expect(updateAccount(ctx, parent.id, { qbType: 'other_expense' })).rejects.toThrow(/sub-accounts of a different type/);
    // Changing type and parent together to a consistent pair works (detach + retype).
    const moved = await updateAccount(ctx, child.id, { qbType: 'other_expense', parentId: null });
    expect(moved.parentId).toBeNull();
  });
});
