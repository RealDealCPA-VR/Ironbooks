/**
 * Independent QA (tester) for the wave-2 reports engine. Adversarial checks of the ledger
 * invariants the reports must preserve:
 *  - every subtotal ("Total <Parent>", section totals, TOTAL ASSETS …) foots to its data rows
 *  - P&L Net Income == Balance Sheet Net Income line (fiscal year to date, non-calendar FY)
 *  - Retained Earnings = prior fiscal years only, before AND after a year-end close
 *  - Trial Balance / combined Trial Balance debit == credit and foot to their rows
 *  - subledger (Customer / Vendor Balance Summary) == control account (A/R, A/P) incl. unnamed
 *    and voided lines
 *  - reports are read-only (running the whole catalog changes nothing)
 *  - malformed parameters, cross-company ids, schedule idempotency / folder escape, and
 *    number-format rounding.
 * Hermetic PGlite data dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, customers, invoices, userCompanies, users, vendors, bills } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { yearEndClose } from './fiscalClose';
import { trialBalance } from './reports';
import { REPORT_CATALOG } from '@/lib/reports/catalog';
import { runStandardReport } from './reportRegistry';
import { sectionForAccount } from './reportEngine';
import { parseReportParams } from '@/lib/validation/reports';
import { formatAmount, roundDecimalString, DEFAULT_NUMBER_FORMAT } from '@/lib/reports/format';
import {
  createMemorizedGroup,
  createReportSchedule,
  listReportSchedules,
  nextRunAfter,
  processMultipleReports,
  runDueSchedules,
  runMemorizedReport,
  saveMemorizedReport,
  updateMemorizedReport,
  updateReportSchedule,
} from './memorizedReports';
import { pivotReport } from './reportsAnalysis';
import type { StdReport, StdRow } from '@/lib/reports/types';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2-qa');
const OUT_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-wave2-qa-exports');
let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext;
const A: Record<string, string> = {};
const ids: Record<string, string> = {};

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const run = (key: string, p: Record<string, string> = {}, c: ServiceContext = ctx) => runStandardReport(c, key, p);
const byLabel = (r: StdReport, label: string) => r.rows.find((x) => x.cells.label === label);
const num = (v: unknown) => Money.of(v === null || v === undefined || v === '' ? '0' : String(v));

/**
 * Every row that totals something (totalOf) must equal the sum of the data rows beneath the
 * row it totals. `val` reads the comparable amount from a row's cells.
 */
