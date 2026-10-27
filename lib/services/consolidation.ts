/**
 * Consolidation service — QB "Combine Reports from Multiple Companies".
 *
 * Each company is treated as a separate reporting entity. The consolidated totals are the
 * arithmetic sum of the per-company figures. Intercompany eliminations are not performed
 * here (that would require mapping intercompany accounts, a future layer).
 *
 * ACCESS: every function here combines ONLY the companies returned by reportableCompanies():
 * the caller's current company plus other companies in this file where the same user is an
 * active member with the report permission. Another company's books never leak into a
 * combined report.
 */
import { listCompanies } from '@/lib/services/company';
import { profitAndLoss, balanceSheet } from '@/lib/services/reports';
import type { ProfitAndLoss, BalanceSheet } from '@/lib/services/reports';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { assertBalanceSheetBalanced, assertTrialBalanceBalanced } from './ledgerAssert';
import type Decimal from 'decimal.js';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import { validation } from './_base';
import { resolveAccess } from './access';
import { can } from '@/lib/permissions/model';
import { trialBalanceAmounts } from './reportsStandard';
import { apAging, arAging, cashFlow, type CashFlowLine, type CashFlowReport } from './reportsExtra';
import {
  activityByAccount,
  buildAccountTree,
  buildPLRows,
  fmtDay,
  isPLSection,
  loadAccountMeta,
  naturalAmount,
  parseDay,
  periodIndex,
  resolveAsOf,
  resolveRange,
  splitPeriods,
  zeros,
  type AccountMeta,
  type Amounts,
} from './reportEngine';

// ---------------------------------------------------------------------------
// Per-company wrapper types
// ---------------------------------------------------------------------------

export interface CompanyPL {
  companyId: string;
  companyName: string;
  report: ProfitAndLoss;
}

export interface ConsolidatedPL {
  companies: CompanyPL[];
  /** Arithmetic sum across all companies. */
  consolidated: ProfitAndLoss;
}

export interface CompanyBS {
  companyId: string;
  companyName: string;
  report: BalanceSheet;
}

export interface ConsolidatedBS {
  companies: CompanyBS[];
  /** Arithmetic sum across all companies. */
  consolidated: BalanceSheet;
}

// ---------------------------------------------------------------------------
// Consolidated Profit & Loss
// ---------------------------------------------------------------------------

/**
 * Run profitAndLoss for every company the caller may report on and sum the results.
 *
 * @param ctx  Caller context (company, user and access decide which companies are combined).
 * @param range  Optional date range forwarded to each per-company P&L call.
 */
