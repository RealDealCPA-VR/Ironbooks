/**
 * Report explanations (reportexplain): every amount on the standard reports drills down to
 * transactions that add up to EXACTLY that amount — on the report's own basis (accrual / cash),
 * dates (period columns, previous period / year, YTD, as-of), class / customer filters and row
 * membership (sub-accounts, "- Other", totals, Net Income, Retained Earnings, aging buckets).
 * Plus the one-line summary math, the route map and the report permission.
 *
 * One realistic company (default chart + sub-accounts) in a throwaway PGlite dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import { DRILLDOWN_REPORTS, SUMMARY_REPORTS, drilldownApiUrl, drilldownHref, drilldownListNotes, explainNote, reportOptions, safeBackHref } from '@/lib/reports/drilldown';
import { API_ROUTE_PERMISSIONS, apiRuleFor, pageAreasFor } from '@/lib/permissions/routes';
import { builtinRole, can, unionRoles } from '@/lib/permissions/model';
import { pageHelpFor } from '@/lib/pageHelp';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createItem } from './items';
import { createClass } from './dimensions';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { createSalesReceipt } from './salesReceipts';
import { createExpense } from './expenses';
import { postJournalEntry } from './posting';
import { REPORT_RUN_MEMO_TTL_MS, clearReportRunMemo, prepareStandardReport, recentReportRun, runStandardReport } from './reportRegistry';
import { basisScopeLabel, drilldownCell, explainText, treeMembers } from './reportDrilldown';
import { aiReplyKeepsNumbers, reportSummary, summaryText } from './reportSummary';
import { loadAccountMeta } from './reportEngine';
import { profitAndLossReport, balanceSheetReport } from './reportsStandard';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-report-drilldown');
let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'drill@test.local', name: 'Drill', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Drilldown Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) code[r.code] = r.id;
  // Sub-accounts under Rent (the parent also gets its own postings → "Rent - Other").
  code['6410'] = (await createAccount(ctx, { code: '6410', name: 'Office Rent', type: 'expense', subtype: 'operating_expenses', parentId: code['6400'] })).id;
  code['6420'] = (await createAccount(ctx, { code: '6420', name: 'Warehouse Rent', type: 'expense', subtype: 'operating_expenses', parentId: code['6400'] })).id;

  ids.east = (await createClass(ctx, { name: 'East' })).id;
  ids.acme = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
  ids.beta = (await createCustomer(ctx, { displayName: 'Beta LLC' })).id;
  ids.landlord = (await createVendor(ctx, { displayName: 'Landlord Inc' })).id;
  ids.supplier = (await createVendor(ctx, { displayName: 'Ad Supplier' })).id;
  ids.consult = (await createItem(ctx, { name: 'Consulting', type: 'service', incomeAccountId: code['4100'] } as never)).id;

  const bank = code['1000'];
  // ---- Prior fiscal year (2025) ----
  await postJournalEntry(ctx, { date: d('2025-01-02'), description: 'Owner investment', lines: [{ accountId: bank, debit: '20000' }, { accountId: code['3000'], credit: '20000' }] });
  const inv2025 = await createInvoice(ctx, { customerId: ids.acme, date: d('2025-11-15'), lines: [{ accountId: code['4000'], quantity: 1, rate: '1000.00', taxable: false }] } as never);
  await createExpense(ctx, { vendorId: ids.landlord, date: d('2025-12-01'), method: 'check', reference: '90', paymentAccountId: bank, lines: [{ accountId: code['6410'], amount: '700.00' }] } as never);
  await createExpense(ctx, { vendorId: ids.supplier, date: d('2025-03-03'), method: 'check', reference: '91', paymentAccountId: bank, lines: [{ accountId: code['6000'], amount: '150.00' }] } as never);
  // Paid in the new year (cash basis recognizes it in 2026).
  await receivePayment(ctx, { customerId: ids.acme, date: d('2026-01-10'), amount: '1000.00', method: 'check', depositAccountId: bank, applications: [{ invoiceId: inv2025.id, amountApplied: '1000.00' }] } as never);

  // ---- 2026 ----
  const invA = await createInvoice(ctx, {
    customerId: ids.acme,
    date: d('2026-01-20'),
    lines: [
      { itemId: ids.consult, quantity: 2, rate: '300.00', taxable: false, classId: ids.east },
      { accountId: code['4000'], quantity: 1, rate: '500.00', taxable: false },
    ],
  } as never);
  await receivePayment(ctx, { customerId: ids.acme, date: d('2026-02-05'), amount: '1100.00', method: 'check', depositAccountId: bank, applications: [{ invoiceId: invA.id, amountApplied: '1100.00' }] } as never);
  const invB = await createInvoice(ctx, { customerId: ids.beta, date: d('2026-02-10'), dueDate: d('2026-03-12'), lines: [{ itemId: ids.consult, quantity: 1, rate: '800.00', taxable: false }] } as never);
  await receivePayment(ctx, { customerId: ids.beta, date: d('2026-03-20'), amount: '300.00', method: 'check', depositAccountId: bank, applications: [{ invoiceId: invB.id, amountApplied: '300.00' }] } as never);
  await createInvoice(ctx, { customerId: ids.acme, date: d('2026-05-02'), dueDate: d('2026-05-17'), lines: [{ accountId: code['4000'], quantity: 1, rate: '250.00', taxable: false, classId: ids.east }] } as never);
  await createSalesReceipt(ctx, { customerId: ids.beta, date: d('2026-02-11'), depositAccountId: bank, lines: [{ itemId: ids.consult, quantity: 1, rate: '150.00', taxable: false }] } as never);

  const rentBill = await createBill(ctx, { vendorId: ids.landlord, date: d('2026-02-01'), lines: [{ accountId: code['6410'], amount: '1000.00' }, { accountId: code['6420'], amount: '500.00', classId: ids.east }] } as never);
  await payBills(ctx, { vendorId: ids.landlord, date: d('2026-02-15'), method: 'check', paymentAccountId: bank, applications: [{ billId: rentBill.id, amountApplied: '1500.00' }] } as never);
  await createBill(ctx, { vendorId: ids.supplier, date: d('2026-03-01'), dueDate: d('2026-03-31'), lines: [{ accountId: code['6000'], amount: '400.00' }] } as never);
  await createBill(ctx, { vendorId: ids.supplier, date: d('2026-05-20'), dueDate: d('2026-06-19'), lines: [{ accountId: code['6000'], amount: '90.00' }] } as never);
  await createExpense(ctx, { vendorId: ids.landlord, date: d('2026-03-05'), method: 'check', reference: '101', paymentAccountId: bank, lines: [{ accountId: code['6400'], amount: '200.00' }] } as never);
  await postJournalEntry(ctx, { date: d('2026-04-30'), description: 'Bank fees', lines: [{ accountId: code['6100'], debit: '25' }, { accountId: bank, credit: '25' }] });
}, 240_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the PGlite files briefly */
  }
});