function assertFoots(r: StdReport, val: (cells: StdRow['cells']) => ReturnType<typeof Money.of>) {
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
  let checked = 0;
  for (const t of r.rows) {
    if (!t.totalOf) continue;
    const sum = r.rows
      .filter((x) => x.kind === 'data' && isUnder(x, t.totalOf!))
      .reduce((s, x) => s.plus(val(x.cells)), Money.zero());
    expect(`${t.cells.label}=${val(t.cells).toFixed(2)}`).toBe(`${t.cells.label}=${sum.toFixed(2)}`);
    checked++;
  }
  return checked;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qa@rep.test', name: 'QA', passwordHash: 'x' }).returning();
  // June 30 fiscal year end: FY2026 = 2025-07-01 .. 2026-06-30.
  const [company] = await db
    .insert(companies)
    .values({ name: 'QA Fiscal Co', ownerId: user.id, settings: { fiscalYearEnd: '06-30' } })
    .returning();
  const [company2] = await db.insert(companies).values({ name: 'QA Sister', ownerId: user.id }).returning();
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
  await mk(ctx, 'equip', '1500', 'Equipment', 'asset', 'fixed_assets');
  await mk(ctx, 'ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable');
  await mk(ctx, 'cc', '2100', 'Visa', 'liability', 'credit_card');
  await mk(ctx, 'loan', '2700', 'Truck Loan', 'liability', 'long_term_liability');
  await mk(ctx, 'equity', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk(ctx, 're', '3900', 'Retained Earnings', 'equity', 'retained_earnings');
  await mk(ctx, 'sales', '4000', 'Sales', 'revenue', 'sales');
  await mk(ctx, 'hw', '4010', 'Hardware', 'revenue', 'sales', 'sales');
  await mk(ctx, 'premium', '4011', 'Premium', 'revenue', 'sales', 'hw');
  await mk(ctx, 'disc', '4090', 'Discounts', 'revenue', 'sales', 'sales');
  await mk(ctx, 'interest', '4900', 'Interest Income', 'revenue', 'other_income');
  await mk(ctx, 'cogs', '5000', 'Materials', 'expense', 'cost_of_goods_sold');
  await mk(ctx, 'util', '6000', 'Utilities', 'expense', 'operating_expenses');
  await mk(ctx, 'elec', '6010', 'Electric', 'expense', 'operating_expenses', 'util');
  // Company 2: same chart numbers so the combined TB merges them.
  await mk(ctx2, 'bank2', '1000', 'Checking', 'asset', 'checking');
  await mk(ctx2, 'equity2', '3000', 'Owner Equity', 'equity', 'owners_equity');
  await mk(ctx2, 'rent2', '6100', 'Rent', 'expense', 'operating_expenses');

  const c = company.id;
  const [cust] = await db.insert(customers).values({ companyId: c, displayName: 'Zed Corp' }).returning();
  const [vend] = await db.insert(vendors).values({ companyId: c, displayName: 'Parts Inc' }).returning();
  Object.assign(ids, { cust: cust.id, vend: vend.id });

  // ---- FY2025 (2024-07-01 .. 2025-06-30): NI = 1000 - 300 = 700
  await postJournalEntry(ctx, { date: d('2024-07-05'), description: 'Capital', lines: [{ accountId: A.bank, debit: '10000' }, { accountId: A.equity, credit: '10000' }] });
  await postJournalEntry(ctx, { date: d('2024-08-01'), description: 'Premium sale', lines: [{ accountId: A.bank, debit: '1000' }, { accountId: A.premium, credit: '1000' }] });
  await postJournalEntry(ctx, { date: d('2024-09-01'), description: 'Power bill', lines: [{ accountId: A.elec, debit: '300' }, { accountId: A.bank, credit: '300' }] });

  // ---- FY2026: NI = 500 + 200 - 50 + 25 - 100 - 40 = 535
  const [inv] = await db
    .insert(invoices)
    .values({ companyId: c, customerId: cust.id, invoiceNumber: 501, date: d('2025-08-01'), total: '500', balanceDue: '450' })
    .returning();
  await postJournalEntry(ctx, { date: d('2025-08-01'), description: 'Invoice 501', sourceRef: `invoice:${inv.id}`, lines: [{ accountId: A.ar, debit: '500', controlLine: true }, { accountId: A.sales, credit: '500' }] });
  await postJournalEntry(ctx, { date: d('2025-08-15'), description: 'Cash hardware sale', lines: [{ accountId: A.bank, debit: '200' }, { accountId: A.hw, credit: '200' }] });
  await postJournalEntry(ctx, { date: d('2025-09-01'), description: 'Early pay discount', sourceRef: `customer:${cust.id}`, lines: [{ accountId: A.disc, debit: '50' }, { accountId: A.ar, credit: '50', controlLine: true }] });
  await postJournalEntry(ctx, { date: d('2025-10-01'), description: 'Bank interest 100% promo_x', lines: [{ accountId: A.bank, debit: '25' }, { accountId: A.interest, credit: '25' }] });
  const [bill] = await db
    .insert(bills)
    .values({ companyId: c, vendorId: vend.id, billNumber: 'P-9', date: d('2025-11-01'), dueDate: d('2025-12-01'), total: '100', balanceDue: '100' })
    .returning();
  await postJournalEntry(ctx, { date: d('2025-11-01'), description: 'Bill P-9', sourceRef: `bill:${bill.id}`, lines: [{ accountId: A.cogs, debit: '100' }, { accountId: A.ap, credit: '100', controlLine: true }] });
  await postJournalEntry(ctx, { date: d('2025-12-01'), description: 'Utilities misc', lines: [{ accountId: A.util, debit: '40' }, { accountId: A.cc, credit: '40' }] });
  await postJournalEntry(ctx, { date: d('2026-01-10'), description: 'Truck', lines: [{ accountId: A.equip, debit: '2000' }, { accountId: A.loan, credit: '2000' }] });
  // Unnamed A/R journal (no customer) — must still be in the A/R subledger total.
  await postJournalEntry(ctx, { date: d('2026-02-01'), description: 'AR adj (no name)', allowUnnamedControl: true, lines: [{ accountId: A.ar, debit: '75' }, { accountId: A.bank, credit: '75' }] });
  // A voided invoice entry: must not appear anywhere.
  const v = await postJournalEntry(ctx, { date: d('2026-02-02'), description: 'Voided invoice', sourceRef: `invoice:${inv.id}`, lines: [{ accountId: A.ar, debit: '999', controlLine: true }, { accountId: A.sales, credit: '999' }] });
  await voidJournalEntry(ctx, v.id);

  // Company 2: checking overdrawn (credit balance) so the combined TB nets across companies.
  await postJournalEntry(ctx2, { date: d('2026-01-02'), description: 'Capital', lines: [{ accountId: A.bank2, debit: '100' }, { accountId: A.equity2, credit: '100' }] });
  await postJournalEntry(ctx2, { date: d('2026-01-05'), description: 'Rent', lines: [{ accountId: A.rent2, debit: '400' }, { accountId: A.bank2, credit: '400' }] });
}, 120_000);

