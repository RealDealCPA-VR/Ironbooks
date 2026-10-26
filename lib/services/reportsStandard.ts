/**
 * Standard financial statements on the report engine (lib/services/reportEngine.ts):
 *
 *  - Profit & Loss with QB sections (Income, COGS, Gross Profit, Expense, Net Ordinary Income,
 *    Other Income, Other Expense, Net Other Income, Net Income), sub-account roll-up, optional
 *    month / quarter / year columns, previous-period / previous-year comparison, % of income,
 *    by-class columns and the YTD comparison.
 *  - Balance Sheet (standard, summary, comparative, by period) with QB sections and separate
 *    Retained Earnings (prior fiscal years) and Net Income (current fiscal year) equity lines.
 *    Every column re-checks Assets = Liabilities + Equity against the ledger-asserted
 *    balanceSheet() totals, so roll-up can never print an unbalanced sheet.
 *  - Trial Balance with sub-account roll-up (totals come from the asserted trialBalance()).
 *  - Detail reports: Profit & Loss Detail, Balance Sheet Detail, Transaction Detail by Account
 *    (the QuickZoom target, with every report filter), Journal, Transaction List by Date /
 *    Customer / Vendor.
 */
import type Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { notFound, validation } from './_base';
import { classes, journalEntries } from '@/lib/db/schema';
import { and, eq, gte, lte } from 'drizzle-orm';
import { LedgerIntegrityError, assertBalanceSheetBalanced, assertTrialBalanceBalanced } from './ledgerAssert';
import { balanceSheet, fiscalYearStartFor, trialBalance, type BalanceSheet } from './reports';
import { cashBasisBalanceSheet } from './balanceSheetCashBasis';
import { cashBasisLedger } from './cashBasisLedger';
import { cashFlow as cashFlowData } from './reportsExtra';
import { isCashAccount } from '@/lib/accountTypes';
import {
  BS_SECTIONS,
  DETAIL_COLUMNS,
  PL_SECTIONS,
  SECTION_LABELS,
  activityByAccount,
  addInto,
  anyNonZero,
  buildAccountTree,
  buildPLRows,
  companyFiscalYearEnd,
  costLineCustomers,
  customerNames,
  dayStr,
  detailColumns,
  GL_LIMITS,
  fetchGlLines,
  fiscalWindowFor,
  fmtDay,
  glFilterFromParams,
  isPLSection,
  layoutDetail,
  loadAccountMeta,
  naturalAmount,
  parseDay,
  periodIndex,
  plAmountsFromActivity,
  resolveAsOf,
  resolveRange,
  splitPeriods,
  stdHref,
  zeros,
  type AccountMeta,
  type Amounts,
  type BSSection,
  type GlLine,
  type GroupKey,
  type PLSection,
  type Period,
} from './reportEngine';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const rangeLabel = (from: Date, to: Date) => `${fmtDay(from)} – ${fmtDay(to)}`;

/** QB "Report Basis": 'cash' runs the report on the cash basis (cashBasisLedger.ts). */
export type Basis = 'cash' | undefined;
const basisOf = (p: Pick<ReportParams, 'basis'>): Basis => (p.basis === 'cash' ? 'cash' : undefined);
const basisSuffix = (b: Basis) => (b === 'cash' ? ' · Cash Basis' : '');
/** The balance sheet for one as-of date on the report's basis. */
const sheetAsOf = (ctx: ServiceContext, asOf: Date, b: Basis) =>
  b === 'cash' ? cashBasisBalanceSheet(ctx, asOf) : balanceSheet(ctx, asOf);

const pct = (num: Decimal, den: Decimal): CellValue =>
  den.isZero() ? null : num.dividedBy(den.abs()).times(100).toFixed(2);

const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const isMonthEnd = (d: Date) => d.getUTCDate() === lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth());

/**
 * Move a date by whole months without rolling over: the day is clamped to the target month
 * (Mar 31 − 1 month = Feb 28, Feb 29 − 12 months = Feb 28) and a month-end date stays a month
 * end (Feb 28 − 1 month = Jan 31). Time of day is kept.
 */
