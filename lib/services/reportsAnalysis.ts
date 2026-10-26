/**
 * Analysis tools on the report engine:
 *  - Advanced Find (QB Edit → Find → Advanced): transactions matching type, name, amount range,
 *    number, account, date, memo, class and cleared filters — one row per transaction.
 *  - Advanced Reporting-lite: a pivot of ledger lines (or item sales lines) by any two
 *    dimensions with a measure.
 *  - QB graphs: Income & Expense, Net Worth, Sales, A/R, A/P, Budget vs. Actual series.
 */
import type Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { budgets, classes, employees, items, jobs, mileageLogs, vehicles, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import { PIVOT_DIMENSIONS, PIVOT_MEASURES } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { validation } from './_base';
import { requireAnyReportAccess } from './reportsAccess';
import { balanceSheet } from './reports';
import { apAging, arAging } from './reportsExtra';
import { budgetVsActualReport } from './budgets';
import { salesLines } from './reportsLists';
import { rangeLabel } from './reportsStandard';
import {
  PL_SECTIONS,
  SECTION_LABELS,
  activityByAccount,
  customerNames,
  dayStr,
  endOfToday,
  fetchGlLines,
  fmtDay,
  glFilterFromParams,
  isPLSection,
  loadAccountMeta,
  naturalAmount,
  parseDay,
  resolveRange,
  splitPeriods,
  stdHref,
  type GlLine,
  type SectionKey,
} from './reportEngine';

// ===========================================================================
// Advanced Find
// ===========================================================================

/** One row per matching transaction; the amount filter applies to the transaction total. */
export async function findTransactions(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const meta = await loadAccountMeta(ctx);
  const range: { from?: Date; to?: Date } = { from: parseDay(p.from), to: parseDay(p.to, true) };
  const f = glFilterFromParams(meta, { ...p, amountMin: undefined, amountMax: undefined }, range);
  // Newest first: a capped read keeps the most recent lines (it kept the OLDEST, so on a large
  // file Find never reached this year's transactions while saying it showed the most recent).
  const { lines: hits, truncated: scanCut } = await fetchGlLines(ctx, meta, { ...f, limit: 20000, newestFirst: true });
  const entryIds = [...new Set(hits.map((l) => l.entryId))];
  const { lines, truncated: entriesCut } = await fetchGlLines(ctx, meta, { entryIds, limit: 50000 });
  const byEntry = new Map<string, GlLine[]>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  const min = p.amountMin ? Money.of(p.amountMin) : null;
  const max = p.amountMax ? Money.of(p.amountMax) : null;
  const rows: StdRow[] = [];
  const entries = [...byEntry.values()].sort((a, b) => b[0].date.getTime() - a[0].date.getTime() || b[0].entryNumber - a[0].entryNumber);
  let total = Money.zero();
  let matches = 0;
  for (const e of entries) {
    const amount = e.reduce((s, l) => s.plus(l.debit), Money.zero());
    if (min && amount.lessThan(min)) continue;
    if (max && amount.greaterThan(max)) continue;
    matches++;
    if (rows.length >= MAX_FIND_ROWS) continue;
    const main = e.find((l) => ['ar', 'ap', 'bank', 'credit_card'].includes(l.account.section)) ?? e[0];
    const memo = e.find((l) => p.memo && l.memo.toLowerCase().includes(p.memo.toLowerCase()))?.memo ?? main.memo;
    total = total.plus(amount);
    rows.push({
      id: `find:${main.entryId}`,
      depth: 0,
      kind: 'data',
      cells: {
        label: main.type,
        date: dayStr(main.date),
        num: main.num,
        name: main.name,
        memo,
        account: main.account.fullName,
        amount: toAmountString(amount),
      },
      entryId: main.entryId,
    });
  }
  const shown = rows.length;
  rows.push({ id: 'find:total', depth: 0, kind: 'grand', cells: { label: `${shown} transaction${shown === 1 ? '' : 's'}`, amount: toAmountString(total) } });
  const notes: string[] = [];
  if (matches > MAX_FIND_ROWS) notes.push(`Showing the ${MAX_FIND_ROWS.toLocaleString('en-US')} most recent of ${matches.toLocaleString('en-US')} matches — add filters to narrow the search.`);
  if (scanCut || entriesCut) notes.push('Only the most recent transactions were searched — add dates or filters to search everything.');
  return {
    key: 'find',
    title: 'Find Transactions',
    subtitle: range.from && range.to ? rangeLabel(range.from, range.to) : 'All dates',
    columns: [
      { key: 'label', header: 'Type' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Num' },
      { key: 'name', header: 'Name' },
      { key: 'memo', header: 'Memo' },
      { key: 'account', header: 'Account' },
      { key: 'amount', header: 'Amount', type: 'money' },
    ],
    rows,
    truncated: scanCut || entriesCut || matches > MAX_FIND_ROWS,
    notes,
  };
}

/** Most transactions Find lists (the most recent ones). */
const MAX_FIND_ROWS = 2000;

// ===========================================================================
// Pivot (Advanced Reporting-lite)
// ===========================================================================

export type PivotDimension = (typeof PIVOT_DIMENSIONS)[number];
export type PivotMeasure = (typeof PIVOT_MEASURES)[number];

export interface PivotInput {
  rows: PivotDimension;
  cols?: PivotDimension;
  measure: PivotMeasure;
  source: 'gl' | 'sales';
  from?: string;
  to?: string;
  section?: string;
}

export const PIVOT_DIMENSION_LABELS: Record<PivotDimension, string> = {
  account: 'Account',
  accountType: 'Account type',
  class: 'Class',
  customer: 'Customer',
  vendor: 'Vendor',
  name: 'Name',
  item: 'Item',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
  txnType: 'Transaction type',
};

const GL_DIMS: PivotDimension[] = ['account', 'accountType', 'class', 'customer', 'vendor', 'name', 'month', 'quarter', 'year', 'txnType'];
const SALES_DIMS: PivotDimension[] = ['customer', 'item', 'month', 'quarter', 'year'];

interface Fact {
  dims: Partial<Record<PivotDimension, { key: string; label: string; sort: string }>>;
  amount: Decimal;
  debit: Decimal;
  credit: Decimal;
  quantity: Decimal;
}

const monthDim = (d: Date) => {
  const k = dayStr(d).slice(0, 7);
  return { key: k, label: k, sort: k };
};
const quarterDim = (d: Date) => {
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  const k = `${d.getUTCFullYear()}-Q${q}`;
  return { key: k, label: `Q${q} ${d.getUTCFullYear()}`, sort: k };
};
const yearDim = (d: Date) => ({ key: String(d.getUTCFullYear()), label: String(d.getUTCFullYear()), sort: String(d.getUTCFullYear()) });

export async function pivotReport(ctx: ServiceContext, input: PivotInput): Promise<StdReport> {
  const allowed = input.source === 'gl' ? GL_DIMS : SALES_DIMS;
  for (const d of [input.rows, input.cols].filter(Boolean) as PivotDimension[]) {
    if (!allowed.includes(d)) {
      throw validation(
        input.source === 'gl'
          ? `"${PIVOT_DIMENSION_LABELS[d]}" is not recorded on ledger lines — switch the data source to Item sales.`
          : `"${PIVOT_DIMENSION_LABELS[d]}" is not available for item sales — switch the data source to Ledger.`,
      );
    }
  }
  if (input.source === 'sales' && (input.measure === 'debit' || input.measure === 'credit')) {
    throw validation('Debit / credit measures are only available for ledger data.');
  }
  if (input.source === 'gl' && input.measure === 'quantity') {
    throw validation('Quantity is only available for item sales.');
  }
  const { from, to } = await resolveRange(ctx, { from: input.from, to: input.to });
  const facts: Fact[] = [];
  let truncated = false;
  if (input.source === 'gl') {
    const meta = await loadAccountMeta(ctx);
    const sections = input.section
      ? (input.section.split(',').filter((s) => s in SECTION_LABELS) as SectionKey[])
      : undefined;
    const plOnly = sections?.length && sections.every(isPLSection);
    const got = await fetchGlLines(ctx, meta, { from, to, sections, excludeClose: !!plOnly, limit: 50000 });
    // A read cut at its cap leaves lines out: the totals must say so (they were silently short).
    truncated = got.truncated;
    const lines = got.lines;
    for (const l of lines) {
      facts.push({
        dims: {
          account: { key: l.accountId, label: l.account.fullName, sort: `${l.account.code}` },
          accountType: { key: l.account.section, label: SECTION_LABELS[l.account.section], sort: l.account.section },
          class: { key: l.classId ?? '', label: l.className || 'Unclassified', sort: l.className || '~' },
          customer: l.nameType === 'customer' ? { key: l.nameId!, label: l.name, sort: l.name } : { key: '', label: '(no customer)', sort: '~' },
          vendor: l.nameType === 'vendor' ? { key: l.nameId!, label: l.name, sort: l.name } : { key: '', label: '(no vendor)', sort: '~' },
          name: { key: l.nameId ?? '', label: l.name || '(no name)', sort: l.name || '~' },
          month: monthDim(l.date),
          quarter: quarterDim(l.date),
          year: yearDim(l.date),
          txnType: { key: l.txnType, label: l.type, sort: l.type },
        },
        amount: l.natural,
        debit: l.debit,
        credit: l.credit,
        quantity: Money.zero(),
      });
    }
  } else {
    const names = await customerNames(ctx);
    for (const l of await salesLines(ctx, { from, to })) {
      const cname = l.customerId ? (names.get(l.customerId)?.name ?? '') : '(no customer)';
      facts.push({
        dims: {
          customer: { key: l.customerId ?? '', label: cname, sort: cname },
          item: { key: l.itemId ?? '', label: l.item || '(no item)', sort: l.item || '~' },
          month: monthDim(l.date),
          quarter: quarterDim(l.date),
          year: yearDim(l.date),
        },
        amount: l.amount,
        debit: Money.zero(),
        credit: Money.zero(),
        quantity: l.qty,
      });
    }
  }
  const measureOf = (f: Fact): Decimal =>
    input.measure === 'count' ? Money.of(1) : input.measure === 'debit' ? f.debit : input.measure === 'credit' ? f.credit : input.measure === 'quantity' ? f.quantity : f.amount;

  const rowVals = new Map<string, { label: string; sort: string }>();
  const colVals = new Map<string, { label: string; sort: string }>();
  const cellsMap = new Map<string, Decimal>();
  for (const f of facts) {
    const r = f.dims[input.rows]!;
    const c = input.cols ? f.dims[input.cols]! : { key: 'total', label: 'Total', sort: '' };
    rowVals.set(r.key, r);
    colVals.set(c.key, c);
    const k = `${r.key}\u0000${c.key}`;
    cellsMap.set(k, (cellsMap.get(k) ?? Money.zero()).plus(measureOf(f)));
  }
  const sortVals = (m: Map<string, { label: string; sort: string }>) =>
    [...m.entries()].sort((a, b) => a[1].sort.localeCompare(b[1].sort, undefined, { numeric: true }));
  let colList = sortVals(colVals);
  const notes: string[] = [];
  if (truncated) notes.push('There are too many ledger lines in this period to include them all, so these totals are incomplete. Narrow the dates.');
  if (colList.length > 40) {
    notes.push(`Only the first 40 ${PIVOT_DIMENSION_LABELS[input.cols!].toLowerCase()} columns are shown (the TOTAL column includes all).`);
    colList = colList.slice(0, 40);
  }
  const type = input.measure === 'count' || input.measure === 'quantity' ? 'number' : 'money';
  const fmt = (v: Decimal) => (type === 'number' ? v.toString() : toAmountString(v));
  const columns: StdColumn[] = [
    { key: 'label', header: PIVOT_DIMENSION_LABELS[input.rows] },
    ...(input.cols ? colList.map(([, v], i) => ({ key: `c${i}`, header: v.label, type: type as 'money' | 'number' })) : []),
    { key: 'total', header: 'TOTAL', type },
  ];
  const colTotals = colList.map(() => Money.zero());
  let grand = Money.zero();
  const drill = (dim: PivotDimension, key: string): Record<string, string | undefined> => {
    if (input.source !== 'gl' || !key) return {};
    if (dim === 'account') return { accountId: key };
    if (dim === 'class') return { classId: key };
    if (dim === 'customer') return { customerId: key };
    if (dim === 'vendor') return { vendorId: key };
    if (dim === 'txnType') return { txnType: key };
    if (dim === 'month') return { from: `${key}-01`, to: dayStr(new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0))) };
    return {};
  };
  const rows: StdRow[] = sortVals(rowVals).map(([rk, rv]) => {
    const cells: Record<string, CellValue> = { label: rv.label };
    let rowTotal = Money.zero();
    for (const [ck] of colVals) rowTotal = rowTotal.plus(cellsMap.get(`${rk}\u0000${ck}`) ?? Money.zero());
    const hrefs: Record<string, string> = {};
    colList.forEach(([ck], i) => {
      const v = cellsMap.get(`${rk}\u0000${ck}`);
      if (input.cols) cells[`c${i}`] = v ? fmt(v) : null;
      if (v) colTotals[i] = colTotals[i].plus(v);
      if (v && input.source === 'gl' && input.cols) {
        hrefs[`c${i}`] = stdHref('transaction-detail-by-account', { from: dayStr(from), to: dayStr(to), ...drill(input.rows, rk), ...drill(input.cols, ck) });
      }
    });
    cells.total = fmt(rowTotal);
    grand = grand.plus(rowTotal);
    return {
      id: `pv:${rk || 'none'}`,
      depth: 0,
      kind: 'data',
      cells,
      hrefs,
      href: input.source === 'gl' ? stdHref('transaction-detail-by-account', { from: dayStr(from), to: dayStr(to), ...drill(input.rows, rk) }) : null,
    };
  });
  const totalCells: Record<string, CellValue> = { label: 'TOTAL', total: fmt(grand) };
  if (input.cols) colList.forEach((_, i) => (totalCells[`c${i}`] = fmt(colTotals[i])));
  rows.push({ id: 'pv:total', depth: 0, kind: 'grand', cells: totalCells });
  return {
    key: 'pivot',
    title: 'Advanced Reporting',
    subtitle: `${rangeLabel(from, to)} · ${input.source === 'gl' ? 'Ledger lines' : 'Item sales'}`,
    columns,
    rows,
    notes,
    truncated,
  };
}