afterAll(async () => {
  await closeDb();
  for (const dir of [TEST_DIR, OUT_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold PGlite files briefly; the next run wipes the dir in beforeAll. */
    }
  }
});

// ---------------------------------------------------------------------------
// H1 sections
// ---------------------------------------------------------------------------

describe('H1 sectionForAccount robustness', () => {
  it('accepts QB names in any case / spacing and keeps BS types out of the P&L', () => {
    expect(sectionForAccount('Expense', 'Other Expense')).toBe('other_expense');
    expect(sectionForAccount('INCOME', 'other-income')).toBe('other_income');
    expect(sectionForAccount('Cost of Goods Sold')).toBe('cogs');
    expect(sectionForAccount('expense', null)).toBe('expense');
    expect(sectionForAccount('liability', 'Credit Card')).toBe('credit_card');
    expect(sectionForAccount('asset', 'Accounts Receivable')).toBe('ar');
    expect(sectionForAccount('equity', 'retained_earnings')).toBe('equity');
    expect(sectionForAccount('asset', 'inventory')).toBe('other_current_asset');
  });
});

// ---------------------------------------------------------------------------
// H1/H2/H3 P&L + Balance Sheet against a June-30 fiscal year
// ---------------------------------------------------------------------------

describe('P&L (non-calendar fiscal year, 3-level roll-up, contra sub-account)', () => {
  it('defaults to fiscal year to date and computes every QB subtotal', async () => {
    const r = await run('profit-loss', { to: '2026-03-31' });
    expect(r.subtitle).toContain('07/01/2025');
    const v = (l: string) => byLabel(r, l)?.cells.total;
    expect(v('Sales - Other')).toBe('500.00');
    expect(v('Hardware')).toBe('200.00');
    expect(v('Discounts')).toBe('-50.00');
    expect(v('Total Sales')).toBe('650.00');
    expect(v('Total Income')).toBe('650.00');
    expect(v('Total Cost of Goods Sold')).toBe('100.00');
    expect(v('Gross Profit')).toBe('550.00');
    expect(v('Total Expense')).toBe('40.00');
    expect(v('Net Ordinary Income')).toBe('510.00');
    expect(v('Total Other Income')).toBe('25.00');
    expect(v('Net Other Income')).toBe('25.00');
    expect(v('Net Income')).toBe('535.00');
    // the voided 999 never shows
    expect(r.rows.some((x) => x.cells.total === '1149.00' || x.cells.total === '1649.00')).toBe(false);
    expect(assertFoots(r, (c) => num(c.total))).toBeGreaterThan(3);
  });

  it('nests Sales > Hardware > Premium in the prior fiscal year and foots', async () => {
    const r = await run('profit-loss', { from: '2024-07-01', to: '2025-06-30' });
    const sales = byLabel(r, 'Sales')!;
    const hw = byLabel(r, 'Hardware')!;
    const prem = byLabel(r, 'Premium')!;
    expect(hw.parentId).toBe(sales.id);
    expect(prem.parentId).toBe(hw.id);
    expect(prem.depth).toBe(hw.depth + 1);
    expect(byLabel(r, 'Total Hardware')?.cells.total).toBe('1000.00');
    expect(byLabel(r, 'Total Sales')?.cells.total).toBe('1000.00');
    expect(byLabel(r, 'Total Utilities')?.cells.total).toBe('300.00');
    expect(byLabel(r, 'Net Income')?.cells.total).toBe('700.00');
    assertFoots(r, (c) => num(c.total));
  });

  it('monthly columns foot across to TOTAL and to the single-column report', async () => {
    const m = await run('profit-loss-by-month', { from: '2025-07-01', to: '2026-06-30' });
    const net = byLabel(m, 'Net Income')!;
    const periodKeys = m.columns.slice(1).map((c) => c.key).filter((k) => k !== 'total');
    expect(periodKeys).toHaveLength(12);
    const across = periodKeys.reduce((s, k) => s.plus(num(net.cells[k])), Money.zero());
    expect(across.toFixed(2)).toBe('535.00');
    expect(net.cells.total).toBe('535.00');
    for (const k of [...periodKeys, 'total']) assertFoots(m, (c) => num(c[k]));
  });

  it('quarter columns follow the July fiscal year (Q1 = Jul–Sep)', async () => {
    const q = await run('profit-loss', { from: '2025-07-01', to: '2026-06-30', columns: 'quarter' });
    const headers = q.columns.slice(1, 5).map((c) => c.header);
    expect(headers[0]).toMatch(/^Q1/);
    expect(headers).toHaveLength(4);
    const net = byLabel(q, 'Net Income')!;
    // Q1 (Jul-Sep): 500 + 200 - 50 = 650; Q2 (Oct-Dec): 25 - 100 - 40 = -115
    expect(net.cells[q.columns[1].key]).toBe('650.00');
    expect(net.cells[q.columns[2].key]).toBe('-115.00');
  });

  it('Previous Period for a whole calendar month compares with the previous calendar month', async () => {
    const r = await run('profit-loss', { from: '2025-09-01', to: '2025-09-30', compare: 'prev_period' });
    // QB: March vs February, September vs August (not "the same number of days earlier").
    expect(r.columns.find((c) => c.key === 'prev')?.header).toBe('08/01/2025 – 08/31/2025');
  });
});