const money = (v: unknown) => Money.of(String(v)).toFixed(2);

/** The value a cell shows (a collapsed heading shows its rolled-up amount). */
function cellOf(r: StdReport['rows'][number], col: string): string | null {
  const v = r.cells[col] ?? (r.kind === 'section' ? r.collapsedCells?.[col] : undefined);
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * Drill every money cell of a report and assert the transactions add up to the cell.
 * Returns how many cells were checked.
 */
async function assertEveryCellTies(key: string, params: Record<string, string>, onlyColumns?: string[]): Promise<number> {
  const report = await runStandardReport(ctx, key, params);
  let checked = 0;
  for (const row of report.rows) {
    for (const col of report.columns) {
      if (col.type !== 'money') continue;
      if (onlyColumns && !onlyColumns.includes(col.key)) continue;
      const cell = cellOf(row, col.key);
      if (cell === null) continue;
      const res = await drilldownCell(ctx, key, params, row.id, col.key, { brief: true });
      if (res.kind === 'formula') continue;
      expect(res.total, `${key} ${row.id} [${col.key}]`).toBe(money(cell));
      expect(res.ties, `${key} ${row.id} [${col.key}]`).toBe(true);
      if (!Money.of(cell).isZero()) expect(res.count, `${key} ${row.id} [${col.key}] count`).toBeGreaterThan(0);
      checked++;
    }
  }
  return checked;
}

const H1 = { from: '2026-01-01', to: '2026-06-30' };

describe('sum(drill-down) == cell, every cell, both bases', () => {
  it('Profit & Loss — accrual and cash', async () => {
    expect(await assertEveryCellTies('profit-loss', { ...H1, basis: 'accrual' })).toBeGreaterThan(10);
    expect(await assertEveryCellTies('profit-loss', { ...H1, basis: 'cash' })).toBeGreaterThan(10);
  }, 300_000);

  it('Profit & Loss — class filter, both bases', async () => {
    expect(await assertEveryCellTies('profit-loss', { ...H1, classId: ids.east, basis: 'accrual' })).toBeGreaterThan(3);
    expect(await assertEveryCellTies('profit-loss', { ...H1, classId: ids.east, basis: 'cash' })).toBeGreaterThan(3);
  }, 300_000);

  it('Profit & Loss — previous year / previous period comparisons ($ change too) and by quarter', async () => {
    expect(await assertEveryCellTies('profit-loss-prev-year', { from: '2026-01-01', to: '2026-12-31', basis: 'accrual' })).toBeGreaterThan(10);
    expect(await assertEveryCellTies('profit-loss', { from: '2026-02-01', to: '2026-02-28', compare: 'prev_period', basis: 'cash' })).toBeGreaterThan(5);
    expect(await assertEveryCellTies('profit-loss-by-month', { ...H1, columns: 'quarter', basis: 'accrual' })).toBeGreaterThan(10);
  }, 300_000);

  it('Profit & Loss by Class, by Job and YTD comparison', async () => {
    expect(await assertEveryCellTies('pl-by-class', { ...H1, basis: 'accrual' })).toBeGreaterThan(10);
    expect(await assertEveryCellTies('pl-by-class', { ...H1, basis: 'cash' })).toBeGreaterThan(10);
    expect(await assertEveryCellTies('profit-loss-by-job', { ...H1, basis: 'accrual' })).toBeGreaterThan(10);
    expect(await assertEveryCellTies('profit-loss-ytd', { from: '2026-03-01', to: '2026-03-31', basis: 'accrual' })).toBeGreaterThan(5);
  }, 300_000);

  it('Balance Sheet — accrual, cash, previous-year comparison and summary (Retained Earnings / Net Income included)', async () => {
    expect(await assertEveryCellTies('balance-sheet', { asOf: '2026-06-30', basis: 'accrual' })).toBeGreaterThan(10);
    expect(await assertEveryCellTies('balance-sheet', { asOf: '2026-06-30', basis: 'cash' })).toBeGreaterThan(10);
    expect(await assertEveryCellTies('balance-sheet-prev-year', { asOf: '2026-06-30', basis: 'accrual' })).toBeGreaterThan(10);
    expect(await assertEveryCellTies('balance-sheet-summary', { asOf: '2026-03-31', basis: 'cash' })).toBeGreaterThan(5);
  }, 300_000);

  it('Trial Balance — accrual and cash, including the TOTAL debit / credit', async () => {
    expect(await assertEveryCellTies('trial-balance', { asOf: '2026-06-30', basis: 'accrual' })).toBeGreaterThan(8);
    expect(await assertEveryCellTies('trial-balance', { asOf: '2026-06-30', basis: 'cash' })).toBeGreaterThan(8);
  }, 300_000);

  it('General Ledger — lines, totals and running balances (with beginning balances)', async () => {
    const n = await assertEveryCellTies('general-ledger', { ...H1, accountId: code['1000'], basis: 'accrual' });
    expect(n).toBeGreaterThan(10);
    expect(await assertEveryCellTies('general-ledger', { from: '2026-03-01', to: '2026-06-30', accountId: code['6400'], basis: 'cash' })).toBeGreaterThan(3);
  }, 300_000);

  it('A/R and A/P aging (summary and detail), Open Invoices', async () => {
    expect(await assertEveryCellTies('ar-aging-summary', { asOf: '2026-06-30' })).toBeGreaterThan(4);
    expect(await assertEveryCellTies('ar-aging-detail', { asOf: '2026-06-30' })).toBeGreaterThan(3);
    expect(await assertEveryCellTies('ap-aging-summary', { asOf: '2026-06-30' })).toBeGreaterThan(4);
    expect(await assertEveryCellTies('ap-aging-detail', { asOf: '2026-06-30' })).toBeGreaterThan(3);
    expect(await assertEveryCellTies('open-invoices', { asOf: '2026-06-30' })).toBeGreaterThan(3);
  }, 300_000);

  it('Sales by Customer / Item and Expenses by Vendor summaries — both bases', async () => {
    for (const basis of ['accrual', 'cash']) {
      expect(await assertEveryCellTies('sales-by-customer-summary', { ...H1, basis })).toBeGreaterThan(2);
      expect(await assertEveryCellTies('sales-by-item-summary', { ...H1, basis }, ['amount'])).toBeGreaterThan(2);
      expect(await assertEveryCellTies('expenses-by-vendor-summary', { ...H1, basis })).toBeGreaterThan(2);
    }
  }, 300_000);
});

describe('drill-down details', () => {
  it('Rent total = parent + sub-accounts; "- Other" = only the parent; explanation names the largest', async () => {
    const p = { ...H1, basis: 'accrual' };
    const report = await runStandardReport(ctx, 'profit-loss', p);
    const total = report.rows.find((r) => r.id === `pl:expense:a:${code['6400']}:total`)!;
    expect(total.cells.total).toBe('1700.00');
    const res = await drilldownCell(ctx, 'profit-loss', p, total.id, 'total');
    expect(res.total).toBe('1700.00');
    expect(res.count).toBe(2); // the bill (two rent lines) + the check to the parent
    expect(res.largest?.amount).toBe('1500.00');
    expect(res.largest?.name).toBe('Landlord Inc');
    expect(res.explanation).toBe('Made of 2 transactions, largest $1,500.00 (Landlord Inc, 02/01/2026).');
    const other = await drilldownCell(ctx, 'profit-loss', p, `pl:expense:a:${code['6400']}:other`, 'total');
    expect(other.total).toBe('200.00');
    expect(other.explanation).toBe('Made of 1 transaction: $200.00 (Landlord Inc, 03/05/2026).');
    expect(other.transactions[0].entryId).toBeTruthy();
    // A collapsed parent heading explains its rolled-up amount.
    const heading = await drilldownCell(ctx, 'profit-loss', p, `pl:expense:a:${code['6400']}`, 'total');
    expect(heading.total).toBe('1700.00');
  }, 120_000);

  it('cash basis moves income to the payment date (prior-year invoice paid in January counts in 2026)', async () => {
    const acc = await drilldownCell(ctx, 'profit-loss', { from: '2026-01-01', to: '2026-01-31', basis: 'accrual' }, `pl:income:a:${code['4000']}`, 'total');
    const cash = await drilldownCell(ctx, 'profit-loss', { from: '2026-01-01', to: '2026-01-31', basis: 'cash' }, `pl:income:a:${code['4000']}`, 'total');
    expect(acc.total).toBe('500.00'); // January invoice line
    expect(cash.total).toBe('1000.00'); // the 2025 invoice paid on 01/10; January's invoice was paid in February
    expect(cash.transactions.map((t) => t.date)).toEqual(['2026-01-10']);
    expect(cash.basis).toBe('cash');
  }, 120_000);

  it('Retained Earnings and Net Income lines are the prior-year and current-year income', async () => {
    const p = { asOf: '2026-06-30', basis: 'accrual' };
    const ni = await drilldownCell(ctx, 'balance-sheet', p, 'bs:ni', 'total');
    const pl = await profitAndLossReport(ctx, { from: '2026-01-01', to: '2026-06-30' });
    expect(ni.total).toBe(pl.rows.find((r) => r.id === 'pl:net')!.cells.total);
    const reRow = (await runStandardReport(ctx, 'balance-sheet', p)).rows.find((r) => r.id === `bs:equity:a:${code['3900']}`)!;
    const re = await drilldownCell(ctx, 'balance-sheet', p, reRow.id, 'total');
    expect(re.total).toBe('150.00'); // 2025: 1,000 income − 700 rent − 150 advertising
    expect(re.transactions.every((t) => t.date < '2026-01-01')).toBe(true);
  }, 120_000);

  it('calculated cells explain their formula and list the base transactions', async () => {
    const p = { ...H1, basis: 'accrual' };
    const pct = await drilldownCell(ctx, 'profit-loss-percent', p, `pl:income:a:${code['4100']}`, 'total_pct');
    expect(pct.kind).toBe('formula');
    expect(pct.formula).toMatch(/Total Income/);
    expect(pct.total).toBe('1550.00');
    expect(pct.ties).toBe(true); // ties to the base amount column
    const item = (await runStandardReport(ctx, 'sales-by-item-summary', p)).rows.find((r) => r.id.endsWith(`:${ids.consult}`))!;
    const avg = await drilldownCell(ctx, 'sales-by-item-summary', p, item.id, 'avgPrice');
    expect(avg.kind).toBe('formula');
    expect(avg.total).toBe('1550.00');
  }, 120_000);

  it('aging rows reproduce the open balances by bucket and name', async () => {
    const p = { asOf: '2026-06-30' };
    const rep = await runStandardReport(ctx, 'ap-aging-summary', p);
    const sup = rep.rows.find((r) => r.id === `ag:${ids.supplier}`)!;
    expect(sup.cells.total).toBe('490.00');
    const res = await drilldownCell(ctx, 'ap-aging-summary', p, sup.id, 'total');
    expect(res.count).toBe(2);
    expect(res.total).toBe('490.00');
    expect(res.transactions.map((t) => t.sourceRef?.split(':')[0])).toEqual(['bill', 'bill']);
    const over = await drilldownCell(ctx, 'ap-aging-summary', p, sup.id, 'over');
    expect(over.total).toBe('400.00'); // due 03/31 → 91 days past due on 06/30: the "> 90" column
  }, 120_000);

  it('brief mode returns count and largest without the list; limit caps the list but not the count', async () => {
    const p = { ...H1, basis: 'accrual' };
    const brief = await drilldownCell(ctx, 'profit-loss', p, 'pl:net', 'total', { brief: true });
    expect(brief.transactions).toEqual([]);
    expect(brief.count).toBeGreaterThan(5);
    expect(brief.largest).not.toBeNull();
    const capped = await drilldownCell(ctx, 'profit-loss', p, 'pl:net', 'total', { limit: 2 });
    expect(capped.transactions).toHaveLength(2);
    expect(capped.listTruncated).toBe(true);
    expect(capped.incomplete).toBe(false);
    expect(capped.ties).toBe(true);
    expect(capped.count).toBe(brief.count);
    // A list cut by the page's limit: the total still covers everything.
    const notes = drilldownListNotes(capped);
    expect(notes.incomplete).toBeUndefined();
    expect(notes.listed).toBe('Only the first 2 transactions are listed; the total and count cover all of them. Narrow the report dates to see fewer.');
    expect(explainNote(capped)).toBeUndefined();
  }, 120_000);

  it('a ledger read that hits its line cap is reported as incomplete (not as a short list), and never as tying', async () => {
    const p = { ...H1, basis: 'accrual' };
    const res = await drilldownCell(ctx, 'profit-loss', p, 'pl:net', 'total', { lineCap: 2 });
    expect(res.incomplete).toBe(true);
    expect(res.listTruncated).toBe(false); // the list is not what was cut
    expect(res.ties).toBe(false);
    expect(res.explanation).toBe('Too many transactions to add up here; narrow the report dates to see them.');
    const notes = drilldownListNotes(res);
    expect(notes.listed).toBeUndefined(); // never "the total covers all of them"
    expect(notes.incomplete).toMatch(/Too many transactions to add up: the total and count above cover only part of them/);
    // The tooltip says to narrow the dates, not that the books changed.
    expect(explainNote(res)).toBe('Too many transactions to add up; narrow the report dates.');
    // Balance sheet / trial balance / expenses-by-vendor reads report it too.
    expect((await drilldownCell(ctx, 'balance-sheet', { asOf: '2026-06-30', basis: 'accrual' }, 'bs:assets:total', 'total', { lineCap: 2 })).incomplete).toBe(true);
    expect((await drilldownCell(ctx, 'trial-balance', { asOf: '2026-06-30' }, 'tb:total', 'debit', { lineCap: 2 })).incomplete).toBe(true);
    expect((await drilldownCell(ctx, 'expenses-by-vendor-summary', p, 'ebv:grand', 'amount', { lineCap: 2 })).incomplete).toBe(true);
    // Uncapped, the same cell is complete and ties.
    const full = await drilldownCell(ctx, 'profit-loss', p, 'pl:net', 'total');
    expect(full.incomplete).toBe(false);
    expect(full.ties).toBe(true);
  }, 120_000);

  it('the scope line names the basis from the basis itself, not from the subtitle', async () => {
    expect(basisScopeLabel('cash', 'January 1 - June 30, 2026')).toBe('Cash basis'); // a subtitle without "Cash"
    expect(basisScopeLabel('cash', 'January 1 - June 30, 2026 · Cash Basis')).toBe('');
    expect(basisScopeLabel('accrual', 'January 1 - June 30, 2026')).toBe('Accrual basis');
    expect(basisScopeLabel('accrual', 'Accrual Basis')).toBe('');
    expect(basisScopeLabel(undefined, 'January 2026')).toBe('');
    const cash = await drilldownCell(ctx, 'profit-loss', { ...H1, basis: 'cash' }, 'pl:net', 'total');
    expect(cash.scope).toMatch(/cash basis/i);
    expect(cash.scope).not.toMatch(/accrual/i);
    const acc = await drilldownCell(ctx, 'profit-loss', { ...H1, basis: 'accrual' }, 'pl:net', 'total');
    expect(acc.scope).toMatch(/Accrual basis/);
    expect(acc.scope).not.toMatch(/cash/i);
  }, 120_000);

  it('rejects unknown reports, reports without explanations, unknown lines and text columns', async () => {
    const p = { ...H1 };
    await expect(drilldownCell(ctx, 'no-such-report', p, 'x', 'total')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(drilldownCell(ctx, 'customer-contact-list', p, 'x', 'total')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(drilldownCell(ctx, 'profit-loss', p, 'pl:nope', 'total')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(drilldownCell(ctx, 'profit-loss', p, 'pl:net', 'label')).rejects.toMatchObject({ code: 'VALIDATION' });
  }, 120_000);

  it('explainText and treeMembers', async () => {
    expect(explainText(0, null)).toMatch(/No transactions/);
    const meta = await loadAccountMeta(ctx);
    expect([...treeMembers(meta, code['6400'])].sort()).toEqual([code['6400'], code['6410'], code['6420']].sort());
    expect([...treeMembers(meta, code['6410'])]).toEqual([code['6410']]);
  }, 60_000);
});

describe('permission and route mapping', () => {
  it('needs the report’s own area: an A/R clerk can explain A/R aging but not the P&L', async () => {
    const clerk = unionRoles([builtinRole('ar_clerk')!]);
    expect(can(clerk, 'reports_sales', 'view')).toBe(true);
    expect(can(clerk, 'reports_financial', 'view')).toBe(false);
    const limited: ServiceContext = { ...ctx, access: clerk };
    await expect(drilldownCell(limited, 'profit-loss', H1, 'pl:net', 'total')).rejects.toBeInstanceOf(ServiceError);
    await expect(drilldownCell(limited, 'profit-loss', H1, 'pl:net', 'total')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reportSummary(limited, 'profit-loss', H1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ok = await drilldownCell(limited, 'ar-aging-summary', { asOf: '2026-06-30' }, 'ag:grand', 'total');
    expect(ok.ties).toBe(true);
  }, 120_000);

  it('routes are in the fail-closed permission map; the page is limited to report users and has help', () => {
    expect(API_ROUTE_PERMISSIONS['/api/reports/drilldown/[report]']).toEqual({ GET: 'member' });
    expect(API_ROUTE_PERMISSIONS['/api/reports/summary/[report]']).toEqual({ GET: 'member' });
    expect(apiRuleFor('/api/reports/drilldown/profit-loss', 'GET')).toBe('member');
    expect(apiRuleFor('/api/reports/summary/balance-sheet', 'GET')).toBe('member');
    expect(apiRuleFor('/api/reports/drilldown/profit-loss', 'POST')).toBeNull();
    expect(pageAreasFor('/reports/drilldown')).toContain('reports_financial');
    expect(pageAreasFor('/reports/drilldown')).toContain('reports_sales');
    expect(pageHelpFor('/reports/drilldown')?.what.length).toBeGreaterThan(20);
  });

  it('URL helpers keep the report options and only safe back links', () => {
    const href = drilldownHref('profit-loss', { from: '2026-01-01', basis: 'cash', junk: 'x' } as Record<string, string>, 'pl:net', 'total', '/reports/profit-loss?from=2026-01-01');
    const q = new URL(href, 'http://x').searchParams;
    expect(q.get('report')).toBe('profit-loss');
    expect(q.get('row')).toBe('pl:net');
    expect(q.get('basis')).toBe('cash');
    expect(q.get('junk')).toBeNull();
    expect(reportOptions(Object.fromEntries(q.entries()))).toEqual({ from: '2026-01-01', basis: 'cash' });
    expect(drilldownApiUrl('profit-loss', { to: '2026-02-01' }, 'pl:net', 'total', true)).toBe('/api/reports/drilldown/profit-loss?to=2026-02-01&row=pl%3Anet&col=total&brief=1');
    expect(safeBackHref('//evil.example')).toBeNull();
    expect(safeBackHref('https://evil.example')).toBeNull();
    expect(safeBackHref('/reports/std/profit-loss?x=1')).toBe('/reports/std/profit-loss?x=1');
    for (const k of SUMMARY_REPORTS) expect(DRILLDOWN_REPORTS).toContain(k);
  });
});

describe('one-line summary (deterministic, AI off)', () => {
  it('net income change % vs previous period and last year, top 3 movers with amounts', async () => {
    const p = { from: '2026-02-01', to: '2026-02-28', basis: 'accrual' };
    const s = await reportSummary(ctx, 'profit-loss', p);
    const cur = await profitAndLossReport(ctx, { from: '2026-02-01', to: '2026-02-28' });
    const jan = await profitAndLossReport(ctx, { from: '2026-01-01', to: '2026-01-31' });
    const ly = await profitAndLossReport(ctx, { from: '2025-02-01', to: '2025-02-28' });
    const net = (r: StdReport) => Money.of(String(r.rows.find((x) => x.id === 'pl:net')!.cells.total));
    expect(s.facts.current.value).toBe(net(cur).toFixed(2));
    expect(s.facts.priorPeriod.value).toBe(net(jan).toFixed(2));
    expect(s.facts.priorPeriod.change).toBe(net(cur).minus(net(jan)).toFixed(2));
    expect(s.facts.priorPeriod.changePct).toBe(net(cur).minus(net(jan)).dividedBy(net(jan).abs()).times(100).toFixed(2));
    expect(s.facts.priorYear.value).toBe(net(ly).toFixed(2));
    // Feb 2026 vs Jan 2026 (accrual): Service Income +200 (800 + 150 − 600×… ), rent sub-accounts +1,500 …
    expect(s.facts.movers).toHaveLength(3);
    const sizes = s.facts.movers.map((m) => Money.of(m.change).abs());
    expect(sizes[0].greaterThanOrEqualTo(sizes[1]) && sizes[1].greaterThanOrEqualTo(sizes[2])).toBe(true);
    expect(s.facts.movers[0].label).toBe('Office Rent');
    expect(s.facts.movers[0].change).toBe('1000.00');
    for (const m of s.facts.movers) expect(Money.of(m.current).minus(m.prior).toFixed(2)).toBe(m.change);
    expect(s.text).toBe(summaryText(s.facts));
    expect(s.text).toMatch(/^Net income is /);
    expect(s.text).toContain('Office Rent +$1,000.00');
    expect(s.aiAvailable).toBe(false);
    expect(s.ai).toBeUndefined();
  }, 120_000);

  it('vs last year uses the same period a year earlier for movers; works with AI requested but none configured', async () => {
    const p = { from: '2026-01-01', to: '2026-06-30', basis: 'cash' };
    const s = await reportSummary(ctx, 'profit-loss', p, { vs: 'prior_year', ai: true });
    expect(s.facts.vs).toBe('prior_year');
    expect(s.text).toContain('Biggest changes vs the same period last year');
    expect(s.ai).toBeUndefined();
    expect(s.aiNotice).toBeTruthy();
    expect(s.facts.basis).toBe('cash');
  }, 120_000);

  it('balance sheet summary compares equity a month and a year earlier', async () => {
    const s = await reportSummary(ctx, 'balance-sheet', { asOf: '2026-06-30', basis: 'accrual' });
    const now = await balanceSheetReport(ctx, { asOf: '2026-06-30' });
    expect(s.facts.current.value).toBe(String(now.rows.find((r) => r.id === 'bs:equity:total')!.cells.total));
    expect(s.facts.current.range).toBe('as of 06/30/2026');
    expect(s.facts.priorPeriod.range).toBe('as of 05/31/2026');
    expect(s.text).toMatch(/^Equity is /);
  }, 120_000);

  it('the AI may not change numbers', () => {
    const facts = 'Net income is $1,200.00 for 02/01/2026 – 02/28/2026, up 20.0% (+$200.00) from the previous period ($1,000.00).';
    expect(aiReplyKeepsNumbers('Net income rose 20.0% to $1,200.00 in February 2026.', facts)).toBe(true);
    expect(aiReplyKeepsNumbers('Net income rose 25% to $1,200.00.', facts)).toBe(false);
    expect(aiReplyKeepsNumbers('Profit jumped to $1,300.00.', facts)).toBe(false);
  });

  it('summary is refused for reports without one', async () => {
    await expect(reportSummary(ctx, 'trial-balance', { asOf: '2026-06-30' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('tooltips reuse the report run the page made (no full re-run per hover)', () => {
  it('brief explanations use the remembered run; the drill-down page and every report run refresh it', async () => {
    clearReportRunMemo();
    // 2027: after every other test's dates, so their expected amounts are untouched.
    const p = { from: '2027-01-01', to: '2027-01-31', basis: 'accrual' };
    const fee = (amt: string) =>
      postJournalEntry(ctx, { date: d('2027-01-15'), description: 'Bank fee', lines: [{ accountId: code['6100'], debit: amt }, { accountId: code['1000'], credit: amt }] });
    const rowId = `pl:expense:a:${code['6100']}`;
    await fee('10');
    const page = await runStandardReport(ctx, 'profit-loss', p); // the report page's run
    expect(page.rows.find((r) => r.id === rowId)?.cells.total).toBe('10.00');
    const { params } = await prepareStandardReport(ctx, 'profit-loss', p);
    expect(recentReportRun(ctx, 'profit-loss', params)?.report).toBe(page);

    await fee('5'); // the books change after the page ran
    const tip = await drilldownCell(ctx, 'profit-loss', p, rowId, 'total', { brief: true });
    expect(tip.cell).toBe('10.00'); // the remembered run: the report was NOT run again
    expect(tip.total).toBe('15.00'); // the transactions are read fresh
    expect(tip.ties).toBe(false);
    expect(explainNote(tip)).toMatch(/The books changed since the report ran/);
    // Hovering the next cell reuses the same run and its account metadata.
    const meta = recentReportRun(ctx, 'profit-loss', params)!.meta;
    expect(meta).toBeDefined();
    await drilldownCell(ctx, 'profit-loss', p, 'pl:net', 'total', { brief: true });
    expect(recentReportRun(ctx, 'profit-loss', params)!.report).toBe(page);
    expect(recentReportRun(ctx, 'profit-loss', params)!.meta).toBe(meta);

    // The drill-down page always runs fresh, and refreshes what tooltips use.
    const full = await drilldownCell(ctx, 'profit-loss', p, rowId, 'total');
    expect(full.cell).toBe('15.00');
    expect(full.ties).toBe(true);
    const tip2 = await drilldownCell(ctx, 'profit-loss', p, rowId, 'total', { brief: true });
    expect(tip2.cell).toBe('15.00');
    expect(tip2.ties).toBe(true);

    // Re-running the report (the page's Run / refresh) replaces the remembered run as well.
    await fee('1');
    const rerun = await runStandardReport(ctx, 'profit-loss', p);
    const tip3 = await drilldownCell(ctx, 'profit-loss', p, rowId, 'total', { brief: true });
    expect(recentReportRun(ctx, 'profit-loss', params)!.report).toBe(rerun);
    expect(tip3.cell).toBe('16.00');
    expect(tip3.ties).toBe(true);

    // Scoped to the company, the user, the report and its options; and short-lived.
    expect(recentReportRun({ ...ctx, userId: 'someone-else' }, 'profit-loss', params)).toBeNull();
    expect(recentReportRun({ ...ctx, companyId: 'another-company' }, 'profit-loss', params)).toBeNull();
    expect(recentReportRun(ctx, 'profit-loss', { ...params, basis: 'cash' })).toBeNull();
    expect(recentReportRun(ctx, 'profit-loss-percent', params)).toBeNull();
    expect(recentReportRun(ctx, 'profit-loss', params, Date.now() + REPORT_RUN_MEMO_TTL_MS + 1000)).toBeNull();
    // Expired: the next tooltip runs the report again.
    expect(recentReportRun(ctx, 'profit-loss', params)).toBeNull();
    const tip4 = await drilldownCell(ctx, 'profit-loss', p, rowId, 'total', { brief: true });
    expect(tip4.cell).toBe('16.00');
    expect(recentReportRun(ctx, 'profit-loss', params)!.report).not.toBe(rerun);
    clearReportRunMemo();
  }, 120_000);
});
