/**
 * Independent QA (tester), part 7: re-test of reports fix round 3 (H5 wired end to end).
 *  - Both run-due routes (/api/reports/schedules/run-due, the timer path, and the legacy
 *    /api/report-schedules/run-due) accept the per-launch internal token and fail closed without it
 *    (missing header, server token unset, wrong-length token), consuming nothing.
 *  - The timer path resolves to file_utilities POST:create in the permission map (not shadowed by
 *    a dynamic /api/reports/* rule), and every run-due route file is mapped.
 *  - Scheduling gates: custom (report builder) reports need reports_financial; a cross-company or
 *    malformed memorized report id is NOT_FOUND / a 4xx error, never a 500 or a schedule row.
 *  - Run-time: a limited "Run due reports now" re-checks the group's CURRENT members (a P&L added
 *    after scheduling makes it skipped, not leaked); a creator removed from the company fails the
 *    trusted run; a skipped schedule leaves lastStatus/lastMessage/audit untouched.
 * Hermetic PGlite data dir (BKA_DATA_DIR so the route's getDb() opens the same file).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { auditLogs, companies, reportSchedules, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { createMemorizedGroup, createReportSchedule, runDueSchedules, saveMemorizedReport } from './memorizedReports';
import { fullAccess } from '@/lib/permissions/model';
import { apiRuleFor, routePatternFromFile, API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';

const ROOT = process.cwd();
const TEST_DIR = path.resolve(ROOT, '.bookkeeper-data', 'test-reports-wave2-qa7');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-qa7-'));
const NEW_ROUTE = path.join(ROOT, 'app', 'api', 'reports', 'schedules', 'run-due', 'route.ts');
const OLD_ROUTE = path.join(ROOT, 'app', 'api', 'report-schedules', 'run-due', 'route.ts');
const NOW = new Date('2026-03-01T08:00:00.000Z');

let db: DB;
let ctx: ServiceContext;
let otherCtx: ServiceContext;
let goneId: string;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const savedEnv = { data: process.env.BKA_DATA_DIR, out: process.env.BKA_REPORT_EXPORT_DIR, tok: process.env.BKA_INTERNAL_TOKEN };
const noFinancial = () => {
  const a = fullAccess();
  a.permissions.reports_financial = [];
  return a;
};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.env.BKA_DATA_DIR = TEST_DIR;
  process.env.BKA_REPORT_EXPORT_DIR = OUT_DIR;
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'qa7@rep.test', name: 'QA7', passwordHash: 'x' }).returning();
  const [gone] = await db.insert(users).values({ email: 'gone7@rep.test', name: 'Gone', passwordHash: 'x' }).returning();
  goneId = gone.id;
  const [company] = await db.insert(companies).values({ name: 'QA7 Co', ownerId: owner.id }).returning();
  ctx = { db, companyId: company.id, userId: owner.id };
  await db.insert(userCompanies).values([{ userId: owner.id, companyId: company.id, role: 'owner' }]);
  // A second company created later (internalContext picks the first-created company).
  const [other] = await db.insert(companies).values({ name: 'QA7 Other', ownerId: owner.id }).returning();
  otherCtx = { db, companyId: other.id, userId: owner.id };
  const bank = await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' } as never);
  const inc = await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue', subtype: 'sales' } as never);
  await postJournalEntry(ctx, {
    date: d('2026-01-10'),
    description: 'Sale',
    lines: [{ accountId: bank.id, debit: '100' }, { accountId: inc.id, credit: '100' }],
  });
}, 120_000);

beforeEach(async () => {
  await db.update(reportSchedules).set({ isActive: false });
});

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

type RouteMod = { POST: (r: NextRequest) => Promise<Response> };
const load = async (file: string) => (await import(/* @vite-ignore */ file)) as RouteMod;
const req = (p: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://127.0.0.1${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

async function dueTb(name: string) {
  const m = await saveMemorizedReport(ctx, { name: `${name} TB`, reportType: 'trial-balance', config: { asOf: '2026-01-31' } });
  return createReportSchedule(ctx, { name, memorizedReportId: m.id, frequency: 'daily', startDate: '2026-01-05' });
}
async function untouched(id: string) {
  const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
  expect(row.lastRunAt).toBeNull();
  expect(row.nextRunAt.toISOString().slice(0, 10)).toBe('2026-01-05');
}

describe('run-due routes: internal token', () => {
  it('the legacy /api/report-schedules/run-due also accepts the internal token', async () => {
    const s = await dueTb('Legacy route');
    const tok = 'f'.repeat(64);
    process.env.BKA_INTERNAL_TOKEN = tok;
    try {
      const res = await (await load(OLD_ROUTE)).POST(req('/api/report-schedules/run-due', { 'x-bka-internal': tok }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { scheduleId: string; status: string }[] };
      expect(body.results.find((r) => r.scheduleId === s.id)?.status).toBe('ok');
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
  });

  for (const [label, env, header] of [
    ['no header', 'c'.repeat(64), undefined],
    ['server token unset', undefined, 'c'.repeat(64)],
    ['wrong-length token (prefix)', 'c'.repeat(64), 'c'.repeat(63)],
    ['empty header', 'c'.repeat(64), ''],
  ] as const) {
    it(`timer path fails closed with ${label} and consumes no schedule`, async () => {
      const s = await dueTb(`Closed ${label}`);
      if (env === undefined) delete process.env.BKA_INTERNAL_TOKEN;
      else process.env.BKA_INTERNAL_TOKEN = env;
      try {
        const res = await (await load(NEW_ROUTE)).POST(
          req('/api/reports/schedules/run-due', header === undefined ? {} : { 'x-bka-internal': header }),
        );
        expect(res.status).toBeGreaterThanOrEqual(401);
        expect(res.status).toBeLessThan(500);
      } finally {
        delete process.env.BKA_INTERNAL_TOKEN;
      }
      await untouched(s.id);
    });
  }

  it('the trusted run only touches the first company (another company schedule stays due)', async () => {
    const m = await saveMemorizedReport(otherCtx, { name: 'Other TB', reportType: 'trial-balance', config: {} });
    const s = await createReportSchedule(otherCtx, { name: 'Other daily', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-01-05' });
    const tok = '9'.repeat(64);
    process.env.BKA_INTERNAL_TOKEN = tok;
    try {
      const res = await (await load(NEW_ROUTE)).POST(req('/api/reports/schedules/run-due', { 'x-bka-internal': tok }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { scheduleId: string }[] };
      expect(body.results.map((r) => r.scheduleId)).not.toContain(s.id);
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
    await untouched(s.id);
  });
});

describe('run-due routes: permission map', () => {
  it('the timer path resolves to file_utilities create (not a dynamic /api/reports rule)', () => {
    expect(apiRuleFor('/api/reports/schedules/run-due', 'POST')).toEqual({ area: 'file_utilities', action: 'create' });
    expect(apiRuleFor('/api/reports/schedules/run-due', 'GET')).toBeNull();
  });

  it('both route files map to a pattern present in API_ROUTE_PERMISSIONS', () => {
    for (const f of [NEW_ROUTE, OLD_ROUTE]) {
      expect(fs.existsSync(f)).toBe(true);
      expect(API_ROUTE_PERMISSIONS[routePatternFromFile(path.relative(ROOT, f))]).toBeTruthy();
    }
  });
});

describe('scheduling gates', () => {
  it('a custom (report builder) memorized report needs reports_financial to schedule', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Builder', reportType: 'custom', config: {} });
    await expect(
      createReportSchedule({ ...ctx, access: noFinancial() }, { name: 'Builder daily', memorizedReportId: m.id, frequency: 'daily' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('another company memorized report cannot be scheduled (NOT_FOUND, no row)', async () => {
    const m = await saveMemorizedReport(otherCtx, { name: 'Foreign', reportType: 'trial-balance', config: {} });
    await expect(createReportSchedule(ctx, { name: 'Foreign daily', memorizedReportId: m.id, frequency: 'daily' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const rows = await db.select().from(reportSchedules).where(and(eq(reportSchedules.companyId, ctx.companyId), eq(reportSchedules.memorizedReportId, m.id)));
    expect(rows).toHaveLength(0);
  });

  it('a malformed memorized report id is rejected with a service error, not a raw DB error', async () => {
    await expect(
      createReportSchedule(ctx, { name: 'Bad id', memorizedReportId: 'not-a-uuid', frequency: 'daily' }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(NOT_FOUND|VALIDATION)$/) });
  });

  it('a group-less and report-less schedule (or both set) is a validation error', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'Both' });
    const m = await saveMemorizedReport(ctx, { name: 'Both TB', reportType: 'trial-balance', config: {}, groupId: g.id });
    await expect(createReportSchedule(ctx, { name: 'x', frequency: 'daily' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createReportSchedule(ctx, { name: 'x', memorizedReportId: m.id, groupId: g.id, frequency: 'daily' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('run-time access', () => {
  it('a limited "Run due now" re-checks the group current members: a P&L added later makes it skipped', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'Drift' });
    await saveMemorizedReport(ctx, { name: 'Drift AR', reportType: 'customer-balance-summary', config: {}, groupId: g.id });
    const s = await createReportSchedule({ ...ctx, access: noFinancial() }, { name: 'Drift daily', groupId: g.id, frequency: 'daily', startDate: '2026-01-05' });
    await saveMemorizedReport(ctx, { name: 'Drift PL', reportType: 'profit-loss', config: {}, groupId: g.id });
    const auditBefore = await db.select().from(auditLogs).where(eq(auditLogs.entityId, s.id));
    const res = await runDueSchedules({ ...ctx, access: noFinancial() }, { now: NOW, outDir: OUT_DIR });
    const r = res.find((x) => x.scheduleId === s.id)!;
    expect(r.status).toBe('skipped');
    expect(r.files).toEqual([]);
    await untouched(s.id);
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row.lastStatus ?? null).toBeNull();
    const auditAfter = await db.select().from(auditLogs).where(eq(auditLogs.entityId, s.id));
    expect(auditAfter.length).toBe(auditBefore.length);
  });

  it('a creator who is not a member of the company fails the trusted run (no file, moves on)', async () => {
    const s = await dueTb('Gone creator');
    await db.update(reportSchedules).set({ createdBy: goneId }).where(eq(reportSchedules.id, s.id));
    const res = await runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR });
    const r = res.find((x) => x.scheduleId === s.id)!;
    expect(r.status).toBe('failed');
    expect(r.files).toEqual([]);
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row.nextRunAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('a limited user without file_utilities cannot run due schedules at all', async () => {
    const a = fullAccess();
    a.permissions.file_utilities = [];
    await expect(runDueSchedules({ ...ctx, access: a }, { now: NOW, outDir: OUT_DIR })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
