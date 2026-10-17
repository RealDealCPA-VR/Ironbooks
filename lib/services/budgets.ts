/**
 * Budgets service — create/read budgets and budget lines, plus budget-vs-actual comparison.
 *
 * Design notes:
 *  - Budgets are company-scoped and keyed by name + fiscalYear.
 *  - Budget lines are monthly amounts per account (month 1-12). setBudgetLine upserts.
 *  - budgetVsActual calls profitAndLoss for the budget's fiscal year and matches income/expense
 *    accounts by accountId, returning [{accountId, code, name, budget, actual, variance}].
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { accounts, budgetLines, budgets, classes, customers } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { profitAndLoss } from '@/lib/services/reports';
import { fiscalYearWindow } from './fiscalClose';
import type { ServiceContext } from './_base';
import { notFound, validation, writeAudit } from './_base';
import type Decimal from 'decimal.js';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import {
  BS_SECTIONS,
  PL_SECTIONS,
  SECTION_LABELS,
  activityByAccount,
  anyNonZero,
  companyFiscalYearEnd,
  buildAccountTree,
  buildPLRows,
  fetchGlLines,
  isPLSection,
  loadAccountMeta,
  naturalAmount,
  zeros,
  type AccountMeta,
  type Amounts,
} from './reportEngine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Budget {
  id: string;
  name: string;
  fiscalYear: number;
  /** 'profit_loss' (default) or 'balance_sheet'. */
  kind?: string;
  /** True for a Forecast (QB Forecasts), reported separately from budgets. */
  isForecast?: boolean;
  createdAt: Date;
}

export interface BudgetLine {
  id: string;
  budgetId: string;
  accountId: string;
  classId?: string | null;
  customerId?: string | null;
  month: number;
  amount: string;
}

export interface BudgetWithLines extends Budget {
  lines: BudgetLine[];
}

/** One budget/actual/variance cell for a single period column. */
export interface BudgetPeriodCell {
  budget: string;
  actual: string;
  /** actual - budget. */
  variance: string;
}

/** Period column mode for budgetVsActual (annual totals when omitted). */
export type BudgetPeriodMode = 'monthly' | 'quarterly';

export interface BudgetVsActualRow {
  accountId: string;
  code: string;
  name: string;
  /** 'revenue' or 'expense' — balance-sheet accounts are not budgetable. */
  accountType: 'revenue' | 'expense';
  /** Sum of all 12 monthly budget amounts for this account. */
  budget: string;
  /** Actual activity from the GL for the full fiscal year. */
  actual: string;
  /** Raw signed variance: actual - budget. */
  variance: string;
  /**
   * Favorability orientation: revenue is favorable when actual >= budget;
   * expense is favorable when actual <= budget.
   */
  favorable: boolean;
  /** Per-period cells (12 monthly or 4 quarterly) when a period mode is requested. */
  periods?: BudgetPeriodCell[];
}

export interface BudgetSectionTotals {
  budget: string;
  actual: string;
  /** actual - budget. */
  variance: string;
}

export interface BudgetVsActualReport {
  budgetId: string;
  budgetName: string;
  fiscalYear: number;
  rows: BudgetVsActualRow[];
  /** Income (revenue) section totals. */
  income: BudgetSectionTotals;
  /** Expense section totals. */
  expense: BudgetSectionTotals;
  /**
   * Net bottom line (income - expense). The legacy totalBudget/totalActual/
   * totalVariance fields carry these net figures — income and expenses are never
   * summed together as one mixed total.
   */
  netBudget: string;
  netActual: string;
  netVariance: string;
  totalBudget: string;
  totalActual: string;
  totalVariance: string;
  /** Period column labels ('Jan'…'Dec' or 'Q1'…'Q4') when a period mode is requested. */
  periodLabels?: string[];
  /** Net (income - expense) budget/actual/variance per period column. */
  periodNetTotals?: BudgetPeriodCell[];
}

// ---------------------------------------------------------------------------
// listBudgets
// ---------------------------------------------------------------------------

export async function listBudgets(ctx: ServiceContext): Promise<Budget[]> {
  const rows = await ctx.db
    .select()
    .from(budgets)
    .where(eq(budgets.companyId, ctx.companyId))
    .orderBy(budgets.fiscalYear, budgets.name);
  return rows;
}

// ---------------------------------------------------------------------------
// createBudget
// ---------------------------------------------------------------------------

