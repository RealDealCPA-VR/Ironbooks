/**
 * Report engine — the shared building blocks every standard report is made of:
 *
 *  - sectionForAccount(type, subtype): which statement section an account reports in
 *    (Income / COGS / Expense / Other Income / Other Expense, and the balance-sheet sections).
 *    Works with today's account types + subtypes AND with the QuickBooks account types the
 *    foundation package adds (cost_of_goods_sold, other_income, other_expense, bank, …).
 *  - account metadata + sub-account roll-up (parent rows with indented children,
 *    "<Parent> - Other" for the parent's own postings and "Total <Parent>").
 *  - P&L / balance-sheet row builders over any number of amount columns.
 *  - period bucketing (month / quarter / year, fiscal-year aware).
 *  - the detail-line engine: posted journal lines with QB-style Type / Num / Name / Split /
 *    Cleared columns and the full report filter set (account, name, transaction type, amount
 *    range, cleared status, class, memo, number), sorting and subtotal grouping.
 *
 * Everything reads POSTED journal lines (the source of truth) — never cached balances — and
 * every amount is Decimal (lib/money.ts).
 */
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  accounts,
  bills,
  classes,
  companies,
  creditMemos,
  customers,
  employees,
  expenseReports,
  expenses,
  invoices,
  itemReceipts,
  journalEntries,
  journalEntryLines,
  paychecks,
  paymentsReceived,
  salesReceipts,
  taxAgencies,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString, type MoneyInput } from '@/lib/money';
import type { CellValue, StdColumn, StdRow } from '@/lib/reports/types';
import type { ReportParams, TxnTypeKey } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { validation } from './_base';
import { fiscalYearWindow } from './fiscalClose';
import { notFiscalCloseEntry } from './reports';

// ===========================================================================
// Sections
// ===========================================================================

export type PLSection = 'income' | 'cogs' | 'expense' | 'other_income' | 'other_expense';
export type BSSection =
  | 'bank'
  | 'ar'
  | 'other_current_asset'
  | 'fixed_asset'
  | 'other_asset'
  | 'ap'
  | 'credit_card'
  | 'other_current_liability'
  | 'long_term_liability'
  | 'equity';
export type SectionKey = PLSection | BSSection;

export const PL_SECTIONS: PLSection[] = ['income', 'cogs', 'expense', 'other_income', 'other_expense'];
export const BS_SECTIONS: BSSection[] = [
  'bank',
  'ar',
  'other_current_asset',
  'fixed_asset',
  'other_asset',
  'ap',
  'credit_card',
  'other_current_liability',
  'long_term_liability',
  'equity',
];

export const SECTION_LABELS: Record<SectionKey, string> = {
  income: 'Income',
  cogs: 'Cost of Goods Sold',
  expense: 'Expense',
  other_income: 'Other Income',
  other_expense: 'Other Expense',
  bank: 'Checking/Savings',
  ar: 'Accounts Receivable',
  other_current_asset: 'Other Current Assets',
  fixed_asset: 'Fixed Assets',
  other_asset: 'Other Assets',
  ap: 'Accounts Payable',
  credit_card: 'Credit Cards',
  other_current_liability: 'Other Current Liabilities',
  long_term_liability: 'Long Term Liabilities',
  equity: 'Equity',
};

const norm = (s: string | null | undefined) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const BANK_SUBTYPES = new Set(['checking', 'savings', 'bank', 'cash', 'cash_on_hand', 'money_market', 'petty_cash']);
const AR_SUBTYPES = new Set(['accounts_receivable', 'ar', 'a/r']);
const FIXED_SUBTYPES = new Set(['fixed_assets', 'fixed_asset', 'machinery_and_equipment', 'buildings', 'vehicles', 'furniture_and_fixtures', 'land', 'accumulated_depreciation']);
const OTHER_ASSET_SUBTYPES = new Set(['other_asset', 'other_assets', 'intangible_assets', 'long_term_asset', 'security_deposits']);
const AP_SUBTYPES = new Set(['accounts_payable', 'ap', 'a/p']);
const CC_SUBTYPES = new Set(['credit_card']);
const LTL_SUBTYPES = new Set(['long_term_liability', 'long_term_liabilities', 'notes_payable_long_term', 'loan_long_term']);
const COGS_NAMES = new Set(['cost_of_goods_sold', 'cogs', 'cost_of_sales']);
const OTHER_INCOME_NAMES = new Set(['other_income']);
const OTHER_EXPENSE_NAMES = new Set(['other_expense', 'other_expenses']);

/**
 * The statement section an account reports in. Accepts the account `type` and `subtype` as
 * strings so it keeps working when the account-type enum grows (the foundation package adds
 * QuickBooks account types such as cost_of_goods_sold / other_income / other_expense, either as
 * subtypes of revenue/expense or as types in their own right).
 */
export function sectionForAccount(type: string, subtype?: string | null): SectionKey {
  const t = norm(type);
  const s = norm(subtype);

  // QB account types used directly as the type.
  if (COGS_NAMES.has(t)) return 'cogs';
  if (OTHER_INCOME_NAMES.has(t)) return 'other_income';
  if (OTHER_EXPENSE_NAMES.has(t)) return 'other_expense';
  if (t === 'bank') return 'bank';
  if (AR_SUBTYPES.has(t)) return 'ar';
  if (t === 'other_current_asset') return 'other_current_asset';
  if (FIXED_SUBTYPES.has(t)) return 'fixed_asset';
  if (OTHER_ASSET_SUBTYPES.has(t)) return 'other_asset';
  if (AP_SUBTYPES.has(t)) return 'ap';
  if (CC_SUBTYPES.has(t)) return 'credit_card';
  if (t === 'other_current_liability') return 'other_current_liability';
  if (LTL_SUBTYPES.has(t)) return 'long_term_liability';

  if (t === 'revenue' || t === 'income') {
    return OTHER_INCOME_NAMES.has(s) ? 'other_income' : 'income';
  }
  if (t === 'expense' || t === 'expenses') {
    if (COGS_NAMES.has(s)) return 'cogs';
    if (OTHER_EXPENSE_NAMES.has(s)) return 'other_expense';
    return 'expense';
  }
  if (t === 'asset') {
    if (BANK_SUBTYPES.has(s)) return 'bank';
    if (AR_SUBTYPES.has(s)) return 'ar';
    if (FIXED_SUBTYPES.has(s)) return 'fixed_asset';
    if (OTHER_ASSET_SUBTYPES.has(s)) return 'other_asset';
    return 'other_current_asset';
  }
  if (t === 'liability') {
    if (AP_SUBTYPES.has(s)) return 'ap';
    if (CC_SUBTYPES.has(s)) return 'credit_card';
    if (LTL_SUBTYPES.has(s)) return 'long_term_liability';
    return 'other_current_liability';
  }
  if (t === 'equity') return 'equity';
  return 'expense';
}

export function isPLSection(s: SectionKey): s is PLSection {
  return (PL_SECTIONS as string[]).includes(s);
}

/** Debit-normal sections (amount = debit − credit); the rest are credit-normal. */
export function isDebitNormal(s: SectionKey): boolean {
  return (
    s === 'bank' ||
    s === 'ar' ||
    s === 'other_current_asset' ||
    s === 'fixed_asset' ||
    s === 'other_asset' ||
    s === 'cogs' ||
    s === 'expense' ||
    s === 'other_expense'
  );
}

/** Natural-sign amount of debit/credit totals for a section. */
export function naturalAmount(section: SectionKey, debit: MoneyInput, credit: MoneyInput): Decimal {
  const d = Money.sub(debit, credit);
  return isDebitNormal(section) ? d : d.negated();
}

