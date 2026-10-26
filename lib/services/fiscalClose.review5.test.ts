/**
 * Round-5 review regressions (year-end close):
 *  A. The closing entry posts net income to the company's Retained Earnings account (the
 *     equity account of type Retained Earnings), whatever its number. It used to take whatever
 *     account had number 3900 — in a chart without a 3900 Retained Earnings that is the
 *     "Opening Balance Equity" account the app creates at 3900 for the first opening balance,
 *     so the year's profit landed in Opening Balance Equity.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount, findOrCreateOpeningBalanceEquity, getAccount } from './accounts';
import { postJournalEntry } from './posting';
import { yearEndClose } from './fiscalClose';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-fiscal-close');
let db: DB;
let ctx: ServiceContext;

describe('year-end close (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@close.test', name: 'Cy', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review5 Close', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: net income goes to Retained Earnings (3200), not to Opening Balance Equity at 3900', async () => {
    // A chart converted from another system: Retained Earnings is 3200.
    const re = await createAccount(ctx, { code: '3200', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings' });
    // The first opening balance creates "Opening Balance Equity" — at 3900, the first free number.
    const bank = await createAccount(ctx, {
      code: '1000',
      name: 'Checking',
      type: 'asset',
      subtype: 'checking',
      openingBalance: '500.00',
      openingBalanceDate: new Date('2024-01-01T00:00:00Z'),
    });
    const obe = await findOrCreateOpeningBalanceEquity(ctx);
    expect(obe.code).toBe('3900');
    const sales = await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue', subtype: 'sales' });
    await postJournalEntry(ctx, {
      date: new Date('2024-06-01T00:00:00Z'),
      description: 'Cash sale',
      lines: [
        { accountId: bank.id, debit: '300.00' },
        { accountId: sales.id, credit: '300.00' },
      ],
    });

    const result = await yearEndClose(ctx, { fiscalYear: 2024 });
    expect(result.netIncome).toBe('300.00');
    expect((await getAccount(ctx, re.id)).balance).toBe('300.00');
    // Opening Balance Equity still holds only the opening balance.
    expect((await getAccount(ctx, obe.id)).balance).toBe('500.00');
  });
});
