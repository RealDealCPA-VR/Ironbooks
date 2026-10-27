/**
 * Round-5 review regressions (year-end close):
 *  A. The closing entry posts net income to the company's Retained Earnings account (the
 *     equity account of type Retained Earnings), whatever its number. It used to take whatever
 *     account had number 3900 — in a chart without a 3900 Retained Earnings that is the
 *     "Opening Balance Equity" account the app creates at 3900 for the first opening balance,
 *     so the year's profit landed in Opening Balance Equity.
 *  B. The Year-End Close window names the account the profit went to (it always said
 *     "Retained Earnings (3900)", also when that was another account).
 *  C. A year-end closing entry can be voided from the journal window, not reversed: the reversal
 *     (an ordinary entry dated Jan 1) was counted by the next year's Profit & Loss, which then
 *     showed the whole closed year's income and expenses again.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount, findOrCreateOpeningBalanceEquity, getAccount } from './accounts';
import { postJournalEntry } from './posting';
import { yearEndClose } from './fiscalClose';
import { reverseEntry, voidEntry } from './journal';
import { profitAndLoss } from './reports';
import { isJournalScreenEntry } from '@/lib/journalScreen';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-fiscal-close');
let db: DB;
let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as yearEndPOST } from '@/app/api/year-end-close/route';

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

  it('B: the close reports which account took the net income', async () => {
    const [bank] = (await db.query.accounts.findMany({ where: (a, { and, eq }) => and(eq(a.companyId, ctx.companyId), eq(a.code, '1000')) }));
    const [sales] = (await db.query.accounts.findMany({ where: (a, { and, eq }) => and(eq(a.companyId, ctx.companyId), eq(a.code, '4000')) }));
    await postJournalEntry(ctx, {
      date: new Date('2025-03-01T00:00:00Z'),
      description: 'Cash sale',
      lines: [
        { accountId: bank.id, debit: '40.00' },
        { accountId: sales.id, credit: '40.00' },
      ],
    });
    const res = await yearEndPOST(
      new NextRequest('http://localhost/api/year-end-close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fiscalYear: 2025 }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { netIncome: string; retainedEarnings?: { code: string; name: string } };
    expect(body.netIncome).toBe('40.00');
    expect(body.retainedEarnings).toEqual({ code: '3200', name: 'Retained Earnings' });
  });

  it("C: a year-end closing entry can be voided but not reversed (the reversal landed in next year's P&L)", async () => {
    const [bank] = await db.query.accounts.findMany({ where: (a, { and, eq }) => and(eq(a.companyId, ctx.companyId), eq(a.code, '1000')) });
    const [sales] = await db.query.accounts.findMany({ where: (a, { and, eq }) => and(eq(a.companyId, ctx.companyId), eq(a.code, '4000')) });
    await postJournalEntry(ctx, {
      date: new Date('2023-05-01T00:00:00Z'),
      description: 'Cash sale',
      lines: [
        { accountId: bank.id, debit: '70.00' },
        { accountId: sales.id, credit: '70.00' },
      ],
    });
    const closed = await yearEndClose(ctx, { fiscalYear: 2023 });
    expect(isJournalScreenEntry(closed.entry.sourceRef, 'reverse')).toBe(false);
    expect(isJournalScreenEntry(closed.entry.sourceRef, 'void')).toBe(true);
    await expect(reverseEntry(ctx, closed.entry.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    // 2024's P&L is untouched by 2023's close.
    const pl2024 = await profitAndLoss(ctx, { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-12-31T00:00:00Z') });
    expect(pl2024.netIncome).toBe('300.00');
    // Voiding the closing entry still works (the way to take a year-end close back).
    await voidEntry(ctx, closed.entry.id);
  });
});
