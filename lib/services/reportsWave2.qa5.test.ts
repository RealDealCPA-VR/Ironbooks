/**
 * Independent QA (tester), part 5: re-test of reports fix round 2.
 *  - legacy memorized rows with unknown / prototype-key report types: owner can rename + delete,
 *    a user with no report access cannot, delete also drops the row's schedules, both are audited
 *  - legacy rows never become runnable through a rename / config replace
 *  - schedule anchor day after a frequency change (weekly -> monthly, monthly -> weekly -> monthly),
 *    and the 0030 backfill statement for null anchors
 * Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { auditLogs, companies, memorizedReports, reportSchedules, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import {
  createReportSchedule,
  deleteMemorizedReport,
  runDueSchedules,
  runMemorizedReport,
  saveMemorizedReport,
  updateMemorizedReport,
  updateReportSchedule,
} from './memorizedReports';
import { fullAccess } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2-qa5');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-qa5-'));
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

const noReports = () => {
  const a = fullAccess();
  for (const k of Object.keys(a.permissions) as (keyof typeof a.permissions)[]) {
    if (String(k).startsWith('reports_') || k === 'time') a.permissions[k] = [];
  }
  return a;
};
const salesOnly = () => {
  const a = fullAccess();
  a.permissions.reports_financial = [];
  return a;
};
const legacy = async (reportType: string, name = `Legacy ${reportType}`) =>
  (await db.insert(memorizedReports).values({ companyId: ctx.companyId, name, reportType, config: {} }).returning())[0];
const exists = async (id: string) => (await db.select().from(memorizedReports).where(eq(memorizedReports.id, id))).length > 0;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qa5@rep.test', name: 'QA5', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'QA5 Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
  await db.insert(userCompanies).values([{ userId: user.id, companyId: company.id, role: 'owner' }]);
  const mk = async (key: string, code: string, name: string, type: string, subtype: string) => {
    const r = await createAccount(ctx, { code, name, type: type as never, subtype } as never);
    A[key] = r.id;
  };
  await mk('bank', '1000', 'Checking', 'asset', 'checking');
  await mk('equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await postJournalEntry(ctx, { date: d('2026-01-02'), description: 'Capital', lines: [{ accountId: A.bank, debit: '1000' }, { accountId: A.equity, credit: '1000' }] });
}, 120_000);

afterAll(async () => {
  await closeDb();
  for (const dir of [TEST_DIR, OUT_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold PGlite files briefly */
    }
  }
});

