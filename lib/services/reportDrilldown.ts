/**
 * Report explanations — the transactions behind any number on a standard report.
 *
 * `drilldownCell(ctx, report, params, rowId, column)` runs the report with exactly the options the
 * viewer used (prepareStandardReport: same defaults, relative dates, basis preference,
 * permission check), finds the cell, and rebuilds the set of transactions that produced it on the
 * report's own terms:
 *
 *  - the same basis (accrual / cash — cash-basis lines are the cash-basis ledger's settlement
 *    shares, as on the report), the same date window per column (period columns, previous period
 *    / previous year, fiscal-year-to-date, as-of dates), the same class / customer:job / name
 *    filters, the same exclusion of year-end closing entries on income statements;
 *  - the same row membership (a leaf account, "<Parent> - Other" = the parent's own postings,
 *    "Total <Parent>" = the parent and its sub-accounts in the same section, section totals,
 *    Gross Profit / Net Ordinary Income / Net Income, Retained Earnings = prior fiscal years'
 *    income, Net Income = this fiscal year's income, aging buckets, customers, items, vendors).
 *
 * The result's `total` is the sum of the transactions and `ties` says it equals the cell —
 * guaranteed by construction and asserted by reportDrilldown.test.ts for several reports and
 * both bases. Calculated cells (% columns, averages, margins, cost × quantity) are explained
 * with their formula plus the transactions of the amount they are based on.
 *
 * Read-only: no posting, no data leaves the machine.
 */
import type Decimal from 'decimal.js';
import { Money, formatCurrency, toAmountString } from '@/lib/money';
import type { CellDrilldown, DrillTransaction } from '@/lib/reports/drilldown';
import { isDrilldownReport } from '@/lib/reports/drilldown';
import type { StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { notFound, validation } from './_base';
import { prepareStandardReport } from './reportRegistry';
import { eq } from 'drizzle-orm';
import { classes } from '@/lib/db/schema';
import {
  BS_SECTIONS,
  PL_SECTIONS,
  activityByAccount,
  companyFiscalYearEnd,
  customerNames,
  dayStr,
  entryIdsForSourceRefs,
  fetchGlLines,
  fiscalWindowFor,
  fmtDay,
  glFilterFromParams,
  isPLSection,
  loadAccountMeta,
  parseDay,
  resolveAsOf,
  resolveRange,
  splitPeriods,
  type AccountMeta,
  type BSSection,
  type GlLine,
  type GlLineFilter,
  type PLSection,
  type SectionKey,
} from './reportEngine';
import { previousPeriod, shiftMonths, shiftYears } from './reportsStandard';
import { fiscalYearStartFor } from './reports';
import { openItems, type OpenItem } from './reportsAging';
import { salesLinesOnBasis } from './reportsLists';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** One posting / document share behind a cell, before grouping into transactions. */
interface DrillItem {
  key: string;
  entryId: string | null;
  sourceRef: string | null;
  date: Date;
  type: string;
  num: string;
  name: string;
  memo: string;
  account: string;
  value: Decimal;
}

interface Resolved {
  items: DrillItem[];
  truncated: boolean;
}

interface Formula {
  formula: string;
  /** The amount column the calculated cell is based on. */
  base: string;
}

interface ResolveInput {
  ctx: ServiceContext;
  key: string;
  p: ReportParams;
  report: StdReport;
  row: StdRow;
  column: string;
  meta: Map<string, AccountMeta>;
}

/** A report family: turns (row, column) into its transactions, or a formula over a base column. */
interface Family {
  formulas?: (column: string) => Formula | null;
  resolve: (i: ResolveInput) => Promise<Resolved>;
}

const LINE_CAP = 50000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const glItem = (l: GlLine, value: Decimal): DrillItem => ({
  key: l.entryId || `line:${l.lineId}`,
  entryId: l.entryId || null,
  sourceRef: l.sourceRef,
  date: l.date,
  type: l.type,
  num: l.num,
  name: l.name,
  memo: l.memo,
  account: l.account.fullName,
  value,
});

/** Lines → items through a contribution function (null / zero contributions are dropped). */
function itemsFrom(lines: GlLine[], contrib: (l: GlLine) => Decimal | null): DrillItem[] {
  const out: DrillItem[] = [];
  for (const l of lines) {
    const v = contrib(l);
    if (v && !v.isZero()) out.push(glItem(l, v));
  }
  return out;
}

async function lines(ctx: ServiceContext, meta: Map<string, AccountMeta>, f: GlLineFilter) {
  return fetchGlLines(ctx, meta, { ...f, limit: f.limit ?? LINE_CAP });
}

/**
 * The accounts a "Total <Parent>" / collapsed parent row adds up: the account and its
 * sub-accounts that report in the same section (buildAccountTree nests a child under its parent
 * only within one section).
 */
export function treeMembers(meta: Map<string, AccountMeta>, id: string): Set<string> {
  const root = meta.get(id);
  const out = new Set<string>([id]);
  if (!root) return out;
  const kids = new Map<string, string[]>();
  for (const a of meta.values()) {
    if (a.parentId && a.section === meta.get(a.parentId)?.section) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a.id]);
  }
  const queue = [id];
  while (queue.length) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      if (!out.has(k)) {
        out.add(k);
        queue.push(k);
      }
    }
  }
  return out;
}