export async function createBudget(
  ctx: ServiceContext,
  input: { name: string; fiscalYear: number; kind?: 'profit_loss' | 'balance_sheet'; isForecast?: boolean },
): Promise<Budget> {
  const { name, fiscalYear } = input;
  const kind = input.kind ?? 'profit_loss';
  if (kind !== 'profit_loss' && kind !== 'balance_sheet') throw validation('Budget type must be profit_loss or balance_sheet');
  if (!name?.trim()) throw validation('Budget name is required');
  if (!fiscalYear || fiscalYear < 2000 || fiscalYear > 2100) {
    throw validation('fiscalYear must be a 4-digit year between 2000 and 2100');
  }

  const [row] = await ctx.db
    .insert(budgets)
    .values({ companyId: ctx.companyId, name: name.trim(), fiscalYear, kind, isForecast: input.isForecast ?? false })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: input.isForecast ? 'forecast' : 'budget',
    entityId: row.id,
    newValues: { name: row.name, fiscalYear: row.fiscalYear, kind, isForecast: row.isForecast },
  });

  return row;
}

// ---------------------------------------------------------------------------
// getBudget (with lines)
// ---------------------------------------------------------------------------

export async function getBudget(ctx: ServiceContext, id: string): Promise<BudgetWithLines> {
  const [budget] = await ctx.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, id), eq(budgets.companyId, ctx.companyId)));

  if (!budget) throw notFound('Budget');

  const lines = await ctx.db
    .select()
    .from(budgetLines)
    .where(eq(budgetLines.budgetId, id))
    .orderBy(budgetLines.accountId, budgetLines.month);

  return { ...budget, lines };
}

// ---------------------------------------------------------------------------
// setBudgetLine (upsert)
// ---------------------------------------------------------------------------

export async function setBudgetLine(
  ctx: ServiceContext,
  input: {
    budgetId: string;
    accountId: string;
    month: number;
    amount: string;
    /** Customer:Job dimension (QB budgets by Customer:Job). */
    customerId?: string | null;
    classId?: string | null;
  },
): Promise<BudgetLine> {
  const { budgetId, accountId, month, amount } = input;
  const customerId = input.customerId ?? null;
  const classId = input.classId ?? null;

  // Verify budget belongs to this company.
  const [budget] = await ctx.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, budgetId), eq(budgets.companyId, ctx.companyId)));
  if (!budget) throw notFound('Budget');

  if (month < 1 || month > 12) throw validation('month must be between 1 and 12');
  if (!amount || isNaN(Number(amount))) throw validation('amount must be a valid number');

  // Verify account belongs to this company.
  const [account] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)));
  if (!account) throw notFound('Account');

  // P&L budgets compare against P&L actuals — balance-sheet accounts have no P&L activity to
  // compare to. Balance-sheet budgets (kind 'balance_sheet') are the reverse.
  const isPl = account.type === 'revenue' || account.type === 'expense';
  if ((budget.kind ?? 'profit_loss') === 'balance_sheet') {
    if (isPl) throw validation('A balance sheet budget can only hold balance sheet accounts.');
    if (customerId) throw validation('Balance sheet budgets cannot be split by customer.');
  } else if (!isPl) {
    throw validation('Budget lines can only be set for revenue or expense accounts.');
  }
  if (customerId) {
    const [cust] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.companyId, ctx.companyId)));
    if (!cust) throw notFound('Customer');
  }
  if (classId) {
    const [cls] = await ctx.db
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.id, classId), eq(classes.companyId, ctx.companyId)));
    if (!cls) throw notFound('Class');
  }
  // A budget is either company-wide or by Customer:Job (QB picks the criteria per budget) —
  // mixing would double count in budget-vs-actual totals.
  const [mix] = await ctx.db
    .select({ id: budgetLines.id })
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetId, budgetId),
        customerId ? isNull(budgetLines.customerId) : isNotNull(budgetLines.customerId),
      ),
    )
    .limit(1);
  if (mix) {
    throw validation(
      customerId
        ? 'This budget already has company-wide amounts; create a separate budget by Customer:Job.'
        : 'This budget is by Customer:Job; choose a customer for every amount.',
    );
  }

  // Upsert: PGlite supports ON CONFLICT via Drizzle's onConflictDoUpdate.
  // The unique constraint is (budgetId, accountId, month) — enforced at app level since
  // there is no DB unique index defined in schema; we query-then-upsert.
  const existing = await ctx.db
    .select()
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetId, budgetId),
        eq(budgetLines.accountId, accountId),
        eq(budgetLines.month, month),
        customerId ? eq(budgetLines.customerId, customerId) : isNull(budgetLines.customerId),
        classId ? eq(budgetLines.classId, classId) : isNull(budgetLines.classId),
      ),
    );

  let line: BudgetLine;
  const normalizedAmount = toAmountString(amount);

  if (existing.length > 0) {
    const [updated] = await ctx.db
      .update(budgetLines)
      .set({ amount: normalizedAmount })
      .where(eq(budgetLines.id, existing[0].id))
      .returning();
    line = updated;
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'budgetLine',
      entityId: line.id,
      oldValues: { amount: existing[0].amount },
      newValues: { amount: normalizedAmount },
    });
  } else {
    const [inserted] = await ctx.db
      .insert(budgetLines)
      .values({ budgetId, accountId, month, amount: normalizedAmount, customerId, classId })
      .returning();
    line = inserted;
    await writeAudit(ctx, {
      action: 'create',
      entityType: 'budgetLine',
      entityId: line.id,
      newValues: { budgetId, accountId, month, amount: normalizedAmount, customerId, classId },
    });
  }

  return line;
}

