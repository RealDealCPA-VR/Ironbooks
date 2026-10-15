/**
 * "Why did this number change?" — lists the transactions created, edited, voided since a moment
 * that moved an account set / report total, with correct before / after / delta and who.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { createExpense } from './expenses';
import { createManualEntry, updateEntry } from './journal';
import { whyChanged } from './whyChanged';
import { runStandardReport } from './reportRegistry';
import { WHY_CHANGED_AREA, canExplainChanges, reportWhyChangedWindow } from '@/lib/reports/whyChangedWindow';
import { apiRuleFor } from '@/lib/permissions/routes';
import type { PermissionSet } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-why-changed');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let since: Date;
let tbBefore: string;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inv = (amount: string, date = '2026-03-01') => ({
  customerId,
  date: d(date),
  lines: [{ accountId: acct['4000'], description: 'Work', quantity: '1', rate: amount, taxable: false }],
});

describe('whyChanged', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'why@test.local', name: 'Dana', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Why Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6300', 'Supplies', 'expense', 'operating_expenses'],
      ['6400', 'Rent', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Acme' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Depot' }).returning())[0].id;
    await createManualEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '5000.00' },
        { accountId: acct['3000'], credit: '5000.00' },
      ],
    });
    ids.a = (await createInvoice(ctx, inv('100.00'))).id;
    ids.c = (await createInvoice(ctx, inv('30.00'))).id;
    ids.je = (
      await createManualEntry(ctx, {
        date: d('2026-02-01'),
        description: 'Reclass',
        lines: [
          { accountId: acct['6400'], debit: '20.00' },
          { accountId: acct['1000'], credit: '20.00' },
        ],
      })
    ).id;
    tbBefore = (await trialBalance(ctx)).totalDebit;

    await pause(30);
    since = new Date();
    await pause(30);

    await updateInvoice(ctx, ids.a, inv('150.00'));
    ids.b = (await createInvoice(ctx, inv('40.00', '2026-04-15'))).id;
    await voidInvoice(ctx, ids.c);
    await createExpense(ctx, {
      vendorId,
      date: d('2026-03-10'),
      method: 'check',
      reference: '7',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '25.00' }],
    });
    await updateEntry(ctx, ids.je, {
      date: d('2026-02-01'),
      description: 'Reclass (fixed)',
      lines: [
        { accountId: acct['6400'], debit: '35.00' },
        { accountId: acct['1000'], credit: '35.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; next run wipes it. */
    }
  });

  it('income total: an edit, a new invoice and a void, each with before / after / delta and who', async () => {
    const r = await whyChanged(ctx, { since, preset: 'income' });
    const byDelta = Object.fromEntries(r.changes.map((c) => [c.delta, c]));
    expect(r.changes).toHaveLength(3);
    expect(byDelta['50.00']).toMatchObject({ kind: 'edited', before: '100.00', after: '150.00', type: 'invoice', who: 'Dana' });
    expect(byDelta['40.00']).toMatchObject({ kind: 'created', before: '0.00', after: '40.00' });
    expect(byDelta['-30.00']).toMatchObject({ kind: 'voided', before: '30.00', after: '0.00' });
    expect(r.totalDelta).toBe('60.00');
    expect(r.totalNow).toBe('190.00');
    expect(r.totalThen).toBe('130.00');
  });

  it('an account balance (A/R) lists the same documents; the expense does not touch it', async () => {
    const r = await whyChanged(ctx, { since, accountIds: [acct['1200']] });
    expect(r.changes.map((c) => c.delta).sort()).toEqual(['-30.00', '40.00', '50.00']);
    expect(r.changes.every((c) => c.type === 'invoice')).toBe(true);
  });

  it('respects the report date window', async () => {
    const r = await whyChanged(ctx, { since, preset: 'income', from: '2026-03-01', to: '2026-03-31' });
    expect(r.changes.map((c) => c.delta).sort()).toEqual(['-30.00', '50.00']);
    expect(r.totalNow).toBe('150.00');
  });

  it('a journal entry edit (replacement entry) shows as one edited row; expenses count once', async () => {
    const r = await whyChanged(ctx, { since, preset: 'expenses' });
    const je = r.changes.find((c) => c.type === 'journal entry');
    expect(je).toMatchObject({ kind: 'edited', before: '20.00', after: '35.00', delta: '15.00' });
    const check = r.changes.find((c) => c.type === 'check / expense');
    expect(check).toMatchObject({ kind: 'created', delta: '25.00' });
    expect(r.changes).toHaveLength(2);
    expect(r.totalDelta).toBe('40.00');
  });

  it('net income reads credit-positive; Trial Balance total compares exactly to the earlier total', async () => {
    const ni = await whyChanged(ctx, { since, preset: 'net_income' });
    expect(ni.totalDelta).toBe('20.00'); // +60 income, -40 expenses
    const tb = await whyChanged(ctx, { since, preset: 'all' });
    expect(tb.totalThen).toBe(tbBefore);
    expect(tb.totalNow).toBe((await trialBalance(ctx)).totalDebit);
    expect(tb.changes.length).toBeGreaterThan(0);
  });

  it('nothing changed since now', async () => {
    const r = await whyChanged(ctx, { since: new Date(Date.now() + 60_000), preset: 'assets' });
    expect(r.changes).toHaveLength(0);
    expect(r.totalDelta).toBe('0.00');
  });

  it('refuses bad input', async () => {
    await expect(whyChanged(ctx, { since: new Date('x'), preset: 'assets' })).rejects.toThrow(/since/);
    await expect(whyChanged(ctx, { since })).rejects.toThrow(/Choose an account/);
    await expect(whyChanged(ctx, { since, accountIds: ['nope'] })).rejects.toThrow(/not valid/);
  });

  it('refuses impossible calendar dates with a validation error (not a crash)', async () => {
    for (const bad of ['2026-13-45', '2026-02-31', '2026-00-10']) {
      await expect(whyChanged(ctx, { since, preset: 'assets', from: bad })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(whyChanged(ctx, { since, preset: 'assets', to: bad })).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringMatching(/real date/),
      });
    }
    // Real dates still work (leap day).
    await expect(whyChanged(ctx, { since, preset: 'income', from: '2024-02-29', to: '2026-12-31' })).resolves.toBeTruthy();
  });

  it('report buttons use the dates the report actually ran with ("Dates" presets resolved)', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    // P&L run for "Last month": the form only carries dates=last_month (no from / to).
    const pl = await runStandardReport(ctx, 'profit-loss', { dates: 'last_month' }, { now });
    expect(pl.range).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    const w = reportWhyChangedWindow('profit-loss', { dates: 'last_month' }, pl.range, '2026-10-15');
    expect(w).toEqual({ from: '2026-09-01', to: '2026-09-30', fiscalYearToDate: false });
    // The explained "Now" figure is the number on the report (Net Income), for presets with activity too.
    for (const dates of ['last_month', 'this_year', 'last_year'] as const) {
      const r = await runStandardReport(ctx, 'profit-loss', { dates }, { now });
      const win = reportWhyChangedWindow('profit-loss', { dates }, r.range, '2026-10-15');
      const net = await whyChanged(ctx, { since, preset: 'net_income', from: win.from, to: win.to });
      const shown = r.rows.find((x) => x.id === 'pl:net')!.cells.total;
      expect(Number(net.totalNow)).toBe(Number(shown ?? 0));
    }
    // Balance Sheet "as of last month end": the as-of date, not today.
    const bs = await runStandardReport(ctx, 'balance-sheet', { dates: 'last_month' }, { now });
    expect(reportWhyChangedWindow('balance-sheet', { dates: 'last_month' }, bs.range, '2026-10-15')).toEqual({
      from: null,
      to: '2026-09-30',
      fiscalYearToDate: false,
    });

    // No dates at all: P&L is the fiscal year to date, resolved explicitly by the server.
    const plDefault = await runStandardReport(ctx, 'profit-loss', { to: '2026-06-30' });
    expect(plDefault.range).toMatchObject({ from: '2026-01-01', to: '2026-06-30' });
  });

  it('window helper falls back to explicit run params when the server sent no range', () => {
    expect(reportWhyChangedWindow('profit-loss', { from: '2026-01-01', to: '2026-03-31' }, undefined, '2026-10-15')).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
      fiscalYearToDate: false,
    });
    expect(reportWhyChangedWindow('profit-loss', {}, undefined, '2026-10-15')).toEqual({
      from: null,
      to: '2026-10-15',
      fiscalYearToDate: true,
    });
    expect(reportWhyChangedWindow('trial-balance', { asOf: '2026-05-31' }, undefined, '2026-10-15').to).toBe('2026-05-31');
  });

  it('buttons are hidden for users who cannot open /api/why-changed', () => {
    expect(apiRuleFor('/api/why-changed', 'GET')).toEqual({ area: WHY_CHANGED_AREA, action: 'view' });
    const banking = { banking: ['view', 'create'] } as unknown as PermissionSet;
    const reports = { banking: ['view'], [WHY_CHANGED_AREA]: ['view'] } as unknown as PermissionSet;
    expect(canExplainChanges(banking)).toBe(false);
    expect(canExplainChanges(reports)).toBe(true);
    expect(canExplainChanges(null)).toBe(true); // unknown: server decides
  });
});