export function shiftMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = lastDayOfMonth(ty, tm);
  const day = isMonthEnd(d) ? last : Math.min(d.getUTCDate(), last);
  return new Date(Date.UTC(ty, tm, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

export function shiftYears(d: Date, years: number): Date {
  return shiftMonths(d, years * 12);
}

/**
 * The period immediately before [from, to]. A range of whole calendar months (1st through a
 * month end) compares with the same number of whole months before it, like QuickBooks
 * (September vs August, Q2 vs Q1); any other range uses the equal-length window just before it.
 */
export function previousPeriod(from: Date, to: Date): { from: Date; to: Date } {
  if (from.getUTCDate() === 1 && isMonthEnd(to)) {
    const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1;
    if (months >= 1) return { from: shiftMonths(from, -months), to: shiftMonths(to, -months) };
  }
  const len = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  return { from: new Date(prevTo.getTime() - len), to: prevTo };
}

const accountDetailHref = (from: Date, to: Date, extra: Record<string, string | undefined> = {}) =>
  (a: AccountMeta) =>
    stdHref('transaction-detail-by-account', { accountId: a.id, from: dayStr(from), to: dayStr(to), ...extra });

// ===========================================================================
// Profit & Loss
// ===========================================================================

export interface PLOptions {
  /** Add a "% of Income" column per amount column. */
  percentOfIncome?: boolean;
  title?: string;
  key?: string;
}

/**
 * Profit & Loss (standard, by month / quarter / year, previous period / year comparison,
 * % of income). Excludes year-end closing entries, like every income statement.
 */
export async function profitAndLossReport(
  ctx: ServiceContext,
  p: ReportParams,
  o: PLOptions = {},
): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const fye = await companyFiscalYearEnd(ctx);
  const classId = p.classId;
  const basis = basisOf(p);
  const periodKind = p.columns && p.columns !== 'total' ? p.columns : null;
  const compare = !periodKind && p.compare && p.compare !== 'none' ? p.compare : null;

  let columns: StdColumn[] = [{ key: 'label', header: '' }];
  let amountKeys: string[];
  let amounts: Map<string, Amounts>;
  let derive: ((v: Amounts, c: { incomeTotal: Amounts }) => Record<string, CellValue>) | undefined;
  const notes: string[] = [];

  if (periodKind) {
    const periods = splitPeriods(from, to, periodKind, fye);
    if (periods.length > 60) throw validation('Too many columns — choose a shorter date range or wider columns.');
    amountKeys = [...periods.map((x) => x.key), 'total'];
    columns.push(...periods.map((x) => ({ key: x.key, header: x.label, type: 'money' as const })));
    columns.push({ key: 'total', header: 'TOTAL', type: 'money' });
    const act = await activityByAccount(ctx, { from, to, classId, excludeClose: true, basis }, 'day');
    amounts = plAmountsFromActivity(meta, act, amountKeys.length, (b) => {
      const i = periodIndex(periods, parseDay(b ?? undefined)!);
      return i >= 0 ? [i, periods.length] : [periods.length];
    });
  } else if (compare) {
    const prev = compare === 'prev_year' ? { from: shiftYears(from, -1), to: shiftYears(to, -1) } : previousPeriod(from, to);
    const [cur, pri] = await Promise.all([
      activityByAccount(ctx, { from, to, classId, excludeClose: true, basis }),
      activityByAccount(ctx, { from: prev.from, to: prev.to, classId, excludeClose: true, basis }),
    ]);
    amountKeys = ['cur', 'prev'];
    columns.push(
      { key: 'cur', header: rangeLabel(from, to), type: 'money' },
      { key: 'prev', header: rangeLabel(prev.from, prev.to), type: 'money' },
      { key: 'chg', header: '$ Change', type: 'money' },
      { key: 'pctchg', header: '% Change', type: 'percent' },
    );
    const tagged = [...cur.map((r) => ({ ...r, bucket: 'cur' })), ...pri.map((r) => ({ ...r, bucket: 'prev' }))];
    amounts = plAmountsFromActivity(meta, tagged, 2, (b) => (b === 'cur' ? 0 : 1));
    derive = (v) => ({ chg: toAmountString(v[0].minus(v[1])), pctchg: pct(v[0].minus(v[1]), v[1]) });
  } else {
    const act = await activityByAccount(ctx, { from, to, classId, excludeClose: true, basis });
    amountKeys = ['total'];
    columns.push({ key: 'total', header: rangeLabel(from, to), type: 'money' });
    amounts = plAmountsFromActivity(meta, act, 1, () => 0);
  }

  if (o.percentOfIncome) {
    const base = derive;
    const pctCols: StdColumn[] = [];
    const out: StdColumn[] = [columns[0]];
    for (const c of columns.slice(1)) {
      out.push(c);
      const i = amountKeys.indexOf(c.key);
      if (i >= 0) {
        const pc: StdColumn = { key: `${c.key}_pct`, header: '% of Income', type: 'percent' };
        out.push(pc);
        pctCols.push(pc);
      }
    }
    columns = out;
    derive = (v, c) => {
      const d: Record<string, CellValue> = base ? base(v, c) : {};
      amountKeys.forEach((k, i) => (d[`${k}_pct`] = pct(v[i], c.incomeTotal[i])));
      return d;
    };
  }

  const qs = { from: dayStr(from), to: dayStr(to), classId, basis };
  const built = buildPLRows({
    meta,
    amounts,
    columns,
    amountKeys,
    derive,
    hrefFor: accountDetailHref(from, to, { classId, basis }),
    totalHref: (s) => (s === 'net' ? stdHref('profit-loss-detail', qs) : stdHref('profit-loss-detail', { ...qs, section: s })),
  });

  let className: string | undefined;
  if (classId) {
    const [c] = await ctx.db
      .select({ name: classes.name })
      .from(classes)
      .where(and(eq(classes.id, classId), eq(classes.companyId, ctx.companyId)));
    if (!c) throw notFound('Class');
    className = c.name;
  }
  return {
    key: o.key ?? 'profit-loss',
    title: o.title ?? 'Profit & Loss',
    subtitle: `${rangeLabel(from, to)}${className ? ` · Class: ${className}` : ''}${basisSuffix(basis)}`,
    columns,
    rows: built.rows,
    notes,
  };
}

/** P&L YTD Comparison: the period vs fiscal year-to-date through the period end, with % of YTD. */
export async function profitAndLossYtdComparison(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const fye = await companyFiscalYearEnd(ctx);
  const ytdFrom = fiscalWindowFor(to, fye).start;
  const basis = basisOf(p);
  const [cur, ytd] = await Promise.all([
    activityByAccount(ctx, { from, to, classId: p.classId, excludeClose: true, basis }),
    activityByAccount(ctx, { from: ytdFrom, to, classId: p.classId, excludeClose: true, basis }),
  ]);
  const tagged = [...cur.map((r) => ({ ...r, bucket: 'cur' })), ...ytd.map((r) => ({ ...r, bucket: 'ytd' }))];
  const amounts = plAmountsFromActivity(meta, tagged, 2, (b) => (b === 'cur' ? 0 : 1));
  const columns: StdColumn[] = [
    { key: 'label', header: '' },
    { key: 'cur', header: rangeLabel(from, to), type: 'money' },
    { key: 'ytd', header: `${fmtDay(ytdFrom)} – ${fmtDay(to)}`, type: 'money' },
    { key: 'pctytd', header: '% of YTD', type: 'percent' },
  ];
  const built = buildPLRows({
    meta,
    amounts,
    columns,
    amountKeys: ['cur', 'ytd'],
    derive: (v) => ({ pctytd: pct(v[0], v[1]) }),
    hrefFor: accountDetailHref(ytdFrom, to, { classId: p.classId, basis }),
  });
  return {
    key: 'profit-loss-ytd',
    title: 'Profit & Loss YTD Comparison',
    subtitle: `${rangeLabel(from, to)} vs fiscal year to date${basisSuffix(basis)}`,
    columns,
    rows: built.rows,
  };
}

/** P&L by Class: one column per class (plus Unclassified) and a total. */
export async function profitAndLossByClassReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const basis = basisOf(p);
  const act = await activityByAccount(ctx, { from, to, excludeClose: true, basis }, 'class');
  const classRows = await ctx.db
    .select({ id: classes.id, name: classes.name })
    .from(classes)
    .where(eq(classes.companyId, ctx.companyId));
  const used = new Set(act.filter((r) => isPLSection(meta.get(r.accountId)?.section ?? 'equity')).map((r) => r.bucket ?? ''));
  const cols = classRows.filter((c) => used.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  const keys = cols.map((c) => c.id);
  if (used.has('')) keys.push('');
  const columns: StdColumn[] = [
    { key: 'label', header: '' },
    ...cols.map((c, i) => ({ key: `c${i}`, header: c.name, type: 'money' as const })),
    ...(used.has('') ? [{ key: `c${cols.length}`, header: 'Unclassified', type: 'money' as const }] : []),
    { key: 'total', header: 'TOTAL', type: 'money' },
  ];
  const amountKeys = [...keys.map((_, i) => `c${i}`), 'total'];
  const amounts = plAmountsFromActivity(meta, act, amountKeys.length, (b) => [keys.indexOf(b ?? ''), keys.length]);
  const built = buildPLRows({
    meta,
    amounts,
    columns,
    amountKeys,
    hrefFor: accountDetailHref(from, to, { basis }),
  });
  // Per-class QuickZoom on account rows.
  for (const r of built.rows) {
    const m = /:a:([0-9a-f-]{36})(?::other)?$/.exec(r.id);
    if (!m || r.kind !== 'data') continue;
    r.hrefs = {};
    keys.forEach((k, i) => {
      if (k) r.hrefs![`c${i}`] = stdHref('transaction-detail-by-account', { accountId: m[1], classId: k, from: dayStr(from), to: dayStr(to), basis });
    });
  }
  return { key: 'pl-by-class', title: 'Profit & Loss by Class', subtitle: `${rangeLabel(from, to)}${basisSuffix(basis)}`, columns, rows: built.rows };
}

/**
 * P&L by Job (QB "Profit & Loss by Job"): one column per customer:job with income or expense in
 * the period (the customer on the invoice / sales receipt, or the customer:job an expense line is
 * billed to), plus "No customer:job" so the TOTAL ties to the Profit & Loss.
 */
export async function profitAndLossByJobReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const basis = basisOf(p);
  const f = glFilterFromParams(meta, { basis: p.basis, classId: p.classId }, { from, to });
  f.sections = [...PL_SECTIONS];
  f.excludeClose = true;
  const { lines, truncated } = await fetchGlLines(ctx, meta, { ...f, limit: 50000 });
  const bucketOf = await jobBucketOf(ctx, lines);
  const custNames = await customerNames(ctx);
  const act = new Map<string, { accountId: string; bucket: string; debit: Decimal; credit: Decimal }>();
  const names = new Map<string, string>();
  for (const l of lines) {
    const bucket = bucketOf(l);
    if (bucket) names.set(bucket, (l.nameType === 'customer' && l.nameId === bucket ? l.name : custNames.get(bucket)?.name) || '(unnamed)');
    const k = `${l.accountId}|${bucket}`;
    const cur = act.get(k) ?? { accountId: l.accountId, bucket, debit: Money.zero(), credit: Money.zero() };
    cur.debit = cur.debit.plus(l.debit);
    cur.credit = cur.credit.plus(l.credit);
    act.set(k, cur);
  }
  const jobs = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (jobs.length > 100) throw validation('More than 100 customers and jobs have activity in this period. Choose a shorter date range.');
  const keys = jobs.map(([id]) => id);
  const hasNone = [...act.values()].some((r) => r.bucket === '');
  if (hasNone) keys.push('');
  const columns: StdColumn[] = [
    { key: 'label', header: '' },
    ...jobs.map(([, name], i) => ({ key: `c${i}`, header: name, type: 'money' as const })),
    ...(hasNone ? [{ key: `c${jobs.length}`, header: 'No customer:job', type: 'money' as const }] : []),
    { key: 'total', header: 'TOTAL', type: 'money' },
  ];
  const amountKeys = [...keys.map((_, i) => `c${i}`), 'total'];
  const rowsIn = [...act.values()].map((r) => ({ accountId: r.accountId, bucket: r.bucket, debit: toAmountString(r.debit), credit: toAmountString(r.credit) }));
  const amounts = plAmountsFromActivity(meta, rowsIn, amountKeys.length, (b) => [keys.indexOf(b ?? ''), keys.length]);
  const built = buildPLRows({ meta, amounts, columns, amountKeys, hrefFor: accountDetailHref(from, to, { basis, classId: p.classId }) });
  for (const r of built.rows) {
    const m = /:a:([0-9a-f-]{36})(?::other)?$/.exec(r.id);
    if (!m || r.kind !== 'data') continue;
    r.hrefs = {};
    keys.forEach((k, i) => {
      if (k) r.hrefs![`c${i}`] = stdHref('transaction-detail-by-account', { accountId: m[1], customerId: k, classId: p.classId, from: dayStr(from), to: dayStr(to), basis });
    });
  }
  return {
    key: 'profit-loss-by-job',
    title: 'Profit & Loss by Job',
    subtitle: `${rangeLabel(from, to)}${basisSuffix(basis)}`,
    columns,
    rows: built.rows,
    truncated,
    notes: truncated ? ['Only the first 50,000 lines were included. Choose a shorter date range.'] : undefined,
  };
}