describe('Balance Sheet (H3 Retained Earnings / Net Income split)', () => {
  const checkBS = (r: StdReport, col = 'total') => {
    const ta = num(byLabel(r, 'TOTAL ASSETS')?.cells[col]);
    const tle = num(byLabel(r, 'TOTAL LIABILITIES & EQUITY')?.cells[col]);
    expect(ta.toFixed(2)).toBe(tle.toFixed(2));
    assertFoots(r, (c) => num(c[col]));
  };

  it('mid fiscal year: RE = prior fiscal years only, Net Income = this fiscal year, equals P&L', async () => {
    const r = await run('balance-sheet', { asOf: '2026-03-31' });
    checkBS(r);
    expect(byLabel(r, 'Retained Earnings')?.cells.total).toBe('700.00');
    expect(byLabel(r, 'Net Income')?.cells.total).toBe('535.00');
    const pl = await run('profit-loss', { from: '2025-07-01', to: '2026-03-31' });
    expect(byLabel(pl, 'Net Income')?.cells.total).toBe(byLabel(r, 'Net Income')?.cells.total);
    expect(byLabel(r, 'Total Accounts Receivable')?.cells.total ?? byLabel(r, 'Accounts Receivable')?.cells.total).toBe('525.00');
    expect(byLabel(r, 'Total Long Term Liabilities')?.cells.total).toBe('2000.00');
  });

  it('on the fiscal year end day all income is still current-year Net Income', async () => {
    const r = await run('balance-sheet', { asOf: '2025-06-30' });
    checkBS(r);
    expect(byLabel(r, 'Net Income')?.cells.total).toBe('700.00');
    const re = byLabel(r, 'Retained Earnings');
    expect(re ? re.cells.total : '0.00').toMatch(/^(0\.00|-?0\.00)$/);
  });

  it('first day of the next fiscal year moves it to Retained Earnings', async () => {
    const r = await run('balance-sheet', { asOf: '2025-07-01' });
    checkBS(r);
    expect(byLabel(r, 'Retained Earnings')?.cells.total).toBe('700.00');
    expect(byLabel(r, 'Net Income')?.cells.total).toBe('0.00');
  });

  it('summary and by-quarter variants balance in every column', async () => {
    checkBS(await run('balance-sheet-summary', { asOf: '2026-03-31' }));
    const q = await run('balance-sheet-by-period', { from: '2025-07-01', to: '2026-06-30', columns: 'quarter' });
    for (const c of q.columns.slice(1)) checkBS(q, c.key);
  });

  it('previous-period comparison as of a month end uses the previous month end (no date overflow)', async () => {
    const r = await run('balance-sheet', { asOf: '2026-03-31', compare: 'prev_period' });
    // 03/31 minus one month must clamp to 02/28, not roll over to 03/03.
    expect(r.columns.find((c) => c.key === 'prev')?.header).toBe('02/28/2026');
    checkBS(r, 'prev');
  });

  it('previous-year comparison from Feb 29 uses Feb 28 of the prior year', async () => {
    const r = await run('balance-sheet', { asOf: '2028-02-29', compare: 'prev_year' });
    expect(r.columns.find((c) => c.key === 'prev')?.header).toBe('02/28/2027');
  });

  it('company without a retained-earnings account still shows a separate Retained Earnings line and balances', async () => {
    // Company 2 has prior activity only in 2026 (calendar FY) -> check 2027.
    const r = await run('balance-sheet', { asOf: '2027-01-31' }, ctx2);
    checkBS(r);
    expect(byLabel(r, 'Retained Earnings')?.cells.total).toBe('-400.00');
    expect(byLabel(r, 'Net Income')?.cells.total).toBe('0.00');
  });
});

