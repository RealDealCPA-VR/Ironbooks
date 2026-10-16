/**
 * Ledger review regressions (2026-10): year-end close with contra balances, closed-period
 * last-day bypass, journal-screen void/reverse of document entries, UTC reversal default,
 * contiguous fiscal-year windows around Feb 29.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { yearEndClose, fiscalYearWindow } from './fiscalClose';
import { fiscalWindowFor } from './reportEngine';
import { closePeriod } from './fiscalPeriods';
import { createBill } from './bills';
import { voidEntry, reverseEntry, createManualEntry, defaultReversalDate } from './journal';
import { vendors, bills } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ledger-review');
let ctx: ServiceContext;
let db: DB;
const a: Record<string, string> = {};

describe('review ledger', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'rl@test.local', name: 'R', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'RL Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    a.cash = (await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' })).id;
    a.re = (await createAccount(ctx, { code: '3900', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings' })).id;
    a.sales = (await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue', subtype: 'sales' })).id;
    a.disc = (await createAccount(ctx, { code: '4900', name: 'Sales Discounts', type: 'revenue', subtype: 'sales' })).id;
    a.exp = (await createAccount(ctx, { code: '6000', name: 'Expenses', type: 'expense', subtype: 'operating_expenses' })).id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('year-end close handles a revenue account with a net debit balance (contra revenue)', async () => {
    await postJournalEntry(ctx, { date: new Date('2023-03-01'), description: 's', lines: [
      { accountId: a.cash, debit: '1000.00' }, { accountId: a.sales, credit: '1000.00' } ] });
    await postJournalEntry(ctx, { date: new Date('2023-03-02'), description: 'd', lines: [
      { accountId: a.disc, debit: '50.00' }, { accountId: a.cash, credit: '50.00' } ] });
    await postJournalEntry(ctx, { date: new Date('2023-03-03'), description: 'e', lines: [
      { accountId: a.exp, debit: '200.00' }, { accountId: a.cash, credit: '200.00' } ] });
    const res = await yearEndClose(ctx, { fiscalYear: 2023 });
    expect(res.netIncome).toBe('750.00');
  });

  it('a closed fiscal period blocks a posting on its last day (year-end closing entry)', async () => {
    await postJournalEntry(ctx, { date: new Date('2024-03-01'), description: 's', lines: [
      { accountId: a.cash, debit: '100.00' }, { accountId: a.sales, credit: '100.00' } ] });
    // As the Fiscal Periods page sends it: date-only strings.
    await closePeriod(ctx, { periodStart: new Date('2024-01-01'), periodEnd: new Date('2024-12-31') });
    await expect(yearEndClose(ctx, { fiscalYear: 2024 })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
  });
  it('Journal page void refuses an entry posted by a source document (bill)', async () => {
    const ap = (await createAccount(ctx, { code: '2000', name: 'A/P', type: 'liability', subtype: 'accounts_payable' })).id;
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'V' }).returning();
    const bill = await createBill(ctx, { vendorId: v.id, date: new Date('2025-05-01'), lines: [{ accountId: a.exp, amount: '300.00' }] } as never);
    const [b] = await db.select().from(bills).where(eq(bills.id, (bill as { id: string }).id));
    await expect(voidEntry(ctx, b.postedEntryId!)).rejects.toMatchObject({ code: 'CONFLICT' });
    void ap;
    // Reverse is refused too, and nothing moved.
    await expect(reverseEntry(ctx, b.postedEntryId!, new Date('2025-06-01'))).rejects.toMatchObject({ code: 'CONFLICT' });
    // A manual entry still voids and reverses from the journal screen.
    const je = await createManualEntry(ctx, { date: new Date('2025-05-02'), description: 'm', lines: [
      { accountId: a.exp, debit: '10.00' }, { accountId: a.cash, credit: '10.00' } ] });
    await reverseEntry(ctx, je.id, new Date('2025-06-01'));
    await voidEntry(ctx, je.id);
  });

  it('closes an expense account with a net credit balance on the debit side', async () => {
    const pd = (await createAccount(ctx, { code: '6900', name: 'Purchase Discounts', type: 'expense', subtype: 'operating_expenses' })).id;
    await postJournalEntry(ctx, { date: new Date('2022-04-01'), description: 's', lines: [
      { accountId: a.cash, debit: '500.00' }, { accountId: a.sales, credit: '500.00' } ] });
    await postJournalEntry(ctx, { date: new Date('2022-04-02'), description: 'pd', lines: [
      { accountId: a.cash, debit: '20.00' }, { accountId: pd, credit: '20.00' } ] });
    const res = await yearEndClose(ctx, { fiscalYear: 2022 });
    expect(res.netIncome).toBe('520.00');
    expect(res.totalExpenses).toBe('-20.00');
  });

  it('defaultReversalDate is the 1st of the next month in UTC (any server timezone)', () => {
    expect(defaultReversalDate(new Date('2026-03-01')).toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(defaultReversalDate(new Date('2026-03-31')).toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(defaultReversalDate(new Date('2026-12-15')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('fiscal years with a 02-28 (month-end) year end are contiguous across a leap day', () => {
    const fy2024 = fiscalYearWindow(2024, '02-28');
    const fy2025 = fiscalYearWindow(2025, '02-28');
    // FY2024 ends on 2024-02-29 (exclusive bound 03-01); FY2025 starts 2024-03-01.
    expect(fy2024.yearEnd.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(fy2024.closingDate.toISOString()).toBe('2024-02-29T23:59:59.000Z');
    expect(fy2025.yearStart.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(fy2024.yearStart.toISOString()).toBe('2023-03-01T00:00:00.000Z');
    const leap = fiscalWindowFor(new Date('2024-02-29'), '02-28');
    expect(leap.start.toISOString()).toBe('2023-03-01T00:00:00.000Z');
    expect(new Date('2024-02-29') >= leap.start && new Date('2024-02-29') <= leap.end).toBe(true);
    // Every day of 2020-2030 is in exactly one fiscal year.
    for (let t = Date.UTC(2020, 0, 1); t < Date.UTC(2030, 0, 1); t += 86_400_000) {
      const day = new Date(t);
      const hits = [day.getUTCFullYear(), day.getUTCFullYear() + 1].filter((y) => {
        const w = fiscalYearWindow(y, '02-28');
        return day >= w.yearStart && day < w.yearEnd;
      });
      expect(hits.length, day.toISOString()).toBe(1);
    }
    // A non-month-end day is clamped, windows still contiguous.
    expect(fiscalYearWindow(2025, '02-29').yearStart.toISOString()).toBe(fiscalYearWindow(2024, '02-29').yearEnd.toISOString());
    expect(fiscalYearWindow(2024, '12-31').yearStart.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(fiscalYearWindow(2026, '06-30').yearStart.toISOString()).toBe('2025-07-01T00:00:00.000Z');
  });
});