/**
 * The P&L by Job column of a ledger line: its customer (income named by the invoice / sales
 * receipt, or a named line), or — for a cost on a bill, check or vendor credit — the
 * Customer:Job its document line is costed to (costLineCustomers); '' = "No customer:job".
 * Shared with the report explanations so a job column explains to exactly its amount.
 */
export async function jobBucketOf(ctx: ServiceContext, lines: GlLine[]): Promise<(l: GlLine) => string> {
  const costed = await costLineCustomers(ctx, lines);
  return (l) => (l.nameType === 'customer' && l.nameId ? l.nameId : (costed.get(l.lineId) ?? ''));
}

// ===========================================================================
// Balance Sheet
// ===========================================================================

interface BSColumn {
  key: string;
  header: string;
  asOf: Date;
  bs: BalanceSheet;
}

const CURRENT_ASSETS: BSSection[] = ['bank', 'ar', 'other_current_asset'];
const CURRENT_LIABS: BSSection[] = ['ap', 'credit_card', 'other_current_liability'];

/**
 * Lay out balance-sheet columns with QB sections and sub-account roll-up. Retained Earnings
 * (unclosed prior-year income + the retained-earnings account) and Net Income (current fiscal
 * year) are separate equity lines. Throws INTEGRITY if any column fails to balance.
 */
