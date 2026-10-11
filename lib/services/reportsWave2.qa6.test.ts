/**
 * Independent QA (tester), part 6: re-test after the "schedule services enforce file_utilities"
 * fix, focused on H5 being wired end to end.
 *  - The prefs team's Electron timer (wave2/prefs electron/main.js) calls
 *    POST /api/reports/schedules/run-due with the per-launch internal token (x-bka-internal) and
 *    stops polling for good on a 404. The work-package spec names that path for the reports team.
 *    The run-due route must exist at that path, be mapped in lib/permissions/routes.ts, and accept
 *    the internal token (the timer has no session cookie), like /api/recurring/run does.
 *  - Session-less calls without the token must fail closed (no schedule consumed).
 *  - Scheduling a memorized report is a way of running it: a file_utilities user who can't view
 *    the report's area must not be able to schedule it (the run happens later under the trusted
 *    timer context and writes the data to the export folder).
 *  - Calendar edge cases of the comparison windows and schedule anchors not yet covered.
 * Hermetic PGlite data dir (BKA_DATA_DIR so the route's getDb() opens the same file).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, reportSchedules, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { createReportSchedule, nextRunAfter, saveMemorizedReport } from './memorizedReports';
import { runStandardReport } from './reportRegistry';
import { fullAccess } from '@/lib/permissions/model';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';

const ROOT = process.cwd();
const TEST_DIR = path.resolve(ROOT, '.bookkeeper-data', 'test-reports-wave2-qa6');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-qa6-'));
const PREFS_TIMER_PATH = '/api/reports/schedules/run-due';
const PREFS_ROUTE_FILE = path.join(ROOT, 'app', 'api', 'reports', 'schedules', 'run-due', 'route.ts');
const CURRENT_ROUTE_FILE = path.join(ROOT, 'app', 'api', 'report-schedules', 'run-due', 'route.ts');

let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const savedEnv = { data: process.env.BKA_DATA_DIR, out: process.env.BKA_REPORT_EXPORT_DIR, tok: process.env.BKA_INTERNAL_TOKEN };

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.env.BKA_DATA_DIR = TEST_DIR;
  process.env.BKA_REPORT_EXPORT_DIR = OUT_DIR;
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qa6@rep.test', name: 'QA6', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'QA6 Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
  await db.insert(userCompanies).values([{ userId: user.id, companyId: company.id, role: 'owner' }]);
  const mk = async (key: string, code: string, name: string, type: string, subtype: string) => {
    const r = await createAccount(ctx, { code, name, type: type as never, subtype } as never);
    A[key] = r.id;
  };
  await mk('bank', '1000', 'Checking', 'asset', 'checking');
  await mk('equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk('inc', '4000', 'Sales', 'revenue', 'sales');
  await postJournalEntry(ctx, { date: d('2026-01-02'), description: 'Capital', lines: [{ accountId: A.bank, debit: '1000' }, { accountId: A.equity, credit: '1000' }] });
  await postJournalEntry(ctx, { date: d('2026-02-10'), description: 'Feb sale', lines: [{ accountId: A.bank, debit: '200' }, { accountId: A.inc, credit: '200' }] });
  await postJournalEntry(ctx, { date: d('2026-05-10'), description: 'May sale', lines: [{ accountId: A.bank, debit: '50' }, { accountId: A.inc, credit: '50' }] });
}, 120_000);

afterAll(async () => {
  await closeDb();
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('BKA_DATA_DIR', savedEnv.data);
  restore('BKA_REPORT_EXPORT_DIR', savedEnv.out);
  restore('BKA_INTERNAL_TOKEN', savedEnv.tok);
  for (const dir of [TEST_DIR, OUT_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold PGlite files briefly */
    }
  }
});

