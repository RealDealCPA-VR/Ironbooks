/**
 * Independent QA (tester), part 3, for the wave-2 reports engine:
 *  - memorized report / group maintenance requires report access (routes are mapped 'member',
 *    so the service is the only gate)
 *  - H6 detail filters: every subtotal-by grouping foots to its lines and to the grand total,
 *    the unfiltered ledger nets to zero, cleared / uncleared partition the ledger, class and
 *    amount filters agree with the summary reports, sort-by orders the lines
 *  - H17 budgets: company-wide and Customer:Job amounts never mix; Budget Overview foots and
 *    Budget vs. Actual "actual" equals the P&L
 * Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { classes, companies, customers, userCompanies, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { runStandardReport } from './reportRegistry';
import { createBudget, setBudgetLine } from './budgets';
import {
  createMemorizedGroup,
  deleteMemorizedGroup,
  deleteMemorizedReport,
  listMemorizedReports,
  renameMemorizedGroup,
  saveMemorizedReport,
  updateMemorizedReport,
} from './memorizedReports';
import type { StdReport, StdRow } from '@/lib/reports/types';
import { fullAccess } from '@/lib/permissions/model';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2-qa3');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const ids: Record<string, string> = {};

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const run = (key: string, p: Record<string, string> = {}, c: ServiceContext = ctx) => runStandardReport(c, key, p);
const byLabel = (r: StdReport, label: string) => r.rows.find((x) => x.cells.label === label);
const num = (v: unknown) => Money.of(v === null || v === undefined || v === '' ? '0' : String(v));
const dataRows = (r: StdReport) => r.rows.filter((x) => x.kind === 'data' && x.entryId);
const grand = (r: StdReport) => r.rows.find((x) => x.kind === 'grand')!;

/** Every subtotal row equals the sum of the data rows under the row it totals. */
function assertFoots(r: StdReport, col: string) {
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  const isUnder = (row: StdRow, ancestor: string) => {
    let p = row.parentId ?? null;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (p === ancestor) return true;
      seen.add(p);
      p = byId.get(p)?.parentId ?? null;
    }
    return false;
  };
  let n = 0;
  for (const t of r.rows) {
    if (!t.totalOf) continue;
    const sum = r.rows.filter((x) => x.kind === 'data' && isUnder(x, t.totalOf!)).reduce((s, x) => s.plus(num(x.cells[col])), Money.zero());
    expect(`${r.key}/${col}/${t.cells.label}=${num(t.cells[col]).toFixed(2)}`).toBe(`${r.key}/${col}/${t.cells.label}=${sum.toFixed(2)}`);
    n++;
  }
  return n;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qa3@rep.test', name: 'QA3', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'QA3 Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
  await db.insert(userCompanies).values([{ userId: user.id, companyId: company.id, role: 'owner' }]);
  const mk = async (key: string, code: string, name: string, type: string, subtype: string, parent?: string) => {
    const r = await createAccount(ctx, { code, name, type: type as never, subtype, parentId: parent ? A[parent] : undefined } as never);
    A[key] = r.id;
  };
  await mk('bank', '1000', 'Checking', 'asset', 'checking');
  await mk('ar', '1200', 'Accounts Receivable', 'asset', 'accounts_receivable');
  await mk('ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable');
  await mk('equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk('sales', '4000', 'Sales', 'revenue', 'sales');
  await mk('svc', '4010', 'Services', 'revenue', 'sales', 'sales');
  await mk('rent', '6100', 'Rent', 'expense', 'operating_expenses');
  await mk('supplies', '6200', 'Supplies', 'expense', 'operating_expenses');

  const c = company.id;
  const [east] = await db.insert(classes).values({ companyId: c, name: 'East' }).returning();
  const [west] = await db.insert(classes).values({ companyId: c, name: 'West' }).returning();
  const [cust] = await db.insert(customers).values({ companyId: c, displayName: 'Acme' }).returning();
  const [cust2] = await db.insert(customers).values({ companyId: c, displayName: 'Beta' }).returning();
  const [vend] = await db.insert(vendors).values({ companyId: c, displayName: 'Landlord' }).returning();
  Object.assign(ids, { east: east.id, west: west.id, cust: cust.id, cust2: cust2.id, vend: vend.id });

  await postJournalEntry(ctx, { date: d('2026-01-02'), description: 'Capital', lines: [{ accountId: A.bank, debit: '10000' }, { accountId: A.equity, credit: '10000' }] });
  // Three-way split that only balances to the cent.
  await postJournalEntry(ctx, {
    date: d('2026-01-15'),
    description: 'Split sale',
    sourceRef: `customer:${cust.id}`,
    lines: [
      { accountId: A.ar, debit: '100.00', controlLine: true },
      { accountId: A.svc, credit: '33.33', classId: east.id },
      { accountId: A.svc, credit: '33.33', classId: west.id },
      { accountId: A.sales, credit: '33.34' },
    ],
  });
  await postJournalEntry(ctx, { date: d('2026-02-01'), description: 'Feb rent', sourceRef: `vendor:${vend.id}`, lines: [{ accountId: A.rent, debit: '1500', classId: east.id }, { accountId: A.ap, credit: '1500', controlLine: true }] });
  await postJournalEntry(ctx, { date: d('2026-02-10'), description: 'Supplies', lines: [{ accountId: A.supplies, debit: '0.01', classId: west.id }, { accountId: A.bank, credit: '0.01' }] });
  await postJournalEntry(ctx, { date: d('2026-03-05'), description: 'Beta job', sourceRef: `customer:${cust2.id}`, lines: [{ accountId: A.ar, debit: '2500', controlLine: true }, { accountId: A.svc, credit: '2500', classId: west.id }] });
  await postJournalEntry(ctx, { date: d('2026-03-20'), description: 'Pay rent', sourceRef: `vendor:${vend.id}`, lines: [{ accountId: A.ap, debit: '1500', controlLine: true }, { accountId: A.bank, credit: '1500' }] });
}, 120_000);

