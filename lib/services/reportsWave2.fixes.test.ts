/**
 * Doer regression tests for the wave-2 reports fix round (beyond the tester's QA files):
 * comparison dates for quarters / month ends, monthly schedule anchors, memorized report
 * delete / group listing permissions, prototype keys. Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, memorizedReports, reportSchedules, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { isStandardReport, runStandardReport } from './reportRegistry';
import { eq } from 'drizzle-orm';
import {
  createReportSchedule,
  deleteReportSchedule,
  listReportSchedules,
  runDueSchedules,
  updateMemorizedReport,
  updateReportSchedule,
  deleteMemorizedReport,
  listMemorizedGroups,
  nextRunAfter,
  processMultipleReports,
  runMemorizedReport,
  saveMemorizedReport,
} from './memorizedReports';
import { parseReportParams } from '@/lib/validation/reports';
import { fullAccess } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2-fixes');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const run = (key: string, p: Record<string, string> = {}, c: ServiceContext = ctx) => runStandardReport(c, key, p);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'fix@rep.test', name: 'Fix', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'Fix Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
  await db.insert(userCompanies).values([{ userId: user.id, companyId: company.id, role: 'owner' }]);
  const mk = async (key: string, code: string, name: string, type: string, subtype: string) => {
    const r = await createAccount(ctx, { code, name, type: type as never, subtype } as never);
    A[key] = r.id;
  };
  await mk('bank', '1000', 'Checking', 'asset', 'checking');
  await mk('equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk('sales', '4000', 'Sales', 'revenue', 'sales');
  await postJournalEntry(ctx, { date: d('2026-01-02'), description: 'Capital', lines: [{ accountId: A.bank, debit: '1000' }, { accountId: A.equity, credit: '1000' }] });
  await postJournalEntry(ctx, { date: d('2026-02-15'), description: 'Sale', lines: [{ accountId: A.bank, debit: '200' }, { accountId: A.sales, credit: '200' }] });
}, 120_000);

afterAll(async () => {
  await closeDb();
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

describe('comparison dates', () => {
  it('a whole quarter compares with the previous whole quarter', async () => {
    const r = await run('profit-loss', { from: '2026-04-01', to: '2026-06-30', compare: 'prev_period' });
    expect(r.columns.find((c) => c.key === 'prev')?.header).toBe('01/01/2026 – 03/31/2026');
  });

  it('a partial range still uses the equal-length window just before it', async () => {
    const r = await run('profit-loss', { from: '2026-03-11', to: '2026-03-20', compare: 'prev_period' });
    expect(r.columns.find((c) => c.key === 'prev')?.header).toBe('03/01/2026 – 03/10/2026');
  });

  it('February month end compares with the January month end; mid-month clamps', async () => {
    const r = await run('balance-sheet', { asOf: '2026-02-28', compare: 'prev_period' });
    expect(r.columns.find((c) => c.key === 'prev')?.header).toBe('01/31/2026');
    const m = await run('balance-sheet', { asOf: '2026-03-15', compare: 'prev_period' });
    expect(m.columns.find((c) => c.key === 'prev')?.header).toBe('02/15/2026');
  });

  it('prev-year P&L for February of a leap year covers all of February the year before', async () => {
    const r = await run('profit-loss', { from: '2028-02-01', to: '2028-02-29', compare: 'prev_year' });
    expect(r.columns.find((c) => c.key === 'prev')?.header).toBe('02/01/2027 – 02/28/2027');
  });

  it('leap day itself is a valid date; Feb 29 of a non-leap year is not', () => {
    expect(parseReportParams({ asOf: '2028-02-29' }).success).toBe(true);
    expect(parseReportParams({ asOf: '2027-02-29' }).success).toBe(false);
  });
});

describe('monthly schedule anchor', () => {
  it('keeps the anchor day across short months', () => {
    const feb = nextRunAfter(new Date('2026-01-31T06:00:00.000Z'), 'monthly', 31);
    expect(feb.toISOString().slice(0, 10)).toBe('2026-02-28');
    const mar = nextRunAfter(feb, 'monthly', 31);
    expect(mar.toISOString().slice(0, 10)).toBe('2026-03-31');
    const apr = nextRunAfter(mar, 'monthly', 31);
    expect(apr.toISOString().slice(0, 10)).toBe('2026-04-30');
    expect(nextRunAfter(new Date('2026-01-30T06:00:00.000Z'), 'monthly', 30).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

describe('schedule anchor on frequency change', () => {
  it('switching weekly to monthly anchors on the next run day; legacy null anchors are filled', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Sched TB', reportType: 'trial-balance', config: {} });
    const s = await createReportSchedule(ctx, { name: 'Weekly TB', memorizedReportId: m.id, frequency: 'weekly', startDate: '2026-01-05' });
    expect(s.anchorDay).toBe(5);
    await db.update(reportSchedules).set({ nextRunAt: new Date('2026-01-31T06:00:00.000Z'), anchorDay: null }).where(eq(reportSchedules.id, s.id));
    const u = await updateReportSchedule(ctx, s.id, { frequency: 'monthly' });
    expect(u.anchorDay).toBe(31);
    // Rename only keeps an existing anchor.
    const r = await updateReportSchedule(ctx, s.id, { name: 'Monthly TB' });
    expect(r.anchorDay).toBe(31);
  });
});

describe('legacy memorized rows (unknown report type)', () => {
  it('owner can rename and delete; a no-report user still cannot', async () => {
    const [legacy] = await db.insert(memorizedReports).values({ companyId: ctx.companyId, name: 'Old', reportType: 'pl_v1', config: {} }).returning();
    const none = fullAccess();
    for (const k of Object.keys(none.permissions) as (keyof typeof none.permissions)[]) {
      if (String(k).startsWith('reports_') || k === 'time') none.permissions[k] = [];
    }
    await expect(deleteMemorizedReport({ ...ctx, access: none }, legacy.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateMemorizedReport(ctx, legacy.id, { name: 'Old (renamed)' })).resolves.toMatchObject({ name: 'Old (renamed)' });
    await expect(deleteMemorizedReport(ctx, legacy.id)).resolves.toMatchObject({ deleted: true });
  });
});

describe('memorized report permissions', () => {
  const salesOnly = () => {
    const a = fullAccess();
    a.permissions.reports_financial = [];
    return a;
  };
  const noReports = () => {
    const a = fullAccess();
    for (const k of Object.keys(a.permissions) as (keyof typeof a.permissions)[]) {
      if (String(k).startsWith('reports_') || k === 'time') a.permissions[k] = [];
    }
    return a;
  };

  it('a sales-only user cannot delete a financial memorized report', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Owner TB', reportType: 'trial-balance', config: {} });
    await expect(deleteMemorizedReport({ ...ctx, access: salesOnly() }, m.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runMemorizedReport(ctx, m.id)).resolves.toBeTruthy();
  });

  it('a user with no report access cannot list groups, run or process memorized reports', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Owner P&L', reportType: 'profit-loss', config: {} });
    const clerk = { ...ctx, access: noReports() };
    await expect(listMemorizedGroups(clerk)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runMemorizedReport(clerk, m.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(processMultipleReports(clerk, { ids: [m.id] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('prototype keys are never standard reports', async () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(isStandardReport(k)).toBe(false);
      await expect(saveMemorizedReport(ctx, { name: k, reportType: k, config: {} })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
  });
});

describe('report schedule services enforce file_utilities in the service', () => {
  it('a user without file_utilities cannot list, create, change, delete or run schedules', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Perm TB', reportType: 'trial-balance', config: {} });
    const s = await createReportSchedule(ctx, { name: 'Perm sched', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-01-05' });
    const noFile = fullAccess();
    noFile.permissions.file_utilities = [];
    const c = { ...ctx, access: noFile };
    await expect(listReportSchedules(c)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createReportSchedule(c, { name: 'x', memorizedReportId: m.id, frequency: 'daily' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateReportSchedule(c, s.id, { isActive: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteReportSchedule(c, s.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runDueSchedules(c, { now: new Date('2026-01-06T00:00:00.000Z'), outDir: path.join(TEST_DIR, 'out') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Untouched.
    const still = (await listReportSchedules(ctx)).find((x) => x.id === s.id);
    expect(still?.isActive).toBe(true);
    await deleteReportSchedule(ctx, s.id);
  });
});