/**
 * Accounts of an account row (`<prefix>:a:<id>`, `…:other`, `…:total`, or a collapsed parent
 * heading). A data row without children is the account's own postings.
 */
function accountRowMembers(row: StdRow, meta: Map<string, AccountMeta>): Set<string> | null {
  const m = new RegExp(`^(.*):a:(${UUID})(:other|:total)?$`).exec(row.id);
  if (!m) return null;
  const id = m[2];
  const own = m[3] === ':other' || (!m[3] && row.kind === 'data');
  return own ? new Set([id]) : treeMembers(meta, id);
}

const dollars = (v: Decimal | string) => formatCurrency(Money.round2(Money.of(v)));
const plusMinus = (v: Decimal) => (v.isNegative() ? `−${dollars(v.abs())}` : `+${dollars(v)}`);

// ===========================================================================
// Profit & Loss family
// ===========================================================================

const PL_FAMILY = ['profit-loss', 'profit-loss-prev-year', 'profit-loss-by-month', 'profit-loss-percent', 'profit-loss-ytd', 'pl-by-class', 'profit-loss-by-job'];

const PL_NET_ROWS: Record<string, Partial<Record<PLSection, number>>> = {
  'pl:net': { income: 1, other_income: 1, cogs: -1, expense: -1, other_expense: -1 },
  'pl:gross': { income: 1, cogs: -1 },
  'pl:netordinary': { income: 1, cogs: -1, expense: -1 },
  'pl:netother': { other_income: 1, other_expense: -1 },
};

/** Sign (+1 / −1 / 0) each P&L account carries into a P&L row. */
function plRowSigns(row: StdRow, meta: Map<string, AccountMeta>): (a: AccountMeta) => number {
  const net = PL_NET_ROWS[row.id];
  if (net) return (a) => net[a.section as PLSection] ?? 0;
  const members = accountRowMembers(row, meta);
  if (members) return (a) => (members.has(a.id) && isPLSection(a.section) ? 1 : 0);
  const s = /^pl:([a-z_]+)(?::total)?$/.exec(row.id);
  if (s && (PL_SECTIONS as string[]).includes(s[1])) return (a) => (a.section === s[1] ? 1 : 0);
  throw validation('This line has no transactions behind it.');
}

interface Window {
  from: Date;
  to: Date;
  mult: number;
  /** Extra per-line test (class / customer:job columns). */
  keep?: (l: GlLine) => boolean;
}

/** The date windows (and column buckets) a P&L column covers. */
async function plWindows(i: ResolveInput, filterLines: GlLine[] | null): Promise<Window[]> {
  const { ctx, key, column } = i;
  let p = i.p;
  if (key === 'profit-loss-prev-year') p = { ...p, compare: p.compare ?? 'prev_year' };
  if (key === 'profit-loss-by-month') p = { ...p, columns: p.columns ?? 'month' };
  const { from, to } = await resolveRange(ctx, p);
  const whole: Window = { from, to, mult: 1 };
  if (key === 'profit-loss-ytd') {
    if (column === 'cur') return [whole];
    if (column === 'ytd') return [{ from: fiscalWindowFor(to, await companyFiscalYearEnd(ctx)).start, to, mult: 1 }];
  } else if (key === 'pl-by-class' || key === 'profit-loss-by-job') {
    if (column === 'total') return [whole];
    const m = /^c(\d+)$/.exec(column);
    if (m) {
      const keys = key === 'pl-by-class' ? await classColumnKeys(i) : jobColumnKeys(filterLines ?? []);
      const k = keys[Number(m[1])];
      if (k !== undefined) {
        const keep =
          key === 'pl-by-class'
            ? (l: GlLine) => (l.classId ?? '') === k
            : (l: GlLine) => (l.nameType === 'customer' && l.nameId ? l.nameId : '') === k;
        return [{ ...whole, keep }];
      }
    }
  } else {
    const periodKind = p.columns && p.columns !== 'total' ? p.columns : null;
    const compare = !periodKind && p.compare && p.compare !== 'none' ? p.compare : null;
    if (periodKind) {
      if (column === 'total') return [whole];
      const periods = splitPeriods(from, to, periodKind, await companyFiscalYearEnd(ctx));
      const per = periods.find((x) => x.key === column);
      if (per) return [{ from: per.from, to: per.to, mult: 1 }];
    } else if (compare) {
      const prev = compare === 'prev_year' ? { from: shiftYears(from, -1), to: shiftYears(to, -1) } : previousPeriod(from, to);
      if (column === 'cur') return [whole];
      if (column === 'prev') return [{ ...prev, mult: 1 }];
      if (column === 'chg') return [whole, { ...prev, mult: -1 }];
    } else if (column === 'total') return [whole];
  }
  throw validation('That column has no amounts to explain.');
}

