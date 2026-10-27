/**
 * Review round 5 — AI error review (each test failed before its fix):
 *  A  a detection can have several suggestions (Analyze clicked twice, or again later); once one of
 *     them is applied the detection is resolved, and applying another one must be refused — it
 *     would post a second correcting entry for the same problem.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, errorDetections, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createManualEntry } from './journal';
import { analyzeError, applyCorrection } from './llmCorrector';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-llm-corrector');
let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T12:00:00Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-llm@test.local', name: 'Reviewer', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review5 LLM Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('review5: applying corrections', () => {
  it('a second suggestion for an already-resolved detection is refused (no second correcting entry)', async () => {
    const je = await createManualEntry(ctx, {
      date: D('2026-05-04'),
      description: 'Very large supplies purchase',
      lines: [
        { accountId: code['6000'], debit: '9000.00' },
        { accountId: code['1000'], credit: '9000.00' },
      ],
    });
    const [det] = await db
      .insert(errorDetections)
      .values({ companyId: ctx.companyId, journalEntryId: je.id, errorType: 'unusual_pattern', severity: 'medium', description: 'Outlier amount' })
      .returning();
    const first = await analyzeError(ctx, det.id);
    const second = await analyzeError(ctx, det.id);
    const fix = {
      date: '2026-05-04',
      description: 'Correct the overstated purchase',
      lines: [
        { accountId: code['1000'], debit: '8100.00', credit: null },
        { accountId: code['6000'], debit: null, credit: '8100.00' },
      ],
    };
    await applyCorrection(ctx, first.id, { approved: true, entry: fix });
    const count = async () =>
      (
        await db
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.description, fix.description)))
      ).length;
    expect(await count()).toBe(1);
    await expect(applyCorrection(ctx, second.id, { approved: true, entry: fix })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await count()).toBe(1);
  });
});