// ===========================================================================
// Account metadata
// ===========================================================================

export interface AccountMeta {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  parentId: string | null;
  isActive: boolean;
  section: SectionKey;
  /** "Parent:Child" full name. */
  fullName: string;
}

export async function loadAccountMeta(ctx: ServiceContext): Promise<Map<string, AccountMeta>> {
  const rows = await ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const map = new Map<string, AccountMeta>();
  for (const r of rows) {
    map.set(r.id, {
      ...r,
      type: String(r.type),
      subtype: String(r.subtype),
      section: sectionForAccount(String(r.type), String(r.subtype)),
      fullName: r.name,
    });
  }
  for (const a of map.values()) {
    const names: string[] = [a.name];
    let p = a.parentId;
    const seen = new Set<string>([a.id]);
    while (p && map.has(p) && !seen.has(p)) {
      seen.add(p);
      names.unshift(map.get(p)!.name);
      p = map.get(p)!.parentId;
    }
    a.fullName = names.join(':');
  }
  return map;
}

/** The account and all of its descendants (for "include sub-accounts" filters). */
export function accountWithDescendants(meta: Map<string, AccountMeta>, id: string): string[] {
  const out = [id];
  const kids = new Map<string, string[]>();
  for (const a of meta.values()) {
    if (a.parentId) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a.id]);
  }
  for (let i = 0; i < out.length; i++) {
    for (const k of kids.get(out[i]) ?? []) if (!out.includes(k)) out.push(k);
  }
  return out;
}

// ===========================================================================
// Sub-account roll-up
// ===========================================================================

export type Amounts = Decimal[];

export const zeros = (n: number): Amounts => Array.from({ length: n }, () => Money.zero());
export const addInto = (a: Amounts, b: Amounts) => {
  for (let i = 0; i < a.length; i++) a[i] = a[i].plus(b[i] ?? 0);
};
export const anyNonZero = (a: Amounts) => a.some((v) => !v.isZero());

export interface TreeOptions {
  meta: Map<string, AccountMeta>;
  /** Natural-sign amounts per account per column. */
  amounts: Map<string, Amounts>;
  ncols: number;
  /** Unique prefix for row ids. */
  idPrefix: string;
  parentRowId: string | null;
  depth: number;
  /** Turn a label + amounts into row cells (the caller owns the column layout). */
  cells: (label: string, values: Amounts) => Record<string, CellValue>;
  /** QuickZoom target for an account row. */
  hrefFor?: (acct: AccountMeta) => string | undefined;
  /** Keep accounts whose amounts are all zero (default false). */
  includeZero?: boolean;
}

/**
 * Sub-account roll-up for one section: parents with indented children, "<Parent> - Other" for
 * the parent's own postings, and "Total <Parent>". Returns the rows and the section total (which
 * is exactly the sum of the leaf amounts — roll-up never changes a total).
 */
export function buildAccountTree(opts: TreeOptions): { rows: StdRow[]; total: Amounts } {
  const { meta, amounts, ncols } = opts;
  const ids = [...amounts.keys()].filter(
    (id) => meta.has(id) && (opts.includeZero || anyNonZero(amounts.get(id)!)),
  );
  const sectionOf = (id: string) => meta.get(id)!.section;
  // Candidate set = accounts with amounts + their ancestors in the SAME section.
  const inSet = new Set<string>(ids);
  for (const id of ids) {
    const sec = sectionOf(id);
    let p = meta.get(id)!.parentId;
    const seen = new Set<string>([id]);
    while (p && meta.has(p) && !seen.has(p) && meta.get(p)!.section === sec) {
      seen.add(p);
      inSet.add(p);
      p = meta.get(p)!.parentId;
    }
  }
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of inSet) {
    const p = meta.get(id)!.parentId;
    if (p && inSet.has(p) && meta.get(p)!.section === sectionOf(id)) {
      children.set(p, [...(children.get(p) ?? []), id]);
    } else {
      roots.push(id);
    }
  }
  const byCode = (a: string, b: string) => {
    const A = meta.get(a)!;
    const B = meta.get(b)!;
    return A.code.localeCompare(B.code, undefined, { numeric: true }) || A.name.localeCompare(B.name);
  };

  const rows: StdRow[] = [];
  const total = zeros(ncols);

  const emit = (id: string, depth: number, parentRowId: string | null): Amounts => {
    const a = meta.get(id)!;
    const own = amounts.get(id) ?? zeros(ncols);
    const kids = (children.get(id) ?? []).sort(byCode);
    const href = opts.hrefFor?.(a);
    if (kids.length === 0) {
      rows.push({
        id: `${opts.idPrefix}:a:${id}`,
        parentId: parentRowId,
        depth,
        kind: 'data',
        cells: opts.cells(a.name, own),
        href: href ?? null,
      });
      return own;
    }
    const headerId = `${opts.idPrefix}:a:${id}`;
    const header: StdRow = {
      id: headerId,
      parentId: parentRowId,
      depth,
      kind: 'section',
      collapseKind: 'account',
      cells: opts.cells(a.name, zeros(ncols)),
      href: href ?? null,
    };
    // Heading rows show no amounts while expanded.
    for (const k of Object.keys(header.cells)) if (k !== Object.keys(header.cells)[0]) header.cells[k] = null;
    rows.push(header);
    const sum = zeros(ncols);
    for (const k of kids) addInto(sum, emit(k, depth + 1, headerId));
    if (anyNonZero(own)) {
      rows.push({
        id: `${headerId}:other`,
        parentId: headerId,
        depth: depth + 1,
        kind: 'data',
        cells: opts.cells(`${a.name} - Other`, own),
        href: href ?? null,
      });
      addInto(sum, own);
    }
    const totalCells = opts.cells(`Total ${a.name}`, sum);
    header.collapsedCells = { ...opts.cells(a.name, sum) };
    rows.push({
      id: `${headerId}:total`,
      parentId: parentRowId,
      depth,
      kind: 'subtotal',
      totalOf: headerId,
      cells: totalCells,
    });
    return sum;
  };

  for (const r of roots.sort(byCode)) addInto(total, emit(r, opts.depth, opts.parentRowId));
  return { rows, total };
}

// ===========================================================================
// Dates & periods
// ===========================================================================

/** 'YYYY-MM-DD' → UTC start of day (or end of day when `endOfDay`). */
export function parseDay(s: string | undefined, endOfDay = false): Date | undefined {
  if (!s) return undefined;
  const d = new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (Number.isNaN(d.getTime())) throw validation(`Invalid date: ${s}`);
  return d;
}