// ---------------------------------------------------------------------------
// budgetVsActual
// ---------------------------------------------------------------------------

/** Bucket 12 monthly Decimal amounts into period sums (12 monthly or 4 quarterly). */
function bucketMonths(
  months: ReturnType<typeof Money.zero>[],
  mode: BudgetPeriodMode,
): ReturnType<typeof Money.zero>[] {
  if (mode === 'monthly') return months;
  const quarters = Array.from({ length: 4 }, () => Money.zero());
  months.forEach((amt, i) => {
    quarters[Math.floor(i / 3)] = quarters[Math.floor(i / 3)].plus(amt);
  });
  return quarters;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface FiscalMonth {
  /** Calendar year and month (1-12) of this month of the fiscal year. */
  year: number;
  month: number;
  from: Date;
  to: Date;
}

/**
 * The budget's fiscal year (the company's fiscal year END, settings.fiscalYearEnd — e.g. FY2026 of
 * a June 30 company is Jul 2025 – Jun 2026) and its twelve months in fiscal order. Budget lines
 * keep their CALENDAR month (1 = January, as the budget grid enters them); each calendar month
 * is the one month of that name inside the fiscal year, so a calendar-year company is unchanged.
 */
async function budgetFiscalYear(ctx: ServiceContext, fiscalYear: number) {
  const w = fiscalYearWindow(fiscalYear, await companyFiscalYearEnd(ctx));
  const from = w.yearStart;
  const to = new Date(w.yearEnd.getTime() - 1);
  const months: FiscalMonth[] = [];
  for (let i = 0; i < 12; i++) {
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - 1);
    months.push({
      year: start.getUTCFullYear(),
      month: start.getUTCMonth() + 1,
      from: start < from ? from : start,
      to: end > to ? to : end,
    });
  }
  /** Fiscal position (0-11) of a calendar month (1-12). */
  const indexOf = (calendarMonth: number) => Math.max(0, months.findIndex((m) => m.month === calendarMonth));
  return { from, to, months, indexOf };
}

/**
 * For each account that has at least one budget line, sum the budgeted amounts
 * (all months), then fetch actual P&L for the full fiscal year and match by accountId.
 * Returns rows sorted by account code.
 *
 * Period columns (additive): pass opts.periods = 'monthly' | 'quarterly' to get
 * per-period budget/actual/variance cells on every row (reuses the monthly P&L
 * bucketing in fiscal months, Q1 = the first fiscal quarter) plus net per-period totals.
 */