/** pl-by-class column order — the same read profitAndLossByClassReport makes. */
async function classColumnKeys(i: ResolveInput): Promise<string[]> {
  const { ctx, meta } = i;
  const { from, to } = await resolveRange(ctx, i.p);
  const act = await activityByAccount(ctx, { from, to, excludeClose: true, basis: i.p.basis === 'cash' ? 'cash' : undefined }, 'class');
  const used = new Set(act.filter((r) => isPLSection(meta.get(r.accountId)?.section ?? 'equity')).map((r) => r.bucket ?? ''));
  const classRows = await ctx.db.select({ id: classes.id, name: classes.name }).from(classes).where(eq(classes.companyId, ctx.companyId));
  const keys = classRows.filter((c) => used.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.id);
  if (used.has('')) keys.push('');
  return keys;
}

/** profit-loss-by-job column order: customers:jobs by name, then "No customer:job". */
function jobColumnKeys(all: GlLine[]): string[] {
  const names = new Map<string, string>();
  let none = false;
  for (const l of all) {
    const b = l.nameType === 'customer' && l.nameId ? l.nameId : '';
    if (b) names.set(b, l.name || '(unnamed)');
    else none = true;
  }
  const keys = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id]) => id);
  if (none) keys.push('');
  return keys;
}

const plFamily: Family = {
  formulas: (column) => {
    if (column === 'pctchg') return { formula: 'Percent change: the $ change divided by the earlier period’s amount', base: 'chg' };
    if (column === 'pctytd') return { formula: 'This period’s amount divided by the fiscal-year-to-date amount', base: 'cur' };
    const m = /^(.+)_pct$/.exec(column);
    if (m) return { formula: 'Share of income: this amount divided by Total Income for the same column', base: m[1] };
    return null;
  },
  resolve: async (i) => {
    const { ctx, key, p, row, meta } = i;
    const signs = plRowSigns(row, meta);
    const basis = p.basis === 'cash' ? 'cash' : undefined;
    // Class filter: every P&L variant except By Class (which spreads classes into columns).
    const classId = key === 'pl-by-class' ? undefined : p.classId;
    const accountIds = [...meta.values()].filter((a) => isPLSection(a.section) && signs(a) !== 0).map((a) => a.id);
    // By Job needs the whole period's lines to rebuild its column order.
    let jobLines: GlLine[] | null = null;
    if (key === 'profit-loss-by-job') {
      const { from, to } = await resolveRange(ctx, p);
      const f = glFilterFromParams(meta, { basis: p.basis, classId: p.classId }, { from, to });
      f.sections = [...PL_SECTIONS];
      f.excludeClose = true;
      jobLines = (await lines(ctx, meta, f)).lines;
    }
    const windows = await plWindows(i, jobLines);
    const items: DrillItem[] = [];
    let truncated = false;
    for (const w of windows) {
      const got = await lines(ctx, meta, { from: w.from, to: w.to, classId, excludeClose: true, basis, accountIds });
      truncated ||= got.truncated;
      items.push(
        ...itemsFrom(got.lines, (l) => {
          const s = signs(l.account);
          if (!s || (w.keep && !w.keep(l))) return null;
          return l.natural.times(s * w.mult);
        }),
      );
    }
    return { items, truncated };
  },
};

// ===========================================================================
// Balance sheet family
// ===========================================================================

const BS_FAMILY = ['balance-sheet', 'balance-sheet-prev-year', 'balance-sheet-summary', 'balance-sheet-by-period'];
const CURRENT_ASSETS: BSSection[] = ['bank', 'ar', 'other_current_asset'];
const ASSETS: BSSection[] = [...CURRENT_ASSETS, 'fixed_asset', 'other_asset'];
const CURRENT_LIABS: BSSection[] = ['ap', 'credit_card', 'other_current_liability'];
const LIABS: BSSection[] = [...CURRENT_LIABS, 'long_term_liability'];

/** As-of date of each balance-sheet column (the same choices balanceSheetReport makes). */
async function bsColumnDates(ctx: ServiceContext, key: string, p: ReportParams): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const periodKind =
    key === 'balance-sheet-by-period' ? (p.columns && p.columns !== 'total' ? p.columns : 'month') : p.columns && p.columns !== 'total' ? p.columns : null;
  const compare = key === 'balance-sheet-prev-year' ? (p.compare && p.compare !== 'none' ? p.compare : 'prev_year') : p.compare;
  if (periodKind) {
    const { from, to } = await resolveRange(ctx, p);
    for (const x of splitPeriods(from, to, periodKind, await companyFiscalYearEnd(ctx))) out.set(x.key, x.to);
    return out;
  }
  const asOf = resolveAsOf(p);
  out.set('total', asOf);
  if (compare && compare !== 'none') {
    let prior = p.priorAsOf ? parseDay(p.priorAsOf, true)! : shiftYears(asOf, -1);
    if (!p.priorAsOf && compare === 'prev_period') prior = shiftMonths(asOf, -1);
    out.set('prev', prior);
  }
  return out;
}