function buildBSRows(
  meta: Map<string, AccountMeta>,
  cols: BSColumn[],
  opts: { summary?: boolean; derive?: (v: Amounts) => Record<string, CellValue>; basis?: Basis },
): { rows: StdRow[]; balanced: boolean } {
  const basis = opts.basis;
  const n = cols.length;
  const amounts = new Map<BSSection, Map<string, Amounts>>();
  for (const s of BS_SECTIONS) amounts.set(s, new Map());
  const put = (id: string, i: number, v: Decimal) => {
    const a = meta.get(id);
    if (!a || isPLSection(a.section)) return;
    const m = amounts.get(a.section as BSSection)!;
    const arr = m.get(id) ?? zeros(n);
    arr[i] = arr[i].plus(v);
    m.set(id, arr);
  };
  cols.forEach((c, i) => {
    for (const l of [...c.bs.assets, ...c.bs.liabilities, ...c.bs.equity]) put(l.accountId, i, Money.of(l.amount));
  });
  // Retained Earnings: fold prior-year earnings into the retained-earnings account when there is one.
  const reAccount = [...meta.values()]
    .filter((a) => a.section === 'equity' && /retained/.test(a.subtype))
    .sort((a, b) => a.code.localeCompare(b.code))[0];
  const priorYears = cols.map((c) => Money.of(c.bs.priorYearsEarnings));
  const netIncome = cols.map((c) => Money.of(c.bs.currentYearNetIncome));
  if (reAccount) cols.forEach((_, i) => put(reAccount.id, i, priorYears[i]));

  const cells = (label: string, v: Amounts): Record<string, CellValue> => {
    const c: Record<string, CellValue> = { label };
    cols.forEach((col, i) => (c[col.key] = toAmountString(v[i])));
    if (opts.derive) Object.assign(c, opts.derive(v));
    return c;
  };
  const rows: StdRow[] = [];
  const hrefFor = (a: AccountMeta) =>
    stdHref('transaction-detail-by-account', { accountId: a.id, to: dayStr(cols[0].asOf), basis });

  const sectionTotal = new Map<BSSection, Amounts>();
  const block = (s: BSSection, depth: number, parent: string | null) => {
    const m = amounts.get(s)!;
    if (![...m.values()].some(anyNonZero)) {
      sectionTotal.set(s, zeros(n));
      return;
    }
    const id = `bs:${s}`;
    if (opts.summary) {
      const total = zeros(n);
      for (const v of m.values()) addInto(total, v);
      sectionTotal.set(s, total);
      rows.push({
        id,
        parentId: parent,
        depth,
        kind: 'data',
        cells: cells(SECTION_LABELS[s], total),
        href: stdHref('balance-sheet-detail', { to: dayStr(cols[0].asOf), section: s, basis }),
      });
      return;
    }
    const header: StdRow = { id, parentId: parent, depth, kind: 'section', collapseKind: 'section', cells: { label: SECTION_LABELS[s] } };
    rows.push(header);
    const tree = buildAccountTree({ meta, amounts: m, ncols: n, idPrefix: id, parentRowId: id, depth: depth + 1, cells, hrefFor });
    rows.push(...tree.rows);
    sectionTotal.set(s, tree.total);
    header.collapsedCells = cells(SECTION_LABELS[s], tree.total);
    rows.push({ id: `${id}:total`, parentId: parent, depth, kind: 'subtotal', totalOf: id, cells: cells(`Total ${SECTION_LABELS[s]}`, tree.total) });
  };
  const group = (id: string, label: string, depth: number, parent: string | null, inner: () => Amounts, kind: 'total' | 'grand' = 'total') => {
    const header: StdRow = { id, parentId: parent, depth, kind: 'section', collapseKind: 'section', cells: { label } };
    rows.push(header);
    const total = inner();
    header.collapsedCells = cells(label, total);
    rows.push({ id: `${id}:total`, parentId: parent, depth, kind, totalOf: id, cells: cells(kind === 'grand' ? label.toUpperCase().replace(/^/, 'TOTAL ') : `Total ${label}`, total) });
    return total;
  };
  const sumOf = (secs: BSSection[]) => {
    const t = zeros(n);
    for (const s of secs) addInto(t, sectionTotal.get(s) ?? zeros(n));
    return t;
  };

  const totalAssets = group('bs:assets', 'Assets', 0, null, () => {
    group('bs:current_assets', 'Current Assets', 1, 'bs:assets', () => {
      for (const s of CURRENT_ASSETS) block(s, 2, 'bs:current_assets');
      return sumOf(CURRENT_ASSETS);
    });
    block('fixed_asset', 1, 'bs:assets');
    block('other_asset', 1, 'bs:assets');
    return sumOf([...CURRENT_ASSETS, 'fixed_asset', 'other_asset']);
  }, 'grand');

  let totalLiabilities = zeros(n);
  let totalEquity = zeros(n);
  const totalLE = group('bs:le', 'Liabilities & Equity', 0, null, () => {
    totalLiabilities = group('bs:liabilities', 'Liabilities', 1, 'bs:le', () => {
      group('bs:current_liabilities', 'Current Liabilities', 2, 'bs:liabilities', () => {
        for (const s of CURRENT_LIABS) block(s, 3, 'bs:current_liabilities');
        return sumOf(CURRENT_LIABS);
      });
      block('long_term_liability', 2, 'bs:liabilities');
      return sumOf([...CURRENT_LIABS, 'long_term_liability']);
    });
    totalEquity = group('bs:equity', 'Equity', 1, 'bs:le', () => {
      const m = amounts.get('equity')!;
      const t = zeros(n);
      if (opts.summary) {
        for (const v of m.values()) addInto(t, v);
        if (!reAccount) addInto(t, priorYears);
        rows.push({
          id: 'bs:equity:accounts',
          parentId: 'bs:equity',
          depth: 2,
          kind: 'data',
          cells: cells('Equity accounts', t),
          href: stdHref('balance-sheet-detail', { to: dayStr(cols[0].asOf), section: 'equity', basis }),
        });
      } else {
        const tree = buildAccountTree({ meta, amounts: m, ncols: n, idPrefix: 'bs:equity', parentRowId: 'bs:equity', depth: 2, cells, hrefFor });
        rows.push(...tree.rows);
        addInto(t, tree.total);
        if (!reAccount && anyNonZero(priorYears)) {
          rows.push({
            id: 'bs:re',
            parentId: 'bs:equity',
            depth: 2,
            kind: 'data',
            cells: cells('Retained Earnings', priorYears),
            href: cols[0].bs.fiscalYearStart
              ? stdHref('profit-loss', { to: dayStr(new Date(new Date(cols[0].bs.fiscalYearStart).getTime() - 1)), from: '1900-01-01', basis })
              : null,
          });
          addInto(t, priorYears);
        }
      }
      rows.push({
        id: 'bs:ni',
        parentId: 'bs:equity',
        depth: 2,
        kind: 'data',
        cells: cells('Net Income', netIncome),
        href: cols[0].bs.fiscalYearStart
          ? stdHref('profit-loss', { from: dayStr(new Date(cols[0].bs.fiscalYearStart)), to: dayStr(cols[0].asOf), basis })
          : null,
      });
      addInto(t, netIncome);
      return t;
    });
    return totalLiabilities.map((v, i) => v.plus(totalEquity[i]));
  }, 'grand');

  // Ledger check per column: the laid-out totals must equal the asserted balanceSheet totals.
  cols.forEach((c, i) => {
    assertBalanceSheetBalanced(`Balance sheet (${c.header})`, totalAssets[i], totalLiabilities[i], totalEquity[i]);
    if (
      !Money.eq(totalAssets[i], c.bs.totalAssets) ||
      !Money.eq(totalLiabilities[i], c.bs.totalLiabilities) ||
      !Money.eq(totalEquity[i], c.bs.totalEquity)
    ) {
      throw new LedgerIntegrityError(`Balance sheet layout (${c.header}) does not match the ledger totals.`, {
        assets: toAmountString(totalAssets[i]),
        ledgerAssets: c.bs.totalAssets,
      });
    }
  });
  void totalLE;
  return { rows, balanced: cols.every((c) => c.bs.balanced) };
}

/**
 * Balance Sheet: standard (one as-of column), summary, previous-year comparison, or one column
 * per month / quarter / year end in [from, to].
 */