export async function budgetVsActual(
  ctx: ServiceContext,
  budgetId: string,
  opts?: { periods?: BudgetPeriodMode },
): Promise<BudgetVsActualReport> {
  const [budget] = await ctx.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, budgetId), eq(budgets.companyId, ctx.companyId)));
  if (!budget) throw notFound('Budget');

  // Sum budget lines per account.
  const lines = await ctx.db
    .select()
    .from(budgetLines)
    .where(eq(budgetLines.budgetId, budgetId));

  // The company's fiscal year, month by month in fiscal order.
  const fy = await budgetFiscalYear(ctx, budget.fiscalYear);

  // Aggregate budget by accountId (annual total + per-month for period columns, fiscal order).
  const budgetByAccount = new Map<string, ReturnType<typeof Money.zero>>();
  const budgetMonthsByAccount = new Map<string, ReturnType<typeof Money.zero>[]>();
  for (const line of lines) {
    const prev = budgetByAccount.get(line.accountId) ?? Money.zero();
    budgetByAccount.set(line.accountId, prev.plus(Money.of(line.amount)));
    const months =
      budgetMonthsByAccount.get(line.accountId) ??
      Array.from({ length: 12 }, () => Money.zero());
    const i = fy.indexOf(line.month);
    months[i] = months[i].plus(Money.of(line.amount));
    budgetMonthsByAccount.set(line.accountId, months);
  }

  // Fetch full fiscal-year P&L actuals (closing entries are already excluded there).
  const pl = await profitAndLoss(ctx, { from: fy.from, to: fy.to });

  // Monthly actuals (fiscal months) only when period columns were requested (12 extra queries).
  const periodMode = opts?.periods;
  type MonthlyActuals = { income: { accountId: string; months: string[] }[]; expenses: { accountId: string; months: string[] }[] };
  let monthlyPl: MonthlyActuals | null = null;
  if (periodMode) {
    const perMonth = await Promise.all(fy.months.map((m) => profitAndLoss(ctx, { from: m.from, to: m.to })));
    const collect = (side: 'income' | 'expenses') => {
      const byAccount = new Map<string, string[]>();
      perMonth.forEach((mp, i) => {
        for (const l of mp[side]) {
          const arr = byAccount.get(l.accountId) ?? Array<string>(12).fill('0.00');
          arr[i] = l.amount;
          byAccount.set(l.accountId, arr);
        }
      });
      return [...byAccount].map(([accountId, months]) => ({ accountId, months }));
    };
    monthlyPl = { income: collect('income'), expenses: collect('expenses') };
  }
  const periodCount = periodMode === 'monthly' ? 12 : periodMode === 'quarterly' ? 4 : 0;
  const periodNetBudget = Array.from({ length: periodCount }, () => Money.zero());
  const periodNetActual = Array.from({ length: periodCount }, () => Money.zero());

  // Build a map of accountId -> actual amount from P&L.
  const actualByAccount = new Map<string, string>();
  for (const line of [...pl.income, ...pl.expenses]) {
    actualByAccount.set(line.accountId, line.amount);
  }

  // Fetch account metadata for all budgeted accounts.
  const accountIds = [...budgetByAccount.keys()];
  const accountRows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId)));

  const accountMeta = new Map(
    accountRows.map((a) => [a.id, { code: a.code, name: a.name, type: a.type }]),
  );

  // Build result rows, sectioned into income vs expense — the two must never be
  // summed into one mixed total (their natural balances point opposite ways).
  const rows: BudgetVsActualRow[] = [];
  let incomeBudget = Money.zero();
  let incomeActual = Money.zero();
  let expenseBudget = Money.zero();
  let expenseActual = Money.zero();

  for (const accountId of accountIds) {
    const meta = accountMeta.get(accountId);
    if (!meta) continue; // account deleted — skip
    // Legacy budget lines saved against balance-sheet accounts have no P&L actuals
    // to compare to — skip them (setBudgetLine now rejects new ones).
    if (meta.type !== 'revenue' && meta.type !== 'expense') continue;

    const isRevenue = meta.type === 'revenue';
    const budgetAmt = budgetByAccount.get(accountId) ?? Money.zero();
    const actualAmt = Money.of(actualByAccount.get(accountId) ?? '0');
    const variance = actualAmt.minus(budgetAmt);

    if (isRevenue) {
      incomeBudget = incomeBudget.plus(budgetAmt);
      incomeActual = incomeActual.plus(actualAmt);
    } else {
      expenseBudget = expenseBudget.plus(budgetAmt);
      expenseActual = expenseActual.plus(actualAmt);
    }

    // Per-period cells (monthly/quarterly column mode).
    let periods: BudgetPeriodCell[] | undefined;
    if (periodMode && monthlyPl) {
      const monthlyRow = (isRevenue ? monthlyPl.income : monthlyPl.expenses).find(
        (r) => r.accountId === accountId,
      );
      const actualMonths = (monthlyRow?.months ?? Array(12).fill('0.00')).map((m: string) =>
        Money.of(m),
      );
      const budgetMonths =
        budgetMonthsByAccount.get(accountId) ?? Array.from({ length: 12 }, () => Money.zero());
      const actualPeriods = bucketMonths(actualMonths, periodMode);
      const budgetPeriods = bucketMonths(budgetMonths, periodMode);
      periods = actualPeriods.map((actualP, p) => {
        const budgetP = budgetPeriods[p];
        // Net per-period totals: income adds, expense subtracts.
        periodNetBudget[p] = isRevenue
          ? periodNetBudget[p].plus(budgetP)
          : periodNetBudget[p].minus(budgetP);
        periodNetActual[p] = isRevenue
          ? periodNetActual[p].plus(actualP)
          : periodNetActual[p].minus(actualP);
        return {
          budget: toAmountString(budgetP),
          actual: toAmountString(actualP),
          variance: toAmountString(actualP.minus(budgetP)),
        };
      });
    }

    rows.push({
      accountId,
      code: meta.code,
      name: meta.name,
      accountType: meta.type,
      budget: toAmountString(budgetAmt),
      actual: toAmountString(actualAmt),
      variance: toAmountString(variance),
      // Over-target income is favorable; over-budget expense is unfavorable.
      favorable: isRevenue
        ? actualAmt.greaterThanOrEqualTo(budgetAmt)
        : actualAmt.lessThanOrEqualTo(budgetAmt),
      periods,
    });
  }

  rows.sort((a, b) => a.code.localeCompare(b.code));

  const netBudget = incomeBudget.minus(expenseBudget);
  const netActual = incomeActual.minus(expenseActual);
  const netVariance = netActual.minus(netBudget);

  return {
    budgetId,
    budgetName: budget.name,
    fiscalYear: budget.fiscalYear,
    rows,
    income: {
      budget: toAmountString(incomeBudget),
      actual: toAmountString(incomeActual),
      variance: toAmountString(incomeActual.minus(incomeBudget)),
    },
    expense: {
      budget: toAmountString(expenseBudget),
      actual: toAmountString(expenseActual),
      variance: toAmountString(expenseActual.minus(expenseBudget)),
    },
    netBudget: toAmountString(netBudget),
    netActual: toAmountString(netActual),
    netVariance: toAmountString(netVariance),
    // Legacy fields now carry the net bottom line (income - expense).
    totalBudget: toAmountString(netBudget),
    totalActual: toAmountString(netActual),
    totalVariance: toAmountString(netVariance),
    periodLabels: periodMode
      ? periodMode === 'monthly'
        ? fy.months.map((m) => MONTH_LABELS[m.month - 1])
        : ['Q1', 'Q2', 'Q3', 'Q4']
      : undefined,
    periodNetTotals: periodMode
      ? periodNetActual.map((actualP, p) => ({
          budget: toAmountString(periodNetBudget[p]),
          actual: toAmountString(actualP),
          variance: toAmountString(actualP.minus(periodNetBudget[p])),
        }))
      : undefined,
  };
}