interface BsSelection {
  account: (a: AccountMeta) => boolean;
  /** Income and expenses of prior fiscal years (Retained Earnings). */
  priorPL: boolean;
  /** Income and expenses of the current fiscal year (Net Income). */
  currentPL: boolean;
}

function bsSelection(row: StdRow, meta: Map<string, AccountMeta>): BsSelection {
  const inSecs = (secs: SectionKey[]) => (a: AccountMeta) => secs.includes(a.section);
  const reAccount = [...meta.values()]
    .filter((a) => a.section === 'equity' && /retained/.test(a.subtype))
    .sort((a, b) => a.code.localeCompare(b.code))[0];
  const members = accountRowMembers(row, meta);
  if (members) return { account: (a) => members.has(a.id), priorPL: !!reAccount && members.has(reAccount.id), currentPL: false };
  const id = row.id.replace(/:total$/, '');
  switch (id) {
    case 'bs:re':
      return { account: () => false, priorPL: true, currentPL: false };
    case 'bs:ni':
      return { account: () => false, priorPL: false, currentPL: true };
    case 'bs:equity':
      return { account: inSecs(['equity']), priorPL: true, currentPL: true };
    case 'bs:equity:accounts':
      return { account: inSecs(['equity']), priorPL: true, currentPL: false };
    case 'bs:le':
      return { account: inSecs([...LIABS, 'equity']), priorPL: true, currentPL: true };
    case 'bs:assets':
      return { account: inSecs(ASSETS), priorPL: false, currentPL: false };
    case 'bs:current_assets':
      return { account: inSecs(CURRENT_ASSETS), priorPL: false, currentPL: false };
    case 'bs:liabilities':
      return { account: inSecs(LIABS), priorPL: false, currentPL: false };
    case 'bs:current_liabilities':
      return { account: inSecs(CURRENT_LIABS), priorPL: false, currentPL: false };
  }
  const s = /^bs:([a-z_]+)$/.exec(id);
  if (s && (BS_SECTIONS as string[]).includes(s[1])) {
    return { account: inSecs([s[1] as SectionKey]), priorPL: false, currentPL: false };
  }
  throw validation('This line has no transactions behind it.');
}

const bsFamily: Family = {
  formulas: (column) => (column === 'pctchg' ? { formula: 'Percent change: the $ change divided by the earlier balance', base: 'chg' } : null),
  resolve: async ({ ctx, key, p, row, column, meta }) => {
    const sel = bsSelection(row, meta);
    const basis = p.basis === 'cash' ? 'cash' : undefined;
    const dates = await bsColumnDates(ctx, key, p);
    const windows: { asOf: Date; mult: number }[] =
      column === 'chg' && dates.has('prev')
        ? [{ asOf: dates.get('total')!, mult: 1 }, { asOf: dates.get('prev')!, mult: -1 }]
        : dates.has(column)
          ? [{ asOf: dates.get(column)!, mult: 1 }]
          : [];
    if (!windows.length) throw validation('That column has no amounts to explain.');
    const isPL = (a: AccountMeta) => a.type === 'revenue' || a.type === 'expense';
    const accountIds = [...meta.values()]
      .filter((a) => (isPL(a) ? sel.priorPL || sel.currentPL : sel.account(a)))
      .map((a) => a.id);
    const items: DrillItem[] = [];
    let truncated = false;
    for (const w of windows) {
      const fyStart = await fiscalYearStartFor(ctx, w.asOf);
      const got = await lines(ctx, meta, { to: w.asOf, basis, accountIds });
      truncated ||= got.truncated;
      items.push(
        ...itemsFrom(got.lines, (l) => {
          if (isPL(l.account)) {
            const wanted = l.date < fyStart ? sel.priorPL : sel.currentPL;
            // Earnings are credits − debits (they raise equity).
            return wanted ? l.credit.minus(l.debit).times(w.mult) : null;
          }
          return sel.account(l.account) ? l.natural.times(w.mult) : null;
        }),
      );
    }
    return { items, truncated };
  },
};

// ===========================================================================
// Trial balance
// ===========================================================================

