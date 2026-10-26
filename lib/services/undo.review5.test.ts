/**
 * Round-5 review regressions (undo of journal-screen voids):
 *  A. Undo never re-enters a voided YEAR-END CLOSING entry as an ordinary journal entry. The copy
 *     lost its fiscal-close link, so the Profit & Loss (which leaves closing entries out) counted
 *     it: the closed year's income and expenses showed as zero.
 *  B. The same for a voided depreciation entry (the copy was not on the asset's schedule: the
 *     asset said the period was not depreciated while the ledger said it was) and for the other
 *     journal-screen entries a document or a list tracks by their source link.
 *  C. A plain journal entry's void can still be undone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, accounts, undoActions } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createManualEntry, getEntry, voidEntry } from './journal';
import { postJournalEntry } from './posting';
import { yearEndClose } from './fiscalClose';
import { createAsset, getAsset, postDepreciation } from './fixedAssets';
import { profitAndLoss } from './reports';
import { commitUndo, performUndo, prepareUndo } from './undo';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-undo');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function voidWithToken(id: string) {
  const { token } = await prepareUndo(ctx, { resource: 'journal-entries', kind: 'void', id });
  await voidEntry(ctx, id);
  return token;
}

describe('undo of journal-screen voids (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@undo.test', name: 'Una', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Review5 Undo', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: the void of a year-end closing entry is not undone as a plain journal entry', async () => {
    await postJournalEntry(ctx, {
      date: d('2025-06-01'),
      description: 'Cash sale',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['4000'], credit: '500.00' },
      ],
    });
    const close = await yearEndClose(ctx, { fiscalYear: 2025 });
    const token = await voidWithToken(close.entry.id);
    await expect(commitUndo(ctx, { resource: 'journal-entries', kind: 'void', token })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Even a token armed some other way re-enters nothing.
    await db.update(undoActions).set({ status: 'armed', expiresAt: new Date(Date.now() + 30_000) }).where(eq(undoActions.id, token));
    await expect(performUndo(ctx, token)).rejects.toMatchObject({ code: 'CONFLICT' });
    const pl = await profitAndLoss(ctx, { from: d('2025-01-01'), to: d('2025-12-31') });
    expect(pl.netIncome).toBe('500.00');
  });

  it('B: the void of a depreciation entry is not undone as a plain journal entry', async () => {
    const asset = await createAsset(ctx, { name: 'Van', cost: '1200.00', usefulLifeMonths: 12, placedInService: d('2026-01-01') });
    const dep = await postDepreciation(ctx, { assetId: asset.id, date: d('2026-01-31') });
    const token = await voidWithToken(dep.journalEntry.id);
    expect((await getAsset(ctx, asset.id)).accumulatedDepreciation).toBe('0.00');
    await expect(commitUndo(ctx, { resource: 'journal-entries', kind: 'void', token })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('C: the void of a plain journal entry can still be undone', async () => {
    const je = await createManualEntry(ctx, {
      date: d('2026-02-01'),
      description: 'Accrual',
      lines: [
        { accountId: acct['6400'], debit: '30.00' },
        { accountId: acct['1000'], credit: '30.00' },
      ],
    });
    const token = await voidWithToken(je.id);
    await commitUndo(ctx, { resource: 'journal-entries', kind: 'void', token });
    const out = await performUndo(ctx, token);
    expect(out.newId).toBeTruthy();
    expect((await getEntry(ctx, out.newId!)).status).toBe('posted');
  });
});