// ===========================================================================
// wave2 reports: Budget Overview, Budget vs. Actual (by Customer:Job / class / balance sheet),
// Forecast Overview — standard report engine output (sub-account roll-up, QB sections).
// ===========================================================================

const MONTH_KEYS = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);

async function loadBudgetForReport(ctx: ServiceContext, budgetId: string | undefined) {
  if (!budgetId) throw validation('Choose a budget or forecast to report on.');
  const [budget] = await ctx.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, budgetId), eq(budgets.companyId, ctx.companyId)));
  if (!budget) throw notFound('Budget');
  const lines = await ctx.db.select().from(budgetLines).where(eq(budgetLines.budgetId, budgetId));
  return { budget, lines };
}

/** Rows for balance-sheet accounts grouped by section (used by balance-sheet budgets). */
function bsSectionRows(
  meta: Map<string, AccountMeta>,
  amounts: Map<string, Amounts>,
  ncols: number,
  cells: (label: string, v: Amounts) => Record<string, CellValue>,
): StdRow[] {
  const rows: StdRow[] = [];
  for (const s of BS_SECTIONS) {
    const m = new Map([...amounts].filter(([id]) => meta.get(id)?.section === s));
    if (![...m.values()].some(anyNonZero)) continue;
    const id = `bb:${s}`;
    const header: StdRow = { id, depth: 0, kind: 'section', collapseKind: 'section', cells: { label: SECTION_LABELS[s] } };
    rows.push(header);
    const tree = buildAccountTree({ meta, amounts: m, ncols, idPrefix: id, parentRowId: id, depth: 1, cells });
    rows.push(...tree.rows);
    header.collapsedCells = cells(SECTION_LABELS[s], tree.total);
    rows.push({ id: `${id}:total`, depth: 0, kind: 'subtotal', totalOf: id, cells: cells(`Total ${SECTION_LABELS[s]}`, tree.total) });
  }
  return rows;
}

