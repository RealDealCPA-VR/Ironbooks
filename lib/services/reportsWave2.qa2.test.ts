/**
 * Independent QA (tester), part 2, for the wave-2 reports engine:
 *  - permissions: memorized "custom" (report builder) reports and Process Multiple Reports must
 *    enforce the report's own area (the routes are mapped 'member')
 *  - migration 0030 is idempotent and journaled once
 *  - budgets: malformed amounts / months, cross-company accounts and customers
 *  - graphs (H13) agree with the P&L / Balance Sheet they summarise
 *  - Advanced Find (J5): no cross-company leakage, inclusive amount range
 *  - H2 roll-up foots on comparative / by-class / by-month variants; combined P&L by month
 *  - H7 QuickZoom: money rows of every summary report drill somewhere
 *  - H10 income tax with an injected mapper; H11 Account Listing ties to the trial balance
 * Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { classes, companies, customers, userCompanies, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { runStandardReport } from './reportRegistry';
import { REPORT_CATALOG } from '@/lib/reports/catalog';
import { createBudget, setBudgetLine } from './budgets';
import { processMultipleReports, runMemorizedReport, saveMemorizedReport } from './memorizedReports';
import { findTransactions, graphData } from './reportsAnalysis';
import { incomeTaxReport, type TaxLineMapper } from './reportsLists';
import type { StdReport, StdRow } from '@/lib/reports/types';
import { fullAccess } from '@/lib/permissions/model';
import { setBudgetLineSchema } from '@/lib/validation/budgets';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2-qa2');
let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext;
const A: Record<string, string> = {};
const ids: Record<string, string> = {};

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const run = (key: string, p: Record<string, string> = {}, c: ServiceContext = ctx) => runStandardReport(c, key, p);
const byLabel = (r: StdReport, label: string) => r.rows.find((x) => x.cells.label === label);
const num = (v: unknown) => Money.of(v === null || v === undefined || v === '' ? '0' : String(v));

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
  for (const t of r.rows) {
    if (!t.totalOf) continue;
    const sum = r.rows.filter((x) => x.kind === 'data' && isUnder(x, t.totalOf!)).reduce((s, x) => s.plus(num(x.cells[col])), Money.zero());
    expect(`${r.key}/${col}/${t.cells.label}=${num(t.cells[col]).toFixed(2)}`).toBe(`${r.key}/${col}/${t.cells.label}=${sum.toFixed(2)}`);
  }
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qa2@rep.test', name: 'QA2', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'QA2 Co', ownerId: user.id }).returning();
  const [company2] = await db.insert(companies).values({ name: 'QA2 Sister', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
  ctx2 = { db, companyId: company2.id, userId: user.id };
  await db.insert(userCompanies).values([
    { userId: user.id, companyId: company.id, role: 'owner' },
    { userId: user.id, companyId: company2.id, role: 'owner' },
  ]);
  const mk = async (c: ServiceContext, key: string, code: string, name: string, type: string, subtype: string, parent?: string) => {
    const r = await createAccount(c, { code, name, type: type as never, subtype, parentId: parent ? A[parent] : undefined } as never);
    A[key] = r.id;
  };
  await mk(ctx, 'bank', '1000', 'Checking', 'asset', 'checking');
  await mk(ctx, 'ar', '1200', 'Accounts Receivable', 'asset', 'accounts_receivable');
  await mk(ctx, 'ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable');
  await mk(ctx, 'equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk(ctx, 'sales', '4000', 'Sales', 'revenue', 'sales');
  await mk(ctx, 'svc', '4010', 'Services', 'revenue', 'sales', 'sales');
  await mk(ctx, 'cogs', '5000', 'Materials', 'expense', 'cost_of_goods_sold');
  await mk(ctx, 'office', '6000', 'Office', 'expense', 'operating_expenses');
  await mk(ctx, 'paper', '6010', 'Paper', 'expense', 'operating_expenses', 'office');
  await mk(ctx, 'penalty', '8000', 'Penalties', 'expense', 'operating_expenses');
  // The foundation package adds QB's 'other_expense' subtype; simulate a post-merge account.
  await db.execute(sql`ALTER TYPE account_subtype ADD VALUE IF NOT EXISTS 'other_expense'`);
  await db.execute(sql`UPDATE accounts SET subtype = 'other_expense' WHERE id = ${A.penalty}`);
  await mk(ctx2, 'bank2', '1000', 'Checking', 'asset', 'checking');
  await mk(ctx2, 'equity2', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk(ctx2, 'sales2', '4000', 'Sales', 'revenue', 'sales');

  const [cls] = await db.insert(classes).values({ companyId: company.id, name: 'East' }).returning();
  const [cust] = await db.insert(customers).values({ companyId: company.id, displayName: 'Alpha' }).returning();
  const [vend] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Paper Co' }).returning();
  const [cust2] = await db.insert(customers).values({ companyId: company2.id, displayName: 'Other Co Customer' }).returning();
  Object.assign(ids, { cls: cls.id, cust: cust.id, vend: vend.id, cust2: cust2.id });

  await postJournalEntry(ctx, { date: d('2025-12-15'), description: 'Capital', lines: [{ accountId: A.bank, debit: '5000' }, { accountId: A.equity, credit: '5000' }] });
  await postJournalEntry(ctx, { date: d('2025-12-20'), description: 'Dec sale', lines: [{ accountId: A.bank, debit: '300' }, { accountId: A.sales, credit: '300' }] });
  await postJournalEntry(ctx, { date: d('2026-01-10'), description: 'Jan sale', sourceRef: `customer:${cust.id}`, lines: [{ accountId: A.ar, debit: '1000', controlLine: true }, { accountId: A.svc, credit: '600', classId: cls.id }, { accountId: A.sales, credit: '400' }] });
  await postJournalEntry(ctx, { date: d('2026-01-20'), description: 'Materials', lines: [{ accountId: A.cogs, debit: '250', classId: cls.id }, { accountId: A.bank, credit: '250' }] });
  await postJournalEntry(ctx, { date: d('2026-02-03'), description: 'Office misc', lines: [{ accountId: A.office, debit: '80' }, { accountId: A.bank, credit: '80' }] });
  await postJournalEntry(ctx, { date: d('2026-02-14'), description: 'Paper', sourceRef: `vendor:${vend.id}`, lines: [{ accountId: A.paper, debit: '120', classId: cls.id }, { accountId: A.ap, credit: '120', controlLine: true }] });
  await postJournalEntry(ctx, { date: d('2026-03-01'), description: 'Late fee', lines: [{ accountId: A.penalty, debit: '33.33' }, { accountId: A.bank, credit: '33.33' }] });
  await postJournalEntry(ctx, { date: d('2026-03-15'), description: 'Collected', allowUnnamedControl: true, lines: [{ accountId: A.bank, debit: '1000' }, { accountId: A.ar, credit: '1000' }] });

  await postJournalEntry(ctx2, { date: d('2026-01-05'), description: 'Capital', lines: [{ accountId: A.bank2, debit: '100' }, { accountId: A.equity2, credit: '100' }] });
  await postJournalEntry(ctx2, { date: d('2026-02-05'), description: 'Sale', sourceRef: `customer:${cust2.id}`, lines: [{ accountId: A.bank2, debit: '1000' }, { accountId: A.sales2, credit: '1000' }] });
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
// Permissions
// ---------------------------------------------------------------------------

describe('memorized reports respect each report area (routes are mapped member)', () => {
  const noFinancial = () => {
    const a = fullAccess();
    a.permissions.reports_financial = [];
    return a;
  };
  const noSales = () => {
    const a = fullAccess();
    a.permissions.reports_sales = [];
    return a;
  };

  it('a memorized custom (report builder) GL report cannot be run without financial report access', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'GL by account', reportType: 'custom', config: { groupBy: 'account' } });
    // the owner can run it
    await expect(runMemorizedReport(ctx, m.id)).resolves.toBeTruthy();
    await expect(runMemorizedReport({ ...ctx, access: noFinancial() }, m.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const out = await processMultipleReports({ ...ctx, access: noFinancial() }, { ids: [m.id] });
    expect(out[0].report).toBeUndefined();
    expect(out[0].error).toBeTruthy();
  });

  it('Process Multiple Reports runs what the user may see and refuses the rest', async () => {
    const pl = await saveMemorizedReport(ctx, { name: 'QA2 P&L', reportType: 'profit-loss', config: { params: { from: '2026-01-01', to: '2026-03-31' } } });
    const cb = await saveMemorizedReport(ctx, { name: 'QA2 Cust bal', reportType: 'customer-balance-summary', config: { params: { asOf: '2026-03-31' } } });
    const out = await processMultipleReports({ ...ctx, access: noSales() }, { ids: [pl.id, cb.id] });
    expect(out.find((x) => x.id === pl.id)?.report).toBeTruthy();
    expect(out.find((x) => x.id === cb.id)?.report).toBeUndefined();
    expect(out.find((x) => x.id === cb.id)?.error).toBeTruthy();
  });

  it('Advanced Find and graphs carry no data for a caller without any report access when called through the registry', async () => {
    const none = fullAccess();
    for (const k of Object.keys(none.permissions) as (keyof typeof none.permissions)[]) {
      if (String(k).startsWith('reports_')) none.permissions[k] = [];
    }
    for (const e of REPORT_CATALOG.filter((x) => x.area.startsWith('reports_'))) {
      await expect(run(e.key, {}, { ...ctx, access: none }), e.key).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('migration 0030_wave2_reports', () => {
  it('is journaled exactly once as idx 30 and re-running every statement is a no-op', async () => {
    const journal = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const mine = journal.entries.filter((e) => e.tag === '0030_wave2_reports');
    expect(mine).toHaveLength(1);
    expect(mine[0].idx).toBe(30);
    expect(journal.entries.filter((e) => e.idx === 30)).toHaveLength(1);
    const text = fs.readFileSync(path.resolve(process.cwd(), 'drizzle/0030_wave2_reports.sql'), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      await db.execute(sql.raw(stmt));
    }
  });
});

// ---------------------------------------------------------------------------
// Budgets (H17) malformed input
// ---------------------------------------------------------------------------

describe('budgets reject malformed and foreign input', () => {
  it('amounts that are not plain decimals and non-integer months are VALIDATION errors', async () => {
    const b = await createBudget(ctx, { name: 'QA2 budget', fiscalYear: 2026 });
    const accepted: string[] = [];
    for (const amount of ['Infinity', '-Infinity', '1e400', 'abc']) {
      const res = await setBudgetLine(ctx, { budgetId: b.id, accountId: A.sales, month: 1, amount }).then(
        (row) => `accepted amount ${JSON.stringify(amount)} -> ${row.amount}`,
        (e: { code?: string }) => (e.code === 'VALIDATION' ? null : `amount ${JSON.stringify(amount)} -> ${e.code ?? String(e)}`),
      );
      if (res) accepted.push(res);
    }
    for (const month of [0, 13, 1.5, Number.NaN]) {
      const res = await setBudgetLine(ctx, { budgetId: b.id, accountId: A.sales, month, amount: '1' }).then(
        () => `accepted month ${month}`,
        (e: { code?: string }) => (e.code === 'VALIDATION' ? null : `month ${month} -> ${e.code ?? String(e)}`),
      );
      if (res) accepted.push(res);
    }
    expect(accepted).toEqual([]);
    // The API boundary (zod) also refuses hex / blank amounts the service's Number() check lets through.
    for (const amount of ['0x10', '   ', 'Infinity']) {
      expect(setBudgetLineSchema.safeParse({ accountId: A.sales, month: 1, amount }).success, amount).toBe(false);
    }
    expect(setBudgetLineSchema.safeParse({ accountId: A.sales, month: 1.5, amount: '1' }).success).toBe(false);
    await expect(setBudgetLine(ctx, { budgetId: b.id, accountId: A.sales2, month: 1, amount: '1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setBudgetLine(ctx, { budgetId: b.id, accountId: A.sales, month: 1, amount: '1', customerId: ids.cust2 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setBudgetLine(ctx2, { budgetId: b.id, accountId: A.sales2, month: 1, amount: '1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createBudget(ctx, { name: 'x', fiscalYear: 2026, kind: 'nonsense' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('setting the same line twice replaces it (upsert, no double counting in Budget Overview)', async () => {
    const b = await createBudget(ctx, { name: 'QA2 upsert', fiscalYear: 2026 });
    await setBudgetLine(ctx, { budgetId: b.id, accountId: A.office, month: 2, amount: '100' });
    await setBudgetLine(ctx, { budgetId: b.id, accountId: A.office, month: 2, amount: '150' });
    const ov = await run('budget-overview', { budgetId: b.id });
    expect(byLabel(ov, 'Office')?.cells.m2).toBe('150.00');
    expect(byLabel(ov, 'Net Income')?.cells.total).toBe('-150.00');
  });
});

// ---------------------------------------------------------------------------
// Graphs (H13) agree with the statements
// ---------------------------------------------------------------------------

describe('graphs tie to the statements', () => {
  it('Income & Expense: income minus expense equals P&L Net Income (mid-month range)', async () => {
    const g = await graphData(ctx, 'income-expense', { from: '2025-12-16', to: '2026-03-31' } as never);
    const inc = g.series[0].values.reduce((a, b) => a + b, 0);
    const exp = g.series[1].values.reduce((a, b) => a + b, 0);
    const pl = await run('profit-loss', { from: '2025-12-16', to: '2026-03-31' });
    expect((inc - exp).toFixed(2)).toBe(num(byLabel(pl, 'Net Income')?.cells.total).toFixed(2));
    expect(g.labels).toHaveLength(4);
  });

  it('Net Worth at each month end equals Balance Sheet assets minus liabilities', async () => {
    const g = await graphData(ctx, 'net-worth', { from: '2026-01-01', to: '2026-03-31' } as never);
    const ends = ['2026-01-31', '2026-02-28', '2026-03-31'];
    for (let i = 0; i < ends.length; i++) {
      const bs = await run('balance-sheet', { asOf: ends[i] });
      const assets = num(byLabel(bs, 'TOTAL ASSETS')?.cells.total);
      const le = num(byLabel(bs, 'TOTAL LIABILITIES & EQUITY')?.cells.total);
      const liabilities = num(byLabel(bs, 'Total Liabilities')?.cells.total);
      expect(assets.toFixed(2)).toBe(le.toFixed(2));
      expect(g.series[2].values[i].toFixed(2), ends[i]).toBe(assets.minus(liabilities).toFixed(2));
    }
  });

  it('refuses very long graph ranges', async () => {
    await expect(graphData(ctx, 'income-expense', { from: '2000-01-01', to: '2026-03-31' } as never)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
// Advanced Find (J5)
// ---------------------------------------------------------------------------

describe('Advanced Find', () => {
  it("never returns another company's transactions, even when filtering by that company's ids", async () => {
    const r = await findTransactions(ctx, { customerId: ids.cust2 } as never);
    expect(r.rows.filter((x) => x.entryId)).toHaveLength(0);
    const r2 = await findTransactions(ctx, { accountId: A.bank2 } as never).catch((e) => e);
    if (!(r2 instanceof Error) && 'rows' in r2) expect(r2.rows.filter((x: StdRow) => x.entryId)).toHaveLength(0);
    else expect((r2 as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('amount range on the transaction total is inclusive and exact to the cent', async () => {
    const r = await findTransactions(ctx, { amountMin: '33.33', amountMax: '120' } as never);
    const amts = r.rows.filter((x) => x.entryId).map((x) => x.cells.amount).sort();
    expect(amts).toEqual(['120.00', '33.33', '80.00']);
    const t = r.rows.find((x) => x.kind === 'grand')!;
    expect(t.cells.amount).toBe('233.33');
  });
});

// ---------------------------------------------------------------------------
// H2 roll-up on every P&L variant; combined P&L by month (H15)
// ---------------------------------------------------------------------------

describe('sub-account roll-up foots on every P&L variant', () => {
  it('P&L by class, previous-year comparison and by month', async () => {
    const byClass = await run('pl-by-class', { from: '2026-01-01', to: '2026-03-31' });
    for (const c of byClass.columns.filter((x) => x.type === 'money')) assertFoots(byClass, c.key);
    const net = byLabel(byClass, 'Net Income')!;
    const classCols = byClass.columns.filter((x) => x.type === 'money' && x.key !== 'total');
    const across = classCols.reduce((s, c) => s.plus(num(net.cells[c.key])), Money.zero());
    expect(across.toFixed(2)).toBe(num(net.cells.total).toFixed(2));
    expect(num(net.cells.total).toFixed(2)).toBe('516.67');

    const py = await run('profit-loss', { from: '2026-01-01', to: '2026-03-31', compare: 'prev_year' });
    for (const c of py.columns.filter((x) => x.type === 'money')) assertFoots(py, c.key);
    const bm = await run('profit-loss-by-month', { from: '2026-01-01', to: '2026-03-31' });
    for (const c of bm.columns.filter((x) => x.type === 'money')) assertFoots(bm, c.key);
    expect(byLabel(bm, 'Total Office')?.cells.total).toBe('200.00');
    expect(byLabel(bm, 'Office - Other')?.cells.total).toBe('80.00');
  });

  it('combined P&L by month: the Combined total equals the sum of each company P&L', async () => {
    const r = await run('combined-pl-by-month', { from: '2026-01-01', to: '2026-03-31' });
    const a = await run('profit-loss', { from: '2026-01-01', to: '2026-03-31' });
    const b = await run('profit-loss', { from: '2026-01-01', to: '2026-03-31' }, ctx2);
    const want = num(byLabel(a, 'Net Income')?.cells.total).plus(num(byLabel(b, 'Net Income')?.cells.total));
    expect(num(byLabel(r, 'Net Income')?.cells.total).toFixed(2)).toBe(want.toFixed(2));
    assertFoots(r, 'total');
  });
});

// ---------------------------------------------------------------------------
// H7 QuickZoom
// ---------------------------------------------------------------------------

describe('QuickZoom (H7)', () => {
  it('every data row with an amount on the summary financial reports drills down', async () => {
    const reports = [
      ['profit-loss', { from: '2026-01-01', to: '2026-03-31' }],
      ['profit-loss', { from: '2026-01-01', to: '2026-03-31', compare: 'prev_year' }],
      ['profit-loss-by-month', { from: '2026-01-01', to: '2026-03-31' }],
      ['pl-by-class', { from: '2026-01-01', to: '2026-03-31' }],
      ['profit-loss-ytd', { from: '2026-03-01', to: '2026-03-31' }],
      ['balance-sheet', { asOf: '2026-03-31' }],
      ['balance-sheet-summary', { asOf: '2026-03-31' }],
      ['trial-balance', { asOf: '2026-03-31' }],
      ['customer-balance-summary', { asOf: '2026-03-31' }],
      ['vendor-balance-summary', { asOf: '2026-03-31' }],
      ['expenses-by-vendor-summary', { from: '2026-01-01', to: '2026-03-31' }],
    ] as const;
    const missing: string[] = [];
    for (const [key, p] of reports) {
      const r = await run(key, p as Record<string, string>);
      const money = r.columns.filter((c) => c.type === 'money').map((c) => c.key);
      for (const row of r.rows.filter((x) => x.kind === 'data')) {
        const hasAmount = money.some((k) => !num(row.cells[k]).isZero());
        // Unnamed groups ("(no name)", "(no vendor)") have no single list item to zoom to.
        if (/^\(no /.test(String(row.cells.label))) continue;
        if (hasAmount && !row.href && !row.entryId && !(row.hrefs && Object.keys(row.hrefs).length)) missing.push(`${key}: ${row.cells.label}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// H10 / H11
// ---------------------------------------------------------------------------

describe('income tax by tax line (injected mapper) and Account Listing', () => {
  it('income tax summary equals detail subtotals and P&L section totals', async () => {
    const mapper: TaxLineMapper = (a) =>
      a.section === 'income' ? { id: 'l1', name: 'Gross receipts' } : a.section === 'cogs' ? { id: 'l2', name: 'Cost of goods sold' } : a.section === 'expense' || a.section === 'other_expense' ? { id: 'l26', name: 'Other deductions' } : null;
    const p = { from: '2026-01-01', to: '2026-03-31' } as never;
    const sum = await incomeTaxReport(ctx, p, false, mapper);
    const det = await incomeTaxReport(ctx, p, true, mapper);
    const pl = await run('profit-loss', { from: '2026-01-01', to: '2026-03-31' });
    expect(byLabel(sum, 'Gross receipts')?.cells.amount).toBe(byLabel(pl, 'Total Income')?.cells.total);
    expect(byLabel(sum, 'Cost of goods sold')?.cells.amount).toBe('250.00');
    expect(byLabel(sum, 'Other deductions')?.cells.amount).toBe('233.33');
    for (const row of sum.rows) expect(byLabel(det, `Total ${row.cells.label}`)?.cells.amount, String(row.cells.label)).toBe(row.cells.amount);
    assertFoots(det, 'amount');
  });

  it('Account Listing balances equal the trial balance for every balance-sheet account', async () => {
    const al = await run('account-listing', { asOf: '2026-03-31' });
    const want: Record<string, string> = { Checking: '5936.67', 'Accounts Receivable': '0.00', 'Accounts Payable': '120.00', 'Owner Equity': '5000.00' };
    for (const [label, v] of Object.entries(want)) expect(byLabel(al, label)?.cells.balance, label).toBe(v);
    expect(al.rows.some((x) => x.cells.label === 'Sales' && x.cells.balance)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H8 subledger detail == summary == control account
// ---------------------------------------------------------------------------

describe('balance detail reports tie to their summaries and the control accounts', () => {
  it('Customer / Vendor Balance Detail data rows sum to the summary TOTAL and to A/R, A/P', async () => {
    for (const [detailKey, summaryKey, control] of [
      ['customer-balance-detail', 'customer-balance-summary', '0.00'],
      ['vendor-balance-detail', 'vendor-balance-summary', '120.00'],
    ] as const) {
      const det = await run(detailKey, { asOf: '2026-03-31' });
      const sum = await run(summaryKey, { asOf: '2026-03-31' });
      const dataTotal = det.rows.filter((x) => x.kind === 'data').reduce((s, x) => s.plus(num(x.cells.amount)), Money.zero());
      expect(dataTotal.toFixed(2), detailKey).toBe(control);
      expect(num(byLabel(sum, 'TOTAL')?.cells.balance).toFixed(2), summaryKey).toBe(control);
      assertFoots(det, 'amount');
    }
    // the other company's customer never appears
    const det = await run('customer-balance-detail', { asOf: '2026-03-31' });
    expect(det.rows.some((x) => x.cells.label === 'Other Co Customer')).toBe(false);
  });
});
