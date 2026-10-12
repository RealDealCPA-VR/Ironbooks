/**
 * Cash-Basis Profit & Loss (QuickBooks Desktop "Report Basis: Cash").
 *
 * Each income / COGS / expense line of an invoice, credit memo, bill or vendor credit is
 * recognized when that document is paid, pro-rata to the amount settled, on the payment's date
 * (see cashBasisLedger.ts for the full rules). Cash transactions (sales receipts, checks, credit
 * card charges, deposits, paychecks, journal entries, payment discounts) count on their own date.
 *
 * Per-account lines ADD UP to the totals, and cash net income to date equals the cash-basis
 * balance sheet's earnings (both come from the same balanced adjustments). The QuickBooks section
 * layout with sub-account roll-up is the standard engine's Profit & Loss with basis=cash
 * (reportsStandard.ts profitAndLossReport); this function is the flat API shape.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { accounts, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { notFiscalCloseEntry, profitAndLoss, type ReportLine } from './reports';
import { cashActivityRows, cashBasisLedger } from './cashBasisLedger';

export interface ProfitAndLossCashBasis {
  basis: 'cash';
  /** Income accounts (revenue type), cash basis. Sums to totalIncome. */
  income: ReportLine[];
  /** Expense accounts (COGS, expense, other expense), cash basis. Sums to totalExpenses. */
  expenses: ReportLine[];
  totalIncome: string;
  totalExpenses: string;
  /** totalIncome − totalExpenses */
  netIncome: string;
  /** The accrual net income for the same range, for reference. */
  accrualNetIncome: string;
  from?: string;
  to?: string;
  classId?: string;
}

/**
 * Profit & Loss on a cash basis for the given range (all history when omitted), optionally
 * for a single class.
 */
export async function profitAndLossCashBasis(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
  opts?: { classId?: string },
): Promise<ProfitAndLossCashBasis> {
  const accrual = await profitAndLoss(ctx, range, opts);
  const { adjustments } = await cashBasisLedger(ctx, { to: range?.to });

  const conds = [eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), notFiscalCloseEntry()];
  if (range?.from) conds.push(sql`${journalEntries.date} >= ${range.from}`);
  if (range?.to) conds.push(lte(journalEntries.date, range.to));
  if (opts?.classId) conds.push(eq(journalEntryLines.classId, opts.classId));
  const posted = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conds))
    .groupBy(journalEntryLines.accountId);
  const adj = cashActivityRows(adjustments, { from: range?.from, to: range?.to, classId: opts?.classId }, 'none');

  const meta = new Map(
    (
      await ctx.db
        .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
        .from(accounts)
        .where(eq(accounts.companyId, ctx.companyId))
    ).map((a) => [a.id, a]),
  );
  const net = new Map<string, ReturnType<typeof Money.zero>>();
  for (const r of [...posted, ...adj]) {
    net.set(r.accountId, (net.get(r.accountId) ?? Money.zero()).plus(Money.sub(r.debit, r.credit)));
  }

  const income: ReportLine[] = [];
  const expenses: ReportLine[] = [];
  let totalIncome = Money.zero();
  let totalExpenses = Money.zero();
  for (const [id, n] of net) {
    const a = meta.get(id);
    if (!a) continue;
    if (a.type === 'revenue') {
      const amt = n.negated();
      if (amt.isZero() && !accrual.income.some((l) => l.accountId === id)) continue;
      income.push({ accountId: id, code: a.code, name: a.name, amount: toAmountString(amt) });
      totalIncome = totalIncome.plus(amt);
    } else if (a.type === 'expense') {
      if (n.isZero() && !accrual.expenses.some((l) => l.accountId === id)) continue;
      expenses.push({ accountId: id, code: a.code, name: a.name, amount: toAmountString(n) });
      totalExpenses = totalExpenses.plus(n);
    }
  }
  income.sort((a, b) => a.code.localeCompare(b.code));
  expenses.sort((a, b) => a.code.localeCompare(b.code));

  return {
    basis: 'cash',
    income,
    expenses,
    totalIncome: toAmountString(totalIncome),
    totalExpenses: toAmountString(totalExpenses),
    netIncome: toAmountString(totalIncome.minus(totalExpenses)),
    accrualNetIncome: accrual.netIncome,
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
    classId: opts?.classId,
  };
}