/**
 * Budget Overview / Forecast Overview — the budget's monthly amounts in statement layout
 * (P&L sections with Net Income, or balance-sheet sections), optionally for one Customer:Job.
 */
export async function budgetOverviewReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { budget, lines } = await loadBudgetForReport(ctx, p.budgetId);
  const meta = await loadAccountMeta(ctx);
  const isBs = budget.kind === 'balance_sheet';
  const ncols = isBs ? 12 : 13;
  const amounts = new Map<string, Amounts>();
  for (const l of lines) {
    if (p.customerId && l.customerId !== p.customerId) continue;
    if (p.classId && l.classId !== p.classId) continue;
    const v = amounts.get(l.accountId) ?? zeros(ncols);
    v[l.month - 1] = v[l.month - 1].plus(Money.of(l.amount));
    if (!isBs) v[12] = v[12].plus(Money.of(l.amount));
    amounts.set(l.accountId, v);
  }
  // Columns in fiscal order (a June 30 company's FY2026 starts with Jul 2025); each budget line
  // keeps its calendar month column (m1 = January).
  const fy = await budgetFiscalYear(ctx, budget.fiscalYear);
  const columns: StdColumn[] = [
    { key: 'label', header: '' },
    ...fy.months.map((m) => ({ key: MONTH_KEYS[m.month - 1], header: `${MONTH_LABELS[m.month - 1]} ${m.year}`, type: 'money' as const })),
    ...(isBs ? [] : [{ key: 'total', header: 'TOTAL', type: 'money' as const }]),
  ];
  const keys = [...MONTH_KEYS, ...(isBs ? [] : ['total'])];
  const rows = isBs
    ? bsSectionRows(meta, amounts, ncols, (label, v) => {
        const c: Record<string, CellValue> = { label };
        keys.forEach((k, i) => (c[k] = toAmountString(v[i])));
        return c;
      })
    : buildPLRows({ meta, amounts, columns, amountKeys: keys }).rows;
  return {
    key: budget.isForecast ? 'forecast-overview' : 'budget-overview',
    title: budget.isForecast ? 'Forecast Overview' : 'Budget Overview',
    subtitle: `${budget.name} · FY${budget.fiscalYear}${p.customerId ? ' · one Customer:Job' : ''}`,
    columns,
    rows,
  };
}

interface BvaPeriod {
  key: string;
  months: number[];
  label: string;
}

/**
 * Budget vs. Actual (QB layout: Actual, Budget, $ Over Budget, % of Budget) — P&L budgets by
 * company, class or Customer:Job (actuals from the ledger lines of that customer's transactions),
 * and balance-sheet budgets (actual month-end balances vs budgeted balances).
 */
