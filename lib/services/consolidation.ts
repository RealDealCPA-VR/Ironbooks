/**
 * Consolidation service — multi-entity reporting across ALL companies in the database.
 *
 * Each company is treated as a separate reporting entity. The consolidated totals are the
 * arithmetic sum of the per-company figures. Intercompany eliminations are not performed
 * here (that would require mapping intercompany accounts, a future layer).
 *
 * NOTE: ctx.db is the shared database; ctx.companyId is the caller's own company but is
 * intentionally NOT used to scope the query — consolidation spans all companies.
 */
import { listCompanies } from '@/lib/services/company';
import { profitAndLoss, balanceSheet } from '@/lib/services/reports';
import type { ProfitAndLoss, BalanceSheet } from '@/lib/services/reports';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { assertBalanceSheetBalanced } from './ledgerAssert';

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
 * Run profitAndLoss for every company in the database and sum the results.
 *
 * @param ctx  Caller context — only ctx.db and ctx.userId are used (companyId is ignored
 *             because consolidation intentionally crosses company boundaries).
 * @param range  Optional date range forwarded to each per-company P&L call.
 */
export async function consolidatedPL(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<ConsolidatedPL> {
  const allCompanies = await listCompanies(ctx.db);

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
 * Run balanceSheet for every company in the database and sum the results.
 *
 * @param ctx  Caller context — only ctx.db and ctx.userId are used.
 * @param asOf  Optional date forwarded to each per-company balance sheet call.
 */
export async function consolidatedBalanceSheet(
  ctx: ServiceContext,
  asOf?: Date,
): Promise<ConsolidatedBS> {
  const allCompanies = await listCompanies(ctx.db);

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
