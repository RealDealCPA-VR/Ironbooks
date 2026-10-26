/**
 * Year-end fiscal close service.
 *
 * yearEndClose computes net income for a fiscal year (sum of all posted revenue
 * minus sum of all posted expenses) and posts a single balanced closing journal
 * entry that zeroes out P&L accounts into Retained Earnings (COA code 3900).
 *
 * Closing entry mechanics:
 *   Revenue accounts are credit-normal. To zero them out: DEBIT each revenue account.
 *   Expense accounts are debit-normal.  To zero them out: CREDIT each expense account.
 *   The net difference (net income) flows to Retained Earnings 3900:
 *     - If net income > 0  (profitable year): CREDIT 3900 (increases equity)
 *     - If net income < 0  (net loss):        DEBIT  3900 (decreases equity)
 *   The entry is always balanced by construction:
 *     totalDebits(revenue zeroing) = totalCredits(expense zeroing) + 3900 credit  [profit]
 *     totalDebits(revenue zeroing) + 3900 debit = totalCredits(expense zeroing)  [loss]
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { accounts, companies, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction } from './_base';
import { ensurePreOpBackup } from './backup';
import { type PostingLine, postJournalEntry } from './posting';

export interface YearEndCloseInput {
  /**
   * Four-digit fiscal year, e.g. 2024 — interpreted as the year in which the fiscal
   * year ENDS (per the company's settings.fiscalYearEnd, default 12-31). For a
   * calendar-year company this is Jan 1 through Dec 31 of that year; for a June 30
   * year end, fiscalYear 2026 covers 2025-07-01 through 2026-06-30.
   */
  fiscalYear: number;
}

/**
 * Compute the UTC window [yearStart, yearEnd) and the closing-entry date for a
 * fiscal year, honoring the company's configured fiscal year end ('MM-DD').
 * `fiscalYear` is the year the fiscal year ends in. Defaults to 12-31 (calendar
 * year). A month-end year end follows the real month end (02-28 -> Feb 29 in leap
 * years); other days are clamped to the month's last valid day. Windows are contiguous.
 */
export function fiscalYearWindow(
  fiscalYear: number,
  fiscalYearEnd?: string | null,
): { yearStart: Date; yearEnd: Date; closingDate: Date } {
  let month = 12;
  let day = 31;
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(fiscalYearEnd ?? '');
  if (match) {
    const m = Number(match[1]);
    const d = Number(match[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      month = m;
      day = d;
    }
  }
  // A year end on the last day of its month means "month end" (onboarding stores a fiscal year
  // starting in March as '02-28'), so it follows the month's real last day: Feb 29 in leap years.
  // Any other day is clamped to the month's last valid day for the year (e.g. 02-29 -> 28).
  const lastDayOf = (y: number) => new Date(Date.UTC(y, month, 0)).getUTCDate();
  const monthEnd = day >= new Date(Date.UTC(2001, month, 0)).getUTCDate(); // 2001: a common year
  const endDayOf = (y: number) => (monthEnd ? lastDayOf(y) : Math.min(day, lastDayOf(y)));
  const endDay = endDayOf(fiscalYear);

  const closingDate = new Date(Date.UTC(fiscalYear, month - 1, endDay, 23, 59, 59, 0));
  // Exclusive upper bound: midnight after the fiscal year end (Date.UTC handles overflow).
  const yearEnd = new Date(Date.UTC(fiscalYear, month - 1, endDay + 1));
  // Inclusive start: the day after the PREVIOUS fiscal year's end (its exclusive upper bound), so
  // consecutive windows are contiguous (shifting this year's end back a year is not when the
  // two years' February lengths differ, which used to leave Feb 29 in no fiscal year).
  const yearStart = new Date(Date.UTC(fiscalYear - 1, month - 1, endDayOf(fiscalYear - 1) + 1));
  return { yearStart, yearEnd, closingDate };
}

/**
 * The company's Retained Earnings account: the equity account whose detail type is Retained
 * Earnings (code 3900 first when there are several, then the lowest number). Number 3900 alone
 * is not enough — in a chart without a 3900 Retained Earnings, 3900 is where the first opening
 * balance creates "Opening Balance Equity" (accounts.ts findOrCreateOpeningBalanceEquity). Legacy
 * charts with no Retained Earnings detail type fall back to an equity account numbered 3900 or
 * named "Retained Earnings", never Opening Balance Equity.
 */
async function findRetainedEarningsAccount(
  ctx: ServiceContext,
): Promise<{ id: string; code: string; name: string } | null> {
  const rows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, subtype: accounts.subtype, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.type, 'equity')));
  const byCode = (a: { code: string }, b: { code: string }) =>
    a.code === '3900' ? -1 : b.code === '3900' ? 1 : a.code.localeCompare(b.code, undefined, { numeric: true });
  const pick = (list: typeof rows) =>
    [...list].sort((a, b) => Number(b.isActive) - Number(a.isActive) || byCode(a, b))[0] ?? null;
  const typed = rows.filter((r) => r.subtype === 'retained_earnings');
  if (typed.length) return pick(typed);
  const legacy = rows.filter(
    (r) => (r.code === '3900' || /^retained earnings$/i.test(r.name.trim())) && !/opening balance equity/i.test(r.name),
  );
  return pick(legacy);
}