/** UTC calendar date of a Date as 'YYYY-MM-DD'. */
export function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function fmtDay(d: Date): string {
  const s = dayStr(d);
  return `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
}

export async function companyFiscalYearEnd(ctx: ServiceContext): Promise<string | undefined> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row?.settings?.fiscalYearEnd;
}

/** The fiscal year window containing `date` (UTC). */
export function fiscalWindowFor(date: Date, fye?: string | null): { start: Date; end: Date } {
  for (const y of [date.getUTCFullYear(), date.getUTCFullYear() + 1]) {
    const w = fiscalYearWindow(y, fye);
    if (date >= w.yearStart && date < w.yearEnd) return { start: w.yearStart, end: new Date(w.yearEnd.getTime() - 1) };
  }
  const w = fiscalYearWindow(date.getUTCFullYear(), fye);
  return { start: w.yearStart, end: new Date(w.yearEnd.getTime() - 1) };
}

/** Resolve a report's date range: explicit from/to, else fiscal year to date. */
export async function resolveRange(
  ctx: ServiceContext,
  p: Pick<ReportParams, 'from' | 'to'>,
): Promise<{ from: Date; to: Date }> {
  const to = parseDay(p.to, true) ?? endOfToday();
  let from = parseDay(p.from);
  if (!from) {
    const fye = await companyFiscalYearEnd(ctx);
    from = fiscalWindowFor(to, fye).start;
  }
  if (from > to) throw validation('The "From" date is after the "To" date.');
  return { from, to };
}

export function endOfToday(): Date {
  return parseDay(dayStr(new Date()), true)!;
}

export function resolveAsOf(p: Pick<ReportParams, 'asOf' | 'to'>): Date {
  return parseDay(p.asOf ?? p.to, true) ?? endOfToday();
}

export type PeriodKind = 'month' | 'quarter' | 'year';

export interface Period {
  key: string;
  label: string;
  from: Date;
  to: Date;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Split [from, to] into month / quarter / year columns. Quarters and years follow the company's
 * fiscal year (e.g. a July–June year has Q1 = Jul–Sep). Partial first/last periods are clipped
 * to the range.
 */
export function splitPeriods(from: Date, to: Date, kind: PeriodKind, fye?: string | null): Period[] {
  const out: Period[] = [];
  const fyStart = fiscalWindowFor(from, fye).start;
  const fyStartMonth = fyStart.getUTCMonth();
  const fyStartDay = fyStart.getUTCDate();
  let cursor = new Date(from);
  let guard = 0;
  while (cursor <= to && guard++ < 1000) {
    let next: Date;
    let label: string;
    if (kind === 'month') {
      next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      label = `${MONTHS[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}`;
    } else {
      // Period boundaries anchored at the fiscal-year start (month + day).
      const span = kind === 'quarter' ? 3 : 12;
      const w = fiscalWindowFor(cursor, fye);
      let b = new Date(w.start);
      while (b <= cursor) {
        b = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + span, fyStartDay));
      }
      next = b;
      const fyLabel = w.end.getUTCFullYear();
      if (kind === 'quarter') {
        const q = Math.floor(((cursor.getUTCMonth() - fyStartMonth + 12) % 12) / 3) + 1;
        label = `Q${q} FY${fyLabel}`;
      } else {
        label = fyStartMonth === 0 && fyStartDay === 1 ? `${fyLabel}` : `FY${fyLabel}`;
      }
    }
    const end = new Date(Math.min(next.getTime() - 1, to.getTime()));
    out.push({ key: `p${out.length}`, label, from: new Date(cursor), to: end });
    cursor = next;
  }
  return out;
}

/** Index of the period containing `d` (or -1). */
export function periodIndex(periods: Period[], d: Date): number {
  for (let i = 0; i < periods.length; i++) if (d >= periods[i].from && d <= periods[i].to) return i;
  return -1;
}

// ===========================================================================
// Account activity aggregation
// ===========================================================================

export interface ActivityFilter {
  from?: Date;
  to?: Date;
  classId?: string;
  /** Exclude year-end closing entries (P&L-style reports). */
  excludeClose?: boolean;
  accountIds?: string[];
}

/**
 * Posted debits/credits per account, optionally bucketed into periods (by month first, in
 * SQL; months are mapped to the caller's periods in JS) or by class.
 */
export async function activityByAccount(
  ctx: ServiceContext,
  f: ActivityFilter,
  bucket: 'none' | 'day' | 'month' | 'class' = 'none',
): Promise<{ accountId: string; bucket: string | null; debit: string; credit: string }[]> {
  const conds: SQL[] = [eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')];
  if (f.from) conds.push(gte(journalEntries.date, f.from));
  if (f.to) conds.push(lte(journalEntries.date, f.to));
  if (f.classId) conds.push(eq(journalEntryLines.classId, f.classId));
  if (f.excludeClose) conds.push(notFiscalCloseEntry());
  if (f.accountIds) {
    if (f.accountIds.length === 0) return [];
    conds.push(inArray(journalEntryLines.accountId, f.accountIds));
  }
  const bucketExpr =
    bucket === 'day'
      ? sql<string>`to_char(${journalEntries.date}, 'YYYY-MM-DD')`
      : bucket === 'month'
      ? sql<string>`to_char(${journalEntries.date}, 'YYYY-MM')`
      : bucket === 'class'
        ? sql<string>`COALESCE(${journalEntryLines.classId}::text, '')`
        : sql<string>`NULL`;
  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      bucket: bucketExpr,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conds))
    .groupBy(...(bucket === 'none' ? [journalEntryLines.accountId] : [journalEntryLines.accountId, bucketExpr]));
  return rows.map((r) => ({ ...r, debit: String(r.debit), credit: String(r.credit), bucket: r.bucket ?? null }));
}

// ===========================================================================
// P&L rows
// ===========================================================================

export interface PLBuildOptions {
  meta: Map<string, AccountMeta>;
  /** Natural-sign amounts per P&L account per column. */
  amounts: Map<string, Amounts>;
  columns: StdColumn[];
  /** Keys of the amount columns, in order (cells beyond these are derived). */
  amountKeys: string[];
  /** Optional derived cells computed from the amount values (e.g. % change, % of income). */
  derive?: (values: Amounts, ctx: { incomeTotal: Amounts }) => Record<string, CellValue>;
  hrefFor?: (acct: AccountMeta) => string | undefined;
  /** QuickZoom for the Net Income line etc. */
  totalHref?: (section: PLSection | 'net') => string | undefined;
}

export interface PLBuildResult {
  rows: StdRow[];
  totals: Record<PLSection, Amounts>;
  grossProfit: Amounts;
  netOrdinary: Amounts;
  netOther: Amounts;
  netIncome: Amounts;
}

/**
 * QuickBooks P&L layout:
 *   Ordinary Income/Expense → Income, Cost of Goods Sold, Gross Profit, Expense,
 *   Net Ordinary Income → Other Income/Expense → Other Income, Other Expense, Net Other Income →
 *   Net Income. Empty COGS / Other sections are omitted like QB does.
 */
export function buildPLRows(o: PLBuildOptions): PLBuildResult {
  const n = o.amountKeys.length;
  const labelKey = o.columns[0].key;
  // Precompute income total for derived columns (% of income).
  const bySection = new Map<PLSection, Map<string, Amounts>>();
  for (const s of PL_SECTIONS) bySection.set(s, new Map());
  for (const [id, vals] of o.amounts) {
    const a = o.meta.get(id);
    if (!a || !isPLSection(a.section)) continue;
    bySection.get(a.section as PLSection)!.set(id, vals);
  }
  const incomeTotal = zeros(n);
  for (const v of bySection.get('income')!.values()) addInto(incomeTotal, v);

  const cells = (label: string, values: Amounts): Record<string, CellValue> => {
    const c: Record<string, CellValue> = { [labelKey]: label };
    o.amountKeys.forEach((k, i) => (c[k] = toAmountString(values[i])));
    if (o.derive) Object.assign(c, o.derive(values, { incomeTotal }));
    return c;
  };

  const rows: StdRow[] = [];
  const totals = {} as Record<PLSection, Amounts>;
  const sectionBlock = (s: PLSection, depth: number, parentRowId: string | null, alwaysShow: boolean) => {
    const amts = bySection.get(s)!;
    const has = [...amts.values()].some(anyNonZero);
    const headerId = `pl:${s}`;
    if (!has && !alwaysShow) {
      totals[s] = zeros(n);
      return false;
    }
    const header: StdRow = {
      id: headerId,
      parentId: parentRowId,
      depth,
      kind: 'section',
      collapseKind: 'section',
      cells: { [labelKey]: SECTION_LABELS[s] },
    };
    rows.push(header);
    const tree = buildAccountTree({
      meta: o.meta,
      amounts: amts,
      ncols: n,
      idPrefix: headerId,
      parentRowId: headerId,
      depth: depth + 1,
      cells,
      hrefFor: o.hrefFor,
    });
    rows.push(...tree.rows);
    totals[s] = tree.total;
    header.collapsedCells = cells(`Total ${SECTION_LABELS[s]}`, tree.total);
    rows.push({
      id: `${headerId}:total`,
      parentId: parentRowId,
      depth,
      kind: 'total',
      totalOf: headerId,
      cells: cells(`Total ${SECTION_LABELS[s]}`, tree.total),
      href: o.totalHref?.(s) ?? null,
    });
    return true;
  };

  const sub = (a: Amounts, b: Amounts) => a.map((v, i) => v.minus(b[i]));

  rows.push({ id: 'pl:ordinary', depth: 0, kind: 'section', cells: { [labelKey]: 'Ordinary Income/Expense' } });
  sectionBlock('income', 1, 'pl:ordinary', true);
  const hasCogs = sectionBlock('cogs', 1, 'pl:ordinary', false);
  const grossProfit = sub(totals.income, totals.cogs);
  rows.push({ id: 'pl:gross', parentId: 'pl:ordinary', depth: 0, kind: 'total', cells: cells('Gross Profit', grossProfit) });
  void hasCogs;
  sectionBlock('expense', 1, 'pl:ordinary', true);
  const netOrdinary = sub(grossProfit, totals.expense);
  rows.push({ id: 'pl:netordinary', depth: 0, kind: 'total', cells: cells('Net Ordinary Income', netOrdinary) });

  const hasOther =
    [...bySection.get('other_income')!.values()].some(anyNonZero) ||
    [...bySection.get('other_expense')!.values()].some(anyNonZero);
  let netOther = zeros(n);
  if (hasOther) {
    rows.push({ id: 'pl:other', depth: 0, kind: 'section', cells: { [labelKey]: 'Other Income/Expense' } });
    sectionBlock('other_income', 1, 'pl:other', false);
    sectionBlock('other_expense', 1, 'pl:other', false);
    netOther = sub(totals.other_income, totals.other_expense);
    rows.push({ id: 'pl:netother', depth: 0, kind: 'total', cells: cells('Net Other Income', netOther) });
  } else {
    totals.other_income = totals.other_income ?? zeros(n);
    totals.other_expense = totals.other_expense ?? zeros(n);
  }
  const netIncome = netOrdinary.map((v, i) => v.plus(netOther[i]));
  rows.push({ id: 'pl:net', depth: 0, kind: 'grand', cells: cells('Net Income', netIncome), href: o.totalHref?.('net') ?? null });
  return { rows, totals, grossProfit, netOrdinary, netOther, netIncome };
}

/**
 * Natural-sign P&L amounts per account per column from bucketed activity rows.
 * `colOf` maps an activity bucket to a column index (or -1 to skip).
 */
export function plAmountsFromActivity(
  meta: Map<string, AccountMeta>,
  activity: { accountId: string; bucket: string | null; debit: string; credit: string }[],
  ncols: number,
  colOf: (bucket: string | null) => number | number[],
): Map<string, Amounts> {
  const out = new Map<string, Amounts>();
  for (const r of activity) {
    const a = meta.get(r.accountId);
    if (!a || !isPLSection(a.section)) continue;
    const idx = colOf(r.bucket);
    const list = Array.isArray(idx) ? idx : [idx];
    const amt = naturalAmount(a.section, r.debit, r.credit);
    for (const i of list) {
      if (i < 0 || i >= ncols) continue;
      const v = out.get(r.accountId) ?? zeros(ncols);
      v[i] = v[i].plus(amt);
      out.set(r.accountId, v);
    }
  }
  return out;
}

// ===========================================================================
// Detail-line engine (Type / Num / Name / Split / Cleared + filters)
// ===========================================================================

export const TXN_TYPE_LABELS: Record<TxnTypeKey, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  refund: 'Refund',
  bill: 'Bill',
  bill_payment: 'Bill Pmt',
  bill_credit: 'Bill Credit',
  check: 'Check',
  deposit: 'Deposit',
  transfer: 'Transfer',
  paycheck: 'Paycheck',
  journal: 'General Journal',
  inventory: 'Inventory Adjust',
  item_receipt: 'Item Receipt',
  depreciation: 'Depreciation',
  sales_tax_payment: 'Sales Tax Payment',
  cc_payment: 'Credit Card Payment',
  expense_report: 'Expense Report',
  opening_balance: 'Opening Balance',
  other: 'Other',
};

/** sourceRef prefixes per transaction type (null = manual entries). */
const TXN_PREFIXES: Record<TxnTypeKey, string[]> = {
  invoice: ['invoice', 'invoice-cogs'],
  payment: ['payment', 'customer'],
  sales_receipt: ['salesreceipt', 'sales_receipt'],
  credit_memo: ['credit_memo', 'creditmemo-cogs'],
  refund: ['refund'],
  bill: ['bill'],
  bill_payment: ['vendor'],
  bill_credit: ['vendor_credit'],
  check: ['expense'],
  deposit: ['deposit'],
  transfer: ['transfer'],
  paycheck: ['paycheck'],
  journal: ['manual', 'reversal', 'fiscal-close', 'condense', 'qbgl', 'iif'],
  inventory: ['item'],
  item_receipt: ['item_receipt', 'item_receipt_void'],
  depreciation: ['fixed_asset'],
  sales_tax_payment: ['tax_agency'],
  cc_payment: ['cc-payment'],
  expense_report: ['expense_report'],
  opening_balance: ['account'],
  other: ['bank_transaction', 'reconciliation'],
};

const PREFIX_TO_TYPE = new Map<string, TxnTypeKey>();
for (const [k, list] of Object.entries(TXN_PREFIXES) as [TxnTypeKey, string[]][]) {
  for (const p of list) PREFIX_TO_TYPE.set(p, k);
}

export function txnTypeOf(sourceRef: string | null | undefined): TxnTypeKey {
  if (!sourceRef) return 'journal';
  const prefix = sourceRef.split(':')[0];
  return PREFIX_TO_TYPE.get(prefix) ?? 'other';
}

function txnTypeCondition(t: TxnTypeKey): SQL {
  const prefixes = TXN_PREFIXES[t];
  const parts = prefixes.map((p) => sql`${journalEntries.sourceRef} LIKE ${p + ':%'}`);
  parts.push(...prefixes.map((p) => sql`${journalEntries.sourceRef} = ${p}`));
  if (t === 'journal') parts.push(sql`${journalEntries.sourceRef} IS NULL`);
  if (t === 'other') {
    // Anything whose prefix is not a known type.
    const known = [...PREFIX_TO_TYPE.keys()].filter((p) => !TXN_PREFIXES.other.includes(p));
    return sql`(${journalEntries.sourceRef} IS NOT NULL AND split_part(${journalEntries.sourceRef}, ':', 1) NOT IN (${sql.join(known.map((k) => sql`${k}`), sql`, `)}))`;
  }
  return sql`(${sql.join(parts, sql` OR `)})`;
}

export type NameType = 'customer' | 'vendor' | 'employee' | 'other';

export interface ResolvedName {
  nameType: NameType | null;
  nameId: string | null;
  name: string;
  num: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Customer full names ("Parent:Job") for the company. */
export async function customerNames(ctx: ServiceContext): Promise<Map<string, { name: string; parentId: string | null }>> {
  const rows = await ctx.db
    .select({ id: customers.id, name: customers.displayName, parentId: customers.parentId })
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId));
  const base = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, { name: string; parentId: string | null }>();
  for (const r of rows) {
    const parts = [r.name];
    let p = r.parentId;
    const seen = new Set([r.id]);
    while (p && base.has(p) && !seen.has(p)) {
      seen.add(p);
      parts.unshift(base.get(p)!.name);
      p = base.get(p)!.parentId;
    }
    out.set(r.id, { name: parts.join(':'), parentId: r.parentId });
  }
  return out;
}

/**
 * Resolve the QB "Name" and "Num" of journal entries from their source documents
 * (sourceRef "invoice:<id>" → the invoice's customer + invoice number, and so on).
 * Batched: one query per document type present.
 *
 * TODO(foundation: JE names) — when journal lines carry their own name (entity) columns,
 * prefer the line-level name over the document-level one here.
 */
export async function resolveEntryNames(
  ctx: ServiceContext,
  entries: { id: string; sourceRef: string | null; reference: string | null }[],
): Promise<Map<string, ResolvedName>> {
  const idsByPrefix = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!e.sourceRef) continue;
    const [prefix, id] = e.sourceRef.split(':');
    if (!id || !UUID_RE.test(id)) continue;
    if (!idsByPrefix.has(prefix)) idsByPrefix.set(prefix, new Set());
    idsByPrefix.get(prefix)!.add(id);
  }
  const ids = (...prefixes: string[]) => {
    const s = new Set<string>();
    for (const p of prefixes) for (const id of idsByPrefix.get(p) ?? []) s.add(id);
    return [...s];
  };

  type Doc = { nameType: NameType; nameId: string | null; num: string | null; payee?: string | null };
  const docs = new Map<string, Doc>(); // key "<table>:<id>"
  const c = ctx.companyId;

  const invIds = ids('invoice', 'invoice-cogs');
  if (invIds.length) {
    const rows = await ctx.db
      .select({ id: invoices.id, nameId: invoices.customerId, num: invoices.invoiceNumber })
      .from(invoices)
      .where(and(eq(invoices.companyId, c), inArray(invoices.id, invIds)));
    for (const r of rows) docs.set(`inv:${r.id}`, { nameType: 'customer', nameId: r.nameId, num: String(r.num) });
  }
  const payIds = ids('payment', 'refund');
  if (payIds.length) {
    const rows = await ctx.db
      .select({ id: paymentsReceived.id, nameId: paymentsReceived.customerId, num: paymentsReceived.reference })
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.companyId, c), inArray(paymentsReceived.id, payIds)));
    for (const r of rows) docs.set(`pay:${r.id}`, { nameType: 'customer', nameId: r.nameId, num: r.num });
  }
  const srIds = ids('salesreceipt', 'sales_receipt');
  if (srIds.length) {
    const rows = await ctx.db
      .select({ id: salesReceipts.id, nameId: salesReceipts.customerId, num: salesReceipts.receiptNumber })
      .from(salesReceipts)
      .where(and(eq(salesReceipts.companyId, c), inArray(salesReceipts.id, srIds)));
    for (const r of rows) docs.set(`sr:${r.id}`, { nameType: 'customer', nameId: r.nameId, num: String(r.num) });
  }
  const cmIds = ids('credit_memo', 'creditmemo-cogs', 'refund');
  if (cmIds.length) {
    const rows = await ctx.db
      .select({ id: creditMemos.id, nameId: creditMemos.customerId, num: creditMemos.memoNumber })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, c), inArray(creditMemos.id, cmIds)));
    for (const r of rows) docs.set(`cm:${r.id}`, { nameType: 'customer', nameId: r.nameId, num: String(r.num) });
  }
  const billIds = ids('bill');
  if (billIds.length) {
    const rows = await ctx.db
      .select({ id: bills.id, nameId: bills.vendorId, num: bills.billNumber })
      .from(bills)
      .where(and(eq(bills.companyId, c), inArray(bills.id, billIds)));
    for (const r of rows) docs.set(`bill:${r.id}`, { nameType: 'vendor', nameId: r.nameId, num: r.num });
  }
  const vcIds = ids('vendor_credit', 'refund');
  if (vcIds.length) {
    const rows = await ctx.db
      .select({ id: vendorCredits.id, nameId: vendorCredits.vendorId })
      .from(vendorCredits)
      .where(and(eq(vendorCredits.companyId, c), inArray(vendorCredits.id, vcIds)));
    for (const r of rows) docs.set(`vc:${r.id}`, { nameType: 'vendor', nameId: r.nameId, num: null });
  }
  const expIds = ids('expense');
  if (expIds.length) {
    const rows = await ctx.db
      .select({ id: expenses.id, nameId: expenses.vendorId, payee: expenses.payeeName, num: expenses.reference })
      .from(expenses)
      .where(and(eq(expenses.companyId, c), inArray(expenses.id, expIds)));
    for (const r of rows) docs.set(`exp:${r.id}`, { nameType: r.nameId ? 'vendor' : 'other', nameId: r.nameId, num: r.num, payee: r.payee });
  }
  const pcIds = ids('paycheck');
  if (pcIds.length) {
    const rows = await ctx.db
      .select({ id: paychecks.id, nameId: paychecks.employeeId })
      .from(paychecks)
      .where(and(eq(paychecks.companyId, c), inArray(paychecks.id, pcIds)));
    for (const r of rows) docs.set(`pc:${r.id}`, { nameType: 'employee', nameId: r.nameId, num: null });
  }
  const erIds = ids('expense_report');
  if (erIds.length) {
    const rows = await ctx.db
      .select({ id: expenseReports.id, nameId: expenseReports.employeeId })
      .from(expenseReports)
      .where(and(eq(expenseReports.companyId, c), inArray(expenseReports.id, erIds)));
    for (const r of rows) docs.set(`er:${r.id}`, { nameType: 'employee', nameId: r.nameId, num: null });
  }
  const irIds = ids('item_receipt', 'item_receipt_void');
  if (irIds.length) {
    const rows = await ctx.db
      .select({ id: itemReceipts.id, nameId: itemReceipts.vendorId })
      .from(itemReceipts)
      .where(and(eq(itemReceipts.companyId, c), inArray(itemReceipts.id, irIds)));
    for (const r of rows) docs.set(`ir:${r.id}`, { nameType: 'vendor', nameId: r.nameId, num: null });
  }
  const taIds = ids('tax_agency');
  const agencyNames = new Map<string, string>();
  if (taIds.length) {
    const rows = await ctx.db
      .select({ id: taxAgencies.id, name: taxAgencies.name })
      .from(taxAgencies)
      .where(and(eq(taxAgencies.companyId, c), inArray(taxAgencies.id, taIds)));
    for (const r of rows) agencyNames.set(r.id, r.name);
  }

  // Name lookups.
  const custIds = new Set<string>(ids('customer'));
  const vendIds = new Set<string>(ids('vendor'));
  const empIds = new Set<string>();
  for (const d of docs.values()) {
    if (!d.nameId) continue;
    if (d.nameType === 'customer') custIds.add(d.nameId);
    else if (d.nameType === 'vendor') vendIds.add(d.nameId);
    else if (d.nameType === 'employee') empIds.add(d.nameId);
  }
  const custNames = custIds.size ? await customerNames(ctx) : new Map<string, { name: string }>();
  const vendNames = new Map<string, string>();
  if (vendIds.size) {
    const rows = await ctx.db
      .select({ id: vendors.id, name: vendors.displayName })
      .from(vendors)
      .where(and(eq(vendors.companyId, c), inArray(vendors.id, [...vendIds])));
    for (const r of rows) vendNames.set(r.id, r.name);
  }
  const empNames = new Map<string, string>();
  if (empIds.size) {
    const rows = await ctx.db
      .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(and(eq(employees.companyId, c), inArray(employees.id, [...empIds])));
    for (const r of rows) empNames.set(r.id, `${r.first} ${r.last}`.trim());
  }
  const nameOf = (t: NameType, id: string | null): string => {
    if (!id) return '';
    if (t === 'customer') return custNames.get(id)?.name ?? '';
    if (t === 'vendor') return vendNames.get(id) ?? '';
    if (t === 'employee') return empNames.get(id) ?? '';
    return '';
  };

  const out = new Map<string, ResolvedName>();
  for (const e of entries) {
    let res: ResolvedName = { nameType: null, nameId: null, name: '', num: e.reference };
    if (e.sourceRef) {
      const [prefix, id] = e.sourceRef.split(':');
      const pick = (...keys: string[]) => keys.map((k) => docs.get(`${k}:${id}`)).find(Boolean);
      let d: Doc | undefined;
      switch (prefix) {
        case 'invoice':
        case 'invoice-cogs':
          d = pick('inv');
          break;
        case 'payment':
          d = pick('pay');
          break;
        case 'refund':
          d = pick('cm', 'pay', 'vc');
          break;
        case 'salesreceipt':
        case 'sales_receipt':
          d = pick('sr');
          break;
        case 'credit_memo':
        case 'creditmemo-cogs':
          d = pick('cm');
          break;
        case 'bill':
          d = pick('bill');
          break;
        case 'vendor_credit':
          d = pick('vc');
          break;
        case 'expense':
          d = pick('exp');
          break;
        case 'paycheck':
          d = pick('pc');
          break;
        case 'expense_report':
          d = pick('er');
          break;
        case 'item_receipt':
        case 'item_receipt_void':
          d = pick('ir');
          break;
        case 'customer':
          if (id && UUID_RE.test(id)) d = { nameType: 'customer', nameId: id, num: null };
          break;
        case 'vendor':
          if (id && UUID_RE.test(id)) d = { nameType: 'vendor', nameId: id, num: null };
          break;
        case 'tax_agency':
          if (id) res = { nameType: 'other', nameId: id, name: agencyNames.get(id) ?? '', num: e.reference };
          break;
      }
      if (d) {
        res = {
          nameType: d.nameType,
          nameId: d.nameId,
          name: nameOf(d.nameType, d.nameId) || d.payee || '',
          num: d.num ?? e.reference,
        };
      }
    }
    out.set(e.id, res);
  }
  return out;
}

export interface GlLine {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: Date;
  txnType: TxnTypeKey;
  type: string;
  num: string;
  nameType: NameType | null;
  nameId: string | null;
  name: string;
  memo: string;
  description: string;
  sourceRef: string | null;
  accountId: string;
  account: AccountMeta;
  classId: string | null;
  className: string;
  debit: Decimal;
  credit: Decimal;
  /** Signed debit − credit. */
  amount: Decimal;
  /** Natural-sign amount for the line's own account section. */
  natural: Decimal;
  cleared: boolean;
  /** QB "Split": the other account of a two-line entry, or "-SPLIT-". */
  split: string;
}

export interface GlLineFilter extends ActivityFilter {
  /** Restrict to accounts in these sections. */
  sections?: SectionKey[];
  nameId?: string;
  nameType?: NameType;
  txnType?: TxnTypeKey;
  amountMin?: string;
  amountMax?: string;
  cleared?: 'any' | 'cleared' | 'uncleared';
  memo?: string;
  number?: string;
  entryIds?: string[];
  limit?: number;
}

/** Translate report params into a detail-line filter (account includes its sub-accounts). */
export function glFilterFromParams(
  meta: Map<string, AccountMeta>,
  p: ReportParams,
  range: { from?: Date; to?: Date },
): GlLineFilter {
  const f: GlLineFilter = { from: range.from, to: range.to };
  if (p.accountId) f.accountIds = accountWithDescendants(meta, p.accountId);
  if (p.classId) f.classId = p.classId;
  if (p.txnType) f.txnType = p.txnType;
  if (p.amountMin) f.amountMin = p.amountMin;
  if (p.amountMax) f.amountMax = p.amountMax;
  if (p.cleared) f.cleared = p.cleared;
  if (p.memo) f.memo = p.memo;
  if (p.number) f.number = p.number;
  if (p.nameId) f.nameId = p.nameId;
  if (p.customerId) {
    f.nameId = p.customerId;
    f.nameType = 'customer';
  }
  if (p.vendorId) {
    f.nameId = p.vendorId;
    f.nameType = 'vendor';
  }
  if (p.employeeId) {
    f.nameId = p.employeeId;
    f.nameType = 'employee';
  }
  if (p.section) {
    const secs = p.section.split(',').filter((s) => [...PL_SECTIONS, ...BS_SECTIONS].includes(s as SectionKey));
    if (secs.length) f.sections = secs as SectionKey[];
  }
  return f;
}

export const DEFAULT_LINE_LIMIT = 10000;

/**
 * Posted journal lines with QB detail columns, filtered. Returns at most `limit` lines (default
 * 10,000) and flags truncation.
 */
export async function fetchGlLines(
  ctx: ServiceContext,
  meta: Map<string, AccountMeta>,
  f: GlLineFilter,
): Promise<{ lines: GlLine[]; truncated: boolean }> {
  const limit = Math.max(1, Math.min(f.limit ?? DEFAULT_LINE_LIMIT, 50000));
  const conds: SQL[] = [eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')];
  if (f.from) conds.push(gte(journalEntries.date, f.from));
  if (f.to) conds.push(lte(journalEntries.date, f.to));
  if (f.classId) conds.push(eq(journalEntryLines.classId, f.classId));
  if (f.excludeClose) conds.push(notFiscalCloseEntry());
  let accountIds = f.accountIds;
  if (f.sections) {
    const secIds = [...meta.values()].filter((a) => f.sections!.includes(a.section)).map((a) => a.id);
    accountIds = accountIds ? accountIds.filter((id) => secIds.includes(id)) : secIds;
  }
  if (accountIds) {
    if (accountIds.length === 0) return { lines: [], truncated: false };
    conds.push(inArray(journalEntryLines.accountId, accountIds));
  }
  if (f.entryIds) {
    if (f.entryIds.length === 0) return { lines: [], truncated: false };
    conds.push(inArray(journalEntries.id, f.entryIds));
  }
  if (f.txnType) conds.push(txnTypeCondition(f.txnType));
  const lineAmt = sql`GREATEST(COALESCE(${journalEntryLines.debit}, 0), COALESCE(${journalEntryLines.credit}, 0))`;
  if (f.amountMin) conds.push(sql`${lineAmt} >= ${f.amountMin}::numeric`);
  if (f.amountMax) conds.push(sql`${lineAmt} <= ${f.amountMax}::numeric`);
  if (f.memo) {
    const like = `%${f.memo.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    conds.push(sql`(${journalEntryLines.memo} ILIKE ${like} OR ${journalEntries.description} ILIKE ${like})`);
  }
  const clearedExpr = sql<boolean>`EXISTS (SELECT 1 FROM reconciliation_items ri WHERE ri.journal_entry_line_id = ${journalEntryLines.id} AND ri.is_cleared = true)`;
  if (f.cleared === 'cleared') conds.push(sql`${clearedExpr}`);
  if (f.cleared === 'uncleared') conds.push(sql`NOT ${clearedExpr}`);

  // Name / number filters are applied after resolution, so read a larger window first.
  const postFilter = !!(f.nameId || f.number);
  const fetchCap = postFilter ? 50000 : limit + 1;

  const raw = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      reference: journalEntries.reference,
      sourceRef: journalEntries.sourceRef,
      accountId: journalEntryLines.accountId,
      memo: journalEntryLines.memo,
      classId: journalEntryLines.classId,
      className: classes.name,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      cleared: clearedExpr,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .leftJoin(classes, eq(journalEntryLines.classId, classes.id))
    .where(and(...conds))
    .orderBy(asc(journalEntries.date), asc(journalEntries.entryNumber), asc(journalEntryLines.createdAt), asc(journalEntryLines.id))
    .limit(fetchCap);

  const entryMap = new Map<string, { id: string; sourceRef: string | null; reference: string | null }>();
  for (const r of raw) entryMap.set(r.entryId, { id: r.entryId, sourceRef: r.sourceRef, reference: r.reference });
  const names = await resolveEntryNames(ctx, [...entryMap.values()]);

  let lines: GlLine[] = raw.map((r) => {
    const account = meta.get(r.accountId)!;
    const debit = Money.of(r.debit ?? '0');
    const credit = Money.of(r.credit ?? '0');
    const n = names.get(r.entryId)!;
    const txnType = txnTypeOf(r.sourceRef);
    return {
      lineId: r.lineId,
      entryId: r.entryId,
      entryNumber: r.entryNumber,
      date: r.date,
      txnType,
      type: TXN_TYPE_LABELS[txnType],
      num: n.num ?? '',
      nameType: n.nameType,
      nameId: n.nameId,
      name: n.name,
      memo: r.memo ?? r.description ?? '',
      description: r.description ?? '',
      sourceRef: r.sourceRef,
      accountId: r.accountId,
      account,
      classId: r.classId,
      className: r.className ?? '',
      debit,
      credit,
      amount: debit.minus(credit),
      natural: account ? naturalAmount(account.section, debit, credit) : debit.minus(credit),
      cleared: r.cleared === true || (r.cleared as unknown) === 't',
      split: '',
    };
  });
  lines = lines.filter((l) => !!l.account);
  if (f.nameId) lines = lines.filter((l) => l.nameId === f.nameId && (!f.nameType || l.nameType === f.nameType));
  if (f.number) {
    const needle = f.number.toLowerCase();
    lines = lines.filter(
      (l) => l.num.toLowerCase().includes(needle) || String(l.entryNumber) === f.number,
    );
  }
  const truncated = lines.length > limit;
  if (truncated) lines = lines.slice(0, limit);

  // Split column: the other account(s) of each entry.
  const entryIds = [...new Set(lines.map((l) => l.entryId))];
  if (entryIds.length) {
    const all: { entryId: string; lineId: string; accountId: string }[] = [];
    for (let i = 0; i < entryIds.length; i += 5000) {
      const chunk = entryIds.slice(i, i + 5000);
      all.push(
        ...(await ctx.db
          .select({ entryId: journalEntryLines.journalEntryId, lineId: journalEntryLines.id, accountId: journalEntryLines.accountId })
          .from(journalEntryLines)
          .where(inArray(journalEntryLines.journalEntryId, chunk))),
      );
    }
    const byEntry = new Map<string, { lineId: string; accountId: string }[]>();
    for (const r of all) byEntry.set(r.entryId, [...(byEntry.get(r.entryId) ?? []), r]);
    for (const l of lines) {
      const others = (byEntry.get(l.entryId) ?? []).filter((o) => o.lineId !== l.lineId);
      const otherAccts = [...new Set(others.map((o) => o.accountId))];
      l.split = otherAccts.length === 1 ? (meta.get(otherAccts[0])?.fullName ?? '') : otherAccts.length > 1 ? '-SPLIT-' : '';
    }
  }
  return { lines, truncated };
}

// ---------------------------------------------------------------------------
// Detail row layout (sort + subtotal-by + running balance)
// ---------------------------------------------------------------------------

export const DETAIL_COLUMNS: StdColumn[] = [
  { key: 'label', header: '' },
  { key: 'type', header: 'Type' },
  { key: 'date', header: 'Date', type: 'date' },
  { key: 'num', header: 'Num' },
  { key: 'name', header: 'Name' },
  { key: 'memo', header: 'Memo' },
  { key: 'account', header: 'Account' },
  { key: 'class', header: 'Class' },
  { key: 'clr', header: 'Clr' },
  { key: 'split', header: 'Split' },
  { key: 'debit', header: 'Debit', type: 'money' },
  { key: 'credit', header: 'Credit', type: 'money' },
  { key: 'amount', header: 'Amount', type: 'money' },
  { key: 'balance', header: 'Balance', type: 'money' },
];

export type GroupKey = 'none' | 'account' | 'name' | 'type' | 'month' | 'class';

export interface DetailLayoutOptions {
  columns: StdColumn[];
  groupBy: GroupKey;
  sortBy?: ReportParams['sortBy'];
  sortDir?: 'asc' | 'desc';
  /** Use natural-sign amounts (P&L / account reports) instead of debit − credit. */
  natural?: boolean;
  /** Running balance per group; with `opening`, groups start from their opening balance. */
  running?: boolean;
  opening?: Map<string, Decimal>;
  /** Groups with no lines but an opening balance (balance-sheet detail). */
  openingOnlyGroups?: { key: string; label: string; href?: string }[];
  idPrefix?: string;
  /** Show the group header even when there is only one group (default true). */
  headers?: boolean;
  /** Column holding the group label (defaults to the first column). */
  hrefForGroup?: (key: string) => string | undefined;
}

/**
 * Sort key that puts unnamed groups ("(no name)", "Unclassified") after every named group.
 * A "~" sentinel doesn't work: localeCompare orders punctuation before letters.
 */
const blankLast = (s: string | null | undefined) => (s ? `0|${s.toLowerCase()}` : '1|');

function groupKeyOf(l: GlLine, g: GroupKey): { key: string; label: string; sort: string } {
  switch (g) {
    case 'account':
      return { key: l.accountId, label: l.account.fullName, sort: `${l.account.code}|${l.account.fullName}` };
    case 'name':
      return { key: l.nameId ?? '', label: l.name || '(no name)', sort: blankLast(l.name) };
    case 'type':
      return { key: l.txnType, label: l.type, sort: l.type };
    case 'month': {
      const k = dayStr(l.date).slice(0, 7);
      return { key: k, label: `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`, sort: k };
    }
    case 'class':
      return { key: l.classId ?? '', label: l.className || 'Unclassified', sort: blankLast(l.className) };
    default:
      return { key: 'all', label: 'All', sort: '' };
  }
}

function compareLines(a: GlLine, b: GlLine, by: NonNullable<ReportParams['sortBy']>, natural: boolean): number {
  switch (by) {
    case 'num':
      return a.num.localeCompare(b.num, undefined, { numeric: true });
    case 'name':
      return a.name.localeCompare(b.name);
    case 'amount':
      return (natural ? a.natural : a.amount).comparedTo(natural ? b.natural : b.amount);
    case 'account':
      return a.account.code.localeCompare(b.account.code, undefined, { numeric: true });
    case 'type':
      return a.type.localeCompare(b.type);
    case 'memo':
      return a.memo.localeCompare(b.memo);
    default:
      return a.date.getTime() - b.date.getTime() || a.entryNumber - b.entryNumber;
  }
}

/** Cells of one detail line (only the keys present in `columns` are read by the viewer). */
export function lineCells(l: GlLine, amount: Decimal, balance: Decimal | null): Record<string, CellValue> {
  return {
    label: '',
    type: l.type,
    date: dayStr(l.date),
    num: l.num,
    name: l.name,
    memo: l.memo,
    account: l.account.fullName,
    class: l.className,
    clr: l.cleared ? '✓' : '',
    split: l.split,
    debit: l.debit.isZero() ? null : toAmountString(l.debit),
    credit: l.credit.isZero() ? null : toAmountString(l.credit),
    amount: toAmountString(amount),
    balance: balance ? toAmountString(balance) : null,
  };
}

/**
 * Lay out detail lines: sort, group (QB "Total by"), subtotal each group, running balance, and a
 * grand total. Returns rows and the grand totals.
 */
export function layoutDetail(
  lines: GlLine[],
  o: DetailLayoutOptions,
): { rows: StdRow[]; total: { debit: Decimal; credit: Decimal; amount: Decimal } } {
  const natural = !!o.natural;
  const sortBy = o.sortBy ?? 'date';
  const dir = o.sortDir === 'desc' ? -1 : 1;
  const prefix = o.idPrefix ?? 'd';
  const groups = new Map<string, { key: string; label: string; sort: string; lines: GlLine[] }>();
  for (const l of lines) {
    const g = groupKeyOf(l, o.groupBy);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, lines: [] });
    groups.get(g.key)!.lines.push(l);
  }
  for (const og of o.openingOnlyGroups ?? []) {
    if (!groups.has(og.key)) groups.set(og.key, { key: og.key, label: og.label, sort: og.label, lines: [] });
  }
  const ordered = [...groups.values()].sort((a, b) => a.sort.localeCompare(b.sort, undefined, { numeric: true }));
  const rows: StdRow[] = [];
  let tDebit = Money.zero();
  let tCredit = Money.zero();
  let tAmount = Money.zero();
  const showHeaders = o.groupBy !== 'none' && o.headers !== false;
  for (const g of ordered) {
    g.lines.sort((a, b) => dir * compareLines(a, b, sortBy, natural) || a.lineId.localeCompare(b.lineId));
    const headerId = `${prefix}:g:${o.groupBy}:${g.key || 'none'}`;
    const depth = showHeaders ? 1 : 0;
    const opening = o.opening?.get(g.key);
    const header: StdRow | null = showHeaders
      ? { id: headerId, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g.label }, href: o.hrefForGroup?.(g.key) ?? null }
      : null;
    if (header) rows.push(header);
    let bal = opening ?? Money.zero();
    if (opening && o.running) {
      rows.push({
        id: `${headerId}:open`,
        parentId: showHeaders ? headerId : null,
        depth,
        kind: 'data',
        cells: { label: 'Beginning balance', balance: toAmountString(opening) },
      });
    }
    let gDebit = Money.zero();
    let gCredit = Money.zero();
    let gAmount = Money.zero();
    for (const l of g.lines) {
      const amt = natural ? l.natural : l.amount;
      bal = bal.plus(amt);
      gDebit = gDebit.plus(l.debit);
      gCredit = gCredit.plus(l.credit);
      gAmount = gAmount.plus(amt);
      rows.push({
        id: `${prefix}:l:${l.lineId}`,
        parentId: showHeaders ? headerId : null,
        depth,
        kind: 'data',
        cells: lineCells(l, amt, o.running ? bal : null),
        entryId: l.entryId,
      });
    }
    tDebit = tDebit.plus(gDebit);
    tCredit = tCredit.plus(gCredit);
    tAmount = tAmount.plus(gAmount);
    if (showHeaders) {
      const totalCells: Record<string, CellValue> = {
        label: `Total ${g.label}`,
        debit: toAmountString(gDebit),
        credit: toAmountString(gCredit),
        amount: toAmountString(gAmount),
        balance: o.running ? toAmountString(bal) : null,
      };
      header!.collapsedCells = { ...totalCells, label: g.label };
      rows.push({ id: `${headerId}:total`, depth: 0, kind: 'subtotal', totalOf: headerId, cells: totalCells });
    }
  }
  rows.push({
    id: `${prefix}:grand`,
    depth: 0,
    kind: 'grand',
    cells: {
      label: 'TOTAL',
      debit: toAmountString(tDebit),
      credit: toAmountString(tCredit),
      amount: toAmountString(tAmount),
    },
  });
  return { rows, total: { debit: tDebit, credit: tCredit, amount: tAmount } };
}

