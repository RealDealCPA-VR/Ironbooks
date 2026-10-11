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
import { classes } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { LedgerIntegrityError, assertBalanceSheetBalanced } from './ledgerAssert';
import { balanceSheet, trialBalance, type BalanceSheet } from './reports';
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
  dayStr,
  detailColumns,
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

const pct = (num: Decimal, den: Decimal): CellValue =>
  den.isZero() ? null : num.dividedBy(den.abs()).times(100).toFixed(2);

function shiftYears(d: Date, years: number): Date {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/** The period of equal length immediately before [from, to]. */
function previousPeriod(from: Date, to: Date): { from: Date; to: Date } {
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
    const act = await activityByAccount(ctx, { from, to, classId, excludeClose: true }, 'day');
    amounts = plAmountsFromActivity(meta, act, amountKeys.length, (b) => {
      const i = periodIndex(periods, parseDay(b ?? undefined)!);
      return i >= 0 ? [i, periods.length] : [periods.length];
    });
  } else if (compare) {
    const prev = compare === 'prev_year' ? { from: shiftYears(from, -1), to: shiftYears(to, -1) } : previousPeriod(from, to);
    const [cur, pri] = await Promise.all([
      activityByAccount(ctx, { from, to, classId, excludeClose: true }),
      activityByAccount(ctx, { from: prev.from, to: prev.to, classId, excludeClose: true }),
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
    const act = await activityByAccount(ctx, { from, to, classId, excludeClose: true });
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

  const qs = { from: dayStr(from), to: dayStr(to), classId };
  const built = buildPLRows({
    meta,
    amounts,
    columns,
    amountKeys,
    derive,
    hrefFor: accountDetailHref(from, to, { classId }),
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
    subtitle: `${rangeLabel(from, to)}${className ? ` · Class: ${className}` : ''}`,
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
  const [cur, ytd] = await Promise.all([
    activityByAccount(ctx, { from, to, classId: p.classId, excludeClose: true }),
    activityByAccount(ctx, { from: ytdFrom, to, classId: p.classId, excludeClose: true }),
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
    hrefFor: accountDetailHref(ytdFrom, to, { classId: p.classId }),
  });
  return {
    key: 'profit-loss-ytd',
    title: 'Profit & Loss YTD Comparison',
    subtitle: `${rangeLabel(from, to)} vs fiscal year to date`,
    columns,
    rows: built.rows,
  };
}

/** P&L by Class: one column per class (plus Unclassified) and a total. */
export async function profitAndLossByClassReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const act = await activityByAccount(ctx, { from, to, excludeClose: true }, 'class');
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
    hrefFor: accountDetailHref(from, to),
  });
  // Per-class QuickZoom on account rows.
  for (const r of built.rows) {
    const m = /:a:([0-9a-f-]{36})(?::other)?$/.exec(r.id);
    if (!m || r.kind !== 'data') continue;
    r.hrefs = {};
    keys.forEach((k, i) => {
      if (k) r.hrefs![`c${i}`] = stdHref('transaction-detail-by-account', { accountId: m[1], classId: k, from: dayStr(from), to: dayStr(to) });
    });
  }
  return { key: 'pl-by-class', title: 'Profit & Loss by Class', subtitle: rangeLabel(from, to), columns, rows: built.rows };
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
  opts: { summary?: boolean; derive?: (v: Amounts) => Record<string, CellValue> },
): { rows: StdRow[]; balanced: boolean } {
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
    stdHref('transaction-detail-by-account', { accountId: a.id, to: dayStr(cols[0].asOf) });

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
        href: stdHref('balance-sheet-detail', { to: dayStr(cols[0].asOf), section: s }),
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
        rows.push({ id: 'bs:equity:accounts', parentId: 'bs:equity', depth: 2, kind: 'data', cells: cells('Equity accounts', t) });
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
              ? stdHref('profit-loss', { to: dayStr(new Date(new Date(cols[0].bs.fiscalYearStart).getTime() - 1)), from: '1900-01-01' })
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
          ? stdHref('profit-loss', { from: dayStr(new Date(cols[0].bs.fiscalYearStart)), to: dayStr(cols[0].asOf) })
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
      periods.map(async (x) => ({ key: x.key, header: fmtDay(x.to), asOf: x.to, bs: await balanceSheet(ctx, x.to) })),
    );
    subtitle = `As of each ${periodKind} end, ${rangeLabel(from, to)}`;
  } else {
    const asOf = resolveAsOf(p);
    cols = [{ key: 'total', header: fmtDay(asOf), asOf, bs: await balanceSheet(ctx, asOf) }];
    subtitle = `As of ${fmtDay(asOf)}`;
    if (p.compare && p.compare !== 'none') {
      let prior = p.priorAsOf ? parseDay(p.priorAsOf, true)! : shiftYears(asOf, -1);
      if (!p.priorAsOf && p.compare === 'prev_period') {
        prior = new Date(asOf);
        prior.setUTCMonth(prior.getUTCMonth() - 1);
      }
      cols.push({ key: 'prev', header: fmtDay(prior), asOf: prior, bs: await balanceSheet(ctx, prior) });
      extraCols.push({ key: 'chg', header: '$ Change', type: 'money' }, { key: 'pctchg', header: '% Change', type: 'percent' });
      derive = (v) => ({ chg: toAmountString(v[0].minus(v[1])), pctchg: pct(v[0].minus(v[1]), v[1]) });
      subtitle = `As of ${fmtDay(asOf)} vs ${fmtDay(prior)}`;
    }
  }
  const built = buildBSRows(meta, cols, { summary: o.summary, derive });
  return {
    key: o.summary ? 'balance-sheet-summary' : 'balance-sheet',
    title: o.summary ? 'Balance Sheet Summary' : 'Balance Sheet',
    subtitle,
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

export async function trialBalanceReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const meta = await loadAccountMeta(ctx);
  const tb = await trialBalance(ctx, asOf);
  const amounts = new Map<string, Amounts>();
  for (const r of tb.rows) amounts.set(r.accountId, [Money.sub(r.debit, r.credit)]);
  const cells = (label: string, v: Amounts): Record<string, CellValue> => ({
    label,
    debit: v[0].greaterThan(0) ? toAmountString(v[0]) : null,
    credit: v[0].lessThan(0) ? toAmountString(v[0].negated()) : null,
  });
  const tree = buildAccountTree({
    meta,
    amounts,
    ncols: 1,
    idPrefix: 'tb',
    parentRowId: null,
    depth: 0,
    cells,
    hrefFor: (a) => stdHref('transaction-detail-by-account', { accountId: a.id, to: dayStr(asOf) }),
  });
  tree.rows.push({ id: 'tb:total', depth: 0, kind: 'grand', cells: { label: 'TOTAL', debit: tb.totalDebit, credit: tb.totalCredit } });
  return {
    key: 'trial-balance',
    title: 'Trial Balance',
    subtitle: `As of ${fmtDay(asOf)}`,
    columns: [
      { key: 'label', header: '' },
      { key: 'debit', header: 'Debit', type: 'money' },
      { key: 'credit', header: 'Credit', type: 'money' },
    ],
    rows: tree.rows,
    balanced: tb.balanced,
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
  // Order account groups in statement order (Income, COGS, Expense, Other Income, Other Expense).
  const order = (l: GlLine) => PL_SECTIONS.indexOf(l.account.section as PLSection);
  lines.sort((a, b) => order(a) - order(b));
  const laid = layoutDetail(lines, {
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    groupBy: (p.subtotalBy as GroupKey) ?? 'account',
    sortBy: p.sortBy,
    sortDir: p.sortDir,
    natural: true,
    running: (p.subtotalBy ?? 'account') === 'account',
    idPrefix: 'pld',
  });
  // Re-order account groups into statement order (layoutDetail sorts by code).
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
    subtitle: rangeLabel(from, to),
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
  const before = await activityByAccount(ctx, { to: new Date(from.getTime() - 1), accountIds: f.accountIds });
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
    subtitle: rangeLabel(from, to),
    columns: detailColumns(DEFAULT_DETAIL_KEYS),
    rows: laid.rows,
    truncated,
    notes: [
      ...detailNotes(truncated),
      'Retained Earnings and Net Income are calculated lines; see the Balance Sheet for them.',
    ],
  };
}

/** Journal — every posted entry with all of its lines and per-entry debit/credit totals. */
export async function journalReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const f = glFilterFromParams(meta, p, { from, to });
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
    key: 'journal',
    title: 'Journal',
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
  const { lines: hits, truncated } = await fetchGlLines(ctx, meta, f);
  const wanted = by === 'date' ? hits : hits.filter((l) => l.nameType === by);
  const entryIds = [...new Set(wanted.map((l) => l.entryId))];
  const { lines } = await fetchGlLines(ctx, meta, { entryIds });
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