export interface YearEndCloseResult {
  /** The posted closing journal entry. */
  entry: Awaited<ReturnType<typeof postJournalEntry>>;
  netIncome: string;
  totalRevenue: string;
  totalExpenses: string;
}

/**
 * Run the year-end closing process for the given fiscal year.
 *
 * Steps:
 *  1. Aggregate all posted revenue and expense lines for the year.
 *  2. Look up the Retained Earnings account (COA code 3900) for the company.
 *  3. Build a balanced closing entry:
 *       - Dr each revenue account for its net credit balance (zeroing it out).
 *       - Cr each expense account for its net debit balance (zeroing it out).
 *       - Cr Retained Earnings for net income (or Dr if net loss).
 *  4. Post through postJournalEntry (balance enforcement + period-open check).
 *  5. Return the entry and summary figures.
 */
export async function yearEndClose(
  ctx: ServiceContext,
  input: YearEndCloseInput,
): Promise<YearEndCloseResult> {
  const { fiscalYear } = input;

  // Backup-before-destructive: snapshot the data dir as a rotating pre-op .bka so a
  // bad close is recoverable. Best-effort — a backup failure must never block closing
  // (mirrors how restoreBackup treats its pre-op snapshot).
  try {
    ensurePreOpBackup(ctx, 'year-end-close');
  } catch (err) {
    console.warn('[fiscalClose] pre-op backup before year-end close failed (continuing):', err);
  }

  // Aggregate + post in ONE transaction: a second close running at the same time sees the first
  // closing entry (the year then nets to zero) instead of posting a second one.
  return inTransaction(ctx, (tx) => yearEndCloseInTx(tx, fiscalYear));
}

