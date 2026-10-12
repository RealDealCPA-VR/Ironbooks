/**
 * Reports fix round 3 (H5 scheduled reports):
 *  - scheduling a report group needs view on every report in the group;
 *  - "Run due reports now" by a limited user skips (leaves due) schedules that user can't run;
 *  - the trusted timer run uses the schedule creator's current access (group drift, deactivated
 *    creator).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, reportSchedules, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { createMemorizedGroup, createReportSchedule, runDueSchedules, saveMemorizedReport } from './memorizedReports';
import { fullAccess } from '@/lib/permissions/model';

const ROOT = process.cwd();
const TEST_DIR = path.resolve(ROOT, '.bookkeeper-data', 'test-reports-wave2-fixes3');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-fix3-'));

let db: DB;
let ctx: ServiceContext;
let clerkId: string;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const NOW = new Date('2026-03-01T08:00:00.000Z');
const noFinancial = () => {
  const a = fullAccess();
  a.permissions.reports_financial = [];
  return a;
};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'fix3@rep.test', name: 'Owner', passwordHash: 'x' }).returning();
  const [clerk] = await db.insert(users).values({ email: 'clerk3@rep.test', name: 'Clerk', passwordHash: 'x' }).returning();
  clerkId = clerk.id;
  const [company] = await db.insert(companies).values({ name: 'Fix3 Co', ownerId: owner.id }).returning();
  ctx = { db, companyId: company.id, userId: owner.id };
  await db.insert(userCompanies).values([
    { userId: owner.id, companyId: company.id, role: 'owner' },
    { userId: clerk.id, companyId: company.id, role: 'accountant' },
  ]);
  await db.insert(userRoleAssignments).values({ companyId: company.id, userId: clerk.id, roleKey: 'ar_clerk' });
  const bank = await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' } as never);
  const inc = await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue', subtype: 'sales' } as never);
  await postJournalEntry(ctx, {
    date: d('2026-01-10'),
    description: 'Sale',
    lines: [{ accountId: bank.id, debit: '100' }, { accountId: inc.id, credit: '100' }],
  });
}, 120_000);

beforeEach(async () => {
  // Each test looks only at its own schedules.
  await db.update(reportSchedules).set({ isActive: false });
});

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

describe('scheduling a group needs view on every report in it', () => {
  it('rejects a group containing a financial report for a user without reports_financial', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'Mixed' });
    await saveMemorizedReport(ctx, { name: 'G AR', reportType: 'customer-balance-summary', config: {}, groupId: g.id });
    await saveMemorizedReport(ctx, { name: 'G PL', reportType: 'profit-loss', config: {}, groupId: g.id });
    await expect(
      createReportSchedule({ ...ctx, access: noFinancial() }, { name: 'Mixed daily', groupId: g.id, frequency: 'daily' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows a group whose reports are all in areas the user can view', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'Sales only' });
    await saveMemorizedReport(ctx, { name: 'S AR', reportType: 'customer-balance-summary', config: {}, groupId: g.id });
    const s = await createReportSchedule({ ...ctx, access: noFinancial() }, { name: 'Sales daily', groupId: g.id, frequency: 'daily' });
    expect(s.id).toBeTruthy();
  });
});

describe('Run due reports now by a limited user', () => {
  it('skips a schedule the user cannot run and leaves it due; the trusted run then runs it', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Owner PL', reportType: 'profit-loss', config: {} });
    const s = await createReportSchedule(ctx, { name: 'Owner PL daily', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-02-01' });
    const limited = await runDueSchedules({ ...ctx, access: noFinancial() }, { now: NOW, outDir: OUT_DIR });
    const mine = limited.find((r) => r.scheduleId === s.id);
    expect(mine?.status).toBe('skipped');
    expect(mine?.files).toEqual([]);
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row.lastRunAt).toBeNull();
    expect(row.nextRunAt.toISOString().slice(0, 10)).toBe('2026-02-01');

    const trusted = await runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR });
    const ran = trusted.find((r) => r.scheduleId === s.id);
    expect(ran?.status).toBe('ok');
    expect(ran?.files.length).toBe(1);
  });
});

describe('trusted (timer) run uses the creator access', () => {
  it('a report added to the group later in an area the creator cannot view is not exported', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'Clerk group' });
    await saveMemorizedReport(ctx, { name: 'Clerk AR', reportType: 'customer-balance-summary', config: {}, groupId: g.id });
    const s = await createReportSchedule(ctx, { name: 'Clerk group daily', groupId: g.id, frequency: 'daily', startDate: '2026-02-01' });
    await db.update(reportSchedules).set({ createdBy: clerkId }).where(eq(reportSchedules.id, s.id));
    // The owner later drops a P&L into the clerk's scheduled group.
    await saveMemorizedReport(ctx, { name: 'Later PL', reportType: 'profit-loss', config: {}, groupId: g.id });
    const res = await runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR });
    const r = res.find((x) => x.scheduleId === s.id)!;
    expect(r.status).toBe('partial');
    expect(r.files.map((f) => path.basename(f))).toEqual([expect.stringMatching(/^Clerk AR /)]);
    expect(r.message).toMatch(/Later PL/);
  });

  it('a schedule whose creator is deactivated fails instead of running with full access', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Clerk AR 2', reportType: 'customer-balance-summary', config: {} });
    const s = await createReportSchedule(ctx, { name: 'Clerk AR 2 daily', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-02-01' });
    await db.update(reportSchedules).set({ createdBy: clerkId }).where(eq(reportSchedules.id, s.id));
    await db.update(userCompanies).set({ isActive: false }).where(eq(userCompanies.userId, clerkId));
    try {
      const res = await runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR });
      const r = res.find((x) => x.scheduleId === s.id)!;
      expect(r.status).toBe('failed');
      expect(r.files).toEqual([]);
      expect(r.message).toMatch(/no longer has access/);
    } finally {
      await db.update(userCompanies).set({ isActive: true }).where(eq(userCompanies.userId, clerkId));
    }
  });
});
