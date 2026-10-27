/**
 * Round-5 review regressions (fixed assets):
 *  A. The depreciation schedule of an asset placed in service on the 29th-31st has one period
 *     per month (Jan 31 + 1 month = Feb 28, not Mar 3 — February used to be skipped and March
 *     listed twice), computed on the UTC calendar like every other ledger date.
 *  B. Two depreciation posts for the same asset at once (two months, two users / a double click)
 *     both count: the asset's accumulated depreciation equals the Accumulated Depreciation
 *     account (it used to keep only one of them), and the default accounts are created once.
 *  C. Concurrent posts never depreciate past cost - salvage.
 *  D. Depreciation goes to a Depreciation Expense / Accumulated Depreciation account, never to
 *     whatever happens to be numbered 6800 / 1590 in a chart converted from QuickBooks (a bank
 *     account at 1590 was credited with the depreciation, a Telephone expense at 6800 debited).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount, getAccount } from './accounts';
import { createAsset, depreciationSchedule, getAsset, postDepreciation } from './fixedAssets';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-fixed-assets');
let db: DB;
let ctx: ServiceContext;
const day = (d: Date) => d.toISOString().slice(0, 10);

describe('fixed assets (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@fa.test', name: 'Fay', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review5 FA', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' });
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: an asset placed in service on Jan 31 depreciates once in every month (Feb 28, Mar 31, Apr 30)', () => {
    const s = depreciationSchedule({
      cost: '1200.00',
      salvageValue: '0',
      usefulLifeMonths: 4,
      placedInService: new Date('2026-01-31T00:00:00Z'),
    });
    expect(s.map((r) => day(r.date))).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    const mid = depreciationSchedule({
      cost: '300.00',
      salvageValue: '0',
      usefulLifeMonths: 3,
      placedInService: new Date('2026-11-15T00:00:00Z'),
    });
    expect(mid.map((r) => day(r.date))).toEqual(['2026-12-15', '2027-01-15', '2027-02-15']);
  });

  it('B: two depreciation posts at once both count, and the default accounts are created once', async () => {
    const asset = await createAsset(ctx, {
      name: 'Truck',
      cost: '12000.00',
      usefulLifeMonths: 60,
      placedInService: new Date('2026-01-01T00:00:00Z'),
    });
    const results = await Promise.allSettled([
      postDepreciation(ctx, { assetId: asset.id, date: new Date('2026-01-31T00:00:00Z') }),
      postDepreciation(ctx, { assetId: asset.id, date: new Date('2026-02-28T00:00:00Z') }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const after = await getAsset(ctx, asset.id);
    expect(after.depreciationEntries).toHaveLength(2);
    expect(after.accumulatedDepreciation).toBe('400.00');

    const accum = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1590')));
    const expense = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6800')));
    expect(accum).toHaveLength(1);
    expect(expense).toHaveLength(1);
    // The schedule, the asset and the ledger agree (Accumulated Depreciation is a contra asset).
    expect((await getAccount(ctx, accum[0].id)).balance).toBe('-400.00');
    expect((await getAccount(ctx, expense[0].id)).balance).toBe('400.00');
  });

  it('C: concurrent posts never depreciate past cost minus salvage', async () => {
    const asset = await createAsset(ctx, {
      name: 'Laptop',
      cost: '300.00',
      salvageValue: '0',
      usefulLifeMonths: 2,
      placedInService: new Date('2026-01-01T00:00:00Z'),
    });
    const results = await Promise.allSettled(
      ['2026-01-31', '2026-02-28', '2026-03-31'].map((s) =>
        postDepreciation(ctx, { assetId: asset.id, date: new Date(`${s}T00:00:00Z`) }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const after = await getAsset(ctx, asset.id);
    expect(after.accumulatedDepreciation).toBe('300.00');
    const posted = after.depreciationEntries.reduce((s, e) => s + Number(e.amount), 0);
    expect(posted).toBe(300);
  });

  it('D: a converted chart with other accounts at 1590 / 6800 keeps them out of depreciation', async () => {
    const [user] = await db.insert(users).values({ email: 'r5d@fa.test', name: 'Dee', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review5 FA converted', ownerId: user.id }).returning();
    const c: ServiceContext = { db, companyId: company.id, userId: user.id };
    const petty = await createAccount(c, { code: '1590', name: 'Petty Cash', type: 'asset', subtype: 'checking' });
    const phone = await createAccount(c, { code: '6800', name: 'Telephone', type: 'expense', subtype: 'operating_expenses' });
    // The converted chart's own Accumulated Depreciation, under another number.
    const accum = await createAccount(c, { code: '1750', name: 'Accumulated Depreciation', qbType: 'fixed_asset' });

    const asset = await createAsset(c, {
      name: 'Forklift',
      cost: '1200.00',
      usefulLifeMonths: 12,
      placedInService: new Date('2026-01-01T00:00:00Z'),
    });
    const res = await postDepreciation(c, { assetId: asset.id, date: new Date('2026-01-31T00:00:00Z') });
    expect(res.periodAmount).toBe('100.00');

    // Nothing landed on Petty Cash or Telephone.
    expect((await getAccount(c, petty.id)).balance).toBe('0.00');
    expect((await getAccount(c, phone.id)).balance).toBe('0.00');
    // The chart's Accumulated Depreciation took the credit; a Depreciation Expense account was made.
    expect((await getAccount(c, accum.id)).balance).toBe('-100.00');
    const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
    const expense = all.filter((a) => a.name === 'Depreciation Expense');
    expect(expense).toHaveLength(1);
    expect(expense[0].type).toBe('expense');
    expect(expense[0].code).not.toBe('6800');
    expect((await getAccount(c, expense[0].id)).balance).toBe('100.00');
    // A second period reuses the same accounts.
    await postDepreciation(c, { assetId: asset.id, date: new Date('2026-02-28T00:00:00Z') });
    expect((await getAccount(c, accum.id)).balance).toBe('-200.00');
    expect((await db.select().from(accounts).where(eq(accounts.companyId, company.id))).length).toBe(all.length);

    // An asset that names its own accounts must name the right kind (not a bank account).
    await expect(
      createAsset(c, {
        name: 'Van',
        cost: '600.00',
        usefulLifeMonths: 6,
        placedInService: new Date('2026-01-01T00:00:00Z'),
        accumulatedDepreciationAccountId: petty.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createAsset(c, {
        name: 'Van',
        cost: '600.00',
        usefulLifeMonths: 6,
        placedInService: new Date('2026-01-01T00:00:00Z'),
        depreciationExpenseAccountId: accum.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
