/**
 * Financial reports computed from the journal (the source of truth), not cached balances.
 * Start with Trial Balance, P&L, and Balance Sheet — the foundation set.
 */
import { and, eq, sql } from 'drizzle-orm';
import { accounts, companies, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { onOrBeforeDay } from './journal';
import { Money, toAmountString } from '@/lib/money';
import { localDateISO } from '@/lib/dates';
import type { ServiceContext } from './_base';
import { fiscalYearWindow } from './fiscalClose';
import { assertBalanceSheetBalanced, assertTrialBalanceBalanced } from './ledgerAssert';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debit: string;
  credit: string;
}

const DEBIT_NORMAL = new Set(['asset', 'expense']);

/**
 * SQL condition excluding year-end closing entries (sourceRef 'fiscal-close:<year>').
 * Closing entries zero P&L accounts into Retained Earnings; they must be excluded
 * from income-statement reports (P&L and derivatives) so closed-year history is
 * preserved, but kept in balance-sheet/trial-balance/GL views so Retained Earnings
 * stays correct after the close.
 */
export function notFiscalCloseEntry() {
  return sql`(${journalEntries.sourceRef} IS NULL OR ${journalEntries.sourceRef} NOT LIKE 'fiscal-close:%')`;
}

/**
 * Aggregate posted debits/credits per account up to an optional date. When `since` is given,
 * the same scan also returns the debits/credits dated on/after it (`debitSince`/`creditSince`),
 * so a split such as current-year vs prior-years earnings comes from the IDENTICAL rows.
 */