export async function budgetVsActualReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { budget, lines } = await loadBudgetForReport(ctx, p.budgetId);
  const meta = await loadAccountMeta(ctx);
  const isBs = budget.kind === 'balance_sheet';
  const year = budget.fiscalYear;
  // The company's fiscal year (FY2026 of a June 30 company = Jul 2025 – Jun 2026), in fiscal order.
  // Budget lines keep their calendar month (1 = January).
  const fy = await budgetFiscalYear(ctx, year);
  const lastFm = fy.months[11];
  const fmOf = (month: number) => fy.months.find((m) => m.month === month) ?? lastFm;
  const periods: BvaPeriod[] =
    p.columns === 'month'
      ? fy.months.map((m) => ({ key: MONTH_KEYS[m.month - 1], months: [m.month], label: `${MONTH_LABELS[m.month - 1]} ${m.year}` }))
      : [
          {
            key: 'total',
            months: isBs ? [lastFm.month] : fy.months.map((m) => m.month),
            label: isBs ? `${MONTH_LABELS[lastFm.month - 1]} ${lastFm.year}` : `FY${year}`,
          },
        ];
  const n = periods.length * 2;
  const amounts = new Map<string, Amounts>();
  const add = (id: string, idx: number, v: Decimal) => {
    const a = amounts.get(id) ?? zeros(n);
    a[idx] = a[idx].plus(v);
    amounts.set(id, a);
  };
  const addForMonth = (id: string, month: number, slot: 0 | 1, v: Decimal) => {
    periods.forEach((per, i) => {
      if (per.months.includes(month)) add(id, i * 2 + slot, v);
    });
  };
  // Budget amounts (odd slots).
  for (const l of lines) {
    if (p.customerId && l.customerId !== p.customerId) continue;
    if (p.classId && l.classId !== p.classId) continue;
    addForMonth(l.accountId, l.month, 1, Money.of(l.amount));
  }
  // Actual amounts (even slots).
  const yearFrom = fy.from;
  const yearTo = fy.to;
  if (isBs) {
    for (let i = 0; i < periods.length; i++) {
      const lastMonth = periods[i].months[periods[i].months.length - 1];
      for (const r of await activityByAccount(ctx, { to: fmOf(lastMonth).to })) {
        const a = meta.get(r.accountId);
        if (!a || isPLSection(a.section)) continue;
        add(r.accountId, i * 2, naturalAmount(a.section, r.debit, r.credit));
      }
    }
  } else if (p.customerId) {
    const { lines: gl } = await fetchGlLines(ctx, meta, {
      from: yearFrom,
      to: yearTo,
      sections: [...PL_SECTIONS],
      excludeClose: true,
      nameId: p.customerId,
      nameType: 'customer',
      limit: 50000,
    });
    for (const l of gl) addForMonth(l.accountId, l.date.getUTCMonth() + 1, 0, l.natural);
  } else {
    const act = await activityByAccount(ctx, { from: yearFrom, to: yearTo, classId: p.classId, excludeClose: true }, 'month');
    for (const r of act) {
      const a = meta.get(r.accountId);
      if (!a || !isPLSection(a.section)) continue;
      addForMonth(r.accountId, Number(String(r.bucket).slice(5, 7)), 0, naturalAmount(a.section, r.debit, r.credit));
    }
  }
  const columns: StdColumn[] = [{ key: 'label', header: '' }];
  const amountKeys: string[] = [];
  for (const per of periods) {
    const pre = periods.length > 1 ? `${per.label} ` : '';
    columns.push(
      { key: `${per.key}_act`, header: `${pre}Actual`, type: 'money' },
      { key: `${per.key}_bud`, header: `${pre}${budget.isForecast ? 'Forecast' : 'Budget'}`, type: 'money' },
      { key: `${per.key}_over`, header: `${pre}$ Over ${budget.isForecast ? 'Forecast' : 'Budget'}`, type: 'money' },
      { key: `${per.key}_pct`, header: `${pre}% of ${budget.isForecast ? 'Forecast' : 'Budget'}`, type: 'percent' },
    );
    amountKeys.push(`${per.key}_act`, `${per.key}_bud`);
  }
  const derive = (v: Amounts): Record<string, CellValue> => {
    const out: Record<string, CellValue> = {};
    periods.forEach((per, i) => {
      const act = v[i * 2];
      const bud = v[i * 2 + 1];
      out[`${per.key}_over`] = toAmountString(act.minus(bud));
      out[`${per.key}_pct`] = bud.isZero() ? null : act.dividedBy(bud.abs()).times(100).toFixed(2);
    });
    return out;
  };
  const cells = (label: string, v: Amounts): Record<string, CellValue> => {
    const c: Record<string, CellValue> = { label };
    amountKeys.forEach((k, i) => (c[k] = toAmountString(v[i])));
    return { ...c, ...derive(v) };
  };
  const rows = isBs
    ? bsSectionRows(meta, amounts, n, cells)
    : buildPLRows({ meta, amounts, columns, amountKeys, derive: (v) => derive(v) }).rows;
  return {
    key: 'budget-vs-actual-report',
    title: budget.isForecast ? 'Forecast vs. Actual' : 'Budget vs. Actual',
    subtitle: `${budget.name} · FY${year}`,
    columns,
    rows,
  };
}
