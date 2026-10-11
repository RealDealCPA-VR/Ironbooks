/**
 * Doer regression tests for the wave-2 reports fix round (beyond the tester's QA files):
 * comparison dates for quarters / month ends, monthly schedule anchors, memorized report
 * delete / group listing permissions, prototype keys. Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { isStandardReport, runStandardReport } from './reportRegistry';
import {
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
