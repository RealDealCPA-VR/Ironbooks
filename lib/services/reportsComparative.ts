/**
 * Comparative & period-over-period reporting — QuickBooks-depth P&L analysis.
 *
 * All functions reuse `profitAndLoss` from reports.ts (source of truth) and layer
 * comparison logic on top. Never mutate reports.ts.
 *
 * Exports:
 *  - profitAndLossComparative   — current vs prior period with variance / %
 *  - profitAndLossByMonth       — 12-column monthly P&L for a given year
 *  - profitAndLossPercentOfIncome — single period with each line as % of total income
 */
import { profitAndLoss, type ReportLine } from './reports';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Comparative P&L — current vs prior
// ---------------------------------------------------------------------------

export interface ComparativeRow {
  accountId: string;
  code: string;
  name: string;
  /** Amount in the current (selected) period. */
  current: string;
  /** Amount in the prior (comparison) period. */
  prior: string;
  /** current - prior (positive = improvement for income, negative = decline). */
  variance: string;
  /** variance / prior * 100, null when prior is zero. */
  variancePct: string | null;
}

export interface ComparativeTotals {
  currentTotalIncome: string;
  priorTotalIncome: string;
  varianceTotalIncome: string;
  variancePctTotalIncome: string | null;
  currentTotalExpenses: string;
  priorTotalExpenses: string;
  varianceTotalExpenses: string;
  variancePctTotalExpenses: string | null;
  currentNetIncome: string;
  priorNetIncome: string;
  varianceNetIncome: string;
  variancePctNetIncome: string | null;
}

export interface ProfitAndLossComparative {
  income: ComparativeRow[];
  expenses: ComparativeRow[];
  totals: ComparativeTotals;
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
}

/** Compute variance and variancePct strings from two Decimal amounts. */
function variance(current: Decimal, prior: Decimal): { variance: string; variancePct: string | null } {
  const v = current.minus(prior);
  const pct = prior.isZero() ? null : v.dividedBy(prior).times(100);
  return {
    variance: toAmountString(v),
    variancePct: pct !== null ? pct.toFixed(2) : null,
  };
}

/**
 * Build a map from accountId -> ReportLine for quick merging.
 */
function indexLines(lines: ReportLine[]): Map<string, ReportLine> {
  return new Map(lines.map((l) => [l.accountId, l]));
}

/**
 * Merge two sets of P&L lines (current + prior) into ComparativeRows, including
 * accounts that appear in only one period.
 */
function mergeLines(
  currentLines: ReportLine[],
  priorLines: ReportLine[],
): ComparativeRow[] {
  const currentMap = indexLines(currentLines);
  const priorMap = indexLines(priorLines);

  // Union of all accountIds across both periods.
  const allIds = new Set([...currentMap.keys(), ...priorMap.keys()]);
  const rows: ComparativeRow[] = [];

  for (const accountId of allIds) {
    const c = currentMap.get(accountId);
    const p = priorMap.get(accountId);

    // Prefer current for metadata (code/name); fall back to prior.
    const code = c?.code ?? p!.code;
    const name = c?.name ?? p!.name;
    const currentAmt = Money.of(c?.amount ?? '0.00');
    const priorAmt = Money.of(p?.amount ?? '0.00');
    const { variance: v, variancePct } = variance(currentAmt, priorAmt);

    rows.push({
      accountId,
      code,
      name,
      current: toAmountString(currentAmt),
      prior: toAmountString(priorAmt),
      variance: v,
      variancePct,
    });
  }

  rows.sort((a, b) => a.code.localeCompare(b.code));
  return rows;
}

/**
 * Profit & Loss — current period vs prior period comparison.
 *
 * Both periods are fetched independently via profitAndLoss; results are merged by
 * accountId so every account that had activity in either period appears on every row.
 */
