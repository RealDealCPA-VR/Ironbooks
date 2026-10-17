/**
 * Classified Balance Sheet service.
 *
 * Extends the standard Balance Sheet by splitting assets and liabilities into
 * Current vs Non-Current (Long-Term) sub-sections, following GAAP presentation.
 *
 * Classification is driven by the QuickBooks account type (lib/accountTypes.ts):
 *   Current assets    : Bank, Accounts Receivable, Other Current Asset (incl. Undeposited
 *                       Funds and inventory)
 *   Non-Current assets: Fixed Asset, Other Asset
 *
 *   Current liabilities   : Accounts Payable, Credit Card, Other Current Liability
 *   Long-Term liabilities : Long Term Liability
 *
 * Equity and net income are included unchanged (same logic as balanceSheet in reports.ts).
 * The report queries posted GL activity, not cached account balances, for accuracy.
 */
import { and, eq, sql } from 'drizzle-orm';
import { accounts, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { onOrBeforeDay } from './journal';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { isCurrentAsset, isCurrentLiability } from '@/lib/accountTypes';
import { assertBalanceSheetBalanced } from './ledgerAssert';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassifiedLine {
  accountId: string;
  code: string;
  name: string;
  subtype: string;
  amount: string;
}

export interface ClassifiedSection {
  lines: ClassifiedLine[];
  total: string;
}

export interface ClassifiedBalanceSheet {
  // Assets
  currentAssets: ClassifiedSection;
  nonCurrentAssets: ClassifiedSection;
  totalAssets: string;

  // Liabilities
  currentLiabilities: ClassifiedSection;
  longTermLiabilities: ClassifiedSection;
  totalLiabilities: string;

  // Equity (same as standard BS — no current/non-current split for equity)
  equity: ClassifiedLine[];
  retainedEarnings: string;
  totalEquity: string;

  /** Assets == Liabilities + Equity (accounting equation check). */
  balanced: boolean;
  asOf?: string;
}

// ---------------------------------------------------------------------------
// Classification sets
// ---------------------------------------------------------------------------

// Current vs non-current comes from lib/accountTypes.ts (isCurrentAsset / isCurrentLiability).

// Debit-normal types.
const DEBIT_NORMAL = new Set(['asset', 'expense']);

// ---------------------------------------------------------------------------
// Internal helper — mirrors accountActivity in reports.ts but also returns subtype.
// ---------------------------------------------------------------------------

async function classifiedAccountActivity(ctx: ServiceContext, asOf?: Date) {
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
  ];
  if (asOf) conds.push(onOrBeforeDay(asOf)); // whole day (entries with a time of day)

  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(...conds))
    .groupBy(
      journalEntryLines.accountId,
      accounts.code,
      accounts.name,
      accounts.type,
      accounts.subtype,
    );

  return rows;
}

import type Decimal from 'decimal.js';

function makeSection(lines: ClassifiedLine[], total: Decimal): ClassifiedSection {
  return {
    lines: lines.sort((a, b) => a.code.localeCompare(b.code)),
    total: toAmountString(total),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function balanceSheetClassified(
  ctx: ServiceContext,
  asOf?: Date,
): Promise<ClassifiedBalanceSheet> {
  const activity = await classifiedAccountActivity(ctx, asOf);

  const currentAssetLines: ClassifiedLine[] = [];
  const nonCurrentAssetLines: ClassifiedLine[] = [];
  const currentLiabilityLines: ClassifiedLine[] = [];
  const longTermLiabilityLines: ClassifiedLine[] = [];
  const equityLines: ClassifiedLine[] = [];

  let totalCurrentAssets = Money.zero();
  let totalNonCurrentAssets = Money.zero();
  let totalCurrentLiabilities = Money.zero();
  let totalLongTermLiabilities = Money.zero();
  let totalEquity = Money.zero();
  let netIncome = Money.zero();

  for (const a of activity) {
    const debitNet = Money.sub(a.debit, a.credit);
    const naturalBalance = DEBIT_NORMAL.has(a.type) ? debitNet : debitNet.negated();

    const line: ClassifiedLine = {
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      subtype: a.subtype,
      amount: toAmountString(naturalBalance),
    };

    if (a.type === 'asset') {
      if (isCurrentAsset(a)) {
        currentAssetLines.push(line);
        totalCurrentAssets = totalCurrentAssets.plus(naturalBalance);
      } else {
        nonCurrentAssetLines.push(line);
        totalNonCurrentAssets = totalNonCurrentAssets.plus(naturalBalance);
      }
    } else if (a.type === 'liability') {
      if (isCurrentLiability(a)) {
        currentLiabilityLines.push(line);
        totalCurrentLiabilities = totalCurrentLiabilities.plus(naturalBalance);
      } else {
        // Long Term Liability accounts.
        longTermLiabilityLines.push(line);
        totalLongTermLiabilities = totalLongTermLiabilities.plus(naturalBalance);
      }
    } else if (a.type === 'equity') {
      equityLines.push(line);
      totalEquity = totalEquity.plus(naturalBalance);
    } else if (a.type === 'revenue') {
      netIncome = netIncome.plus(naturalBalance);
    } else if (a.type === 'expense') {
      netIncome = netIncome.minus(naturalBalance);
    }
  }

  const totalAssets = totalCurrentAssets.plus(totalNonCurrentAssets);
  const totalLiabilities = totalCurrentLiabilities.plus(totalLongTermLiabilities);
  const totalEquityWithRE = totalEquity.plus(netIncome);

  equityLines.sort((a, b) => a.code.localeCompare(b.code));
  // Balanced by construction (all accounts from the same posted rows, net income folded into
  // equity); unreachable while the DB ledger guards hold — throws a loud INTEGRITY error.
  assertBalanceSheetBalanced('Classified balance sheet', totalAssets, totalLiabilities, totalEquityWithRE);

  return {
    currentAssets: makeSection(currentAssetLines, totalCurrentAssets),
    nonCurrentAssets: makeSection(nonCurrentAssetLines, totalNonCurrentAssets),
    totalAssets: toAmountString(totalAssets),

    currentLiabilities: makeSection(currentLiabilityLines, totalCurrentLiabilities),
    longTermLiabilities: makeSection(longTermLiabilityLines, totalLongTermLiabilities),
    totalLiabilities: toAmountString(totalLiabilities),

    equity: equityLines,
    retainedEarnings: toAmountString(netIncome),
    totalEquity: toAmountString(totalEquityWithRE),

    balanced: Money.eq(totalAssets, totalLiabilities.plus(totalEquityWithRE)),
    asOf: asOf?.toISOString(),
  };
}