export async function balanceSheetReport(
  ctx: ServiceContext,
  p: ReportParams,
  o: { summary?: boolean } = {},
): Promise<StdReport> {
  const meta = await loadAccountMeta(ctx);
  const basis = basisOf(p);
  const periodKind = p.columns && p.columns !== 'total' ? p.columns : null;
  let cols: BSColumn[];
  let derive: ((v: Amounts) => Record<string, CellValue>) | undefined;
  const extraCols: StdColumn[] = [];
  let subtitle: string;
  if (periodKind) {
    const { from, to } = await resolveRange(ctx, p);
    const fye = await companyFiscalYearEnd(ctx);
    const periods: Period[] = splitPeriods(from, to, periodKind, fye);
    if (periods.length > 60) throw validation('Too many columns — choose a shorter date range or wider columns.');
    cols = await Promise.all(
      periods.map(async (x) => ({ key: x.key, header: fmtDay(x.to), asOf: x.to, bs: await sheetAsOf(ctx, x.to, basis) })),
    );
    subtitle = `As of each ${periodKind} end, ${rangeLabel(from, to)}`;
  } else {
    const asOf = resolveAsOf(p);
    cols = [{ key: 'total', header: fmtDay(asOf), asOf, bs: await sheetAsOf(ctx, asOf, basis) }];
    subtitle = `As of ${fmtDay(asOf)}`;
    if (p.compare && p.compare !== 'none') {
      let prior = p.priorAsOf ? parseDay(p.priorAsOf, true)! : shiftYears(asOf, -1);
      if (!p.priorAsOf && p.compare === 'prev_period') {
        prior = shiftMonths(asOf, -1);
      }
      cols.push({ key: 'prev', header: fmtDay(prior), asOf: prior, bs: await sheetAsOf(ctx, prior, basis) });
      extraCols.push({ key: 'chg', header: '$ Change', type: 'money' }, { key: 'pctchg', header: '% Change', type: 'percent' });
      derive = (v) => ({ chg: toAmountString(v[0].minus(v[1])), pctchg: pct(v[0].minus(v[1]), v[1]) });
      subtitle = `As of ${fmtDay(asOf)} vs ${fmtDay(prior)}`;
    }
  }
  const built = buildBSRows(meta, cols, { summary: o.summary, derive, basis });
  return {
    key: o.summary ? 'balance-sheet-summary' : 'balance-sheet',
    title: o.summary ? 'Balance Sheet Summary' : 'Balance Sheet',
    subtitle: `${subtitle}${basisSuffix(basis)}`,
    columns: [
      { key: 'label', header: '' },
      ...cols.map((c) => ({ key: c.key, header: c.header, type: 'money' as const })),
      ...extraCols,
    ],
    rows: built.rows,
    balanced: built.balanced,
  };
}

// ===========================================================================
// Trial Balance (with sub-account roll-up)
// ===========================================================================

/** The account Retained Earnings is reported on (the first equity account of that kind), if any. */
export function retainedEarningsAccount(meta: Map<string, AccountMeta>): AccountMeta | undefined {
  return [...meta.values()]
    .filter((a) => a.section === 'equity' && /retained/.test(a.subtype))
    .sort((a, b) => a.code.localeCompare(b.code))[0];
}

/**
 * Trial balance amounts as QuickBooks shows them, as of a date on either basis: balance-sheet
 * accounts at their balance; income and expense accounts at their FISCAL-YEAR-TO-DATE amount
 * (year-end closing entries left out, as on the balance sheet); and the income of every earlier
 * fiscal year rolled into Retained Earnings (QB closes the books implicitly at each fiscal year
 * end — the trial balance never shows several years of income on the income accounts). The
 * Retained Earnings roll-in is booked on the company's retained-earnings account, or returned
 * separately (`retainedEarnings`) when there is none. Values are debit − credit.
 */
export async function trialBalanceAmounts(
  ctx: ServiceContext,
  meta: Map<string, AccountMeta>,
  asOf: Date,
  basis: Basis,
): Promise<{ amounts: Map<string, Decimal>; retainedEarnings: Decimal; fyStart: Date; ledgerBalanced: boolean }> {
  const [tb, sheet] = await Promise.all([trialBalance(ctx, asOf), balanceSheet(ctx, asOf)]);
  const fyStart = sheet.fiscalYearStart ? new Date(sheet.fiscalYearStart) : await fiscalYearStartFor(ctx, asOf);
  // Cash basis: the balanced cash-basis adjustments (cashBasisLedger.ts), computed ONCE and split
  // here exactly as the cash-basis balance sheet splits them (balanceSheetCashBasis.ts).
  const adjustments = basis === 'cash' ? (await cashBasisLedger(ctx, { to: asOf })).adjustments.filter((a) => a.date <= asOf) : [];
  const amounts = new Map<string, Decimal>();
  const add = (id: string, v: Decimal) => amounts.set(id, (amounts.get(id) ?? Money.zero()).plus(v));
  const isPL = (id: string) => {
    const a = meta.get(id);
    return !!a && isPLSection(a.section);
  };
  // Balance-sheet accounts: the balance as of the date (closing entries included — they are part
  // of Retained Earnings), plus their cash-basis adjustments.
  for (const r of tb.rows) if (!isPL(r.accountId)) add(r.accountId, Money.sub(r.debit, r.credit));
  for (const a of adjustments) if (!isPL(a.accountId)) add(a.accountId, a.net);
  // Income and expense accounts: this fiscal year only (and its cash-basis adjustments).
  for (const r of await activityByAccount(ctx, { from: fyStart, to: asOf, excludeClose: true })) {
    if (isPL(r.accountId)) add(r.accountId, Money.sub(r.debit, r.credit));
  }
  let priorAdj = Money.zero();
  for (const a of adjustments) {
    if (!isPL(a.accountId)) continue;
    if (a.date >= fyStart) add(a.accountId, a.net);
    else priorAdj = priorAdj.plus(a.net);
  }
  // Earlier fiscal years' income (credit = positive earnings → a credit on Retained Earnings).
  const prior = Money.of(sheet.priorYearsEarnings).negated().plus(priorAdj);
  const re = retainedEarningsAccount(meta);
  let retainedEarnings = Money.zero();
  if (re) add(re.id, prior);
  else retainedEarnings = prior;
  for (const [id, v] of amounts) if (v.isZero()) amounts.delete(id);
  return { amounts, retainedEarnings, fyStart, ledgerBalanced: tb.balanced };
}

export async function trialBalanceReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const meta = await loadAccountMeta(ctx);
  const basis = basisOf(p);
  const tbAmounts = await trialBalanceAmounts(ctx, meta, asOf, basis);
  const amounts = new Map<string, Amounts>();
  for (const [id, v] of tbAmounts.amounts) amounts.set(id, [v]);
  let totalDebit = Money.zero();
  let totalCredit = Money.zero();
  for (const v of [...tbAmounts.amounts.values(), tbAmounts.retainedEarnings]) {
    if (v.greaterThan(0)) totalDebit = totalDebit.plus(v);
    else totalCredit = totalCredit.minus(v);
  }
  // Unreachable while the ledger guards hold: the roll-in moves earnings, it never adds any.
  assertTrialBalanceBalanced(basis === 'cash' ? 'Cash-basis trial balance' : 'Trial balance', totalDebit, totalCredit);
  const cells = (label: string, v: Amounts): Record<string, CellValue> => ({
    label,
    debit: v[0].greaterThan(0) ? toAmountString(v[0]) : null,
    credit: v[0].lessThan(0) ? toAmountString(v[0].negated()) : null,
  });
  const fyFrom = dayStr(tbAmounts.fyStart);
  const tree = buildAccountTree({
    meta,
    amounts,
    ncols: 1,
    idPrefix: 'tb',
    parentRowId: null,
    depth: 0,
    cells,
    // QuickZoom: an income / expense account opens this fiscal year's transactions.
    hrefFor: (a) =>
      stdHref('transaction-detail-by-account', { accountId: a.id, from: isPLSection(a.section) ? fyFrom : undefined, to: dayStr(asOf), basis }),
  });
  if (!tbAmounts.retainedEarnings.isZero()) {
    tree.rows.push({
      id: 'tb:re',
      depth: 0,
      kind: 'data',
      cells: cells('Retained Earnings', [tbAmounts.retainedEarnings]),
      href: stdHref('profit-loss', { from: '1900-01-01', to: dayStr(new Date(tbAmounts.fyStart.getTime() - 1)), basis }),
    });
  }
  tree.rows.push({
    id: 'tb:total',
    depth: 0,
    kind: 'grand',
    cells: { label: 'TOTAL', debit: toAmountString(totalDebit), credit: toAmountString(totalCredit) },
  });
  return {
    key: 'trial-balance',
    title: 'Trial Balance',
    subtitle: `As of ${fmtDay(asOf)}${basisSuffix(basis)}`,
    columns: [
      { key: 'label', header: '' },
      { key: 'debit', header: 'Debit', type: 'money' },
      { key: 'credit', header: 'Credit', type: 'money' },
    ],
    rows: tree.rows,
    balanced: tbAmounts.ledgerBalanced && Money.eq(totalDebit, totalCredit),
    notes: [`Income and expense accounts show this fiscal year (from ${fmtDay(tbAmounts.fyStart)}); earlier years’ net income is in Retained Earnings.`],
  };
}