/** Pick a subset of the detail columns by key (label first). */
export function detailColumns(keys: string[]): StdColumn[] {
  return keys.map((k) => DETAIL_COLUMNS.find((c) => c.key === k)!).filter(Boolean);
}

/** Query string for a std report link. */
export function stdHref(key: string, params: Record<string, string | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return `/reports/std/${key}${s ? `?${s}` : ''}`;
}

/** Posted journal entry id per sourceRef (for QuickZoom from document-based reports). */
export async function entryIdsForSourceRefs(ctx: ServiceContext, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(refs.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 2000) {
    const chunk = unique.slice(i, i + 2000);
    const rows = await ctx.db
      .select({ id: journalEntries.id, sourceRef: journalEntries.sourceRef })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          inArray(journalEntries.sourceRef, chunk),
        ),
      );
    for (const r of rows) if (r.sourceRef && !out.has(r.sourceRef)) out.set(r.sourceRef, r.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relative date ranges (QB "Dates" drop-down) — stored by memorized / scheduled reports so they
// always run for the current period.
// ---------------------------------------------------------------------------

export const DATE_MACROS = [
  'today',
  'this_week',
  'this_month',
  'this_month_to_date',
  'last_month',
  'this_quarter',
  'this_quarter_to_date',
  'last_quarter',
  'this_year',
  'this_year_to_date',
  'last_year',
  'this_fiscal_year',
  'this_fiscal_year_to_date',
  'last_fiscal_year',
  'all',
] as const;
export type DateMacro = (typeof DATE_MACROS)[number];

/** Resolve a relative date range to concrete 'YYYY-MM-DD' from / to (UTC calendar days). */
export function resolveDateMacro(macro: DateMacro, now: Date, fye?: string | null): { from?: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const day = (yy: number, mm: number, dd: number) => dayStr(new Date(Date.UTC(yy, mm, dd)));
  const today = dayStr(now);
  const q = Math.floor(m / 3);
  switch (macro) {
    case 'today':
      return { from: today, to: today };
    case 'this_week': {
      const dow = now.getUTCDay();
      return { from: day(y, m, now.getUTCDate() - dow), to: day(y, m, now.getUTCDate() - dow + 6) };
    }
    case 'this_month':
      return { from: day(y, m, 1), to: day(y, m + 1, 0) };
    case 'this_month_to_date':
      return { from: day(y, m, 1), to: today };
    case 'last_month':
      return { from: day(y, m - 1, 1), to: day(y, m, 0) };
    case 'this_quarter':
      return { from: day(y, q * 3, 1), to: day(y, q * 3 + 3, 0) };
    case 'this_quarter_to_date':
      return { from: day(y, q * 3, 1), to: today };
    case 'last_quarter':
      return { from: day(y, q * 3 - 3, 1), to: day(y, q * 3, 0) };
    case 'this_year':
      return { from: day(y, 0, 1), to: day(y, 11, 31) };
    case 'this_year_to_date':
      return { from: day(y, 0, 1), to: today };
    case 'last_year':
      return { from: day(y - 1, 0, 1), to: day(y - 1, 11, 31) };
    case 'this_fiscal_year': {
      const w = fiscalWindowFor(now, fye);
      return { from: dayStr(w.start), to: dayStr(w.end) };
    }
    case 'this_fiscal_year_to_date':
      return { from: dayStr(fiscalWindowFor(now, fye).start), to: today };
    case 'last_fiscal_year': {
      const cur = fiscalWindowFor(now, fye);
      const w = fiscalWindowFor(new Date(cur.start.getTime() - 1), fye);
      return { from: dayStr(w.start), to: dayStr(w.end) };
    }
    default:
      return { to: today };
  }
}
