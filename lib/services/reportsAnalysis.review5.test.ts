/**
 * Review round 5 — analysis tools on a large company file (reportsAnalysis.ts).
 *
 *  - Find read the company's OLDEST ledger lines up to its scan cap and then showed "the 2,000
 *    most recent matches" of those: on a large file an unfiltered (or broadly filtered) Find never
 *    showed this year's transactions at all, with nothing saying so.
 *  - Advanced Reporting (pivot) silently dropped every ledger line past its 50,000-line read cap:
 *    the totals were incomplete with no note and no truncated flag.
 *
 * The caps are lowered through GL_LIMITS (the knob the engine exposes for tests).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { GL_LIMITS } from './reportEngine';
import { findTransactions, pivotReport } from './reportsAnalysis';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-reports-analysis');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const saved = { ...GL_LIMITS };

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-analysis@test.local', name: 'R5 Analysis', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Analysis Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  // Six sales, one a month: 10, 20, … 60.
  for (let m = 1; m <= 6; m++) {
    await postJournalEntry(ctx, {
      date: d(`2026-0${m}-15`),
      description: `sale ${m}`,
      lines: [
        { accountId: A['1000'], debit: `${m * 10}.00` },
        { accountId: A['4000'], credit: `${m * 10}.00` },
      ],
    });
  }
});

afterEach(() => Object.assign(GL_LIMITS, saved));

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Find on a large company file', () => {
  it('shows the most recent transactions and says when it could not search everything', async () => {
    GL_LIMITS.maxLines = 4; // the read returns at most 4 lines
    const r = await findTransactions(ctx, {} as never);
    const dates = r.rows.filter((x) => x.kind === 'data').map((x) => x.cells.date);
    // The newest transactions — never January / February while June is left out.
    expect(dates[0]).toBe('2026-06-15');
    expect(dates).not.toContain('2026-01-15');
    expect(r.truncated).toBe(true);
    expect((r.notes ?? []).join(' ')).toMatch(/most recent/i);
  });

  it('with everything read, nothing is flagged', async () => {
    const r = await findTransactions(ctx, {} as never);
    expect(r.rows.filter((x) => x.kind === 'data')).toHaveLength(6);
    expect(r.truncated).toBe(false);
    expect(r.notes ?? []).toEqual([]);
  });
});

describe('Advanced Reporting (pivot) on a large company file', () => {
  it('says its totals are incomplete when the ledger read hits its cap', async () => {
    GL_LIMITS.maxLines = 4;
    const r = await pivotReport(ctx, { rows: 'account', measure: 'amount', source: 'gl', from: '2026-01-01', to: '2026-12-31' });
    expect(r.truncated).toBe(true);
    expect((r.notes ?? []).join(' ')).toMatch(/incomplete|narrow/i);
  });

  it('a complete read is not flagged', async () => {
    const r = await pivotReport(ctx, { rows: 'account', measure: 'amount', source: 'gl', from: '2026-01-01', to: '2026-12-31' });
    expect(r.truncated ?? false).toBe(false);
    expect(r.rows.find((x) => x.id === `pv:${A['4000']}`)?.cells.total).toBe('210.00');
  });
});
