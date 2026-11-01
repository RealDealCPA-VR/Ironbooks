/**
 * Report gaps round — scheduled reports:
 *  - H5: a schedule can also EMAIL its export (QB "Send report as e-mail" on a schedule): the
 *    files are attached and sent through the app's mail service (lib/services/email.ts sendMail,
 *    which applies the Send Forms / SMTP settings, sandbox mode and the network opt-in); a failed
 *    email never loses the saved files.
 *  - Leftover: export files are written to a temporary file and renamed into place, so a run that
 *    fails while writing never leaves a half-written report where the last good one was.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const sent: Array<{ to: string; subject: string; text: string; attachments?: Array<{ filename?: string; content?: unknown }> }> = [];
let failSend: Error | null = null;
vi.mock('./email', async (orig) => ({
  ...(await orig<typeof import('./email')>()),
  sendMail: vi.fn(async (opts: (typeof sent)[number]) => {
    if (failSend) throw failSend;
    sent.push(opts);
  }),
}));

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, reportSchedules, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import {
  createReportSchedule,
  normalizeRecipients,
  runDueSchedules,
  saveMemorizedReport,
  updateReportSchedule,
} from './memorizedReports';
import { reportScheduleSchema, updateReportScheduleSchema } from '@/lib/validation/reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-sched');
let OUT: string;
let db: DB;
let ctx: ServiceContext;
let memId: string;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-gaps-sched-'));
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'gaps-sched@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Schedule Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const code: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) code[a.code] = a.id;
  await postJournalEntry(ctx, { date: d('2026-01-10'), description: 'Sale', lines: [{ accountId: code['1000'], debit: '125.00' }, { accountId: code['4000'], credit: '125.00' }] });
  memId = (await saveMemorizedReport(ctx, { name: 'Month TB', reportType: 'trial-balance', config: { params: { asOf: '2026-01-31' } } })).id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
});

beforeEach(async () => {
  sent.length = 0;
  failSend = null;
  await db.delete(reportSchedules).where(eq(reportSchedules.companyId, ctx.companyId));
});

describe('email recipients', () => {
  it('normalizes a recipient list and refuses anything that is not an email address', () => {
    expect(normalizeRecipients(' a@x.com; B@y.org ,a@x.com ')).toBe('a@x.com, B@y.org');
    expect(normalizeRecipients('')).toBeNull();
    expect(normalizeRecipients(null)).toBeNull();
    expect(() => normalizeRecipients('not an email')).toThrow(/not a valid email/);
    expect(() => normalizeRecipients('a@x.com\r\nBcc: evil@x.com')).toThrow();
    expect(() => normalizeRecipients(Array.from({ length: 21 }, (_, i) => `p${i}@x.com`).join(','))).toThrow(/at most 20/);
    expect(reportScheduleSchema.safeParse({ name: 'x', memorizedReportId: memId, frequency: 'daily', emailTo: 'a@x.com' }).success).toBe(true);
    expect(updateReportScheduleSchema.safeParse({ emailTo: null }).success).toBe(true);
  });

  it('a schedule keeps its recipients; clearing them goes back to files only', async () => {
    const s = await createReportSchedule(ctx, { name: 'Mail', memorizedReportId: memId, frequency: 'monthly', startDate: '2026-02-01', emailTo: 'boss@x.com,cpa@y.com' });
    expect(s.emailTo).toBe('boss@x.com, cpa@y.com');
    const u = await updateReportSchedule(ctx, s.id, { emailTo: '' });
    expect(u.emailTo).toBeNull();
    await expect(updateReportSchedule(ctx, s.id, { emailTo: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('scheduled report email (H5)', () => {
  it('emails the saved export to the recipients, attached', async () => {
    const s = await createReportSchedule(ctx, { name: 'Month-end pack', memorizedReportId: memId, frequency: 'monthly', startDate: '2026-02-01', emailTo: 'boss@x.com' });
    const [r] = await runDueSchedules(ctx, { now: d('2026-02-01'), outDir: OUT });
    expect(r.status).toBe('ok');
    expect(r.files).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('boss@x.com');
    expect(sent[0].subject).toContain('Month-end pack');
    expect(sent[0].attachments?.map((a) => a.filename)).toEqual([path.basename(r.files[0])]);
    expect(String(sent[0].attachments?.[0].content)).toContain('Month TB');
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(row.lastMessage).toMatch(/emailed to boss@x\.com/);
  });

  it('a schedule without recipients sends nothing', async () => {
    await createReportSchedule(ctx, { name: 'Files only', memorizedReportId: memId, frequency: 'monthly', startDate: '2026-02-01' });
    const [r] = await runDueSchedules(ctx, { now: d('2026-02-01'), outDir: OUT });
    expect(r.status).toBe('ok');
    expect(sent).toHaveLength(0);
  });

  it('when the email cannot be sent the files are still saved and the run says why', async () => {
    failSend = Object.assign(new Error('Email not configured.'), { code: 'VALIDATION' });
    await createReportSchedule(ctx, { name: 'No smtp', memorizedReportId: memId, frequency: 'monthly', startDate: '2026-02-01', emailTo: 'boss@x.com' });
    const [r] = await runDueSchedules(ctx, { now: d('2026-02-01'), outDir: OUT });
    expect(r.status).toBe('partial');
    expect(r.files).toHaveLength(1);
    expect(fs.existsSync(r.files[0])).toBe(true);
    expect(r.message).toMatch(/not emailed.*Email not configured/i);
  });
});

describe('export files are replaced atomically (leftover)', () => {
  it('a write that fails half-way leaves the previous export intact', async () => {
    await createReportSchedule(ctx, { name: 'Atomic', memorizedReportId: memId, frequency: 'daily', startDate: '2026-03-01' });
    const [first] = await runDueSchedules(ctx, { now: d('2026-03-01'), outDir: OUT });
    expect(first.status).toBe('ok');
    const file = first.files[0];
    fs.writeFileSync(file, 'LAST GOOD EXPORT');
    // Same day again: the run writes the same file name; the disk fills up half-way through.
    await db.update(reportSchedules).set({ nextRunAt: d('2026-03-01') }).where(eq(reportSchedules.companyId, ctx.companyId));
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      // Only the export folder runs out of space (the company file's own log keeps working).
      if (!String(p).startsWith(OUT)) return (real as (...a: unknown[]) => void)(p, data, ...rest);
      real(p, typeof data === 'string' ? data.slice(0, 5) : 'PART');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }) as typeof fs.writeFileSync);
    try {
      const [second] = await runDueSchedules(ctx, { now: d('2026-03-01'), outDir: OUT });
      expect(second.status).toBe('failed');
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('LAST GOOD EXPORT');
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