export async function consolidatedPL(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<ConsolidatedPL> {
  const allCompanies = await reportableCompanies(ctx);

  const companies: CompanyPL[] = await Promise.all(
    allCompanies.map(async (company) => {
      const companyCtx: ServiceContext = {
        db: ctx.db,
        companyId: company.id,
        userId: ctx.userId,
      };
      const report = await profitAndLoss(companyCtx, range);
      return { companyId: company.id, companyName: company.name, report };
    }),
  );

  // Sum totals across all companies.
  let totalIncome = Money.zero();
  let totalExpenses = Money.zero();
  for (const c of companies) {
    totalIncome = totalIncome.plus(Money.of(c.report.totalIncome));
    totalExpenses = totalExpenses.plus(Money.of(c.report.totalExpenses));
  }
  const netIncome = totalIncome.minus(totalExpenses);

  const consolidated: ProfitAndLoss = {
    income: [],
    expenses: [],
    totalIncome: toAmountString(totalIncome),
    totalExpenses: toAmountString(totalExpenses),
    netIncome: toAmountString(netIncome),
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
  };

  return { companies, consolidated };
}

// ---------------------------------------------------------------------------
// Consolidated Balance Sheet
// ---------------------------------------------------------------------------

/**
 * Run balanceSheet for every company the caller may report on and sum the results.
 *
 * @param ctx  Caller context (company, user and access decide which companies are combined).
 * @param asOf  Optional date forwarded to each per-company balance sheet call.
 */
export async function consolidatedBalanceSheet(
  ctx: ServiceContext,
  asOf?: Date,
): Promise<ConsolidatedBS> {
  const allCompanies = await reportableCompanies(ctx);

  const companies: CompanyBS[] = await Promise.all(
    allCompanies.map(async (company) => {
      const companyCtx: ServiceContext = {
        db: ctx.db,
        companyId: company.id,
        userId: ctx.userId,
      };
      const report = await balanceSheet(companyCtx, asOf);
      return { companyId: company.id, companyName: company.name, report };
    }),
  );

  // Sum balance sheet totals across all companies.
  let totalAssets = Money.zero();
  let totalLiabilities = Money.zero();
  let totalEquity = Money.zero();
  let totalRetainedEarnings = Money.zero();
  let totalPriorYears = Money.zero();
  let totalCurrentYear = Money.zero();

  for (const c of companies) {
    totalAssets = totalAssets.plus(Money.of(c.report.totalAssets));
    totalLiabilities = totalLiabilities.plus(Money.of(c.report.totalLiabilities));
    // totalEquity from balanceSheet already includes retained earnings (see reports.ts).
    totalEquity = totalEquity.plus(Money.of(c.report.totalEquity));
    totalRetainedEarnings = totalRetainedEarnings.plus(Money.of(c.report.retainedEarnings));
    totalPriorYears = totalPriorYears.plus(Money.of(c.report.priorYearsEarnings));
    totalCurrentYear = totalCurrentYear.plus(Money.of(c.report.currentYearNetIncome));
  }
  // Each company's sheet already balances (asserted in balanceSheet), so the sum must too.
  assertBalanceSheetBalanced('Consolidated balance sheet', totalAssets, totalLiabilities, totalEquity);

  const consolidated: BalanceSheet = {
    assets: [],
    liabilities: [],
    equity: [],
    totalAssets: toAmountString(totalAssets),
    totalLiabilities: toAmountString(totalLiabilities),
    totalEquity: toAmountString(totalEquity),
    retainedEarnings: toAmountString(totalRetainedEarnings),
    priorYearsEarnings: toAmountString(totalPriorYears),
    currentYearNetIncome: toAmountString(totalCurrentYear),
    balanced: Money.eq(totalAssets, totalLiabilities.plus(totalEquity)),
    asOf: asOf?.toISOString(),
  };

  return { companies, consolidated };
}

// ===========================================================================
// wave2 reports: Combine Reports from Multiple Companies — Trial Balance, Cash Flow,
// P&L by Month, A/R and A/P aging summaries (standard report engine output).
// ===========================================================================

/**
 * Companies in this file the caller may report on: the current company, plus every other
 * company where the same user is an ACTIVE member (or the owner) whose roles allow viewing the
 * report area. Combining never leaks another company's books. This holds for internal contexts
 * without an `access` grant too (the report scheduler runs as a company owner), so a scheduled
 * combined report cannot pull in a company that user can't open.
 */
export async function reportableCompanies(
  ctx: ServiceContext,
  area: 'reports_financial' | 'reports_sales' | 'reports_purchases' = 'reports_financial',
) {
  const all = await listCompanies(ctx.db);
  const out: typeof all = [];
  for (const c of all) {
    if (c.id === ctx.companyId) {
      out.push(c);
      continue;
    }
    if (!ctx.userId) continue;
    // Archived (soft-deleted) company files are not combined, as in QB (closed files).
    if ((c.settings as Record<string, unknown> | null)?.archived === true) continue;
    const r = await resolveAccess(ctx.db, c.id, ctx.userId);
    if (r.member && r.active && can(r.access, area, 'view')) out.push(c);
  }
  return out;
}

const companyCtx = (ctx: ServiceContext, companyId: string): ServiceContext => ({ db: ctx.db, companyId, userId: ctx.userId });

/** Merge charts of accounts across companies by section + number + name (QB combines by name). */
async function mergedMeta(ctx: ServiceContext, companyIds: string[]) {
  const meta = new Map<string, AccountMeta>();
  const keyOfAccount = new Map<string, string>();
  const perCompany: Map<string, AccountMeta>[] = [];
  for (const id of companyIds) perCompany.push(await loadAccountMeta(companyCtx(ctx, id)));
  for (const m of perCompany) {
    for (const a of m.values()) {
      const key = `${a.section}|${a.code}|${a.name.toLowerCase()}`;
      keyOfAccount.set(a.id, key);
      if (!meta.has(key)) meta.set(key, { ...a, id: key, parentId: null });
    }
  }
  for (const m of perCompany) {
    for (const a of m.values()) {
      if (!a.parentId) continue;
      const k = keyOfAccount.get(a.id)!;
      const pk = keyOfAccount.get(a.parentId);
      const merged = meta.get(k)!;
      if (pk && !merged.parentId && pk !== k) merged.parentId = pk;
    }
  }
  return { meta, keyOfAccount };
}

/** Merged-chart key of the Retained Earnings line of companies that have no such account. */
const SYNTHETIC_RE_KEY = 'equity|~|retained earnings';

export async function combinedTrialBalance(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const cos = await reportableCompanies(ctx);
  const { meta, keyOfAccount } = await mergedMeta(ctx, cos.map((c) => c.id));
  const n = cos.length + 1;
  const amounts = new Map<string, Amounts>();
  let totalDebit = Money.zero();
  let totalCredit = Money.zero();
  let balanced = true;
  for (let i = 0; i < cos.length; i++) {
    // Each company's trial balance as QuickBooks shows it (trialBalanceAmounts): income and
    // expense accounts for its fiscal year to date, earlier years' income in Retained Earnings.
    const cctx = companyCtx(ctx, cos[i].id);
    const tb = await trialBalanceAmounts(cctx, await loadAccountMeta(cctx), asOf, undefined);
    balanced = balanced && tb.ledgerBalanced;
    const put = (k: string, net: Decimal) => {
      if (net.isZero()) return;
      const v = amounts.get(k) ?? zeros(n);
      v[i] = v[i].plus(net);
      v[n - 1] = v[n - 1].plus(net);
      amounts.set(k, v);
      if (net.greaterThan(0)) totalDebit = totalDebit.plus(net);
      else totalCredit = totalCredit.minus(net);
    };
    for (const [accountId, net] of tb.amounts) put(keyOfAccount.get(accountId)!, net);
    if (!tb.retainedEarnings.isZero()) {
      // A company with no Retained Earnings account: its earlier years' income on one shared line.
      if (!meta.has(SYNTHETIC_RE_KEY)) {
        meta.set(SYNTHETIC_RE_KEY, { id: SYNTHETIC_RE_KEY, code: '', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings', parentId: null, isActive: true, section: 'equity', fullName: 'Retained Earnings' });
      }
      put(SYNTHETIC_RE_KEY, tb.retainedEarnings);
    }
  }
  assertTrialBalanceBalanced('Combined trial balance', totalDebit, totalCredit);
  const colKey = (i: number) => (i === n - 1 ? 'total' : `c${i}`);
  const cells = (label: string, v: Amounts): Record<string, CellValue> => {
    const c: Record<string, CellValue> = { label };
    v.forEach((x, i) => {
      c[`${colKey(i)}_dr`] = x.greaterThan(0) ? toAmountString(x) : null;
      c[`${colKey(i)}_cr`] = x.lessThan(0) ? toAmountString(x.negated()) : null;
    });
    return c;
  };
  const tree = buildAccountTree({ meta, amounts, ncols: n, idPrefix: 'ctb', parentRowId: null, depth: 0, cells });
  // TOTAL row = sum of the rows shown: each account's net per column lands in Debit or Credit,
  // so (e.g.) an overdrawn bank in one company nets against the other's balance in Combined.
  const colDr = zeros(n);
  const colCr = zeros(n);
  for (const v of amounts.values()) {
    v.forEach((x, i) => {
      if (x.greaterThan(0)) colDr[i] = colDr[i].plus(x);
      else if (x.lessThan(0)) colCr[i] = colCr[i].plus(x.negated());
    });
  }
  for (let i = 0; i < n; i++) {
    assertTrialBalanceBalanced(i === n - 1 ? 'Combined trial balance (combined column)' : `Combined trial balance (${cos[i].name})`, colDr[i], colCr[i]);
  }
  const totalCells: Record<string, CellValue> = { label: 'TOTAL' };
  for (let i = 0; i < n; i++) {
    totalCells[`${colKey(i)}_dr`] = toAmountString(colDr[i]);
    totalCells[`${colKey(i)}_cr`] = toAmountString(colCr[i]);
  }
  tree.rows.push({ id: 'ctb:total', depth: 0, kind: 'grand', cells: totalCells });
  const columns: StdColumn[] = [{ key: 'label', header: '' }];
  for (let i = 0; i < n; i++) {
    const name = i === n - 1 ? 'Combined' : cos[i].name;
    columns.push({ key: `${colKey(i)}_dr`, header: `${name} Debit`, type: 'money' }, { key: `${colKey(i)}_cr`, header: `${name} Credit`, type: 'money' });
  }
  return {
    key: 'combined-trial-balance',
    title: 'Combined Trial Balance',
    subtitle: `As of ${fmtDay(asOf)} · ${cos.length} companies`,
    columns,
    rows: tree.rows,
    balanced: balanced && Money.eq(totalDebit, totalCredit) && Money.eq(colDr[n - 1], colCr[n - 1]),
  };
}

export async function combinedProfitAndLossByMonth(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const cos = await reportableCompanies(ctx);
  const { meta, keyOfAccount } = await mergedMeta(ctx, cos.map((c) => c.id));
  const periods = splitPeriods(from, to, 'month');
  if (periods.length > 60) throw validation('Choose a shorter range (at most 60 months).');
  const amountKeys = [...periods.map((x) => x.key), 'total'];
  const amounts = new Map<string, Amounts>();
  for (const c of cos) {
    const cmeta = await loadAccountMeta(companyCtx(ctx, c.id));
    const act = await activityByAccount(
      companyCtx(ctx, c.id),
      { from, to, excludeClose: true, basis: p.basis === 'cash' ? 'cash' : undefined },
      'day',
    );
    for (const r of act) {
      const a = cmeta.get(r.accountId);
      if (!a || !isPLSection(a.section)) continue;
      const k = keyOfAccount.get(r.accountId)!;
      const v = amounts.get(k) ?? zeros(amountKeys.length);
      const amt = naturalAmount(a.section, r.debit, r.credit);
      const i = periodIndex(periods, parseDay(r.bucket ?? undefined)!);
      if (i >= 0) v[i] = v[i].plus(amt);
      v[periods.length] = v[periods.length].plus(amt);
      amounts.set(k, v);
    }
  }
  const columns: StdColumn[] = [
    { key: 'label', header: '' },
    ...periods.map((x) => ({ key: x.key, header: x.label, type: 'money' as const })),
    { key: 'total', header: 'TOTAL', type: 'money' },
  ];
  const built = buildPLRows({ meta, amounts, columns, amountKeys });
  return {
    key: 'combined-pl-by-month',
    title: 'Combined Profit & Loss by Month',
    subtitle: `${fmtDay(from)} – ${fmtDay(to)} · ${cos.length} companies${p.basis === 'cash' ? ' · Cash Basis' : ''}`,
    columns,
    rows: built.rows,
  };
}

export async function combinedCashFlow(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const cos = await reportableCompanies(ctx);
  const reports = await Promise.all(cos.map((c) => cashFlow(companyCtx(ctx, c.id), { from, to })));
  const n = cos.length + 1;
  const columns: StdColumn[] = [
    { key: 'label', header: '' },
    ...cos.map((c, i) => ({ key: `c${i}`, header: c.name, type: 'money' as const })),
    { key: 'total', header: 'Combined', type: 'money' },
  ];
  const cells = (label: string, vals: Decimal[]): Record<string, CellValue> => {
    const c: Record<string, CellValue> = { label };
    vals.forEach((v, i) => (c[i === n - 1 ? 'total' : `c${i}`] = toAmountString(v)));
    return c;
  };
  const withTotal = (vals: Decimal[]) => [...vals, vals.reduce((s, v) => s.plus(v), Money.zero())];
  const rows: StdRow[] = [];
  const line = (id: string, label: string, pick: (r: CashFlowReport) => string, depth = 1, kind: StdRow['kind'] = 'data') =>
    rows.push({ id, depth, kind, cells: cells(label, withTotal(reports.map((r) => Money.of(pick(r))))) });
  const named = (id: string, list: (r: CashFlowReport) => CashFlowLine[]) => {
    const names = new Map<string, string>();
    for (const r of reports) for (const l of list(r)) names.set(`${l.code}|${l.name}`, l.name);
    for (const [k, label] of [...names.entries()].sort()) {
      line(
        `${id}:${k}`,
        label,
        (r) =>
          list(r)
            .filter((l) => `${l.code}|${l.name}` === k)
            .reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero())
            .toFixed(2),
        1,
      );
    }
  };
  rows.push({ id: 'ccf:op', depth: 0, kind: 'section', cells: { label: 'OPERATING ACTIVITIES' } });
  line('ccf:ni', 'Net Income', (r) => r.operating.netIncome);
  line('ccf:ar', 'Accounts Receivable', (r) => r.operating.changeInAR);
  line('ccf:ap', 'Accounts Payable', (r) => r.operating.changeInAP);
  line('ccf:inv', 'Inventory', (r) => r.operating.changeInInventory);
  named('ccf:oth', (r) => r.operating.otherChanges);
  line('ccf:optotal', 'Net cash provided by Operating Activities', (r) => r.operating.total, 0, 'total');
  rows.push({ id: 'ccf:invest', depth: 0, kind: 'section', cells: { label: 'INVESTING ACTIVITIES' } });
  named('ccf:invl', (r) => r.investing.lines);
  line('ccf:invtotal', 'Net cash provided by Investing Activities', (r) => r.investing.total, 0, 'total');
  rows.push({ id: 'ccf:fin', depth: 0, kind: 'section', cells: { label: 'FINANCING ACTIVITIES' } });
  named('ccf:finl', (r) => r.financing.lines);
  line('ccf:fintotal', 'Net cash provided by Financing Activities', (r) => r.financing.total, 0, 'total');
  line('ccf:net', 'Net cash increase for period', (r) => r.netCashChange, 0, 'grand');
  return {
    key: 'combined-cash-flow',
    title: 'Combined Statement of Cash Flows',
    subtitle: `${fmtDay(from)} – ${fmtDay(to)} · ${cos.length} companies`,
    columns,
    rows,
  };
}

export async function combinedAging(ctx: ServiceContext, p: ReportParams, which: 'ar' | 'ap'): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const cos = await reportableCompanies(ctx, which === 'ar' ? 'reports_sales' : 'reports_purchases');
  const keys = ['current', 'days1_30', 'days31_60', 'days61_90', 'days91plus', 'total'] as const;
  const rows: StdRow[] = [];
  const grand = keys.map(() => Money.zero());
  for (const c of cos) {
    const r = which === 'ar' ? await arAging(companyCtx(ctx, c.id), asOf) : await apAging(companyCtx(ctx, c.id), asOf);
    if (r.rows.length === 0) continue;
    const hid = `cag:${c.id}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: c.name } };
    rows.push(header);
    for (const b of r.rows) {
      const cells: Record<string, CellValue> = { label: b.name };
      for (const k of keys) cells[k] = b[k];
      rows.push({ id: `${hid}:${b.id}`, parentId: hid, depth: 1, kind: 'data', cells });
    }
    const tc: Record<string, CellValue> = { label: `Total ${c.name}` };
    keys.forEach((k, i) => {
      tc[k] = r.totals[k];
      grand[i] = grand[i].plus(Money.of(r.totals[k]));
    });
    header.collapsedCells = { ...tc, label: c.name };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tc });
  }
  const gc: Record<string, CellValue> = { label: 'TOTAL' };
  keys.forEach((k, i) => (gc[k] = toAmountString(grand[i])));
  rows.push({ id: 'cag:grand', depth: 0, kind: 'grand', cells: gc });
  return {
    key: which === 'ar' ? 'combined-ar-aging' : 'combined-ap-aging',
    title: which === 'ar' ? 'Combined A/R Aging Summary' : 'Combined A/P Aging Summary',
    subtitle: `As of ${fmtDay(asOf)} · ${cos.length} companies`,
    columns: [
      { key: 'label', header: which === 'ar' ? 'Customer' : 'Vendor' },
      { key: 'current', header: 'Current', type: 'money' },
      { key: 'days1_30', header: '1 - 30', type: 'money' },
      { key: 'days31_60', header: '31 - 60', type: 'money' },
      { key: 'days61_90', header: '61 - 90', type: 'money' },
      { key: 'days91plus', header: '> 90', type: 'money' },
      { key: 'total', header: 'TOTAL', type: 'money' },
    ],
    rows,
  };
}
