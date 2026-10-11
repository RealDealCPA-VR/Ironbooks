/**
 * Cash-Basis Profit & Loss reporting.
 *
 * AccountING BASIS OVERVIEW
 * ─────────────────────────
 * Accrual basis: income is recorded when earned (invoice posted), expenses when incurred (bill
 * posted). This is the standard double-entry GL view.
 *
 * Cash basis: income is recorded only when cash is received, expenses only when cash is paid.
 * The simplest correct conversion from an accrual GL is the INDIRECT method:
 *
 *   cashIncome   = accrualIncome   − increaseInAR
 *   cashExpenses = accrualExpenses − increaseInAP
 *   netCash      = cashIncome      − cashExpenses
 *
 * Intuition:
 *  • If AR increased over the period, some revenue was billed but not yet collected → subtract it.
 *  • If AP increased over the period, some expenses were accrued but not yet paid → subtract them.
 *
 * `increaseInAR` = AR balance at period-end minus AR balance at period-start (debit-normal).
 *   Positive value → AR grew → we collected less cash than we earned.
 *
 * `increaseInAP` = AP balance at period-end minus AP balance at period-start (credit-normal,
 *   so we compare net-credit activity, i.e. credits − debits on account 2000).
 *   Positive value → AP grew → we paid less cash than we incurred in expenses.
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { accounts, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { profitAndLoss, type ProfitAndLoss, type ReportLine } from './reports';

import { isPayable, isReceivable } from './cashBasisClassify';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Returns the net change in an account's debit-normal balance between two dates
 * using POSTED journal entry lines.
 *
 *   netChange = SUM(debits posted in [from, to]) − SUM(credits posted in [from, to])
 *
 * For a debit-normal account (asset, expense) a positive result means the balance grew.
 * For a credit-normal account (liability, equity, revenue) invert the sign at the call site.
 *
 * @param ctx      Service context (includes companyId for multi-tenant isolation).
 * @param code     Chart-of-accounts code to identify the account (e.g. '1200').
 * @param from     Inclusive start of the period.
 * @param to       Inclusive end of the period.
 */
export async function accountNetChange(
  ctx: ServiceContext,
  code: string,
  from: Date,
  to: Date,
): Promise<string> {
  const rows = await ctx.db
    .select({
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(accounts.code, code),
        sql`${journalEntries.date} >= ${from}`,
        lte(journalEntries.date, to),
      ),
    );

  const row = rows[0];
  const net = Money.sub(row?.totalDebit ?? 0, row?.totalCredit ?? 0);
  return toAmountString(net);
}

/**
 * Net debit-normal change (debits − credits) over [from, to] summed across EVERY account the
 * shared classifier treats as A/R ('receivable') or A/P ('payable') — the same set the
 * cash-basis Balance Sheet removes, so cash-basis net income to date equals cash-basis
 * retained earnings on the sheet.
 */
export async function classifiedNetChange(
  ctx: ServiceContext,
  kind: 'receivable' | 'payable',
  from: Date,
  to: Date,
): Promise<string> {
  const accts = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, subtype: accounts.subtype })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const ids = accts.filter((a) => (kind === 'receivable' ? isReceivable(a) : isPayable(a))).map((a) => a.id);
  if (ids.length === 0) return toAmountString(Money.zero());

  const rows = await ctx.db
    .select({
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        inArray(journalEntryLines.accountId, ids),
        sql`${journalEntries.date} >= ${from}`,
        lte(journalEntries.date, to),
      ),
    );

  const row = rows[0];
  return toAmountString(Money.sub(row?.totalDebit ?? 0, row?.totalCredit ?? 0));
}

// ---------------------------------------------------------------------------
// Cash-Basis P&L
// ---------------------------------------------------------------------------

export interface ProfitAndLossCashBasis {
  basis: 'cash';
  /** Same income lines as the accrual report (before adjustment). */
  income: ReportLine[];
  /** Same expense lines as the accrual report (before adjustment). */
  expenses: ReportLine[];
  /** Cash-adjusted total income = accrualTotalIncome − increaseInAR */
  totalIncome: string;
  /** Cash-adjusted total expenses = accrualTotalExpenses − increaseInAP */
  totalExpenses: string;
  /** totalIncome − totalExpenses */
  netIncome: string;
  /**
   * AR adjustment applied to income (positive = AR grew = income reduced).
   * arAdjustment = SUM of AR debits − credits over the period.
   */
  arAdjustment: string;
  /**
   * AP adjustment applied to expenses (positive = AP grew = expenses reduced).
   * apAdjustment = SUM of AP credits − debits over the period.
   */
  apAdjustment: string;
  from?: string;
  to?: string;
}

/**
 * Profit & Loss on a CASH basis for the given date range.
 *
 * Implements the indirect conversion method:
 *   1. Fetch the standard accrual P&L for the period.
 *   2. Compute the change in all Accounts Receivable accounts (shared classifier in
 *      cashBasisClassify.ts: 1200, Retainage Receivable, …) during the period.
 *      A debit-net increase in AR means revenue was recognised but cash not yet received.
 *   3. Compute the change in all Accounts Payable accounts (same classifier) during the period.
 *      A credit-net increase in AP means expenses were recognised but cash not yet paid.
 *   4. Adjust:
 *        cashIncome   = accrualIncome   − increaseInAR
 *        cashExpenses = accrualExpenses − increaseInAP
 *
 * Both `from` and `to` are required for a meaningful cash-basis adjustment; if either
 * is omitted the function falls back to the full history (i.e. the adjustments are
 * computed over all posted activity, which is equivalent to setting from = epoch start).
 */
export async function profitAndLossCashBasis(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<ProfitAndLossCashBasis> {
  // 1. Accrual P&L (delegate to the canonical report — do NOT edit reports.ts).
  //    Year-end closing entries (sourceRef 'fiscal-close:<year>') cannot leak in
  //    here: profitAndLoss already excludes them via notFiscalCloseEntry(), and
  //    the AR/AP adjustments below are immune by construction — closing entries
  //    only touch revenue/expense accounts and Retained Earnings (3900), never
  //    A/R or A/P accounts.
  const accrual = await profitAndLoss(ctx, range);

  // 2. Period boundaries. Default: 1970-01-01 → now (covers all history).
  const from = range?.from ?? new Date(0);
  const to = range?.to ?? new Date();

  // 3. AR change (debit-normal: debits − credits over the period).
  //    Positive → AR grew → less cash collected than earned.
  const arNetChange = await classifiedNetChange(ctx, 'receivable', from, to);
  const increaseInAR = Money.of(arNetChange);

  // 4. AP change (credit-normal: credits − debits over the period).
  //    Positive → AP grew → less cash paid than expensed.
  const apRaw = await classifiedNetChange(ctx, 'payable', from, to);
  // accountNetChange returns debits−credits; for AP (credit-normal) negate to get credit-net.
  const increaseInAP = Money.of(apRaw).negated();

  // 5. Cash-adjusted totals.
  const cashIncome = Money.of(accrual.totalIncome).minus(increaseInAR);
  const cashExpenses = Money.of(accrual.totalExpenses).minus(increaseInAP);
  const netCash = cashIncome.minus(cashExpenses);

  return {
    basis: 'cash',
    income: accrual.income,
    expenses: accrual.expenses,
    totalIncome: toAmountString(cashIncome),
    totalExpenses: toAmountString(cashExpenses),
    netIncome: toAmountString(netCash),
    arAdjustment: toAmountString(increaseInAR),
    apAdjustment: toAmountString(increaseInAP),
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
  };
}