// ===========================================================================
// Graphs
// ===========================================================================

export interface GraphSeries {
  name: string;
  values: number[];
}

export interface GraphData {
  kind: string;
  title: string;
  subtitle: string;
  labels: string[];
  series: GraphSeries[];
  /** Optional breakdown (pie-style) of the period total. */
  breakdown?: { label: string; value: number; href?: string }[];
  /** QuickZoom per label (bar group). */
  hrefs?: string[];
}

export const GRAPH_KINDS = ['income-expense', 'net-worth', 'sales', 'ar', 'ap', 'budget-vs-actual'] as const;
export type GraphKind = (typeof GRAPH_KINDS)[number];

const num = (d: Decimal) => Number(d.toFixed(2));

function topN(map: Map<string, { label: string; value: Decimal; href?: string }>, n: number) {
  const list = [...map.values()].filter((x) => !x.value.isZero()).sort((a, b) => b.value.comparedTo(a.value));
  const head = list.slice(0, n).map((x) => ({ label: x.label, value: num(x.value), href: x.href }));
  const rest = list.slice(n).reduce((s, x) => s.plus(x.value), Money.zero());
  if (!rest.isZero()) head.push({ label: 'Other', value: num(rest), href: undefined });
  return head;
}

export async function graphData(ctx: ServiceContext, kind: GraphKind, p: ReportParams): Promise<GraphData> {
  if (kind === 'ar' || kind === 'ap') {
    const asOf = parseDay(p.asOf ?? p.to, true) ?? endOfToday();
    const aging = kind === 'ar' ? await arAging(ctx, asOf) : await apAging(ctx, asOf);
    const t = aging.totals;
    const labels = ['Current', '1-30', '31-60', '61-90', '> 90'];
    const by = new Map<string, { label: string; value: Decimal; href?: string }>();
    for (const r of aging.rows) {
      by.set(r.id, {
        label: r.name,
        value: Money.of(r.total),
        href: stdHref(kind === 'ar' ? 'customer-balance-detail' : 'vendor-balance-detail', { [kind === 'ar' ? 'customerId' : 'vendorId']: r.id }),
      });
    }
    return {
      kind,
      title: kind === 'ar' ? 'Accounts Receivable' : 'Accounts Payable',
      subtitle: `Aging as of ${fmtDay(asOf)}`,
      labels,
      series: [{ name: 'Open balance', values: [t.current, t.days1_30, t.days31_60, t.days61_90, t.days91plus].map((v) => num(Money.of(v))) }],
      breakdown: topN(by, 8),
      hrefs: labels.map(() => (kind === 'ar' ? '/reports/ar-aging-detail' : '/reports/ap-aging-detail')),
    };
  }
  if (kind === 'budget-vs-actual') {
    const r = await budgetVsActualReport(ctx, { ...p, columns: 'month' });
    const net = r.rows.find((x) => x.id === 'pl:net');
    const months = r.columns.filter((c) => c.key.endsWith('_act')).map((c) => c.header.replace(/ Actual$/, ''));
    const keys = r.columns.filter((c) => c.key.endsWith('_act')).map((c) => c.key.slice(0, -4));
    return {
      kind,
      title: 'Budget vs. Actual',
      subtitle: `${r.subtitle} · Net income`,
      labels: months,
      series: [
        { name: 'Actual', values: keys.map((k) => Number(net?.cells[`${k}_act`] ?? 0)) },
        { name: 'Budget', values: keys.map((k) => Number(net?.cells[`${k}_bud`] ?? 0)) },
      ],
    };
  }
  const { from, to } = await resolveRange(ctx, p);
  const periods = splitPeriods(from, to, 'month');
  if (periods.length > 36) throw validation('Choose a range of 36 months or fewer for graphs.');
  const labels = periods.map((x) => x.label);
  const hrefs = periods.map((x) => stdHref(kind === 'sales' ? 'sales-by-customer-detail' : 'profit-loss', { from: dayStr(x.from), to: dayStr(x.to) }));
  if (kind === 'net-worth') {
    const sheets = await Promise.all(periods.map((x) => balanceSheet(ctx, x.to)));
    return {
      kind,
      title: 'Net Worth',
      subtitle: `Month-end balances, ${rangeLabel(from, to)}`,
      labels,
      series: [
        { name: 'Assets', values: sheets.map((s) => num(Money.of(s.totalAssets))) },
        { name: 'Liabilities', values: sheets.map((s) => num(Money.of(s.totalLiabilities))) },
        { name: 'Net worth', values: sheets.map((s) => num(Money.of(s.totalAssets).minus(Money.of(s.totalLiabilities)))) },
      ],
      hrefs: periods.map((x) => stdHref('balance-sheet', { asOf: dayStr(x.to) })),
    };
  }
  const meta = await loadAccountMeta(ctx);
  const act = await activityByAccount(ctx, { from, to, excludeClose: true }, 'month');
  const income = periods.map(() => Money.zero());
  const expense = periods.map(() => Money.zero());
  const byAccount = new Map<string, { label: string; value: Decimal; href?: string }>();
  for (const r of act) {
    const a = meta.get(r.accountId);
    if (!a || !isPLSection(a.section)) continue;
    const i = periods.findIndex((x) => dayStr(x.from).slice(0, 7) === r.bucket);
    if (i < 0) continue;
    const v = naturalAmount(a.section, r.debit, r.credit);
    const isIncome = a.section === 'income' || a.section === 'other_income';
    if (kind === 'sales' && a.section !== 'income') continue;
    if (isIncome) income[i] = income[i].plus(v);
    else expense[i] = expense[i].plus(v);
    if (kind === 'sales' ? isIncome : !isIncome) {
      const cur = byAccount.get(a.id) ?? { label: a.fullName, value: Money.zero(), href: stdHref('transaction-detail-by-account', { accountId: a.id, from: dayStr(from), to: dayStr(to) }) };
      cur.value = cur.value.plus(v);
      byAccount.set(a.id, cur);
    }
  }
  if (kind === 'sales') {
    const names = await customerNames(ctx);
    const byCust = new Map<string, { label: string; value: Decimal; href?: string }>();
    for (const l of await salesLines(ctx, { from, to })) {
      const k = l.customerId ?? '';
      const cur = byCust.get(k) ?? { label: k ? (names.get(k)?.name ?? '') : '(no customer)', value: Money.zero(), href: k ? stdHref('sales-by-customer-detail', { customerId: k, from: dayStr(from), to: dayStr(to) }) : undefined };
      cur.value = cur.value.plus(l.amount);
      byCust.set(k, cur);
    }
    return {
      kind,
      title: 'Sales',
      subtitle: rangeLabel(from, to),
      labels,
      series: [{ name: 'Sales', values: income.map(num) }],
      breakdown: topN(byCust, 8),
      hrefs,
    };
  }
  return {
    kind,
    title: 'Income & Expense',
    subtitle: rangeLabel(from, to),
    labels,
    series: [
      { name: 'Income', values: income.map(num) },
      { name: 'Expense', values: expense.map(num) },
    ],
    breakdown: topN(byAccount, 8),
    hrefs,
  };
}