const tbFamily: Family = {
  resolve: async ({ ctx, p, row, column, meta }) => {
    if (column !== 'debit' && column !== 'credit') throw validation('That column has no amounts to explain.');
    const asOf = resolveAsOf(p);
    const basis = p.basis === 'cash' ? 'cash' : undefined;
    const sign = column === 'debit' ? 1 : -1;
    if (row.id === 'tb:total') {
      const got = await lines(ctx, meta, { to: asOf, basis });
      const bal = new Map<string, Decimal>();
      for (const l of got.lines) bal.set(l.accountId, (bal.get(l.accountId) ?? Money.zero()).plus(l.amount));
      // TOTAL Debit = every account with a debit balance; TOTAL Credit = every credit balance.
      const keep = (id: string) => {
        const b = bal.get(id) ?? Money.zero();
        return column === 'debit' ? b.greaterThan(0) : b.lessThan(0);
      };
      return { items: itemsFrom(got.lines, (l) => (keep(l.accountId) ? l.amount.times(sign) : null)), truncated: got.truncated };
    }
    const members = accountRowMembers(row, meta);
    if (!members) throw validation('This line has no transactions behind it.');
    const got = await lines(ctx, meta, { to: asOf, basis, accountIds: [...members] });
    return { items: itemsFrom(got.lines, (l) => l.amount.times(sign)), truncated: got.truncated };
  },
};

// ===========================================================================
// General ledger
// ===========================================================================

const glFamily: Family = {
  resolve: async ({ ctx, p, report, row, column, meta }) => {
    if (!['debit', 'credit', 'amount', 'balance'].includes(column)) throw validation('That column has no amounts to explain.');
    const { from, to } = await resolveRange(ctx, p);
    const f = glFilterFromParams(meta, p, { from, to });
    // Exactly the report's own read (same filter, same 10,000-line cap) so line ids match.
    const got = await fetchGlLines(ctx, meta, f);
    const byId = new Map(got.lines.map((l) => [l.lineId, l]));
    const value = (l: GlLine) => (column === 'debit' ? l.debit : column === 'credit' ? l.credit : l.natural);

    // Which group (account) and which of its lines the cell covers.
    let groupId: string;
    let lineIds: string[];
    let withOpening = column === 'balance';
    const lm = /^gl:l:(.+)$/.exec(row.id);
    if (lm) {
      const l = byId.get(lm[1]);
      if (!l) throw notFound('Report line');
      groupId = row.parentId ?? '';
      if (column !== 'balance') return { items: itemsFrom([l], value), truncated: false };
      // Running balance: the opening balance plus every line of the group up to this one.
      lineIds = [];
      for (const r of report.rows) {
        if (r.parentId !== groupId) continue;
        const m = /^gl:l:(.+)$/.exec(r.id);
        if (m) lineIds.push(m[1]);
        if (r.id === row.id) break;
      }
    } else {
      const g = /^(gl:g:account:[^:]+)(:open|:total)?$/.exec(row.id);
      if (!g) throw validation('This line has no transactions behind it.');
      groupId = g[1];
      if (g[2] === ':open') {
        if (column !== 'balance') throw validation('That column has no amounts to explain.');
        lineIds = [];
      } else {
        lineIds = report.rows.filter((r) => r.parentId === groupId && r.id.startsWith('gl:l:')).map((r) => r.id.slice('gl:l:'.length));
      }
    }
    const accountId = groupId.slice('gl:g:account:'.length);
    const items = itemsFrom(
      lineIds.map((id) => byId.get(id)).filter((l): l is GlLine => !!l),
      value,
    );
    // Beginning balance (only shown when no line filter is on — see generalLedgerReport).
    const hasOpening = report.rows.some((r) => r.id === `${groupId}:open`);
    if (withOpening && hasOpening) {
      const a = meta.get(accountId);
      if (a) {
        const dayBefore = new Date(from.getTime() - 1);
        const basis = f.basis;
        let opening: GlLine[];
        if (isPLSection(a.section)) {
          const fyStart = fiscalWindowFor(from, await companyFiscalYearEnd(ctx)).start;
          opening = fyStart < from ? (await lines(ctx, meta, { from: fyStart, to: dayBefore, accountIds: [accountId], basis, excludeClose: true })).lines : [];
        } else {
          opening = (await lines(ctx, meta, { to: dayBefore, accountIds: [accountId], basis })).lines;
        }
        items.unshift(...itemsFrom(opening, (l) => l.natural));
      }
    }
    return { items, truncated: got.truncated };
  },
};

// ===========================================================================
// A/R and A/P aging, Open Invoices, Collections
// ===========================================================================

const AGING_SOURCE: Partial<Record<OpenItem['docType'], string>> = {
  invoice: 'invoice',
  credit_memo: 'credit_memo',
  bill: 'bill',
  vendor_credit: 'vendor_credit',
};

