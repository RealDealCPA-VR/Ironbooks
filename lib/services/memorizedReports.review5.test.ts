/**
 * Review round 5 — scheduled report exports never overwrite each other.
 *
 * A scheduled group wrote one CSV per report named "<report name> <date>.csv". Two memorized
 * reports with the same name in the group — or names that only differ by a character a file
 * name cannot hold ("A/R" and "A:R" both become "A-R") — wrote the SAME file: the second
 * silently replaced the first, so that period's export of one report was lost, while the run
 * still listed two files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createMemorizedGroup, createReportSchedule, runDueSchedules, saveMemorizedReport } from './memorizedReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-memorized');
const OUT_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-memorized-out');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-mem@test.local', name: 'R5 Mem', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Memorized Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
});

describe('scheduled group exports', () => {
  it('reports with the same (or file-name-equal) names each get their own file', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'Month end' });
    await saveMemorizedReport(ctx, { name: 'Summary', reportType: 'profit-loss', config: { params: { from: '2026-01-01', to: '2026-01-31' } }, groupId: g.id });
    await saveMemorizedReport(ctx, { name: 'Summary', reportType: 'balance-sheet', config: { params: { asOf: '2026-01-31' } }, groupId: g.id });
    await saveMemorizedReport(ctx, { name: 'A/R', reportType: 'ar-aging-summary', config: { params: { asOf: '2026-01-31' } }, groupId: g.id });
    await saveMemorizedReport(ctx, { name: 'A:R', reportType: 'ar-aging-detail', config: { params: { asOf: '2026-01-31' } }, groupId: g.id });
    await createReportSchedule(ctx, { name: 'Month end', groupId: g.id, frequency: 'monthly', startDate: '2026-02-01', format: 'csv' });
    const [res] = await runDueSchedules(ctx, { now: new Date(2026, 1, 1, 9, 0, 0), outDir: OUT_DIR });
    expect(res.status).toBe('ok');
    expect(res.files).toHaveLength(4);
    expect(new Set(res.files).size).toBe(4);
    for (const f of res.files) expect(fs.existsSync(f), f).toBe(true);
    const titles = res.files.map((f) => fs.readFileSync(f, 'utf8').split('\r\n')[0]);
    expect(titles.some((t) => t.includes('Profit & Loss') || t.includes('Summary'))).toBe(true);
    // Each file holds a different report.
    expect(new Set(res.files.map((f) => fs.readFileSync(f, 'utf8'))).size).toBe(4);
  });
});