// ===========================================================================
// Detail reports
// ===========================================================================

const DEFAULT_DETAIL_KEYS = ['label', 'type', 'date', 'num', 'name', 'memo', 'class', 'clr', 'split', 'amount', 'balance'];

function detailNotes(truncated: boolean): string[] {
  return truncated ? ['Only the first 10,000 lines are shown — narrow the dates or filters to see everything.'] : [];
}

/**
 * Transaction Detail by Account — QuickZoom target of every summary row and the fully
 * filterable custom detail report (account, name, type, amount, cleared, class, memo, number,
 * sort-by and total-by).
 */
export async function transactionDetailByAccount(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const meta = await loadAccountMeta(ctx);
  if (p.accountId && !meta.has(p.accountId)) throw notFound('Account');
  const range: { from?: Date; to?: Date } =
    p.from || p.to ? await resolveRange(ctx, { from: p.from ?? '1900-01-01', to: p.to }) : {};
  const f = glFilterFromParams(meta, p, range);
  const { lines, truncated } = await fetchGlLines(ctx, meta, f);
  const groupBy: GroupKey = (p.subtotalBy as GroupKey) ?? 'account';
  const laid = layoutDetail(lines, {
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    groupBy,
    sortBy: p.sortBy,
    sortDir: p.sortDir,
    natural: true,
    running: groupBy === 'account',
    idPrefix: 'tda',
    hrefForGroup: groupBy === 'account' ? (k) => (k ? `/registers/${k}` : undefined) : undefined,
  });
  const acct = p.accountId ? meta.get(p.accountId) : undefined;
  return {
    key: 'transaction-detail-by-account',
    title: 'Transaction Detail by Account',
    subtitle: [
      p.from && range.from && range.to ? rangeLabel(range.from, range.to) : range.to ? `Through ${fmtDay(range.to)}` : 'All dates',
      acct ? `Account: ${acct.fullName}` : '',
      p.basis === 'cash' ? 'Cash Basis' : '',
    ]
      .filter(Boolean)
      .join(' · '),
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    rows: laid.rows,
    truncated,
    notes: detailNotes(truncated),
  };
}

/** Profit & Loss Detail — every P&L posting in the period, by account (closing entries excluded). */
export async function profitAndLossDetail(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const f = glFilterFromParams(meta, p, { from, to });
  f.excludeClose = true;
  f.sections = f.sections ? f.sections.filter(isPLSection) : [...PL_SECTIONS];
  const { lines, truncated } = await fetchGlLines(ctx, meta, f);
  const laid = layoutDetail(lines, {
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    groupBy: (p.subtotalBy as GroupKey) ?? 'account',
    sortBy: p.sortBy,
    sortDir: p.sortDir,
    natural: true,
    running: (p.subtotalBy ?? 'account') === 'account',
    idPrefix: 'pld',
    // Account groups in statement order (Income, COGS, Expense, Other Income, Other Expense), then
    // by number — never by number alone.
    sectionOrder: PL_SECTIONS,
  });
  const rows = laid.rows;
  // Net income line: income-type naturals minus expense-type naturals.
  let net = Money.zero();
  for (const l of lines) {
    const s = l.account.section;
    net = s === 'income' || s === 'other_income' ? net.plus(l.natural) : net.minus(l.natural);
  }
  rows[rows.length - 1] = { id: 'pld:net', depth: 0, kind: 'grand', cells: { label: 'Net Income', amount: toAmountString(net) } };
  return {
    key: 'profit-loss-detail',
    title: 'Profit & Loss Detail',
    subtitle: `${rangeLabel(from, to)}${basisSuffix(basisOf(p))}`,
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    rows,
    truncated,
    notes: detailNotes(truncated),
  };
}

/** Balance Sheet Detail — per balance-sheet account: beginning balance, the period's postings, ending balance. */
export async function balanceSheetDetail(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const f = glFilterFromParams(meta, p, { from, to });
  f.sections = f.sections ? f.sections.filter((s) => !isPLSection(s)) : [...BS_SECTIONS];
  const { lines, truncated } = await fetchGlLines(ctx, meta, f);
  // Beginning balances are whole-account balances: with a line filter on (a name, class, type,
  // amount …) they would add every other name's balance to the filtered lines, so — as on the
  // General Ledger — they are left out then.
  const lineFiltered = hasLineFilter(p);
  const before = lineFiltered ? [] : await activityByAccount(ctx, { to: new Date(from.getTime() - 1), accountIds: f.accountIds, basis: f.basis });
  const opening = new Map<string, Decimal>();
  for (const r of before) {
    const a = meta.get(r.accountId);
    if (!a || isPLSection(a.section)) continue;
    if (f.sections && !f.sections.includes(a.section)) continue;
    const v = naturalAmount(a.section, r.debit, r.credit);
    if (!v.isZero()) opening.set(r.accountId, v);
  }
  const laid = layoutDetail(lines, {
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    groupBy: 'account',
    sortBy: p.sortBy,
    sortDir: p.sortDir,
    natural: true,
    running: true,
    opening,
    openingOnlyGroups: [...opening.keys()].map((id) => ({ key: id, label: meta.get(id)!.fullName })),
    idPrefix: 'bsd',
    hrefForGroup: (k) => (k ? `/registers/${k}` : undefined),
  });
  // Grand total in QB BS Detail is not meaningful across asset/liability signs — drop it.
  laid.rows.pop();
  return {
    key: 'balance-sheet-detail',
    title: 'Balance Sheet Detail',
    subtitle: `${rangeLabel(from, to)}${basisSuffix(basisOf(p))}`,
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    rows: laid.rows,
    truncated,
    notes: [
      ...detailNotes(truncated),
      ...(lineFiltered ? ['Beginning balances are left out because a filter is on.'] : []),
      'Retained Earnings and Net Income are calculated lines; see the Balance Sheet for them.',
    ],
  };
}