describe('Trial Balance (H2 roll-up) and combined Trial Balance (H15)', () => {
  it('debits equal credits and the TOTAL row equals the sum of the rows shown', async () => {
    const r = await run('trial-balance', { asOf: '2026-03-31' });
    const leaf = r.rows.filter((x) => x.kind === 'data');
    const dr = leaf.reduce((s, x) => s.plus(num(x.cells.debit)), Money.zero());
    const cr = leaf.reduce((s, x) => s.plus(num(x.cells.credit)), Money.zero());
    const total = byLabel(r, 'TOTAL')!;
    expect(r.balanced).toBe(true);
    expect(num(total.cells.debit).toFixed(2)).toBe(num(total.cells.credit).toFixed(2));
    expect(dr.toFixed(2)).toBe(num(total.cells.debit).toFixed(2));
    expect(cr.toFixed(2)).toBe(num(total.cells.credit).toFixed(2));
    assertFoots(r, (c) => num(c.debit).minus(num(c.credit)));
  });

  it('combined TB: the Combined column foots to its TOTAL row even when one company is overdrawn', async () => {
    const r = await run('combined-trial-balance', { asOf: '2026-03-31' });
    expect(r.balanced).toBe(true);
    const total = byLabel(r, 'TOTAL')!;
    expect(num(total.cells.total_dr).toFixed(2)).toBe(num(total.cells.total_cr).toFixed(2));
    const leaf = r.rows.filter((x) => x.kind === 'data');
    const dr = leaf.reduce((s, x) => s.plus(num(x.cells.total_dr)), Money.zero());
    const cr = leaf.reduce((s, x) => s.plus(num(x.cells.total_cr)), Money.zero());
    expect(dr.toFixed(2)).toBe(num(total.cells.total_dr).toFixed(2));
    expect(cr.toFixed(2)).toBe(num(total.cells.total_cr).toFixed(2));
  });
});

// ---------------------------------------------------------------------------
// Subledger == control account
// ---------------------------------------------------------------------------