async function accountActivity(ctx: ServiceContext, asOf?: Date, since?: Date) {
  // Only include posted entries — explicitly exclude draft and void.
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
  ];
  // Whole-day bound: postings with a time of day (year-end close at 23:59:59Z, bank-feed
  // entries, older data) belong to their own day.
  if (asOf) conds.push(onOrBeforeDay(asOf));
  // The current-year split leaves out a year-end closing entry dated inside the window (it is dated
  // on the fiscal year's LAST day): a balance sheet as of that day still shows the year's Net
  // Income, with the closing entry's Retained Earnings credit offset in prior-years earnings, like
  // QuickBooks and the P&L its Net Income line zooms to. Totals are unchanged.
  const sinceCond = since ? sql`${journalEntries.date} >= ${since} AND ${notFiscalCloseEntry()}` : sql`FALSE`;

  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
      debitSince: sql<string>`COALESCE(SUM(${journalEntryLines.debit}) FILTER (WHERE ${sinceCond}), 0)`,
      creditSince: sql<string>`COALESCE(SUM(${journalEntryLines.credit}) FILTER (WHERE ${sinceCond}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(...conds))
    .groupBy(journalEntryLines.accountId, accounts.code, accounts.name, accounts.type);

  return rows;
}

export async function trialBalance(
  ctx: ServiceContext,
  asOf?: Date,
): Promise<{ rows: TrialBalanceRow[]; totalDebit: string; totalCredit: string; balanced: boolean }> {
  const activity = await accountActivity(ctx, asOf);
  const rows: TrialBalanceRow[] = [];
  let totalDebit = Money.zero();
  let totalCredit = Money.zero();

  for (const a of activity) {
    const net = Money.sub(a.debit, a.credit); // positive => net debit
    const debit = net.greaterThan(0) ? net : Money.zero();
    const credit = net.lessThan(0) ? net.negated() : Money.zero();
    if (debit.isZero() && credit.isZero()) continue;
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    rows.push({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      type: a.type,
      debit: toAmountString(debit),
      credit: toAmountString(credit),
    });
  }
  rows.sort((x, y) => x.code.localeCompare(y.code));
  // Unreachable while the DB ledger guards hold — throws a loud INTEGRITY error otherwise.
  assertTrialBalanceBalanced('Trial balance', totalDebit, totalCredit);
  return {
    rows,
    totalDebit: toAmountString(totalDebit),
    totalCredit: toAmountString(totalCredit),
    balanced: Money.eq(totalDebit, totalCredit),
  };
}

export interface ReportLine {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

export interface ProfitAndLoss {
  income: ReportLine[];
  expenses: ReportLine[];
  totalIncome: string;
  totalExpenses: string;
  netIncome: string;
  from?: string;
  to?: string;
  /** Echoed back when the report was filtered to a single class. */
  classId?: string;
}

/**
 * Profit & Loss for a date range (revenue - expenses).
 * Optionally filtered to a single class dimension (opts.classId) — only
 * journal lines tagged with that class are included.
 */
export async function profitAndLoss(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
  opts?: { classId?: string },
): Promise<ProfitAndLoss> {
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    // Year-end closing entries must not wipe out closed-year P&L history.
    notFiscalCloseEntry(),
  ];
  if (range?.from) conds.push(sql`${journalEntries.date} >= ${range.from}`);
  if (range?.to) conds.push(onOrBeforeDay(range.to));
  if (opts?.classId) conds.push(eq(journalEntryLines.classId, opts.classId));

  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(...conds))
    .groupBy(journalEntryLines.accountId, accounts.code, accounts.name, accounts.type);

  const income: ReportLine[] = [];
  const expenses: ReportLine[] = [];
  let totalIncome = Money.zero();
  let totalExpenses = Money.zero();

  for (const r of rows) {
    if (r.type === 'revenue') {
      const amt = Money.sub(r.credit, r.debit); // credit-normal
      income.push({ accountId: r.accountId, code: r.code, name: r.name, amount: toAmountString(amt) });
      totalIncome = totalIncome.plus(amt);
    } else if (r.type === 'expense') {
      const amt = Money.sub(r.debit, r.credit); // debit-normal
      expenses.push({ accountId: r.accountId, code: r.code, name: r.name, amount: toAmountString(amt) });
      totalExpenses = totalExpenses.plus(amt);
    }
  }
  income.sort((a, b) => a.code.localeCompare(b.code));
  expenses.sort((a, b) => a.code.localeCompare(b.code));

  return {
    income,
    expenses,
    totalIncome: toAmountString(totalIncome),
    totalExpenses: toAmountString(totalExpenses),
    netIncome: toAmountString(Money.sub(totalIncome, totalExpenses)),
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
    classId: opts?.classId,
  };
}

export interface BalanceSheet {
  assets: ReportLine[];
  liabilities: ReportLine[];
  equity: ReportLine[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  /**
   * All not-yet-closed earnings to date (revenue − expenses over every posted row up to asOf),
   * folded into equity so the equation holds. Always = priorYearsEarnings + currentYearNetIncome.
   */
  retainedEarnings: string;
  /** Unclosed earnings dated before the current fiscal year (QB "Retained Earnings" line). */
  priorYearsEarnings: string;
  /** Net income of the fiscal year containing asOf, up to asOf (QB "Net Income" line). */
  currentYearNetIncome: string;
  /** Start of the fiscal year used for the split above (ISO; absent on consolidated sums). */
  fiscalYearStart?: string;
  balanced: boolean;
  asOf?: string;
}

/** Start of the company's fiscal year containing `date` (honours settings.fiscalYearEnd). */
export async function fiscalYearStartFor(ctx: ServiceContext, date: Date): Promise<Date> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  const fye = row?.settings?.fiscalYearEnd;
  // The fiscal year containing `date` ends in its calendar year or the next one.
  for (const year of [date.getUTCFullYear(), date.getUTCFullYear() + 1]) {
    const { yearStart, yearEnd } = fiscalYearWindow(year, fye);
    if (date >= yearStart && date < yearEnd) return yearStart;
  }
  return fiscalYearWindow(date.getUTCFullYear(), fye).yearStart;
}

/**
 * Balance Sheet as of a date. BALANCED BY CONSTRUCTION: every account's balance comes from the
 * same posted ledger rows, and revenue/expense balances (net income not yet closed) are folded
 * into equity — split into prior-years earnings and current-year net income from those same rows.
 * Because every posted entry balances (enforced by the database), Σ assets = Σ liabilities +
 * Σ equity + net income identically; `assertBalanceSheetBalanced` guards that invariant loudly.
 */
export async function balanceSheet(ctx: ServiceContext, asOf?: Date): Promise<BalanceSheet> {
  // No date: the fiscal year of TODAY on this computer's calendar (the UTC moment is already next
  // year on a Dec 31 evening in the US, which moved the whole year's income into Retained Earnings).
  const fyStart = await fiscalYearStartFor(ctx, asOf ?? new Date(`${localDateISO(new Date())}T23:59:59.999Z`));
  const activity = await accountActivity(ctx, asOf, fyStart);
  const assets: ReportLine[] = [];
  const liabilities: ReportLine[] = [];
  const equity: ReportLine[] = [];
  let totalAssets = Money.zero();
  let totalLiabilities = Money.zero();
  let totalEquity = Money.zero();
  let netIncome = Money.zero();
  let currentYearNetIncome = Money.zero();

  for (const a of activity) {
    const debitNet = Money.sub(a.debit, a.credit);
    const naturalBalance = DEBIT_NORMAL.has(a.type) ? debitNet : debitNet.negated();
    if (a.type === 'revenue' || a.type === 'expense') {
      // Net income = credits − debits on P&L accounts; current year = same rows, FILTERed.
      currentYearNetIncome = currentYearNetIncome.minus(Money.sub(a.debitSince, a.creditSince));
    }
    const line: ReportLine = {
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      amount: toAmountString(naturalBalance),
    };
    if (a.type === 'asset') {
      assets.push(line);
      totalAssets = totalAssets.plus(naturalBalance);
    } else if (a.type === 'liability') {
      liabilities.push(line);
      totalLiabilities = totalLiabilities.plus(naturalBalance);
    } else if (a.type === 'equity') {
      equity.push(line);
      totalEquity = totalEquity.plus(naturalBalance);
    } else if (a.type === 'revenue') {
      netIncome = netIncome.plus(naturalBalance);
    } else if (a.type === 'expense') {
      netIncome = netIncome.minus(naturalBalance);
    }
  }

  const totalEquityWithRE = totalEquity.plus(netIncome);
  [assets, liabilities, equity].forEach((g) => g.sort((a, b) => a.code.localeCompare(b.code)));
  // Unreachable while the DB ledger guards hold — throws a loud INTEGRITY error otherwise.
  assertBalanceSheetBalanced('Balance sheet', totalAssets, totalLiabilities, totalEquityWithRE);

  return {
    assets,
    liabilities,
    equity,
    totalAssets: toAmountString(totalAssets),
    totalLiabilities: toAmountString(totalLiabilities),
    totalEquity: toAmountString(totalEquityWithRE),
    retainedEarnings: toAmountString(netIncome),
    priorYearsEarnings: toAmountString(netIncome.minus(currentYearNetIncome)),
    currentYearNetIncome: toAmountString(currentYearNetIncome),
    fiscalYearStart: fyStart.toISOString(),
    balanced: Money.eq(totalAssets, totalLiabilities.plus(totalEquityWithRE)),
    asOf: asOf?.toISOString(),
  };
}