export { PL_SECTIONS };

// ===========================================================================
// Report filter options (names only) for the report toolbar's filter pickers
// ===========================================================================

export interface FilterOption {
  id: string;
  name: string;
}

export interface ReportFilterOptions {
  accounts: (FilterOption & { section: string })[];
  customers: FilterOption[];
  vendors: FilterOption[];
  classes: FilterOption[];
  items: FilterOption[];
  employees: FilterOption[];
  jobs: FilterOption[];
  budgets: (FilterOption & { fiscalYear: number; kind: string; isForecast: boolean })[];
  vehicles: string[];
}

/**
 * Id + display name lists for report filters. Any member who may run at least one report may
 * read them (names only — no balances, contact details or tax ids).
 */
export async function reportFilterOptions(ctx: ServiceContext): Promise<ReportFilterOptions> {
  requireAnyReportAccess(ctx);
  const c = ctx.companyId;
  const [meta, custs, vends, cls, its, emps, jbs, bdg, veh] = await Promise.all([
    loadAccountMeta(ctx),
    customerNames(ctx),
    ctx.db.select({ id: vendors.id, name: vendors.displayName }).from(vendors).where(eq(vendors.companyId, c)),
    ctx.db.select({ id: classes.id, name: classes.name }).from(classes).where(eq(classes.companyId, c)),
    ctx.db.select({ id: items.id, name: items.name }).from(items).where(eq(items.companyId, c)),
    ctx.db.select({ id: employees.id, first: employees.firstName, last: employees.lastName }).from(employees).where(eq(employees.companyId, c)),
    ctx.db.select({ id: jobs.id, name: jobs.name, customerId: jobs.customerId }).from(jobs).where(eq(jobs.companyId, c)),
    ctx.db.select().from(budgets).where(eq(budgets.companyId, c)),
    // Free-text vehicles (wave2 reports) plus the Vehicle list (wave2 lists).
    ctx.db
      .selectDistinct({ v: mileageLogs.vehicle })
      .from(mileageLogs)
      .where(eq(mileageLogs.companyId, c))
      .then(async (rows) => [
        ...rows,
        ...(await ctx.db.select({ v: vehicles.name }).from(vehicles).where(eq(vehicles.companyId, c))),
      ]),
  ]);
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  return {
    accounts: [...meta.values()]
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((a) => ({ id: a.id, name: `${a.code ? `${a.code} · ` : ''}${a.fullName}`, section: a.section })),
    customers: [...custs.entries()].map(([id, v]) => ({ id, name: v.name })).sort(byName),
    vendors: vends.sort(byName),
    classes: cls.sort(byName),
    items: its.sort(byName),
    employees: emps.map((e) => ({ id: e.id, name: `${e.first} ${e.last}`.trim() })).sort(byName),
    jobs: jbs
      .map((j) => ({ id: j.id, name: j.customerId ? `${custs.get(j.customerId)?.name ?? ''}:${j.name}` : j.name }))
      .sort(byName),
    budgets: bdg
      .map((b) => ({ id: b.id, name: b.name, fiscalYear: b.fiscalYear, kind: b.kind, isForecast: b.isForecast }))
      .sort((a, b) => b.fiscalYear - a.fiscalYear || a.name.localeCompare(b.name)),
    vehicles: [...new Set(veh.map((v) => v.v).filter((v): v is string => !!v))].sort(),
  };
}