afterAll(async () => {
  await closeDb();
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

// ---------------------------------------------------------------------------
// Permissions: memorized report maintenance
// ---------------------------------------------------------------------------

describe('memorized report maintenance requires report access (routes are member)', () => {
  /** A user who may do everything except see any report (e.g. a data-entry clerk). */
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

  it('a member with no report access cannot list, save, rename, re-point or delete memorized reports', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Owner P&L', reportType: 'profit-loss', config: {} });
    const clerk = { ...ctx, access: noReports() };
    await expect(listMemorizedReports(clerk)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(saveMemorizedReport(clerk, { name: 'x', reportType: 'trial-balance', config: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateMemorizedReport(clerk, m.id, { name: 'renamed by clerk' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteMemorizedReport(clerk, m.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // still there, untouched
    const still = (await listMemorizedReports(ctx)).find((x) => x.id === m.id);
    expect(still?.name).toBe('Owner P&L');
  });

  it('a member with no report access cannot create, rename or delete memorized report groups', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'Month end pack' });
    const clerk = { ...ctx, access: noReports() };
    await expect(createMemorizedGroup(clerk, { name: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(renameMemorizedGroup(clerk, g.id, { name: 'y' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteMemorizedGroup(clerk, g.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('memorizing a report requires being allowed to run that report', async () => {
    const sales = { ...ctx, access: salesOnly() };
    await expect(saveMemorizedReport(sales, { name: 'Sneaky BS', reportType: 'balance-sheet', config: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A report in an area the user has is fine.
    await expect(saveMemorizedReport(sales, { name: 'My customers', reportType: 'customer-balance-summary', config: {} })).resolves.toBeTruthy();
    // ... and it cannot re-point an existing financial report's settings either.
    const m = await saveMemorizedReport(ctx, { name: 'Owner BS', reportType: 'balance-sheet', config: { params: { asOf: '2026-03-31' } } });
    await expect(updateMemorizedReport(sales, m.id, { config: { params: { asOf: '2020-01-01' } } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ---------------------------------------------------------------------------
// H6 filters / subtotal-by / sort-by on the shared detail service
// ---------------------------------------------------------------------------

describe('H6 detail filters (transaction-detail-by-account)', () => {
  const P = { from: '2026-01-01', to: '2026-03-31' };

  it('the unfiltered ledger nets to zero and every subtotal-by grouping foots to the same grand total', async () => {
    const base = await run('transaction-detail-by-account', P);
    const g0 = grand(base);
    expect(num(g0.cells.debit).toFixed(2)).toBe(num(g0.cells.credit).toFixed(2));
    expect(num(g0.cells.debit).toFixed(2)).toBe('15600.01');
    const lineCount = dataRows(base).length;
    expect(lineCount).toBe(14);
    for (const subtotalBy of ['account', 'name', 'type', 'month', 'class', 'none']) {
      const r = await run('transaction-detail-by-account', { ...P, subtotalBy });
      expect(dataRows(r).length, subtotalBy).toBe(lineCount);
      const g = grand(r);
      expect(`${subtotalBy}:${num(g.cells.debit).toFixed(2)}/${num(g.cells.credit).toFixed(2)}`).toBe(
        `${subtotalBy}:${num(g0.cells.debit).toFixed(2)}/${num(g0.cells.credit).toFixed(2)}`,
      );
      assertFoots(r, 'debit');
      assertFoots(r, 'credit');
      // grand total = sum of the subtotals shown
      const subs = r.rows.filter((x) => x.kind === 'subtotal');
      if (subtotalBy !== 'none') {
        const sd = subs.reduce((s, x) => s.plus(num(x.cells.debit)), Money.zero());
        expect(sd.toFixed(2)).toBe(num(g.cells.debit).toFixed(2));
      }
    }
  });

  it('class subtotals equal the P&L by Class columns', async () => {
    const r = await run('transaction-detail-by-account', { ...P, subtotalBy: 'class' });
    expect(r.rows.filter((x) => x.kind === 'subtotal').map((x) => x.cells.label)).toEqual(['Total East', 'Total West', 'Total Unclassified']);
    const east = await run('transaction-detail-by-account', { ...P, classId: ids.east });
    const eastLines = dataRows(east);
    expect(eastLines.length).toBe(2);
    // East: 33.33 income (credit), 1500 rent (debit)
    const g = grand(east);
    expect(num(g.cells.debit).toFixed(2)).toBe('1500.00');
    expect(num(g.cells.credit).toFixed(2)).toBe('33.33');
    const byClass = await run('pl-by-class', P);
    const ni = byLabel(byClass, 'Net Income')!;
    const eastKey = byClass.columns.find((c) => c.header === 'East')?.key;
    expect(eastKey).toBeTruthy();
    expect(num(ni.cells[eastKey!]).toFixed(2)).toBe('-1466.67');
  });

  it('cleared and uncleared partition the ledger', async () => {
    const all = dataRows(await run('transaction-detail-by-account', { ...P, cleared: 'any' })).length;
    const c = dataRows(await run('transaction-detail-by-account', { ...P, cleared: 'cleared' })).length;
    const u = dataRows(await run('transaction-detail-by-account', { ...P, cleared: 'uncleared' })).length;
    expect(c + u).toBe(all);
  });

  it('a one-cent line survives amount filters at both edges, and the range excludes neighbours', async () => {
    const r = await run('transaction-detail-by-account', { ...P, amountMin: '0.01', amountMax: '0.01' });
    expect(dataRows(r).length).toBe(2); // both sides of the supplies entry
    const none = await run('transaction-detail-by-account', { ...P, amountMin: '0.02', amountMax: '33.32' });
    expect(dataRows(none).length).toBe(0);
  });

  it('sort-by amount descending orders lines inside every group; sort is stable across runs', async () => {
    const r = await run('transaction-detail-by-account', { ...P, sortBy: 'amount', sortDir: 'desc', subtotalBy: 'none' });
    const amts = dataRows(r).map((x) => num(x.cells.amount));
    for (let i = 1; i < amts.length; i++) expect(amts[i - 1].greaterThanOrEqualTo(amts[i])).toBe(true);
    const again = await run('transaction-detail-by-account', { ...P, sortBy: 'amount', sortDir: 'desc', subtotalBy: 'none' });
    expect(dataRows(again).map((x) => x.id)).toEqual(dataRows(r).map((x) => x.id));
  });

  it('the name filter matches the customer subledger (A/R lines for Acme == Acme balance)', async () => {
    const r = await run('transaction-detail-by-account', { ...P, accountId: A.ar, nameId: ids.cust });
    const g = grand(r);
    expect(num(g.cells.debit).minus(num(g.cells.credit)).toFixed(2)).toBe('100.00');
    const cbs = await run('customer-balance-summary', { asOf: '2026-03-31' });
    const acme = cbs.rows.find((x) => x.cells.label === 'Acme');
    const amtKey = cbs.columns.find((c) => c.type === 'money')!.key;
    expect(num(acme?.cells[amtKey]).toFixed(2)).toBe('100.00');
  });
});

// ---------------------------------------------------------------------------
// H17 budgets
// ---------------------------------------------------------------------------

describe('H17 budgets by Customer:Job never double count', () => {
  it('a company-wide budget refuses Customer:Job amounts and vice versa', async () => {
    const co = await createBudget(ctx, { name: 'Company 2026', fiscalYear: 2026 });
    await setBudgetLine(ctx, { budgetId: co.id, accountId: A.svc, month: 1, amount: '1000' });
    await expect(setBudgetLine(ctx, { budgetId: co.id, accountId: A.svc, month: 2, amount: '50', customerId: ids.cust })).rejects.toMatchObject({ code: 'VALIDATION' });
    const byCust = await createBudget(ctx, { name: 'By job 2026', fiscalYear: 2026 });
    await setBudgetLine(ctx, { budgetId: byCust.id, accountId: A.svc, month: 1, amount: '100', customerId: ids.cust });
    await expect(setBudgetLine(ctx, { budgetId: byCust.id, accountId: A.svc, month: 1, amount: '100' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('Budget Overview foots and Budget vs. Actual "actual" equals the P&L for the year', async () => {
    const b = await createBudget(ctx, { name: 'Ops 2026', fiscalYear: 2026 });
    for (const m of [1, 2, 3]) {
      await setBudgetLine(ctx, { budgetId: b.id, accountId: A.svc, month: m, amount: '1000.01' });
      await setBudgetLine(ctx, { budgetId: b.id, accountId: A.rent, month: m, amount: '1500' });
    }
    const ov = await run('budget-overview', { budgetId: b.id });
    for (const c of ov.columns.filter((x) => x.type === 'money')) assertFoots(ov, c.key);
    const bva = await run('budget-vs-actual-report', { budgetId: b.id });
    const actualKey = bva.columns.find((c) => /actual/i.test(c.header) && c.type === 'money')?.key;
    expect(actualKey).toBeTruthy();
    const pl = await run('profit-loss', { from: '2026-01-01', to: '2026-12-31' });
    expect(num(byLabel(bva, 'Net Income')?.cells[actualKey!]).toFixed(2)).toBe(num(byLabel(pl, 'Net Income')?.cells.total).toFixed(2));
  });
});