const openItem = (it: OpenItem): DrillItem => ({
  key: `${it.docType}:${it.docId}`,
  entryId: it.entryId,
  sourceRef: AGING_SOURCE[it.docType] ? `${AGING_SOURCE[it.docType]}:${it.docId}` : null,
  date: parseDay(it.date.slice(0, 10))!,
  type: it.typeLabel,
  num: it.docLabel,
  name: it.entityName,
  memo:
    it.aging === null
      ? 'Unapplied credit'
      : it.aging > 0
        ? `${it.aging} day${it.aging === 1 ? '' : 's'} past due`
        : it.dueDate
          ? `Due ${fmtDay(parseDay(it.dueDate.slice(0, 10))!)}`
          : 'Current',
  account: it.column.label,
  value: Money.of(it.openBalance),
});

function agingFamily(side: 'ar' | 'ap', kind: 'summary' | 'detail' | 'open-invoices' | 'collections-report'): Family {
  return {
    resolve: async ({ ctx, p, row, column, report }) => {
      const params = kind === 'open-invoices' || kind === 'collections-report' ? { ...p, agingFrom: 'due_date' as const } : p;
      let { items } = await openItems(ctx, side, params);
      if (kind === 'collections-report') items = items.filter((i) => i.aging !== null && i.aging > 0);
      let pick: (it: OpenItem) => boolean;
      if (kind === 'summary') {
        const cols = report.columns.filter((c) => c.type === 'money').map((c) => c.key);
        if (!cols.includes(column)) throw validation('That column has no amounts to explain.');
        const byCol = column === 'total' ? () => true : (it: OpenItem) => it.column.key === column;
        if (row.id === 'ag:grand') pick = byCol;
        else {
          const m = /^ag:(.+)$/.exec(row.id);
          if (!m) throw validation('This line has no transactions behind it.');
          pick = (it) => it.entityId === m[1] && byCol(it);
        }
      } else {
        if (column !== 'open') throw validation('That column has no amounts to explain.');
        const prefix = kind === 'detail' ? 'agd' : kind;
        const id = row.id.replace(/:total$/, '');
        if (id === `${prefix}:grand`) pick = () => true;
        else {
          const doc = new RegExp(`^${prefix}:([^:]+):([a-z_]+):(${UUID})$`).exec(id);
          const group = new RegExp(`^${prefix}:([^:]+)$`).exec(id);
          if (doc) pick = (it) => it.docType === doc[2] && it.docId === doc[3] && (kind === 'detail' ? it.column.key === doc[1] : it.entityId === doc[1]);
          else if (group) pick = kind === 'detail' ? (it) => it.column.key === group[1] : (it) => it.entityId === group[1];
          else throw validation('This line has no transactions behind it.');
        }
      }
      return { items: items.filter(pick).map(openItem).filter((x) => !x.value.isZero()), truncated: false };
    },
  };
}

// ===========================================================================
// Sales by Customer / Item summaries
// ===========================================================================

function salesFamily(by: 'customer' | 'item'): Family {
  return {
    formulas: (column) => {
      if (by !== 'item') return null;
      const f: Record<string, string> = {
        pct: 'This item’s sales divided by total sales',
        avgPrice: 'Average price: the amount divided by the quantity sold',
        cogs: 'Cost of goods sold: the quantity sold times the item’s average cost',
        avgCogs: 'Average cost: COGS divided by the quantity sold',
        margin: 'Gross margin: the amount minus COGS',
        marginPct: 'Gross margin divided by the amount',
      };
      return f[column] ? { formula: f[column], base: 'amount' } : null;
    },
    resolve: async ({ ctx, p, report, row, column }) => {
      if (column !== 'amount') throw validation('That column has no amounts to explain.');
      const { from, to } = await resolveRange(ctx, p);
      const basis = p.basis === 'cash' ? 'cash' : undefined;
      const all = await salesLinesOnBasis(ctx, { from, to }, { customerId: p.customerId, itemId: p.itemId, classId: p.classId }, basis);
      let pick: (l: (typeof all)[number]) => boolean;
      if (by === 'customer') {
        if (row.id === 'sbc:grand') pick = () => true;
        else {
          const m = /^sbc:(.+)$/.exec(row.id);
          if (!m) throw validation('This line has no transactions behind it.');
          const id = m[1] === 'none' ? '' : m[1];
          pick = (l) => (l.customerId ?? '') === id;
        }
      } else if (row.id === 'sbi:grand') {
        pick = () => true;
      } else {
        const heading = row.kind === 'section' ? row.id : row.totalOf ?? null;
        const itemOf = (r: StdRow) => {
          const x = r.id.slice((r.parentId ?? '').length + 1);
          return x === 'none' ? '' : x;
        };
        if (heading) {
          const ids = new Set(report.rows.filter((r) => r.parentId === heading).map(itemOf));
          pick = (l) => ids.has(l.itemId ?? '');
        } else if (row.parentId && row.id.startsWith(`${row.parentId}:`)) {
          const id = itemOf(row);
          pick = (l) => (l.itemId ?? '') === id;
        } else throw validation('This line has no transactions behind it.');
      }
      const chosen = all.filter(pick);
      const names = await customerNames(ctx);
      const entryIds = await entryIdsForSourceRefs(ctx, chosen.filter((l) => l.entryId === undefined).map((l) => l.sourceRef));
      const items: DrillItem[] = chosen
        .filter((l) => !l.amount.isZero())
        .map((l) => {
          const entryId = l.entryId !== undefined ? l.entryId : (entryIds.get(l.sourceRef) ?? null);
          return {
            key: `${l.sourceRef}|${l.entryId ?? ''}|${dayStr(l.date)}`,
            entryId,
            sourceRef: l.sourceRef,
            date: l.date,
            type: l.type,
            num: l.num,
            name: l.customerId ? (names.get(l.customerId)?.name ?? '') : '',
            memo: l.memo,
            account: l.item || '(no item)',
            value: l.amount,
          };
        });
      return { items, truncated: false };
    },
  };
}