export async function profitAndLossComparative(
  ctx: ServiceContext,
  opts: { from: Date; to: Date; priorFrom: Date; priorTo: Date },
): Promise<ProfitAndLossComparative> {
  const [current, prior] = await Promise.all([
    profitAndLoss(ctx, { from: opts.from, to: opts.to }),
    profitAndLoss(ctx, { from: opts.priorFrom, to: opts.priorTo }),
  ]);

  const income = mergeLines(current.income, prior.income);
  const expenses = mergeLines(current.expenses, prior.expenses);

  const curIncome = Money.of(current.totalIncome);
  const priIncome = Money.of(prior.totalIncome);
  const curExpenses = Money.of(current.totalExpenses);
  const priExpenses = Money.of(prior.totalExpenses);
  const curNet = Money.of(current.netIncome);
  const priNet = Money.of(prior.netIncome);

  const incomeVar = variance(curIncome, priIncome);
  const expenseVar = variance(curExpenses, priExpenses);
  const netVar = variance(curNet, priNet);

  return {
    income,
    expenses,
    totals: {
      currentTotalIncome: toAmountString(curIncome),
      priorTotalIncome: toAmountString(priIncome),
      varianceTotalIncome: incomeVar.variance,
      variancePctTotalIncome: incomeVar.variancePct,
      currentTotalExpenses: toAmountString(curExpenses),
      priorTotalExpenses: toAmountString(priExpenses),
      varianceTotalExpenses: expenseVar.variance,
      variancePctTotalExpenses: expenseVar.variancePct,
      currentNetIncome: toAmountString(curNet),
      priorNetIncome: toAmountString(priNet),
      varianceNetIncome: netVar.variance,
      variancePctNetIncome: netVar.variancePct,
    },
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    priorFrom: opts.priorFrom.toISOString(),
    priorTo: opts.priorTo.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Monthly P&L — 12 columns for a calendar year
// ---------------------------------------------------------------------------

export interface MonthlyRow {
  accountId: string;
  code: string;
  name: string;
  /** Index 0–11 for Jan–Dec. */
  months: string[];
  /** Sum across all 12 months. */
  total: string;
}

export interface ProfitAndLossByMonth {
  year: number;
  income: MonthlyRow[];
  expenses: MonthlyRow[];
  /** Total income per month (index 0–11). */
  monthlyTotalIncome: string[];
  /** Total expenses per month (index 0–11). */
  monthlyTotalExpenses: string[];
  /** Net income per month (index 0–11). */
  monthlyNetIncome: string[];
  /** Grand-total income across all 12 months. */
  totalIncome: string;
  /** Grand-total expenses across all 12 months. */
  totalExpenses: string;
  /** Grand-total net income across all 12 months. */
  netIncome: string;
}

/**
 * Profit & Loss broken into 12 monthly columns for a given calendar year.
 *
 * Runs 12 independent profitAndLoss calls (one per month) and stitches them
 * together into per-account monthly rows. All 12 are fetched in parallel.
 */
export async function profitAndLossByMonth(
  ctx: ServiceContext,
  year: number,
): Promise<ProfitAndLossByMonth> {
  // Build Jan–Dec date ranges for the year.
  const ranges = Array.from({ length: 12 }, (_, m) => {
    // UTC bounds: stored document dates are UTC midnight of their calendar day, so local-time
    // bounds would move each month's first-day activity into the previous month west of UTC.
    const from = new Date(Date.UTC(year, m, 1));
    const to = new Date(Date.UTC(year, m + 1, 1) - 1); // last instant of the month
    return { from, to };
  });

  const monthlyPL = await Promise.all(ranges.map((r) => profitAndLoss(ctx, r)));

  // Collect all unique accountIds across all months.
  type AccountMeta = { code: string; name: string; isExpense: boolean };
  const accountMeta = new Map<string, AccountMeta>();

  for (const pl of monthlyPL) {
    for (const l of pl.income) {
      if (!accountMeta.has(l.accountId))
        accountMeta.set(l.accountId, { code: l.code, name: l.name, isExpense: false });
    }
    for (const l of pl.expenses) {
      if (!accountMeta.has(l.accountId))
        accountMeta.set(l.accountId, { code: l.code, name: l.name, isExpense: true });
    }
  }

  // Build per-account monthly arrays.
  const incomeRows: MonthlyRow[] = [];
  const expenseRows: MonthlyRow[] = [];

  const monthlyTotalIncome: Decimal[] = Array.from({ length: 12 }, () => Money.zero());
  const monthlyTotalExpenses: Decimal[] = Array.from({ length: 12 }, () => Money.zero());

  for (const [accountId, meta] of accountMeta) {
    const months = monthlyPL.map((pl) => {
      const lines = meta.isExpense ? pl.expenses : pl.income;
      const line = lines.find((l) => l.accountId === accountId);
      return line?.amount ?? '0.00';
    });

    const total = months.reduce<Decimal>((sum, m) => sum.plus(Money.of(m)), Money.zero());

    const row: MonthlyRow = {
      accountId,
      code: meta.code,
      name: meta.name,
      months,
      total: toAmountString(total),
    };

    if (meta.isExpense) {
      expenseRows.push(row);
      months.forEach((amt, i) => {
        monthlyTotalExpenses[i] = monthlyTotalExpenses[i].plus(Money.of(amt));
      });
    } else {
      incomeRows.push(row);
      months.forEach((amt, i) => {
        monthlyTotalIncome[i] = monthlyTotalIncome[i].plus(Money.of(amt));
      });
    }
  }

  incomeRows.sort((a, b) => a.code.localeCompare(b.code));
  expenseRows.sort((a, b) => a.code.localeCompare(b.code));

  const monthlyNetIncome = monthlyTotalIncome.map((inc, i) =>
    toAmountString(inc.minus(monthlyTotalExpenses[i])),
  );

  const totalIncome = monthlyTotalIncome.reduce<Decimal>((s, v) => s.plus(v), Money.zero());
  const totalExpenses = monthlyTotalExpenses.reduce<Decimal>((s, v) => s.plus(v), Money.zero());

  return {
    year,
    income: incomeRows,
    expenses: expenseRows,
    monthlyTotalIncome: monthlyTotalIncome.map(toAmountString),
    monthlyTotalExpenses: monthlyTotalExpenses.map(toAmountString),
    monthlyNetIncome,
    totalIncome: toAmountString(totalIncome),
    totalExpenses: toAmountString(totalExpenses),
    netIncome: toAmountString(totalIncome.minus(totalExpenses)),
  };
}

// ---------------------------------------------------------------------------
// Percent-of-income P&L
// ---------------------------------------------------------------------------

export interface PercentRow {
  accountId: string;
  code: string;
  name: string;
  amount: string;
  /** Amount as a percentage of total income (2dp), null when totalIncome is zero. */
  pctOfIncome: string | null;
}

export interface ProfitAndLossPercentOfIncome {
  income: PercentRow[];
  expenses: PercentRow[];
  totalIncome: string;
  totalExpenses: string;
  netIncome: string;
  /** Total income % of itself = "100.00" (or null if no income). */
  totalIncomePct: string | null;
  /** Total expenses as % of total income. */
  totalExpensesPct: string | null;
  /** Net income as % of total income. */
  netIncomePct: string | null;
  from?: string;
  to?: string;
}

/**
 * Profit & Loss with each line amount expressed as a percentage of total income.
 * Useful for common-size analysis (mirrors QB's "% of Income" column).
 */
export async function profitAndLossPercentOfIncome(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<ProfitAndLossPercentOfIncome> {
  const pl = await profitAndLoss(ctx, range);
  const totalIncome = Money.of(pl.totalIncome);

  function toPct(amount: string): string | null {
    if (totalIncome.isZero()) return null;
    return Money.of(amount).dividedBy(totalIncome).times(100).toFixed(2);
  }

  const income: PercentRow[] = pl.income.map((l) => ({
    ...l,
    pctOfIncome: toPct(l.amount),
  }));

  const expenses: PercentRow[] = pl.expenses.map((l) => ({
    ...l,
    pctOfIncome: toPct(l.amount),
  }));

  return {
    income,
    expenses,
    totalIncome: pl.totalIncome,
    totalExpenses: pl.totalExpenses,
    netIncome: pl.netIncome,
    totalIncomePct: totalIncome.isZero() ? null : '100.00',
    totalExpensesPct: toPct(pl.totalExpenses),
    netIncomePct: toPct(pl.netIncome),
    from: pl.from,
    to: pl.to,
  };
}
