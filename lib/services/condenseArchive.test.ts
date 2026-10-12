/**
 * Condense + archive copy (QB "Condense Data" writes a full archive copy first):
 *  condense → archive .bka recorded → trial balance identical before/after →
 *  restore the archive copy → full detail back: identical tables, trial balance and journal
 *  entry/line counts equal to the pre-condense file. The transaction log verifies at every step.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, journalEntries, journalEntryLines } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { condensePeriod, listCondenseArchives, restoreCondenseArchive } from './condense';
import { computeTableDigests } from './portableFile';
import { verifyTransactionLog } from './transactionLog';
import { trialBalance } from './reports';
import { seedRichCompany } from './companyFile.fixture';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-condense-archive');
const DIR = path.join(ROOT, 'data');

let db: DB;
let ctx: ServiceContext;

async function counts(d: DB) {
  const [e] = await d.select({ n: sql<number>`COUNT(*)::int` }).from(journalEntries);
  const [l] = await d.select({ n: sql<number>`COUNT(*)::int` }).from(journalEntryLines);
  return { entries: e.n, lines: l.n };
}

describe('condense archive copy', () => {
  let before: { tb: Awaited<ReturnType<typeof trialBalance>>; counts: { entries: number; lines: number }; digests: Awaited<ReturnType<typeof computeTableDigests>> };
  let runId: string;

  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(DIR);
    ({ ctx } = await seedRichCompany(db, DIR, 'Condense Co'));
    // Close January so it can be condensed.
    await db.update(companies).set({ settings: { closingDate: '2025-01-31' } }).where(eq(companies.id, ctx.companyId));
    before = { tb: await trialBalance(ctx), counts: await counts(db), digests: await computeTableDigests(db) };
  }, 180_000);

  afterAll(async () => {
    await closeDb(DIR);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('writes and records a full archive copy before condensing; the TB is unchanged', async () => {
    const result = await condensePeriod(ctx, { beforeDate: new Date('2025-02-01T00:00:00Z'), dataDir: DIR });
    expect(result.dryRun).toBe(false);
    expect(result.entriesToCondense).toBeGreaterThan(0);
    runId = result.runId!;
    expect(fs.existsSync(result.archivePath!)).toBe(true);

    const archives = listCondenseArchives(DIR);
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({ id: runId, path: result.archivePath, available: true, beforeDate: '2025-02-01' });

    const after = await trialBalance(ctx);
    expect(after.rows).toEqual(before.tb.rows);
    expect(after.totalDebit).toBe(before.tb.totalDebit);
    expect((await counts(db)).entries).toBeLessThan(before.counts.entries);
    // Summary entries were logged, so the log still accounts for every posted entry.
    expect((await verifyTransactionLog(db, DIR)).ok).toBe(true);
  });

  it('restoring the archive copy brings back the full pre-condense detail', async () => {
    await expect(restoreCondenseArchive(ctx, 'not-a-real-id', DIR)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const res = await restoreCondenseArchive(ctx, runId, DIR);
    expect(res.restored).toBe(true);

    db = await getDb(DIR); // the old handle was closed by the restore
    const restoredCtx = { ...ctx, db };
    expect(await counts(db)).toEqual(before.counts);
    const tb = await trialBalance(restoredCtx);
    expect(tb.rows).toEqual(before.tb.rows);
    expect(tb.balanced).toBe(true);
    expect(await computeTableDigests(db)).toEqual(before.digests);
    expect((await verifyTransactionLog(db, DIR)).ok).toBe(true);
  });
});
