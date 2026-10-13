/**
 * P2 AI — independent tester for applyCorrection posting the correcting entry.
 *  - A duplicate that was already voided must not be "reversed" again: applying the stored
 *    reversal would post a second correction for an entry that no longer counts, overstating
 *    the accounts in the opposite direction.
 *  - Two simultaneous approvals post exactly one correcting entry.
 *  - A user-edited entry on another company's (real) account, or an A/R line with no customer,
 *    is refused and nothing changes; another company's correction id is not found.
 *  - Reversing a duplicate General Journal charge on A/R keeps A/R == aging == customer balances.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, errorCorrections, errorDetections, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { createManualEntry, voidEntry } from './journal';
import { analyzeError, applyCorrection } from './llmCorrector';
import { trialBalance } from './reports';
import { arAging } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-llm-corrector-tester');
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

async function duplicate(date: string, amount: string, lines?: (amt: string) => Parameters<typeof createManualEntry>[1]['lines']) {
  const mk = () =>
    createManualEntry(ctx, {
      date: D(date),
      description: `Dup ${amount}`,
      lines: lines
        ? lines(amount)
        : [
            { accountId: code['6300'], debit: amount },
            { accountId: code['1000'], credit: amount },
          ],
    });
  const original = await mk();
  const dup = await mk();
  const [det] = await db
    .insert(errorDetections)
    .values({ companyId: ctx.companyId, journalEntryId: dup.id, errorType: 'duplicate', severity: 'medium', description: 'Possible duplicate' })
    .returning();
  return { original, dup, det };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'llm-tester@test.local', name: 'Tess', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'LLM Tester Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
  const [u2] = await db.insert(users).values({ email: 'llm-other@test.local', name: 'Otto', passwordHash: 'x' }).returning();
  const c2 = await createCompany(db, { name: 'Other Co', ownerId: u2.id });
  other = { db, companyId: c2.id, userId: u2.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, other.companyId))) otherCode[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('applyCorrection — adversarial', () => {
  it('refuses to reverse a duplicate that has since been voided (no double correction)', async () => {
    const { dup, det } = await duplicate('2026-05-02', '42.00');
    const correction = await analyzeError(ctx, det.id);
    expect((correction.correctionData as { entry?: unknown }).entry).toBeTruthy();
    // Someone voids the duplicate by hand before the correction is approved.
    await voidEntry(ctx, dup.id);
    const tbBefore = await trialBalance(ctx, AS_OF);
    const n = await countEntries(ctx);

    await expect(applyCorrection(ctx, correction.id, { approved: true })).rejects.toBeTruthy();
    expect(await countEntries(ctx)).toBe(n);
    expect((await trialBalance(ctx, AS_OF)).rows).toEqual(tbBefore.rows);
  });

  it('two simultaneous approvals post exactly one correcting entry', async () => {
    const { det } = await duplicate('2026-05-03', '15.50');
    const correction = await analyzeError(ctx, det.id);
    const n = await countEntries(ctx);
    const results = await Promise.allSettled([
      applyCorrection(ctx, correction.id, { approved: true }),
      applyCorrection(ctx, correction.id, { approved: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await countEntries(ctx)).toBe(n + 1);
    expect((await trialBalance(ctx, AS_OF)).balanced).toBe(true);
  });

  it('a user-edited entry on another company\'s real account, or an unnamed A/R line, is refused; nothing changes', async () => {
    const [det] = await db
      .insert(errorDetections)
      .values({ companyId: ctx.companyId, errorType: 'unusual_pattern', severity: 'low', description: 'Odd' })
      .returning();
    const correction = await analyzeError(ctx, det.id);
    const n = await countEntries(ctx);
    const nOther = await countEntries(other);
    await expect(
      applyCorrection(ctx, correction.id, {
        approved: true,
        entry: {
          date: '2026-05-04',
          description: 'x',
          lines: [
            { accountId: code['6300'], debit: '5.00' },
            { accountId: otherCode['1000'], credit: '5.00' },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      applyCorrection(ctx, correction.id, {
        approved: true,
        entry: {
          date: '2026-05-04',
          description: 'x',
          lines: [
            { accountId: code['1200'], debit: '5.00' },
            { accountId: code['4000'], credit: '5.00' },
          ],
        },
      }),
    ).rejects.toBeTruthy();
    expect(await countEntries(ctx)).toBe(n);
    expect(await countEntries(other)).toBe(nOther);
    const [c] = await db.select().from(errorCorrections).where(eq(errorCorrections.id, correction.id));
    expect(c.status).toBe('pending');
    const [d] = await db.select().from(errorDetections).where(eq(errorDetections.id, det.id));
    expect(d.resolvedAt).toBeNull();

    // Another company cannot apply this company's correction.
    await expect(applyCorrection(other, correction.id, { approved: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reversing a duplicate A/R charge keeps A/R control == aging == customer balances', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Dup Customer' })).id;
    const { det } = await duplicate('2026-05-05', '88.00', (amt) => [
      { accountId: code['1200'], debit: amt, entityType: 'customer', entityId: cust },
      { accountId: code['4000'], credit: amt },
    ]);
    const correction = await analyzeError(ctx, det.id);
    await applyCorrection(ctx, correction.id, { approved: true });

    const tb = await trialBalance(ctx, AS_OF);
    expect(tb.balanced).toBe(true);
    const arIds = new Set(
      (
        await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.subtype} = 'accounts_receivable'`))
      ).map((r) => r.id),
    );
    let ar = 0;
    for (const r of tb.rows) if (arIds.has(r.accountId)) ar += Number(r.debit) - Number(r.credit);
    ar = Math.round(ar * 100) / 100;
    expect(ar).toBeCloseTo(88, 2); // the original charge remains owed; the duplicate is cancelled
    expect(Number((await arAging(ctx, AS_OF)).totals.total)).toBeCloseTo(ar, 2);
    const byCustomer = (await customerBalanceSummary(ctx)).reduce((s, r) => s + Number(r.totalBalanceDue), 0);
    expect(byCustomer).toBeCloseTo(ar, 2);
  });
});