async function yearEndCloseInTx(ctx: ServiceContext, fiscalYear: number): Promise<YearEndCloseResult> {
  // Honor the company's configured fiscal year end (settings.fiscalYearEnd, 'MM-DD').
  // Defaults to 12-31 (calendar year) when unset.
  const [companyRow] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  const fiscalYearEnd = companyRow?.settings?.fiscalYearEnd;
  const { yearStart, yearEnd, closingDate } = fiscalYearWindow(fiscalYear, fiscalYearEnd);

  // 1. Aggregate posted P&L activity for the year, per account.
  const plRows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
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
        gte(journalEntries.date, yearStart),
        lt(journalEntries.date, yearEnd),
      ),
    )
    .groupBy(
      journalEntryLines.accountId,
      accounts.code,
      accounts.name,
      accounts.type,
    );

  // 2. Separate into revenue / expense buckets and compute net balances.
  //    Revenue: credit-normal → net credit = credit - debit.
  //    Expense: debit-normal  → net debit  = debit  - credit.
  interface PLAccount {
    accountId: string;
    code: string;
    name: string;
    netBalance: string; // signed natural balance (negative = on the non-normal side)
  }
  const revenueAccounts: PLAccount[] = [];
  const expenseAccounts: PLAccount[] = [];
  let totalRevenue = Money.zero();
  let totalExpenses = Money.zero();

  for (const row of plRows) {
    if (row.type === 'revenue') {
      const net = Money.sub(row.totalCredit, row.totalDebit); // credit-normal
      if (!net.isZero()) {
        revenueAccounts.push({ accountId: row.accountId, code: row.code, name: row.name, netBalance: toAmountString(net) });
        totalRevenue = totalRevenue.plus(net);
      }
    } else if (row.type === 'expense') {
      const net = Money.sub(row.totalDebit, row.totalCredit); // debit-normal
      if (!net.isZero()) {
        expenseAccounts.push({ accountId: row.accountId, code: row.code, name: row.name, netBalance: toAmountString(net) });
        totalExpenses = totalExpenses.plus(net);
      }
    }
  }

  if (revenueAccounts.length === 0 && expenseAccounts.length === 0) {
    // Nothing left to close because this year's closing entry already zeroed it.
    const [closed] = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          eq(journalEntries.sourceRef, `fiscal-close:${fiscalYear}`),
        ),
      )
      .limit(1);
    if (closed) {
      throw new ServiceError('CONFLICT', `Fiscal year ${fiscalYear} is already closed. Nothing left to close.`);
    }
    throw new ServiceError(
      'VALIDATION',
      `No posted revenue or expense activity found for fiscal year ${fiscalYear}. Nothing to close.`,
    );
  }

  // 3. Find the company's Retained Earnings account.
  const reAccount = await findRetainedEarningsAccount(ctx);
  if (!reAccount) {
    throw new ServiceError(
      'NOT_FOUND',
      'Retained Earnings account not found. Create an equity account of type Retained Earnings before running year-end close.',
    );
  }

  // 4. Build the balanced closing entry lines.
  //
  //   For each revenue account: Dr the account for its net credit balance.
  //   For each expense account: Cr the account for its net debit balance.
  //   Net income = revenue - expenses.
  //     If positive: Cr Retained Earnings (equity increases).
  //     If negative: Dr Retained Earnings (equity decreases).
  //
  //   Proof of balance:
  //     Debits  = sum(revenue debits) + [Dr RE if loss]
  //     Credits = sum(expense credits) + [Cr RE if profit]
  //     Net income = revenue - expenses
  //     If profit: debits(revenue) = credits(expenses) + credits(RE)  ✓
  //     If loss:   debits(revenue) + debits(RE) = credits(expenses)   ✓
  //     If zero:   debits(revenue) = credits(expenses)                ✓

  const netIncome = totalRevenue.minus(totalExpenses);
  const lines: PostingLine[] = [];

  // A net balance can be on the account's non-normal side (a contra-revenue "Sales Discounts"
  // income account with a net debit, a "Purchase Discounts" expense account with a net credit).
  // Zeroing it then takes the opposite side, for the absolute amount (lines are never negative).
  for (const r of revenueAccounts) {
    const net = Money.of(r.netBalance);
    const amt = toAmountString(net.abs());
    lines.push({
      accountId: r.accountId,
      ...(net.isNegative() ? { credit: amt } : { debit: amt }),
      memo: `Close ${fiscalYear} revenue: ${r.code} ${r.name}`,
    });
  }

  for (const e of expenseAccounts) {
    const net = Money.of(e.netBalance);
    const amt = toAmountString(net.abs());
    lines.push({
      accountId: e.accountId,
      ...(net.isNegative() ? { debit: amt } : { credit: amt }),
      memo: `Close ${fiscalYear} expense: ${e.code} ${e.name}`,
    });
  }

  // Retained Earnings offset — only add if non-zero to avoid a zero-amount line.
  if (!netIncome.isZero()) {
    if (netIncome.greaterThan(0)) {
      // Profitable year: credit Retained Earnings.
      lines.push({
        accountId: reAccount.id,
        credit: toAmountString(netIncome),
        memo: `${fiscalYear} net income to retained earnings`,
      });
    } else {
      // Net loss: debit Retained Earnings.
      lines.push({
        accountId: reAccount.id,
        debit: toAmountString(netIncome.abs()),
        memo: `${fiscalYear} net loss to retained earnings`,
      });
    }
  }

  // Edge case: revenue == expenses (net income = 0) means debits(revenue) already equal
  // credits(expenses), so the entry is balanced without a RE line. postJournalEntry will
  // verify this via assertBalanced.

  // 5. Post through the engine (enforces balance, period-open check, audit log).
  //    Dated at the fiscal year end (from company settings), tagged with a
  //    machine-readable sourceRef so P&L-type reports can exclude it.
  const entry = await postJournalEntry(ctx, {
    date: closingDate,
    description: `Year-End Closing Entry — Fiscal Year ${fiscalYear}`,
    reference: `CLOSE-${fiscalYear}`,
    status: 'posted',
    lines,
    sourceRef: `fiscal-close:${fiscalYear}`,
  });

  return {
    entry,
    netIncome: toAmountString(netIncome),
    totalRevenue: toAmountString(totalRevenue),
    totalExpenses: toAmountString(totalExpenses),
  };
}