/** A filter that picks individual lines (so whole-account beginning balances no longer apply). */
function hasLineFilter(p: ReportParams): boolean {
  return !!(p.customerId || p.vendorId || p.employeeId || p.nameId || p.txnType || p.amountMin || p.amountMax || p.memo || p.number || (p.cleared && p.cleared !== 'any') || p.classId);
}

/**
 * General Ledger (QB): every account with activity — beginning balance, the period's postings
 * with a running balance, ending balance. Balance-sheet accounts open with their balance before
 * the From date; income and expense accounts open with their fiscal-year-to-date amount (they
 * start each fiscal year at zero). Runs on either basis, with all detail filters.
 */
export async function generalLedgerReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  if (p.accountId && !meta.has(p.accountId)) throw notFound('Account');
  const f = glFilterFromParams(meta, p, { from, to });
  const { lines, truncated } = await fetchGlLines(ctx, meta, f);
  const dayBefore = new Date(from.getTime() - 1);
  const fyStart = fiscalWindowFor(from, await companyFiscalYearEnd(ctx)).start;
  // Opening balances only make sense when no line-level filter (name, type, amount…) is on.
  const lineFiltered = hasLineFilter(p);
  const opening = new Map<string, Decimal>();
  if (!lineFiltered) {
    const [bsBefore, plBefore] = await Promise.all([
      activityByAccount(ctx, { to: dayBefore, accountIds: f.accountIds, basis: f.basis }),
      fyStart < from ? activityByAccount(ctx, { from: fyStart, to: dayBefore, accountIds: f.accountIds, basis: f.basis, excludeClose: true }) : Promise.resolve([]),
    ]);
    for (const r of bsBefore) {
      const a = meta.get(r.accountId);
      if (!a || isPLSection(a.section) || (f.sections && !f.sections.includes(a.section))) continue;
      const v = naturalAmount(a.section, r.debit, r.credit);
      if (!v.isZero()) opening.set(r.accountId, (opening.get(r.accountId) ?? Money.zero()).plus(v));
    }
    for (const r of plBefore) {
      const a = meta.get(r.accountId);
      if (!a || !isPLSection(a.section) || (f.sections && !f.sections.includes(a.section))) continue;
      const v = naturalAmount(a.section, r.debit, r.credit);
      if (!v.isZero()) opening.set(r.accountId, (opening.get(r.accountId) ?? Money.zero()).plus(v));
    }
  }
  const laid = layoutDetail(lines, {
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    groupBy: 'account',
    sortBy: p.sortBy,
    sortDir: p.sortDir,
    natural: true,
    running: true,
    opening,
    openingOnlyGroups: [...opening.keys()].map((id) => ({ key: id, label: meta.get(id)!.fullName })),
    idPrefix: 'gl',
    hrefForGroup: (k) => (k ? `/registers/${k}` : undefined),
  });
  // A grand total across assets, liabilities, income and expenses means nothing — drop it.
  laid.rows.pop();
  const acct = p.accountId ? meta.get(p.accountId) : undefined;
  return {
    key: 'general-ledger',
    title: 'General Ledger',
    subtitle: [rangeLabel(from, to), acct ? `Account: ${acct.fullName}` : '', basisOf(p) ? 'Cash Basis' : ''].filter(Boolean).join(' · '),
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    rows: laid.rows,
    truncated,
    notes: [
      ...detailNotes(truncated),
      ...(lineFiltered ? ['Beginning balances are left out because a filter is on.'] : []),
    ],
  };
}

/**
 * Statement of Cash Flows (QB, indirect method): Net Income, then the change in each other
 * current asset / liability (operating), fixed and other assets (investing), long-term
 * liabilities and equity (financing); net cash increase, cash at beginning and end of period.
 * Same classification as cashFlow() in reportsExtra.ts. QuickZoom on every line.
 */
export async function statementOfCashFlows(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const cf = await cashFlowData(ctx, { from, to });
  const openingCash = await activityByAccount(ctx, { to: new Date(from.getTime() - 1) });
  let cashStart = Money.zero();
  for (const r of openingCash) {
    const a = meta.get(r.accountId);
    if (a && isCashAccount(a)) cashStart = cashStart.plus(Money.sub(r.debit, r.credit));
  }
  const q = { from: dayStr(from), to: dayStr(to) };
  const zoomAcct = (id: string) => stdHref('transaction-detail-by-account', { accountId: id, ...q });
  const rows: StdRow[] = [];
  const line = (id: string, label: string, v: string, href: string | null, depth = 1, kind: StdRow['kind'] = 'data', parentId?: string) =>
    rows.push({ id, parentId, depth, kind, cells: { label, total: v }, href });
  const section = (id: string, label: string) => rows.push({ id, depth: 0, kind: 'section', collapseKind: 'section', cells: { label } });
  section('scf:op', 'OPERATING ACTIVITIES');
  line('scf:ni', 'Net Income', cf.operating.netIncome, stdHref('profit-loss', q), 1, 'data', 'scf:op');
  rows.push({ id: 'scf:adj', parentId: 'scf:op', depth: 1, kind: 'section', cells: { label: 'Adjustments to reconcile Net Income to net cash provided by operations:' } });
  const adj: [string, string, string, string | null][] = [];
  if (!Money.of(cf.operating.changeInAR).isZero()) adj.push(['scf:ar', 'Accounts Receivable', cf.operating.changeInAR, stdHref('transaction-detail-by-account', { section: 'ar', ...q })]);
  if (!Money.of(cf.operating.changeInInventory).isZero()) adj.push(['scf:inv', 'Inventory Asset', cf.operating.changeInInventory, stdHref('transaction-detail-by-account', { section: 'other_current_asset', ...q })]);
  if (!Money.of(cf.operating.changeInAP).isZero()) adj.push(['scf:ap', 'Accounts Payable', cf.operating.changeInAP, stdHref('transaction-detail-by-account', { section: 'ap', ...q })]);
  for (const l of cf.operating.otherChanges) adj.push([`scf:o:${l.accountId}`, meta.get(l.accountId)?.fullName ?? l.name, l.amount, zoomAcct(l.accountId)]);
  for (const [id, label, v, href] of adj) line(id, label, v, href, 2, 'data', 'scf:op');
  line('scf:optotal', 'Net cash provided by Operating Activities', cf.operating.total, null, 0, 'total');
  section('scf:invest', 'INVESTING ACTIVITIES');
  for (const l of cf.investing.lines) line(`scf:i:${l.accountId}`, meta.get(l.accountId)?.fullName ?? l.name, l.amount, zoomAcct(l.accountId), 1, 'data', 'scf:invest');
  line('scf:invtotal', 'Net cash provided by Investing Activities', cf.investing.total, null, 0, 'total');
  section('scf:fin', 'FINANCING ACTIVITIES');
  for (const l of cf.financing.lines) line(`scf:f:${l.accountId}`, meta.get(l.accountId)?.fullName ?? l.name, l.amount, zoomAcct(l.accountId), 1, 'data', 'scf:fin');
  line('scf:fintotal', 'Net cash provided by Financing Activities', cf.financing.total, null, 0, 'total');
  line('scf:net', 'Net cash increase for period', cf.netCashChange, stdHref('transaction-detail-by-account', { section: 'bank', ...q }), 0, 'total');
  line('scf:begin', 'Cash at beginning of period', toAmountString(cashStart), null, 0, 'data');
  line('scf:end', 'Cash at end of period', toAmountString(cashStart.plus(Money.of(cf.netCashChange))), null, 0, 'grand');
  const ties = Money.eq(cf.netCashChange, cf.cashAccountsChange);
  return {
    key: 'statement-of-cash-flows',
    title: 'Statement of Cash Flows',
    subtitle: rangeLabel(from, to),
    columns: [{ key: 'label', header: '' }, { key: 'total', header: rangeLabel(from, to), type: 'money' }],
    rows,
    balanced: ties,
  };
}

