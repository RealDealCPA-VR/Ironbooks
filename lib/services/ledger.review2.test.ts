/**
 * Ledger review round 2 regressions: GL-only entries with no document (cc-payment, fx_adjustment)
 * stay voidable from the journal; voiding a depreciation entry takes the period off the asset;
 * register / GL / journal list "to" filters cover the whole day (year-end closing entry 23:59:59Z).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, journalEntries, depreciationEntries, fixedAssets } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { yearEndClose } from './fiscalClose';
import { voidEntry, reverseEntry, accountRegister, generalLedger, listEntries } from './journal';
import { payCreditCard } from './liabilityPayments';
import { recordFxAdjustment } from './currencies';
import { createAsset, postDepreciation } from './fixedAssets';
import { isJournalScreenEntry } from '@/lib/journalScreen';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-ledger');
let ctx: ServiceContext;
let db: DB;
const a: Record<string, string> = {};

describe('ledger review 2', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'r2l@test.local', name: 'R', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'R2L Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    a.cash = (await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' })).id;
    a.cc = (await createAccount(ctx, { code: '2100', name: 'Visa', type: 'liability', subtype: 'credit_card' })).id;
    a.re = (await createAccount(ctx, { code: '3900', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings' })).id;
    a.sales = (await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue', subtype: 'sales' })).id;
    a.other = (await createAccount(ctx, { code: '4900', name: 'Other Income', type: 'revenue', subtype: 'other_income' })).id;
    a.fees = (await createAccount(ctx, { code: '6100', name: 'Bank Fees', type: 'expense', subtype: 'operating_expenses' })).id;
  }, 180_000);
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a credit card payment recorded for a reconciliation (cc-payment:) can be voided — it has no other void path', async () => {
    const entry = await payCreditCard(ctx, {
      creditCardAccountId: a.cc,
      paymentAccountId: a.cash,
      amount: '25.00',
      date: new Date('2025-05-01'),
      reconciliationId: randomUUID(),
    });
    expect(entry.sourceRef?.startsWith('cc-payment:')).toBe(true);
    await expect(voidEntry(ctx, entry.id)).resolves.toMatchObject({ status: 'void' });
  });

  it('an FX gain/loss adjustment (fx_adjustment) can be voided or reversed — it has no other void path', async () => {
    const { entryId } = await recordFxAdjustment(ctx, { accountId: a.cash, amount: '10.00', gain: true, date: new Date('2025-05-02') });
    await expect(reverseEntry(ctx, entryId)).resolves.toBeTruthy();
    await expect(voidEntry(ctx, entryId)).resolves.toMatchObject({ status: 'void' });
  });

  it('voiding a depreciation entry takes the period off the asset (schedule row + accumulated), and it can be re-posted', async () => {
    const asset = await createAsset(ctx, { name: 'Laptop', cost: '1200.00', usefulLifeMonths: 12, placedInService: new Date('2025-01-01') });
    const date = new Date('2025-01-31');
    const first = await postDepreciation(ctx, { assetId: asset.id, date });
    expect(first.newAccumulatedDepreciation).toBe('100.00');
    expect(isJournalScreenEntry(first.journalEntry.sourceRef, 'reverse')).toBe(false);
    await expect(reverseEntry(ctx, first.journalEntry.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(voidEntry(ctx, first.journalEntry.id)).resolves.toMatchObject({ status: 'void' });
    const rows = await db
      .select()
      .from(depreciationEntries)
      .where(and(eq(depreciationEntries.companyId, ctx.companyId), eq(depreciationEntries.fixedAssetId, asset.id)));
    expect(rows).toHaveLength(0);
    const [after] = await db.select().from(fixedAssets).where(eq(fixedAssets.id, asset.id));
    expect(after.accumulatedDepreciation).toBe('0.00');

    const again = await postDepreciation(ctx, { assetId: asset.id, date });
    expect(again.newAccumulatedDepreciation).toBe('100.00');
  });

  it('register / GL / journal list filtered "to" the fiscal year end include the year-end closing entry', async () => {
    await postJournalEntry(ctx, { date: new Date('2023-06-01'), description: 's', lines: [
      { accountId: a.cash, debit: '500.00' }, { accountId: a.sales, credit: '500.00' } ] });
    const res = await yearEndClose(ctx, { fiscalYear: 2023 });
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, res.entry.id));
    expect(je.date.toISOString()).toBe('2023-12-31T23:59:59.000Z');

    // As the register page / QuickZoom links send it: date-only strings (UTC midnight).
    const from = new Date('2023-01-01');
    const to = new Date('2023-12-31');
    const reg = await accountRegister(ctx, a.re, { from, to });
    expect(reg.rows.map((r) => r.journalEntryId)).toContain(res.entry.id);
    expect(reg.closingBalance).toBe('500.00');

    const gl = await generalLedger(ctx, { accountId: a.re, from, to });
    expect(gl[0].lines.map((l) => l.journalEntryId)).toContain(res.entry.id);

    const list = await listEntries(ctx, { from, to });
    expect(list.map((e) => e.id)).toContain(res.entry.id);
    // The next day is still excluded.
    const before = await listEntries(ctx, { from, to: new Date('2023-12-30') });
    expect(before.map((e) => e.id)).not.toContain(res.entry.id);
  });
});