// ===========================================================================
// Expenses by Vendor Summary
// ===========================================================================

const EXPENSE_SECTIONS: SectionKey[] = ['cogs', 'expense', 'other_expense'];

const expensesFamily: Family = {
  resolve: async ({ ctx, p, row, column, meta }) => {
    if (column !== 'amount') throw validation('That column has no amounts to explain.');
    const { from, to } = await resolveRange(ctx, p);
    const f = glFilterFromParams(meta, { ...p, vendorId: undefined }, { from, to });
    f.sections = EXPENSE_SECTIONS;
    f.excludeClose = true;
    const got = await lines(ctx, meta, f);
    let pick: (l: GlLine) => boolean;
    if (row.id === 'ebv:grand') pick = () => true;
    else {
      const m = /^ebv:(.+)$/.exec(row.id);
      if (!m) throw validation('This line has no transactions behind it.');
      const id = m[1] === 'none' ? '' : m[1];
      pick = (l) => (l.nameType === 'vendor' && l.nameId ? l.nameId : '') === id;
    }
    return { items: itemsFrom(got.lines, (l) => (pick(l) ? l.natural : null)), truncated: got.truncated };
  },
};

// ===========================================================================
// Registry
// ===========================================================================

function familyFor(key: string): Family | null {
  if (PL_FAMILY.includes(key)) return plFamily;
  if (BS_FAMILY.includes(key)) return bsFamily;
  switch (key) {
    case 'trial-balance':
      return tbFamily;
    case 'general-ledger':
      return glFamily;
    case 'ar-aging-summary':
      return agingFamily('ar', 'summary');
    case 'ap-aging-summary':
      return agingFamily('ap', 'summary');
    case 'ar-aging-detail':
      return agingFamily('ar', 'detail');
    case 'ap-aging-detail':
      return agingFamily('ap', 'detail');
    case 'open-invoices':
      return agingFamily('ar', 'open-invoices');
    case 'collections-report':
      return agingFamily('ar', 'collections-report');
    case 'sales-by-customer-summary':
      return salesFamily('customer');
    case 'sales-by-item-summary':
      return salesFamily('item');
    case 'expenses-by-vendor-summary':
      return expensesFamily;
  }
  return null;
}

// ===========================================================================
// Entry point
// ===========================================================================

export interface DrilldownOptions {
  /** Maximum transactions returned (the count and largest always cover all of them). */
  limit?: number;
  /** Tooltip mode: count, total and largest only (no transaction list). */
  brief?: boolean;
  now?: Date;
}

function toTxn(t: { key: string; entryId: string | null; sourceRef: string | null; date: Date; type: string; num: string; name: string; memo: string; accounts: Set<string>; value: Decimal }): DrillTransaction {
  const accts = [...t.accounts];
  return {
    key: t.key,
    entryId: t.entryId,
    sourceRef: t.sourceRef,
    date: dayStr(t.date),
    type: t.type,
    num: t.num,
    name: t.name,
    memo: t.memo,
    account: accts.length > 3 ? `${accts.slice(0, 3).join(', ')} +${accts.length - 3} more` : accts.join(', '),
    amount: toAmountString(t.value),
  };
}

/** Group posting-level items into transactions (one per journal entry / document share). */
export function groupTransactions(items: DrillItem[]): DrillTransaction[] {
  const by = new Map<string, { key: string; entryId: string | null; sourceRef: string | null; date: Date; type: string; num: string; name: string; memo: string; accounts: Set<string>; value: Decimal }>();
  for (const it of items) {
    const cur = by.get(it.key);
    if (!cur) {
      by.set(it.key, { ...it, accounts: new Set(it.account ? [it.account] : []), value: it.value });
      continue;
    }
    cur.value = cur.value.plus(it.value);
    if (it.account) cur.accounts.add(it.account);
    if (!cur.name && it.name) cur.name = it.name;
    if (it.date < cur.date) cur.date = it.date;
  }
  return [...by.values()]
    .map(toTxn)
    .sort((a, b) => a.date.localeCompare(b.date) || a.num.localeCompare(b.num, undefined, { numeric: true }) || a.key.localeCompare(b.key));
}