describe('Customer / Vendor balances tie to A/R and A/P', () => {
  it('Customer Balance Summary total == A/R on the trial balance (unnamed + voided lines)', async () => {
    const r = await run('customer-balance-summary', { asOf: '2026-03-31' });
    const tb = await trialBalance(ctx, new Date('2026-03-31T23:59:59.999Z'));
    const ar = tb.rows.find((x) => x.accountId === A.ar)!;
    const arBal = num(ar.debit).minus(num(ar.credit));
    expect(arBal.toFixed(2)).toBe('525.00');
    expect(num(byLabel(r, 'TOTAL')?.cells.balance).toFixed(2)).toBe(arBal.toFixed(2));
    expect(byLabel(r, 'Zed Corp')?.cells.balance).toBe('450.00');
  });

  it('Vendor Balance Summary total == A/P', async () => {
    const r = await run('vendor-balance-summary', { asOf: '2026-03-31' });
    expect(byLabel(r, 'TOTAL')?.cells.balance).toBe('100.00');
    expect(byLabel(r, 'Parts Inc')?.cells.balance).toBe('100.00');
  });

  it('P&L Detail nets to Net Income and excludes the voided entry', async () => {
    const r = await run('profit-loss-detail', { from: '2025-07-01', to: '2026-03-31' });
    const data = r.rows.filter((x) => x.kind === 'data');
    expect(data.some((x) => String(x.cells.memo ?? '').includes('Voided'))).toBe(false);
    expect(byLabel(r, 'Net Income')?.cells.amount).toBe('535.00');
    // Grouped by name instead of account: same net.
    const byName = await run('profit-loss-detail', { from: '2025-07-01', to: '2026-03-31', subtotalBy: 'name' });
    expect(byLabel(byName, 'Net Income')?.cells.amount).toBe('535.00');
  });

  it('P&L Detail for a period with no activity still shows Net Income 0.00', async () => {
    const r = await run('profit-loss-detail', { from: '2023-01-01', to: '2023-01-31' });
    expect(byLabel(r, 'Net Income')?.cells.amount).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// H6 filters + malformed input
// ---------------------------------------------------------------------------

describe('Report parameter validation (malformed input)', () => {
  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(parseReportParams({ to: '2026-02-30' }).success).toBe(false);
    expect(parseReportParams({ asOf: '2026-04-31' }).success).toBe(false);
    expect(parseReportParams({ from: '2026-13-01' }).success).toBe(false);
  });

  it('rejects from > to, inverted negative amount ranges, bad ids and enum junk', async () => {
    await expect(run('profit-loss', { from: '2026-05-01', to: '2026-04-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(parseReportParams({ amountMin: '-5', amountMax: '-10' }).success).toBe(false);
    expect(parseReportParams({ amountMin: '1.999' }).success).toBe(false);
    await expect(run('transaction-detail-by-account', { accountId: 'not-a-uuid' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(run('transaction-detail-by-account', { sortBy: 'drop table' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(run('no-such-report')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run('__proto__')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run('constructor')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses absurd column counts instead of building thousands of columns', async () => {
    await expect(run('profit-loss', { from: '1900-01-01', to: '2026-01-01', columns: 'month' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('an account id from another company is not found (no cross-company leakage)', async () => {
    await expect(run('transaction-detail-by-account', { accountId: A.bank2 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('memo filter treats % and _ literally', async () => {
    const all = await run('transaction-detail-by-account', { memo: '%' });
    const hits = all.rows.filter((x) => x.kind === 'data');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((x) => String(x.cells.memo).includes('%'))).toBe(true);
    const under = await run('transaction-detail-by-account', { memo: 'int_rest' });
    expect(under.rows.filter((x) => x.kind === 'data')).toHaveLength(0);
  });

  it('amount range is inclusive at both ends and txnType narrows', async () => {
    const r = await run('transaction-detail-by-account', { amountMin: '40', amountMax: '50' });
    const amts = r.rows.filter((x) => x.kind === 'data').map((x) => num(x.cells.amount).abs().toFixed(2));
    expect(new Set(amts)).toEqual(new Set(['40.00', '50.00']));
    const bills = await run('transaction-detail-by-account', { txnType: 'bill' });
    expect(bills.rows.filter((x) => x.kind === 'data').every((x) => x.cells.type === 'Bill')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reports are read-only + idempotent
// ---------------------------------------------------------------------------

describe('running the whole catalog is side-effect free', () => {
  it('ledger, balances and entry count are unchanged, and a second run gives identical output', async () => {
    const snap = async () => {
      const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM journal_entries`)).rows as { n: number }[];
      const bal = (await db.execute(sql`SELECT id, balance FROM accounts ORDER BY id`)).rows;
      return JSON.stringify({ n, bal });
    };
    const before = await snap();
    const p = { from: '2025-07-01', to: '2026-03-31', asOf: '2026-03-31' };
    const first: Record<string, string> = {};
    for (const e of REPORT_CATALOG) {
      try {
        first[e.key] = JSON.stringify((await run(e.key, p)).rows);
      } catch (err) {
        first[e.key] = `ERR ${(err as { code?: string }).code}`;
      }
    }
    expect(await snap()).toBe(before);
    const errs = Object.entries(first).filter(([, v]) => v.startsWith('ERR') && !v.includes('VALIDATION'));
    expect(errs).toEqual([]);
    for (const e of REPORT_CATALOG.slice(0, 15)) {
      let again: string;
      try {
        again = JSON.stringify((await run(e.key, p)).rows);
      } catch (err) {
        again = `ERR ${(err as { code?: string }).code}`;
      }
      expect(again).toBe(first[e.key]);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// H14 pivot invariant
// ---------------------------------------------------------------------------

describe('pivot (H14)', () => {
  it('ledger debits equal credits in every month column', async () => {
    const dr = await pivotReport(ctx, { rows: 'account', cols: 'month', measure: 'debit', source: 'gl', from: '2025-07-01', to: '2026-03-31' });
    const cr = await pivotReport(ctx, { rows: 'account', cols: 'month', measure: 'credit', source: 'gl', from: '2025-07-01', to: '2026-03-31' });
    const tDr = dr.rows.find((x) => x.id === 'pv:total')!;
    const tCr = cr.rows.find((x) => x.id === 'pv:total')!;
    expect(tDr.cells.total).toBe(tCr.cells.total);
    for (const c of dr.columns.slice(1)) expect(tDr.cells[c.key]).toBe(tCr.cells[c.key]);
  });

  it('rejects dimensions that do not exist on the source', async () => {
    await expect(pivotReport(ctx, { rows: 'item', measure: 'amount', source: 'gl' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(pivotReport(ctx, { rows: 'account', measure: 'quantity', source: 'gl' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
// H4 / H5 memorized reports, groups, schedules
// ---------------------------------------------------------------------------

describe('memorized reports: tenant isolation and bad configs', () => {
  it('another company cannot run, rename, regroup or schedule this company\'s reports', async () => {
    const g = await createMemorizedGroup(ctx, { name: 'QA Group' });
    const m = await saveMemorizedReport(ctx, { name: 'QA P&L', reportType: 'profit-loss', config: { params: { from: '2025-07-01', to: '2026-03-31' } }, groupId: g.id });
    await expect(runMemorizedReport(ctx2, m.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateMemorizedReport(ctx2, m.id, { name: 'hijack' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(saveMemorizedReport(ctx2, { name: 'x', reportType: 'profit-loss', config: {}, groupId: g.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createReportSchedule(ctx2, { name: 's', memorizedReportId: m.id, frequency: 'daily' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await processMultipleReports(ctx2, { ids: [m.id] })).toEqual([]);
    await expect(processMultipleReports(ctx2, { groupId: g.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const ok = await runMemorizedReport(ctx, m.id);
    expect(byLabel(ok, 'Net Income')?.cells.total).toBe('535.00');
  });

  it('rejects unknown / prototype report types on save', async () => {
    await expect(saveMemorizedReport(ctx, { name: 'x', reportType: 'toString', config: {} })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveMemorizedReport(ctx, { name: '   ', reportType: 'profit-loss', config: {} })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a memorized report with corrupt saved params fails with VALIDATION and does not abort a batch', async () => {
    const bad = await saveMemorizedReport(ctx, { name: 'Bad dates', reportType: 'profit-loss', config: { params: { from: '2026-05-01', to: '2026-01-01' } } });
    const good = await saveMemorizedReport(ctx, { name: 'Good TB', reportType: 'trial-balance', config: { params: { asOf: '2026-03-31' } } });
    await expect(runMemorizedReport(ctx, bad.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    const out = await processMultipleReports(ctx, { ids: [bad.id, good.id] });
    expect(out.find((x) => x.id === bad.id)?.error).toBeTruthy();
    expect(out.find((x) => x.id === good.id)?.report?.balanced).toBe(true);
  });
});

describe('scheduled reports (H5)', () => {
  it('runDueSchedules is idempotent for the same instant and skips inactive schedules', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Sched TB', reportType: 'trial-balance', config: { params: { dates: 'this_month_to_date' } } });
    const s = await createReportSchedule(ctx, { name: 'Daily TB', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-03-01' });
    const off = await createReportSchedule(ctx, { name: 'Off', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-03-01' });
    await updateReportSchedule(ctx, off.id, { isActive: false });
    const now = new Date('2026-03-10T09:00:00.000Z');
    const first = await runDueSchedules(ctx, { now, outDir: OUT_DIR });
    expect(first.map((x) => x.scheduleId)).toContain(s.id);
    expect(first.map((x) => x.scheduleId)).not.toContain(off.id);
    expect(first.find((x) => x.scheduleId === s.id)?.status).toBe('ok');
    const second = await runDueSchedules(ctx, { now, outDir: OUT_DIR });
    expect(second.map((x) => x.scheduleId)).not.toContain(s.id);
    // Another company's timer never runs this company's schedules.
    expect((await runDueSchedules(ctx2, { now: new Date('2030-01-01T00:00:00Z'), outDir: OUT_DIR })).length).toBe(0);
  });

  it('folder and report names cannot escape the export folder', async () => {
    const m = await saveMemorizedReport(ctx, { name: '..\\..\\..\\evil', reportType: 'trial-balance', config: { params: { asOf: '2026-03-31' } } });
    await createReportSchedule(ctx, { name: '../../x', memorizedReportId: m.id, frequency: 'weekly', startDate: '2026-03-01', folder: '../../../escape' });
    await createReportSchedule(ctx, { name: 'dots', memorizedReportId: m.id, frequency: 'weekly', startDate: '2026-03-01', folder: '..', format: 'xlsx' });
    const res = await runDueSchedules(ctx, { now: new Date('2026-03-11T09:00:00.000Z'), outDir: OUT_DIR });
    const files = res.flatMap((x) => x.files);
    expect(files.length).toBeGreaterThanOrEqual(2);
    const root = path.resolve(OUT_DIR) + path.sep;
    for (const f of files) {
      expect(path.resolve(f).startsWith(root)).toBe(true);
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it('a monthly schedule started on the 31st runs on Feb 28 and then on Mar 31 (no drift to the 28th)', async () => {
    const m = await saveMemorizedReport(ctx, { name: 'Month-end TB', reportType: 'trial-balance', config: { params: { asOf: '2026-03-31' } } });
    const s = await createReportSchedule(ctx, { name: 'Month end', memorizedReportId: m.id, frequency: 'monthly', startDate: '2026-01-31' });
    const nextOf = async () => (await listReportSchedules(ctx)).find((x) => x.id === s.id)!.nextRunAt.toISOString().slice(0, 10);
    await runDueSchedules(ctx, { now: new Date('2026-01-31T10:00:00.000Z'), outDir: OUT_DIR });
    expect(await nextOf()).toBe('2026-02-28');
    await runDueSchedules(ctx, { now: new Date('2026-02-28T10:00:00.000Z'), outDir: OUT_DIR });
    // QB month-end schedules stay on the month end; the stateless helper re-anchors on the 28th.
    expect(await nextOf()).toBe('2026-03-31');
    // sanity: the helper itself clamps Jan 31 -> Feb 28
    expect(nextRunAfter(new Date('2026-01-31T06:00:00.000Z'), 'monthly').toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

// ---------------------------------------------------------------------------
// H16 number formats
// ---------------------------------------------------------------------------

describe('number formats (H16) rounding edge cases', () => {
  const F = DEFAULT_NUMBER_FORMAT;
  it('never shows a negative zero and rounds half away from zero', () => {
    expect(formatAmount('-0.004', F)).toEqual({ text: '0.00', negative: false });
    expect(formatAmount('-0.004', { ...F, negative: 'parens' }).text).toBe('0.00');
    expect(formatAmount('0.995', F).text).toBe('1.00');
    expect(formatAmount('-0.995', F).text).toBe('-1.00');
    expect(formatAmount('-999.5', { ...F, withoutCents: true }).text).toBe('-1,000');
    expect(formatAmount('-0.49', { ...F, withoutCents: true })).toEqual({ text: '0', negative: false });
    expect(roundDecimalString('9999999999999.995', 2)).toBe('10000000000000.00');
  });

  it('formats large and thousand-divided amounts exactly', () => {
    expect(formatAmount('12345678901234.56', F).text).toBe('12,345,678,901,234.56');
    expect(formatAmount('-1234567.89', { ...F, divideBy1000: true, negative: 'parens' }).text).toBe('(1,234.57)');
    expect(formatAmount('-1234.5', { ...F, negative: 'trailing', thousands: false }).text).toBe('1234.50-');
    expect(formatAmount('-0.4', { ...F, divideBy1000: true })).toEqual({ text: '0.00', negative: false });
  });

  it('passes junk through untouched and treats null / blank as empty', () => {
    expect(formatAmount('N/A', F).text).toBe('N/A');
    expect(formatAmount(null, F).text).toBe('');
    expect(formatAmount('', F).text).toBe('');
    expect(formatAmount('0', { ...F, hideZero: true }).text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Year-end close (run last: it locks FY2025)
// ---------------------------------------------------------------------------

describe('after a year-end close', () => {
  it('Retained Earnings is not double counted, the P&L still shows the closed year, BS balances', async () => {
    await yearEndClose(ctx, { fiscalYear: 2025 });
    const bs = await run('balance-sheet', { asOf: '2026-03-31' });
    expect(byLabel(bs, 'Retained Earnings')?.cells.total).toBe('700.00');
    expect(byLabel(bs, 'Net Income')?.cells.total).toBe('535.00');
    expect(num(byLabel(bs, 'TOTAL ASSETS')?.cells.total).toFixed(2)).toBe(num(byLabel(bs, 'TOTAL LIABILITIES & EQUITY')?.cells.total).toFixed(2));
    const pl = await run('profit-loss', { from: '2024-07-01', to: '2025-06-30' });
    expect(byLabel(pl, 'Net Income')?.cells.total).toBe('700.00');
    const ytd = await run('profit-loss-ytd', { from: '2025-06-01', to: '2025-06-30' });
    expect(byLabel(ytd, 'Net Income')?.cells.ytd).toBe('700.00');
    const tb = await run('trial-balance', { asOf: '2026-03-31' });
    expect(tb.balanced).toBe(true);
  });
});
