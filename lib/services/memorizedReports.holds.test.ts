/**
 * Scheduled Reports always say why a schedule waits now (lib/services/memorizedReports.ts):
 *  - listReportSchedules answers `waitingForAPerson` per schedule, from the audit trail, exactly as
 *    runDueSchedules decides it (an agent set it up or changed it, and no person has confirmed its
 *    recipients since);
 *  - a hold for another reason later (internet services off for this file on this computer)
 *    rewrites the stored reason, once, so a confirmed agent hold no longer shows.
 * The sequence: an agent sets a schedule up (held for a person), a person confirms it, then it is
 * held because internet services are off here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

const net = vi.hoisted(() => ({ held: false }));
vi.mock('@/lib/net/fileTrust', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/net/fileTrust')>()),
  internetHeldHere: async () => net.held,
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-memorized-report-holds');
const TEST_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'exports');

import { closeDb, getDb, type DB } from '@/lib/db';
import { auditLogs, reportSchedules, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import {
  AGENT_SCHEDULE_HELD_MESSAGE,
  SCHEDULE_HELD_MESSAGE,
  createReportSchedule,
  listReportSchedules,
  normalizeRecipients,
  runDueSchedules,
  saveMemorizedReport,
  updateReportSchedule,
} from './memorizedReports';
import { SEND_JUST_THE_ADDRESSES } from './emailSettings';

const NOW = new Date(2026, 1, 1, 9, 0, 0);
const AGENT = { id: '00000000-0000-4000-8000-0000000000b2', name: 'Reports agent', mode: 'post' as const };

let db: DB;
let ctx: ServiceContext;
let companyId: string;
let reportId: string;

/** Audit rows are ordered by time: keep each step on its own millisecond. */
const nextMoment = () => new Promise((r) => setTimeout(r, 5));
const runOnce = async (id: string) => (await runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR })).find((r) => r.scheduleId === id)!;
const listed = async (id: string) => (await listReportSchedules(ctx)).find((s) => s.id === id)!;
const auditRows = async (id: string) =>
  (await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityType, 'report_schedule'), eq(auditLogs.entityId, id)))).length;

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@holds.test', name: 'Holly Owner', passwordHash: 'x' }).returning();
  companyId = (await createCompany(db, { name: 'Holds Co', ownerId: u.id })).id;
  ctx = { db, companyId, userId: u.id };
  reportId = (await saveMemorizedReport(ctx, { name: 'Monthly P&L', reportType: 'profit-loss', config: { params: { from: '2026-01-01', to: '2026-01-31' } } })).id;
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('what a held schedule says it waits for', () => {
  it('agent hold, then a person confirms, then an internet hold: the listing and the stored reason follow each step', async () => {
    net.held = false;
    const s = await createReportSchedule(
      { ...ctx, agent: AGENT },
      { name: 'Board pack', memorizedReportId: reportId, frequency: 'monthly', startDate: '2026-02-01', format: 'csv', folder: 'Board', emailTo: 'board@acme.test' },
    );
    // Waiting for a person from the start, before it ever ran (the stored row has no message yet).
    expect(await listed(s.id)).toMatchObject({ waitingForAPerson: true, lastStatus: null, lastMessage: null });

    // 1. Held for a person.
    expect(await runOnce(s.id)).toMatchObject({ status: 'held', message: AGENT_SCHEDULE_HELD_MESSAGE });
    expect(await listed(s.id)).toMatchObject({ waitingForAPerson: true, lastStatus: 'held', lastMessage: AGENT_SCHEDULE_HELD_MESSAGE });

    // 2. A person saves its recipients: it no longer waits for a person (the stored message is the
    // last run's, until the next run).
    await nextMoment();
    await updateReportSchedule(ctx, s.id, { emailTo: 'board@acme.test' });
    expect(await listed(s.id)).toMatchObject({ waitingForAPerson: false, lastMessage: AGENT_SCHEDULE_HELD_MESSAGE });

    // 3. Internet services are off for this file here: held for that reason, and the row says so.
    net.held = true;
    await nextMoment();
    expect(await runOnce(s.id)).toMatchObject({ status: 'held', message: SCHEDULE_HELD_MESSAGE, files: [] });
    let [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row).toMatchObject({ lastStatus: 'held', lastMessage: SCHEDULE_HELD_MESSAGE });
    expect(row.nextRunAt.getTime()).toBeLessThanOrEqual(NOW.getTime()); // still due
    expect(await listed(s.id)).toMatchObject({ waitingForAPerson: false, lastMessage: SCHEDULE_HELD_MESSAGE });

    // The timer asks again: still held, nothing rewritten.
    const n = await auditRows(s.id);
    expect(await runOnce(s.id)).toMatchObject({ status: 'held', message: SCHEDULE_HELD_MESSAGE });
    expect(await auditRows(s.id)).toBe(n);

    // An agent changes it again: the agent hold decides first, and the reason is rewritten back.
    await nextMoment();
    await updateReportSchedule({ ...ctx, agent: AGENT }, s.id, { emailTo: 'board@acme.test', frequency: 'monthly' });
    expect(await listed(s.id)).toMatchObject({ waitingForAPerson: true });
    expect(await runOnce(s.id)).toMatchObject({ status: 'held', message: AGENT_SCHEDULE_HELD_MESSAGE });
    [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row.lastMessage).toBe(AGENT_SCHEDULE_HELD_MESSAGE);
  });

  it("a person's own schedule never waits for a person", async () => {
    net.held = false;
    const s = await createReportSchedule(ctx, { name: 'Own one', memorizedReportId: reportId, frequency: 'monthly', startDate: '2026-02-01', format: 'csv', folder: 'Own' });
    expect(await listed(s.id)).toMatchObject({ waitingForAPerson: false });
  });
});

describe("a schedule's recipients follow the app's one address rule", () => {
  it('refuses what the mailer reads as a group, a literal or an escape, for a person and an agent; an agent sends plain addresses only', async () => {
    for (const bad of ['acme.com:x@evil.example', 'a[b]@acme.com', 'a\\b@acme.com', 'a(b)@acme.com', 'Name<x@evil.example>']) {
      expect(() => normalizeRecipients(bad), bad).toThrow(/is not a valid email address/);
      expect(() => normalizeRecipients(bad, { agent: AGENT }), bad).toThrow(`Recipients: ${SEND_JUST_THE_ADDRESSES}`);
    }
    // A person may still type a domain an agent may not send to.
    expect(normalizeRecipients('ap@acme_corp.com')).toBe('ap@acme_corp.com');
    expect(() => normalizeRecipients('ap@acme_corp.com', { agent: AGENT })).toThrow(`Recipients: ${SEND_JUST_THE_ADDRESSES}`);
    expect(() => normalizeRecipients('a‮b@acme.com', { agent: AGENT })).toThrow(`Recipients: ${SEND_JUST_THE_ADDRESSES}`);
    expect(normalizeRecipients('a@acme.com; b@acme.co.uk', { agent: AGENT })).toBe('a@acme.com, b@acme.co.uk');
    // The service refuses an agent's before anything is saved.
    await expect(
      createReportSchedule({ ...ctx, agent: AGENT }, { name: 'Bad one', memorizedReportId: reportId, frequency: 'monthly', emailTo: 'acme.com:x@evil.example' }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: `Recipients: ${SEND_JUST_THE_ADDRESSES}` });
    expect((await listReportSchedules(ctx)).some((s) => s.name === 'Bad one')).toBe(false);
  });
});