const req = (headers: Record<string, string> = {}) =>
  new NextRequest(`http://127.0.0.1${PREFS_TIMER_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });

type RouteMod = { POST: (r: NextRequest) => Promise<Response> };
async function loadRoute(file: string): Promise<RouteMod> {
  return (await import(/* @vite-ignore */ file)) as RouteMod;
}

describe('H5: the run-due endpoint the Electron timer calls', () => {
  it('exists at /api/reports/schedules/run-due (the path the prefs timer polls; a 404 stops it for good)', () => {
    expect(fs.existsSync(PREFS_ROUTE_FILE)).toBe(true);
  });

  it('is mapped in lib/permissions/routes.ts', () => {
    expect(Object.keys(API_ROUTE_PERMISSIONS)).toContain(PREFS_TIMER_PATH);
  });

  it('accepts the per-launch internal token and runs the due schedule (no session cookie)', async () => {
    const file = fs.existsSync(PREFS_ROUTE_FILE) ? PREFS_ROUTE_FILE : CURRENT_ROUTE_FILE;
    const { POST } = await loadRoute(file);
    const m = await saveMemorizedReport(ctx, { name: 'Timer TB', reportType: 'trial-balance', config: { asOf: '2026-03-31' } });
    const s = await createReportSchedule(ctx, { name: 'Timer TB daily', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-01-05', folder: 'Timer' });
    const token = 'e'.repeat(64);
    process.env.BKA_INTERNAL_TOKEN = token;
    try {
      const res = await POST(req({ 'x-bka-internal': token }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { scheduleId: string; status: string; files: string[] }[] };
      const mine = body.results.find((r) => r.scheduleId === s.id);
      expect(mine?.status).toBe('ok');
      expect(mine?.files.length).toBe(1);
      expect(fs.existsSync(mine!.files[0])).toBe(true);
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
  });

  it('fails closed for a session-less call with a wrong token, and consumes no schedule', async () => {
    const file = fs.existsSync(PREFS_ROUTE_FILE) ? PREFS_ROUTE_FILE : CURRENT_ROUTE_FILE;
    const { POST } = await loadRoute(file);
    const m = await saveMemorizedReport(ctx, { name: 'Closed TB', reportType: 'trial-balance', config: {} });
    const s = await createReportSchedule(ctx, { name: 'Closed TB daily', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-01-05' });
    process.env.BKA_INTERNAL_TOKEN = 'a'.repeat(64);
    try {
      const res = await POST(req({ 'x-bka-internal': 'b'.repeat(64) }));
      expect(res.status).toBeGreaterThanOrEqual(401);
      expect(res.status).toBeLessThan(500);
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row.lastRunAt).toBeNull();
    expect(row.nextRunAt.toISOString().slice(0, 10)).toBe('2026-01-05');
  });
});

describe('scheduling a report needs access to that report', () => {
  it('a file_utilities user without reports_financial cannot schedule a financial memorized report', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Owner P&L', reportType: 'profit-loss', config: {} });
    const a = fullAccess();
    a.permissions.reports_financial = [];
    await expect(
      createReportSchedule({ ...ctx, access: a }, { name: 'Sneaky P&L', memorizedReportId: m.id, frequency: 'daily' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the same user may still schedule a report in an area they can view', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Owner AR', reportType: 'customer-balance-summary', config: {} });
    const a = fullAccess();
    a.permissions.reports_financial = [];
    const s = await createReportSchedule({ ...ctx, access: a }, { name: 'AR daily', memorizedReportId: m.id, frequency: 'daily' });
    expect(s.id).toBeTruthy();
  });
});

describe('comparison windows: more calendar edges', () => {
  const header = async (key: string, params: Record<string, string>) => {
    const r = await runStandardReport(ctx, key, params);
    return r.columns.map((c) => c.header).join(' | ');
  };

  it('February 2029 vs prev_year covers all of February 2028, leap day included', async () => {
    const h = await header('profit-loss', { from: '2029-02-01', to: '2029-02-28', compare: 'prev_year' });
    expect(h).toContain('02/29/2028');
  });

  it('a two-month range (Apr-May) compares with Feb-Mar, and the Feb-Mar column foots to the Feb sale', async () => {
    const r = await runStandardReport(ctx, 'profit-loss', { from: '2026-04-01', to: '2026-05-31', compare: 'prev_period' });
    const hs = r.columns.map((c) => c.header).join(' | ');
    expect(hs).toContain('02/01/2026');
    expect(hs).toContain('03/31/2026');
    const ni = r.rows.find((x) => /net income/i.test(String(x.cells.label)));
    expect(ni).toBeTruthy();
    const vals = Object.entries(ni!.cells).filter(([k]) => k !== 'label').map(([, v]) => v);
    expect(vals).toContain('50.00');
    expect(vals).toContain('200.00');
  });

  it('balance sheet as of Feb 29 2028 vs prev_period compares with Jan 31 (month end stays month end)', async () => {
    expect(await header('balance-sheet', { asOf: '2028-02-29', compare: 'prev_period' })).toContain('01/31/2028');
  });

  it('balance sheet as of Feb 28 2029 vs prev_year compares with Feb 29 2028', async () => {
    expect(await header('balance-sheet', { asOf: '2029-02-28', compare: 'prev_year' })).toContain('02/29/2028');
  });
});

describe('monthly schedule anchors', () => {
  it('anchor 31 walks Jan 31 -> Feb 29 (leap) -> Mar 31 -> Apr 30 -> May 31', () => {
    let x = new Date('2028-01-31T06:00:00.000Z');
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      x = nextRunAfter(x, 'monthly', 31);
      seen.push(x.toISOString().slice(0, 10));
    }
    expect(seen).toEqual(['2028-02-29', '2028-03-31', '2028-04-30', '2028-05-31']);
  });

  it('anchor 30 across December -> January -> February keeps the year roll right', () => {
    let x = new Date('2026-12-30T06:00:00.000Z');
    x = nextRunAfter(x, 'monthly', 30);
    expect(x.toISOString().slice(0, 10)).toBe('2027-01-30');
    x = nextRunAfter(x, 'monthly', 30);
    expect(x.toISOString().slice(0, 10)).toBe('2027-02-28');
    x = nextRunAfter(x, 'monthly', 30);
    expect(x.toISOString().slice(0, 10)).toBe('2027-03-30');
  });

  it('a garbage anchor (0, 32, -1) falls back to the current day instead of producing an invalid date', () => {
    for (const bad of [0, 32, -1]) {
      const x = nextRunAfter(new Date('2026-01-15T06:00:00.000Z'), 'monthly', bad);
      expect(x.toISOString().slice(0, 10)).toBe('2026-02-15');
    }
  });
});
