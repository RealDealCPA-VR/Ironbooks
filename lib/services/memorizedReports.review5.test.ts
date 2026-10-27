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

/**
 * Where scheduled exports go when a single company file (1.6) is open. The app server then runs
 * on a working copy in %LOCALAPPDATA%\Ironbooks\Working\<name>-<hash>\data, and the export root
 * was derived from that folder: exports landed inside the working-copy cache, in a folder called
 * "data", which is deleted when the cache is cleaned up (45 days unopened) or replaced. They now
 * go next to the company file itself.
 */
describe('scheduled export folder with a single company file', () => {
  it('is next to the company file, not inside the working copy', async () => {
    const { reportExportRoot } = await import('./memorizedReports');
    const saved = { file: process.env.BKA_COMPANY_FILE, data: process.env.BKA_DATA_DIR, dir: process.env.BKA_REPORT_EXPORT_DIR };
    try {
      delete process.env.BKA_REPORT_EXPORT_DIR;
      const books = path.resolve('Books');
      process.env.BKA_COMPANY_FILE = path.join(books, 'Acme Ltd.ironbooks');
      process.env.BKA_DATA_DIR = path.resolve('AppData', 'Ironbooks', 'Working', 'Acme Ltd-1a2b3c', 'data');
      expect(reportExportRoot()).toBe(path.join(books, 'Report Exports', 'Acme Ltd'));
      // A company kept as a folder (no single file) is unchanged: next to its data folder.
      delete process.env.BKA_COMPANY_FILE;
      process.env.BKA_DATA_DIR = path.join(books, 'Acme');
      expect(reportExportRoot()).toBe(path.join(books, 'Report Exports', 'Acme'));
    } finally {
      for (const [k, v] of [['BKA_COMPANY_FILE', saved.file], ['BKA_DATA_DIR', saved.data], ['BKA_REPORT_EXPORT_DIR', saved.dir]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