describe('legacy memorized rows with unknown report types', () => {
  it.each(['pl_v1', '__proto__', 'constructor', 'toString', 'hasOwnProperty', ''])(
    'type %j: no-report user is FORBIDDEN, owner can rename and delete',
    async (type) => {
      const row = await legacy(type);
      const none = { ...ctx, access: noReports() };
      await expect(deleteMemorizedReport(none, row.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(updateMemorizedReport(none, row.id, { name: 'hijack' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await exists(row.id)).toBe(true);
      await expect(updateMemorizedReport(ctx, row.id, { name: '  Renamed  ' })).resolves.toMatchObject({ name: 'Renamed' });
      await expect(deleteMemorizedReport(ctx, row.id)).resolves.toMatchObject({ deleted: true });
      expect(await exists(row.id)).toBe(false);
    },
  );

  it('any report access (sales-only) may delete a legacy row, which exposes no data', async () => {
    const row = await legacy('old_sales_thing');
    await expect(deleteMemorizedReport({ ...ctx, access: salesOnly() }, row.id)).resolves.toMatchObject({ deleted: true });
  });

  it('a known financial report is still protected from a sales-only user (fix did not widen access)', async () => {
    const tb = await saveMemorizedReport(ctx, { name: 'TB keep', reportType: 'trial-balance', config: {} });
    const s = { ...ctx, access: salesOnly() };
    await expect(deleteMemorizedReport(s, tb.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateMemorizedReport(s, tb.id, { name: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await exists(tb.id)).toBe(true);
  });

  it('renaming / replacing config never makes a legacy row runnable', async () => {
    const row = await legacy('pl_v1');
    await updateMemorizedReport(ctx, row.id, { name: 'Now P&L', config: { params: { from: '2026-01-01' } } });
    await expect(runMemorizedReport(ctx, row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [after] = await db.select().from(memorizedReports).where(eq(memorizedReports.id, row.id));
    expect(after.reportType).toBe('pl_v1');
  });

  it('deleting a legacy row removes its schedules and writes audit entries for rename and delete', async () => {
    const row = await legacy('pl_v1', 'Scheduled legacy');
    const s = await createReportSchedule(ctx, { name: 'Legacy sched', memorizedReportId: row.id, frequency: 'daily', startDate: '2026-03-01' });
    await updateMemorizedReport(ctx, row.id, { name: 'Scheduled legacy 2' });
    await deleteMemorizedReport(ctx, row.id);
    expect(await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id))).toHaveLength(0);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'memorized_report'), eq(auditLogs.entityId, row.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(['delete', 'update']);
  });

  it('a non-existent id is NOT_FOUND, and another company cannot delete the row', async () => {
    const row = await legacy('pl_v1');
    await expect(deleteMemorizedReport(ctx, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [other] = await db.insert(companies).values({ name: 'Other Co', ownerId: ctx.userId! }).returning();
    await expect(deleteMemorizedReport({ ...ctx, companyId: other.id }, row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await exists(row.id)).toBe(true);
  });
});

describe('schedule anchor after frequency changes', () => {
  const sched = async (name: string, frequency: 'daily' | 'weekly' | 'monthly', startDate: string) => {
    const m = await saveMemorizedReport(ctx, { name: `M ${name}`, reportType: 'trial-balance', config: {} });
    return createReportSchedule(ctx, { name, memorizedReportId: m.id, frequency, startDate });
  };
  const setNext = (id: string, iso: string, anchorDay: number | null) =>
    db.update(reportSchedules).set({ nextRunAt: new Date(iso), anchorDay }).where(eq(reportSchedules.id, id));

  it('monthly anchor 31 survives rename / toggle / same-frequency patch while next run sits on Feb 28', async () => {
    const s = await sched('M31', 'monthly', '2026-01-31');
    expect(s.anchorDay).toBe(31);
    await setNext(s.id, '2026-02-28T06:00:00.000Z', 31);
    expect((await updateReportSchedule(ctx, s.id, { name: 'M31b' })).anchorDay).toBe(31);
    expect((await updateReportSchedule(ctx, s.id, { isActive: false })).anchorDay).toBe(31);
    expect((await updateReportSchedule(ctx, s.id, { frequency: 'monthly', isActive: true })).anchorDay).toBe(31);
  });

  it('monthly -> weekly -> monthly re-anchors on the next run day', async () => {
    const s = await sched('Flip', 'monthly', '2026-01-31');
    await setNext(s.id, '2026-02-28T06:00:00.000Z', 31);
    const w = await updateReportSchedule(ctx, s.id, { frequency: 'weekly' });
    expect(w.frequency).toBe('weekly');
    await setNext(s.id, '2026-03-14T06:00:00.000Z', w.anchorDay);
    const m = await updateReportSchedule(ctx, s.id, { frequency: 'monthly' });
    expect(m.anchorDay).toBe(14);
  });

  it('weekly switched to monthly on the 31st runs Feb 28 then Mar 31 (no drift to 28)', async () => {
    const s = await sched('W31', 'weekly', '2026-01-03');
    await setNext(s.id, '2026-01-31T06:00:00.000Z', 3);
    await updateReportSchedule(ctx, s.id, { frequency: 'monthly' });
    await runDueSchedules(ctx, { now: new Date('2026-01-31T07:00:00.000Z'), outDir: OUT_DIR });
    let [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row.nextRunAt.toISOString().slice(0, 10)).toBe('2026-02-28');
    await runDueSchedules(ctx, { now: new Date('2026-02-28T07:00:00.000Z'), outDir: OUT_DIR });
    [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row.nextRunAt.toISOString().slice(0, 10)).toBe('2026-03-31');
  });

  it('a legacy null anchor on an unchanged monthly schedule is filled from the next run', async () => {
    const s = await sched('Null', 'monthly', '2026-01-30');
    await setNext(s.id, '2026-03-30T06:00:00.000Z', null);
    expect((await updateReportSchedule(ctx, s.id, { name: 'Null2' })).anchorDay).toBe(30);
  });

  it('0030 backfill sets null anchors to the UTC day of next_run_at and leaves set anchors alone', async () => {
    const a = await sched('BF1', 'monthly', '2026-01-31');
    const b = await sched('BF2', 'monthly', '2026-01-15');
    await setNext(a.id, '2026-05-31T23:30:00.000Z', null);
    await setNext(b.id, '2026-05-01T00:30:00.000Z', 15);
    await db.execute(sql`UPDATE "report_schedules" SET "anchor_day" = EXTRACT(DAY FROM "next_run_at")::integer WHERE "anchor_day" IS NULL`);
    const [ra] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, a.id));
    const [rb] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, b.id));
    expect(ra.anchorDay).toBe(31);
    expect(rb.anchorDay).toBe(15);
  });

  it('unknown schedule id is NOT_FOUND', async () => {
    await expect(updateReportSchedule(ctx, '00000000-0000-0000-0000-000000000000', { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
