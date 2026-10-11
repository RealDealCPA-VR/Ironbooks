/**
 * Independent QA (tester), part 4: re-test of the wave-2 reports fix round.
 *  - legacy memorized rows (saved before report types were validated) stay manageable
 *  - report-builder ("custom") memorized reports are gated on reports_financial for every path
 *  - comparison windows for leap February, whole years, and partial ranges ending on a month end
 *  - calendar date validation edge cases (month 00 / day 00 / leap centuries)
 *  - blank groups sort last for subtotal-by name as well as class
 *  - the combined trial balance foots per company column
 * Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, customers, memorizedReports, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { runStandardReport } from './reportRegistry';
import {
  deleteMemorizedReport,
  listMemorizedReports,
  processMultipleReports,
  runMemorizedReport,
  saveMemorizedReport,
  updateMemorizedReport,
} from './memorizedReports';
import { parseReportParams } from '@/lib/validation/reports';
import type { StdReport } from '@/lib/reports/types';
import { fullAccess } from '@/lib/permissions/model';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2-qa4');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const run = (key: string, p: Record<string, string> = {}, c: ServiceContext = ctx) => runStandardReport(c, key, p);
const prevHeader = (r: StdReport) => r.columns.find((c) => c.key === 'prev')?.header;
const num = (v: unknown) => Money.of(v === null || v === undefined || v === '' ? '0' : String(v));

const salesOnly = () => {
  const a = fullAccess();
  a.permissions.reports_financial = [];
  return a;
};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qa4@rep.test', name: 'QA4', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'QA4 Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
  await db.insert(userCompanies).values([{ userId: user.id, companyId: company.id, role: 'owner' }]);
  const mk = async (key: string, code: string, name: string, type: string, subtype: string) => {
    const r = await createAccount(ctx, { code, name, type: type as never, subtype } as never);
    A[key] = r.id;
  };
  await mk('bank', '1000', 'Checking', 'asset', 'checking');
  await mk('ar', '1200', 'Accounts Receivable', 'asset', 'accounts_receivable');
  await mk('equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk('sales', '4000', 'Sales', 'revenue', 'sales');
  const [zed] = await db.insert(customers).values({ companyId: company.id, displayName: 'Zed Corp' }).returning();
  await postJournalEntry(ctx, { date: d('2026-01-02'), description: 'Capital', lines: [{ accountId: A.bank, debit: '1000' }, { accountId: A.equity, credit: '1000' }] });
  await postJournalEntry(ctx, {
    date: d('2026-02-10'),
    description: 'Zed sale',
    sourceRef: `customer:${zed.id}`,
    lines: [{ accountId: A.ar, debit: '250' }, { accountId: A.sales, credit: '250' }],
  });
}, 120_000);

afterAll(async () => {
  await closeDb();
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

describe('legacy memorized rows', () => {
  it('a row saved before report types were validated can still be listed, deleted by the owner, and fails alone in a batch', async () => {
    // Before wave 2 the API accepted any reportType string.
    const [legacy] = await db.insert(memorizedReports).values({ companyId: ctx.companyId, name: 'Old thing', reportType: 'pl_v1', config: {} }).returning();
    const good = await saveMemorizedReport(ctx, { name: 'Good TB', reportType: 'trial-balance', config: {} });
    expect((await listMemorizedReports(ctx)).some((r) => r.id === legacy.id)).toBe(true);

    const out = await processMultipleReports(ctx, { ids: [legacy.id, good.id] });
    expect(out.find((o) => o.id === good.id)?.report).toBeTruthy();
    expect(out.find((o) => o.id === legacy.id)?.error).toBeTruthy();
    await expect(runMemorizedReport(ctx, legacy.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The owner must be able to clean it up; otherwise it stays in the list forever.
    await expect(deleteMemorizedReport(ctx, legacy.id)).resolves.toMatchObject({ deleted: true });
    expect((await listMemorizedReports(ctx)).some((r) => r.id === legacy.id)).toBe(false);
  });
});

describe('report builder (custom) memorized reports need reports_financial', () => {
  it('a sales-only user cannot save, rename, delete or run a custom report, and a batch reports it as an error', async () => {
    const cfg = { source: 'gl', columns: ['date', 'account', 'debit', 'credit'] };
    const custom = await saveMemorizedReport(ctx, { name: 'GL dump', reportType: 'custom', config: cfg });
    const sales = await saveMemorizedReport(ctx, { name: 'AR balances', reportType: 'customer-balance-summary', config: {} });
    const s = { ...ctx, access: salesOnly() };
    await expect(saveMemorizedReport(s, { name: 'x', reportType: 'custom', config: cfg })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateMemorizedReport(s, custom.id, { name: 'renamed' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteMemorizedReport(s, custom.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runMemorizedReport(s, custom.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const out = await processMultipleReports(s, { ids: [custom.id, sales.id] });
    expect(out.find((o) => o.id === custom.id)?.report).toBeUndefined();
    expect(out.find((o) => o.id === custom.id)?.error).toBeTruthy();
    expect(out.find((o) => o.id === sales.id)?.report).toBeTruthy();
    // The sales-only user can still memorize a sales report.
    await expect(saveMemorizedReport(s, { name: 'My AR', reportType: 'customer-balance-summary', config: {} })).resolves.toBeTruthy();
  });

  it('save rejects a non-string report type as VALIDATION, not a crash', async () => {
    await expect(saveMemorizedReport(ctx, { name: 'x', reportType: 42 as unknown as string, config: {} })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveMemorizedReport(ctx, { name: 'x', reportType: '   ', config: {} })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('comparison windows', () => {
  it('March of a leap year compares with all of February (29 days)', async () => {
    expect(prevHeader(await run('profit-loss', { from: '2028-03-01', to: '2028-03-31', compare: 'prev_period' }))).toBe('02/01/2028 – 02/29/2028');
  });

  it('a whole calendar year compares with the previous whole year', async () => {
    expect(prevHeader(await run('profit-loss', { from: '2025-01-01', to: '2025-12-31', compare: 'prev_period' }))).toBe('01/01/2024 – 12/31/2024');
  });

  it('a mid-month start ending on a month end still uses the equal-length window', async () => {
    // 03/17–03/31 is 15 days; the 15 days before are 03/02–03/16.
    expect(prevHeader(await run('profit-loss', { from: '2026-03-17', to: '2026-03-31', compare: 'prev_period' }))).toBe('03/02/2026 – 03/16/2026');
  });

  it('balance sheet as of Mar 30 with prev_period compares with Feb 28 (clamped), as of Jan 31 with Dec 31', async () => {
    expect(prevHeader(await run('balance-sheet', { asOf: '2026-03-30', compare: 'prev_period' }))).toBe('02/28/2026');
    expect(prevHeader(await run('balance-sheet', { asOf: '2026-01-31', compare: 'prev_period' }))).toBe('12/31/2025');
  });

  it('prev-period P&L columns still foot: Net Income for February equals February alone', async () => {
    const r = await run('profit-loss', { from: '2026-03-01', to: '2026-03-31', compare: 'prev_period' });
    const ni = r.rows.find((x) => x.cells.label === 'Net Income')!;
    expect(num(ni.cells.prev).toFixed(2)).toBe('250.00');
    const feb = await run('profit-loss', { from: '2026-02-01', to: '2026-02-28' });
    const ni2 = feb.rows.find((x) => x.cells.label === 'Net Income')!;
    const key = feb.columns.find((c) => c.type === 'money')!.key;
    expect(num(ni2.cells[key]).toFixed(2)).toBe('250.00');
  });
});

describe('calendar date validation', () => {
  it('rejects month 00, day 00 and Feb 29 of a non-leap century; accepts Feb 29 2000', () => {
    for (const bad of ['2026-00-10', '2026-12-00', '1900-02-29', '2100-02-29', '2026-06-31']) {
      expect(`${bad}:${parseReportParams({ to: bad }).success}`).toBe(`${bad}:false`);
    }
    for (const ok of ['2000-02-29', '2026-12-31', '2026-01-01']) {
      expect(`${ok}:${parseReportParams({ to: ok }).success}`).toBe(`${ok}:true`);
    }
  });
});

describe('blank groups sort last', () => {
  it('subtotal by name puts "(no name)" after named customers, even ones starting with Z', async () => {
    const r = await run('transaction-detail-by-account', { from: '2026-01-01', to: '2026-03-31', subtotalBy: 'name' });
    const subs = r.rows.filter((x) => x.kind === 'subtotal').map((x) => String(x.cells.label));
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(subs[subs.length - 1]).toContain('(no name)');
    expect(subs.some((s) => s.includes('Zed Corp'))).toBe(true);
  });
});
