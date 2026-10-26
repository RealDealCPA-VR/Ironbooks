/**
 * Review round 5 — report dates follow the LOCAL calendar day (the desktop app's clock, the same
 * "today" the report date fields default to), not the UTC day.
 *
 * Pinned to US Pacific time. At 11:30 pm on Oct 31 it is already Nov 1 in UTC: "Today",
 * "This Month", "Last Month", the default as-of date and the default To date must all still be
 * October 31 there, and a monthly schedule set to start Nov 1 must not run (and export "last
 * month" = September) the evening before.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { endOfToday, resolveDateMacro } from './reportEngine';
import { runStandardReport } from './reportRegistry';
import { arAging, collectionsReport } from './reportsExtra';
import { createReportSchedule, listReportSchedules, nextRunAfter, runDueSchedules, saveMemorizedReport } from './memorizedReports';
import { balanceSheet } from './reports';

const origTz = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-report-dates');
const OUT_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-report-dates-out');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Oct 31 2026, 11:30 pm Pacific (PDT) = Nov 1 06:30 UTC. */
const OCT31_LATE = new Date('2026-11-01T06:30:00.000Z');
/** Nov 1 2026, 1:30 am Pacific. */
const NOV1_EARLY = new Date('2026-11-01T08:30:00.000Z');

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-dates@test.local', name: 'R5 Dates', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Dates Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  const sale = (date: string, amount: string) =>
    postJournalEntry(ctx, {
      date: d(date),
      description: `sale ${date}`,
      lines: [
        { accountId: A['1000'], debit: amount },
        { accountId: A['4000'], credit: amount },
      ],
    });
  await sale('2026-09-15', '50.00');
  await sale('2026-10-15', '100.00');
  await sale('2026-11-01', '7.00'); // tomorrow, locally
});

afterAll(async () => {
  vi.useRealTimers();
  if (origTz === undefined) delete process.env.TZ;
  else process.env.TZ = origTz;
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
});

const at = (now: Date) => vi.useFakeTimers({ toFake: ['Date'], now });

describe('relative dates use the local calendar day', () => {
  it('Today / This Month / Last Month at 11:30 pm on Oct 31 (Pacific)', () => {
    expect(resolveDateMacro('today', OCT31_LATE)).toEqual({ from: '2026-10-31', to: '2026-10-31' });
    expect(resolveDateMacro('this_month', OCT31_LATE)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveDateMacro('last_month', OCT31_LATE)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveDateMacro('this_year_to_date', OCT31_LATE)).toEqual({ from: '2026-01-01', to: '2026-10-31' });
  });

  it('a report run with Dates = This month covers October', async () => {
    const r = await runStandardReport(ctx, 'profit-loss', { dates: 'this_month' }, { now: OCT31_LATE });
    expect(r.range).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(r.rows.find((x) => x.id === 'pl:net')?.cells.total).toBe('100.00');
  });
});

describe('default as-of / To date is today on this computer', () => {
  afterAll(() => vi.useRealTimers());

  it('endOfToday is the end of the local day', () => {
    at(OCT31_LATE);
    expect(endOfToday().toISOString()).toBe('2026-10-31T23:59:59.999Z');
  });

  it('Balance Sheet with no date is as of Oct 31 and leaves out tomorrow', async () => {
    at(OCT31_LATE);
    const r = await runStandardReport(ctx, 'balance-sheet', {});
    expect(r.subtitle).toContain('10/31/2026');
    expect(r.range?.asOf).toBe('2026-10-31');
    expect(r.rows.find((x) => x.id === 'bs:ni')?.cells.total).toBe('150.00');
  });

  it('Profit & Loss with no dates runs fiscal year to Oct 31', async () => {
    at(OCT31_LATE);
    const r = await runStandardReport(ctx, 'profit-loss', {});
    expect(r.range).toMatchObject({ from: '2026-01-01', to: '2026-10-31' });
    expect(r.rows.find((x) => x.id === 'pl:net')?.cells.total).toBe('150.00');
  });

  it('A/R aging and Collections with no date are as of Oct 31', async () => {
    at(OCT31_LATE);
    expect((await arAging(ctx)).asOf.slice(0, 10)).toBe('2026-10-31');
    expect((await collectionsReport(ctx)).asOf.slice(0, 10)).toBe('2026-10-31');
  });

  it('the legacy balance sheet with no date splits Net Income at the local fiscal year (Dec 31 evening)', async () => {
    // Dec 31 2026, 9 pm Pacific = Jan 1 2027 05:00 UTC: still fiscal 2026 here.
    at(new Date('2027-01-01T05:00:00.000Z'));
    const bs = await balanceSheet(ctx);
    expect(bs.fiscalYearStart?.slice(0, 10)).toBe('2026-01-01');
    expect(bs.currentYearNetIncome).toBe('157.00');
  });
});

describe('scheduled reports run on the local calendar day', () => {
  it('a monthly "last month" schedule starting Nov 1 waits for Nov 1 and exports October', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Monthly P&L', reportType: 'profit-loss', config: { params: { dates: 'last_month' } } });
    const s = await createReportSchedule(ctx, { name: 'Month end P&L', memorizedReportId: m.id, frequency: 'monthly', startDate: '2026-11-01' });
    // 11:30 pm on Oct 31 locally: not due yet.
    expect((await runDueSchedules(ctx, { now: OCT31_LATE, outDir: OUT_DIR })).map((x) => x.scheduleId)).not.toContain(s.id);
    // 1:30 am on Nov 1: due; the export covers October and is stamped Nov 1.
    const res = (await runDueSchedules(ctx, { now: NOV1_EARLY, outDir: OUT_DIR })).find((x) => x.scheduleId === s.id)!;
    expect(res.status).toBe('ok');
    expect(path.basename(res.files[0])).toContain('2026-11-01');
    const csv = fs.readFileSync(res.files[0], 'utf8');
    expect(csv).toContain('10/01/2026');
    expect(csv).toContain('10/31/2026');
    // The next run is Dec 1 (local), still the anchor day.
    const next = (await listReportSchedules(ctx)).find((x) => x.id === s.id)!.nextRunAt;
    expect(next.getDate()).toBe(1);
    expect(next.getMonth()).toBe(11);
  });

  it('monthly runs stay on the same local day across the DST change', () => {
    const start = new Date(2026, 9, 31, 0, 0, 0); // Oct 31 local midnight (PDT)
    const nov = nextRunAfter(start, 'monthly', 31);
    expect([nov.getMonth(), nov.getDate(), nov.getHours()]).toEqual([10, 30, 0]); // Nov 30 midnight (PST)
    const daily = nextRunAfter(new Date(2026, 10, 1, 0, 0, 0), 'daily');
    expect([daily.getMonth(), daily.getDate(), daily.getHours()]).toEqual([10, 2, 0]);
  });
});
