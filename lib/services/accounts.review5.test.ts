/**
 * Round-5 review regressions (chart of accounts / dated defaults):
 *  A. An account number that differs only by surrounding spaces is a duplicate (the uniqueness
 *     check used the raw number, the insert the trimmed one, so " 1000" created a second 1000).
 *  B. An opening balance entered without a date is dated TODAY on this computer's calendar (a
 *     ledger date: the calendar day at UTC midnight). It was stamped with the current instant, so
 *     at 9:30 pm in New York it landed on TOMORROW: today's balance sheet left it out.
 *  C. The same for a General Journal credit applied without a date (Receive Payments / Pay Bills).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createManualEntry } from './journal';
import { applyJournalCredit } from './journalApplications';
import { balanceSheet } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-accounts');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const realTz = process.env.TZ;

describe('accounts (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@accounts.test', name: 'Ace', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review5 Accounts', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    for (const [code, name, type, subtype] of [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6000', 'Bad Debt', 'expense', 'operating_expenses'],
    ] as const) {
      acct[code] = (await createAccount(ctx, { code, name, type, subtype })).id;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: " 1000" is the same number as "1000"', async () => {
    await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' });
    for (const code of [' 1000', '1000 ', '\t1000']) {
      const err = await createAccount(ctx, { code, name: 'Checking 2', type: 'asset', subtype: 'checking' }).catch((e) => e);
      expect(err, JSON.stringify(code)).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('B: an undated opening balance is dated today (local calendar day) and is on today’s balance sheet', async () => {
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T01:30:00Z')); // Oct 26, 9:30 pm in New York
    const savings = await createAccount(ctx, {
      code: '1010',
      name: 'Savings',
      type: 'asset',
      subtype: 'savings',
      openingBalance: '700.00',
    });
    const [ob] = await db
      .select({ date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `account:${savings.id}`)));
    expect(ob.date.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    // The Balance Sheet as of today (Oct 26) shows it.
    const bs = await balanceSheet(ctx, new Date('2026-10-26T00:00:00Z'));
    expect(bs.assets.find((a) => a.code === '1010')?.amount).toBe('700.00');
  });

  it('C: a General Journal credit applied without a date is dated today (local calendar day)', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Late Payer' } as never);
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2026-10-01T00:00:00Z'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '50.00' }],
    } as never);
    const je = await createManualEntry(ctx, {
      date: new Date('2026-10-20T00:00:00Z'),
      description: 'Write off',
      lines: [
        { accountId: acct['6000'], debit: '50.00' },
        { accountId: acct['1200'], credit: '50.00', entityType: 'customer', entityId: cust.id },
      ],
    });
    const [cr] = await db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, je.id), isNotNull(journalEntryLines.credit)));
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T01:30:00Z')); // Oct 26, 9:30 pm in New York
    const app = await applyJournalCredit(ctx, { journalLineId: cr.id, invoiceId: inv.id, amount: '50.00' });
    expect(app.date.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
});