const mdy = (s: string) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;

/** "Made of 12 transactions, largest $1,200.00 (Acme Corp, 03/14/2026)." */
export function explainText(count: number, largest: DrillTransaction | null): string {
  if (count === 0 || !largest) return 'No transactions are behind this amount for these report settings.';
  const who = largest.name || [largest.type, largest.num].filter(Boolean).join(' ') || 'no name';
  const detail = `${dollars(largest.amount)} (${who}, ${mdy(largest.date)})`;
  return count === 1 ? `Made of 1 transaction: ${detail}.` : `Made of ${count.toLocaleString('en-US')} transactions, largest ${detail}.`;
}

/** Value of a cell, including a collapsed heading's rolled-up amount. */
function cellOf(row: StdRow, column: string): string | null {
  const v = row.cells[column] ?? (row.kind === 'section' ? row.collapsedCells?.[column] : undefined) ?? null;
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * The transactions behind one report number, rebuilt on the report's own basis, dates and
 * filters. Throws NOT_FOUND for an unknown report / line, VALIDATION for a column or line that
 * has nothing to explain, FORBIDDEN without the report's area permission.
 */
export async function drilldownCell(
  ctx: ServiceContext,
  key: string,
  rawParams: URLSearchParams | Record<string, unknown>,
  rowId: string,
  column: string,
  opts: DrilldownOptions = {},
): Promise<CellDrilldown> {
  // Permission + parameter normalization first (unknown report → NOT_FOUND, no area → FORBIDDEN).
  const { entry, runner, params } = await prepareStandardReport(ctx, key, rawParams, { now: opts.now });
  const family = isDrilldownReport(key) ? familyFor(key) : null;
  if (!family) throw validation('Explanations are not available for this report.');
  if (typeof rowId !== 'string' || !rowId || rowId.length > 300) throw validation('Choose a line of the report.');
  if (typeof column !== 'string' || !column || column.length > 60) throw validation('Choose a column of the report.');

  const report = await runner(ctx, params);
  const row = report.rows.find((r) => r.id === rowId);
  if (!row) throw notFound('Report line');
  const col = report.columns.find((c) => c.key === column);
  if (!col || (col.type !== 'money' && col.type !== 'percent')) throw validation('That column has no amounts to explain.');
  const meta = await loadAccountMeta(ctx);

  const formula = family.formulas?.(column) ?? null;
  const resolvedColumn = formula ? formula.base : column;
  if (formula && !report.columns.some((c) => c.key === resolvedColumn)) throw validation('That column has no amounts to explain.');
  if (!formula && col.type !== 'money') throw validation('That column has no amounts to explain.');

  const { items, truncated } = await family.resolve({ ctx, key, p: params, report, row, column: resolvedColumn, meta });
  const txns = groupTransactions(items);
  const total = items.reduce((s, it) => s.plus(it.value), Money.zero());
  let largest: DrillTransaction | null = null;
  for (const t of txns) if (!largest || Money.of(t.amount).abs().greaterThan(Money.of(largest.amount).abs())) largest = t;

  const cell = cellOf(row, column);
  const baseCell = cellOf(row, resolvedColumn);
  const label0 = report.columns[0]?.key ?? 'label';
  const rowLabel =
    String(row.cells[label0] ?? row.collapsedCells?.[label0] ?? '').trim() ||
    [row.cells.type, row.cells.num, row.cells.name].filter(Boolean).join(' ') ||
    'This line';
  const columnLabel = col.header || report.title;
  const basis = entry.basis ? (params.basis === 'cash' ? 'cash' : 'accrual') : undefined;
  const scope = [rowLabel, col.header && col.header !== report.subtitle ? col.header : '', report.subtitle ?? '', basis && !report.subtitle?.includes('Cash') ? 'Accrual basis' : '']
    .filter(Boolean)
    .join(' · ');
  let explanation = explainText(txns.length, largest);
  if (formula) explanation = `${formula.formula}. ${explanation}`;
  const limit = opts.brief ? 0 : Math.max(0, Math.min(opts.limit ?? 1000, 5000));
  return {
    report: key,
    rowId,
    column,
    rowLabel,
    columnLabel,
    kind: formula ? 'formula' : 'transactions',
    formula: formula?.formula,
    cell,
    total: toAmountString(total),
    ties: formula ? baseCell !== null && Money.eq(total, baseCell) : cell !== null ? Money.eq(total, cell) : total.isZero(),
    count: txns.length,
    largest,
    transactions: txns.slice(0, limit),
    truncated: truncated || txns.length > limit,
    explanation,
    scope,
    basis,
  };
}

/** For tests / callers: the change text used by summaries ("+$1,200.00" / "−$300.00"). */
export const signedDollars = plusMinus;
