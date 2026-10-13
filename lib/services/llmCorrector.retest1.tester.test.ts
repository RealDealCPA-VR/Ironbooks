/**
 * P2 AI — re-test round 1 (independent tester): applyCorrection refuses to post when the flagged
 * entry is no longer posted (fix ddc0f77).
 *
 *  - Refusal is clean: VALIDATION, no entry posted, TB unchanged, the correction stays pending and
 *    the detection unresolved (so the user can ask again) — nothing is half-applied.
 *  - A user-edited correcting entry is refused too when the flagged entry was voided (the edit
 *    path must not bypass the check).
 *  - Isolation: a detection pointing at ANOTHER company's (posted) entry is not treated as posted.
 *  - No regression: a still-posted duplicate is reversed exactly once and the correction links
 *    the posted entry; a second apply is refused; the TB balances.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, errorCorrections, errorDetections, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createManualEntry, voidEntry } from './journal';
import { analyzeError, applyCorrection } from './llmCorrector';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-llm-corrector-retest1');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
const code: Record<string, string> = {};
const otherCode: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const AS_OF = new Date('2026-12-31T23:59:59Z');

async function countEntries(c: ServiceContext) {
  return (await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId))).length;
}

async function dupPair(c: ServiceContext, codes: Record<string, string>, date: string, amount: string) {
  const mk = () =>
    createManualEntry(c, {
      date: D(date),
      description: `Dup ${amount}`,
      lines: [
        { accountId: codes['6300'], debit: amount },
        { accountId: codes['1000'], credit: amount },
      ],
    });
  const original = await mk();
  const dup = await mk();
  return { original, dup };
}

async function detect(journalEntryId: string) {
  const [det] = await db
    .insert(errorDetections)
    .values({ companyId: ctx.companyId, journalEntryId, errorType: 'duplicate', severity: 'medium', description: 'Possible duplicate' })
    .returning();
  return det;
}

async function expectUntouched(correctionId: string, detectionId: string) {
  const [c] = await db.select().from(errorCorrections).where(eq(errorCorrections.id, correctionId));
  expect(c.status).toBe('pending');
  expect((c.correctionData as { postedEntryId?: string } | null)?.postedEntryId).toBeUndefined();
  const [d] = await db.select().from(errorDetections).where(eq(errorDetections.id, detectionId));
  expect(d.resolvedAt).toBeNull();
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'llm-retest@test.local', name: 'Rhea', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'LLM Retest Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
  const [u2] = await db.insert(users).values({ email: 'llm-retest-other@test.local', name: 'Olaf', passwordHash: 'x' }).returning();
  const c2 = await createCompany(db, { name: 'Other Retest Co', ownerId: u2.id });
  other = { db, companyId: c2.id, userId: u2.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, other.companyId))) otherCode[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('applyCorrection after the flagged entry changed (re-test)', () => {
  it('a voided duplicate: refused cleanly — nothing posted, correction still pending, detection unresolved', async () => {
    const { dup } = await dupPair(ctx, code, '2026-06-02', '31.00');
    const det = await detect(dup.id);
    const correction = await analyzeError(ctx, det.id);
    await voidEntry(ctx, dup.id);
    const tb = (await trialBalance(ctx, AS_OF)).rows;
    const n = await countEntries(ctx);

    await expect(applyCorrection(ctx, correction.id, { approved: true })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countEntries(ctx)).toBe(n);
    expect((await trialBalance(ctx, AS_OF)).rows).toEqual(tb);
    await expectUntouched(correction.id, det.id);
  });

  it('a voided duplicate: a user-edited correcting entry is refused as well', async () => {
    const { dup } = await dupPair(ctx, code, '2026-06-03', '17.00');
    const det = await detect(dup.id);
    const correction = await analyzeError(ctx, det.id);
    await voidEntry(ctx, dup.id);
    const n = await countEntries(ctx);
    await expect(
      applyCorrection(ctx, correction.id, {
        approved: true,
        entry: {
          date: '2026-06-03',
          description: 'My own reversal',
          lines: [
            { accountId: code['1000'], debit: '17.00' },
            { accountId: code['6300'], credit: '17.00' },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countEntries(ctx)).toBe(n);
    await expectUntouched(correction.id, det.id);
  });

  it("a detection pointing at another company's posted entry is not treated as this company's posted entry", async () => {
    const { dup: theirs } = await dupPair(other, otherCode, '2026-06-04', '9.00');
    const det = await detect(theirs.id);
    const correction = await analyzeError(ctx, det.id);
    const n = await countEntries(ctx);
    const nOther = await countEntries(other);
    await expect(
      applyCorrection(ctx, correction.id, {
        approved: true,
        entry: {
          date: '2026-06-04',
          description: 'x',
          lines: [
            { accountId: code['1000'], debit: '9.00' },
            { accountId: code['6300'], credit: '9.00' },
          ],
        },
      }),
    ).rejects.toBeTruthy();
    expect(await countEntries(ctx)).toBe(n);
    expect(await countEntries(other)).toBe(nOther);
    const [theirEntry] = await db.select().from(journalEntries).where(eq(journalEntries.id, theirs.id));
    expect(theirEntry.status).toBe('posted');
  });

  it('a still-posted duplicate is reversed exactly once and linked; a second apply is refused', async () => {
    const { dup } = await dupPair(ctx, code, '2026-06-05', '23.45');
    const det = await detect(dup.id);
    const correction = await analyzeError(ctx, det.id);
    const n = await countEntries(ctx);
    const applied = await applyCorrection(ctx, correction.id, { approved: true });
    expect(applied.status).toBe('applied');
    const postedId = (applied.correctionData as { postedEntryId?: string }).postedEntryId;
    expect(postedId).toBeTruthy();
    expect(await countEntries(ctx)).toBe(n + 1);
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, postedId!));
    expect(je.status).toBe('posted');
    expect(je.companyId).toBe(ctx.companyId);

    await expect(applyCorrection(ctx, correction.id, { approved: true })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countEntries(ctx)).toBe(n + 1);
    expect((await trialBalance(ctx, AS_OF)).balanced).toBe(true);
  });
});