/** Journal — every posted entry with all of its lines and per-entry debit/credit totals. */
export async function journalReport(
  ctx: ServiceContext,
  p: ReportParams,
  o: { adjustingOnly?: boolean } = {},
): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const f = glFilterFromParams(meta, p, { from, to });
  if (o.adjustingOnly) {
    // QB Adjusting Journal Entries: only entries marked "Adjusting Entry".
    const adj = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.isAdjusting, true),
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, from),
          lte(journalEntries.date, to),
        ),
      );
    f.entryIds = adj.map((r) => r.id);
  }
  // Filters pick ENTRIES; the report then shows each matching entry in full.
  const { lines: hits, truncated: t1 } = await fetchGlLines(ctx, meta, f);
  const entryIds = [...new Set(hits.map((l) => l.entryId))];
  const { lines, truncated: t2 } = await fetchGlLines(ctx, meta, { entryIds });
  const byEntry = new Map<string, GlLine[]>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  const entries = [...byEntry.values()].sort(
    (a, b) => a[0].date.getTime() - b[0].date.getTime() || a[0].entryNumber - b[0].entryNumber,
  );
  const rows: StdRow[] = [];
  let tD = Money.zero();
  let tC = Money.zero();
  for (const e of entries) {
    const head = e[0];
    const id = `j:${head.entryId}`;
    let d = Money.zero();
    let c = Money.zero();
    const header: StdRow = {
      id,
      depth: 0,
      kind: 'section',
      collapseKind: 'group',
      cells: { label: `#${head.entryNumber}`, type: head.type, date: dayStr(head.date), num: head.num, name: head.name, memo: head.description },
      entryId: head.entryId,
    };
    rows.push(header);
    for (const l of e) {
      d = d.plus(l.debit);
      c = c.plus(l.credit);
      rows.push({
        id: `j:l:${l.lineId}`,
        parentId: id,
        depth: 1,
        kind: 'data',
        cells: {
          label: '',
          memo: l.memo,
          account: l.account.fullName,
          class: l.className,
          debit: l.debit.isZero() ? null : toAmountString(l.debit),
          credit: l.credit.isZero() ? null : toAmountString(l.credit),
        },
        entryId: l.entryId,
      });
    }
    rows.push({ id: `${id}:total`, depth: 0, kind: 'subtotal', totalOf: id, cells: { label: '', debit: toAmountString(d), credit: toAmountString(c) } });
    header.collapsedCells = { ...header.cells, debit: toAmountString(d), credit: toAmountString(c) };
    tD = tD.plus(d);
    tC = tC.plus(c);
  }
  rows.push({ id: 'j:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', debit: toAmountString(tD), credit: toAmountString(tC) } });
  const truncated = t1 || t2;
  return {
    key: o.adjustingOnly ? 'adjusting-journal-entries' : 'journal',
    title: o.adjustingOnly ? 'Adjusting Journal Entries' : 'Journal',
    subtitle: rangeLabel(from, to),
    columns: detailColumns(['label', 'type', 'date', 'num', 'name', 'memo', 'account', 'class', 'debit', 'credit']).map((c) =>
      c.key === 'label' ? { ...c, header: 'Trans #' } : c,
    ),
    rows,
    balanced: Money.eq(tD, tC),
    truncated,
    notes: detailNotes(truncated),
  };
}

/**
 * Transaction lists: one row per transaction (not per line). `by` groups the list by customer,
 * vendor or not at all (Transaction List by Date). The row amount is the transaction total
 * (sum of debits); Account / Split show the main account and the other side.
 */
export async function transactionList(
  ctx: ServiceContext,
  p: ReportParams,
  by: 'date' | 'customer' | 'vendor',
): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const f = glFilterFromParams(meta, p, { from, to });
  if (by === 'customer' || by === 'vendor') f.nameType = by;
  const { lines: hits, truncated: hitsCut } = await fetchGlLines(ctx, meta, f);
  const wanted = by === 'date' ? hits : hits.filter((l) => l.nameType === by);
  const entryIds = [...new Set(wanted.map((l) => l.entryId))];
  // Every line of those transactions (their total and Split). This read is capped too: when it
  // is cut, some totals are built from part of their lines, so the report must say so.
  const { lines, truncated: linesCut } = await fetchGlLines(ctx, meta, { entryIds, limit: GL_LIMITS.maxLines });
  const truncated = hitsCut || linesCut;
  const byEntry = new Map<string, GlLine[]>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  // One synthetic "line" per transaction for the shared detail layout.
  const txns: GlLine[] = [];
  for (const e of byEntry.values()) {
    const total = e.reduce((s, l) => s.plus(l.debit), Money.zero());
    // Main account: the A/R / A/P / bank side when present, else the first line.
    const main =
      e.find((l) => ['ar', 'ap', 'bank', 'credit_card'].includes(l.account.section)) ?? e[0];
    const others = [...new Set(e.filter((l) => l.lineId !== main.lineId).map((l) => l.accountId))];
    txns.push({
      ...main,
      amount: total,
      natural: total,
      debit: total,
      credit: Money.zero(),
      split: others.length === 1 ? meta.get(others[0])!.fullName : others.length > 1 ? '-SPLIT-' : '',
    });
  }
  const keys = ['label', 'type', 'date', 'num', 'name', 'memo', 'account', 'clr', 'split', 'amount'];
  const laid = layoutDetail(txns, {
    columns: detailColumns(keys),
    groupBy: by === 'date' ? ((p.subtotalBy as GroupKey) ?? 'none') : 'name',
    sortBy: p.sortBy,
    sortDir: p.sortDir,
    natural: true,
    idPrefix: `tl${by}`,
  });
  const title =
    by === 'customer' ? 'Transaction List by Customer' : by === 'vendor' ? 'Transaction List by Vendor' : 'Transaction List by Date';
  return {
    key: by === 'date' ? 'transaction-list-by-date' : `transaction-list-by-${by}`,
    title,
    subtitle: rangeLabel(from, to),
    columns: detailColumns(keys),
    rows: laid.rows,
    truncated,
    notes: detailNotes(truncated),
  };
}

export { DETAIL_COLUMNS };
