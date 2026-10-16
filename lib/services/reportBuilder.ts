/**
 * Custom report builder — query posted journal entry lines grouped by account,
 * account type, or calendar month. Results can be saved as memorized reports.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accounts, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GroupBy = 'account' | 'type' | 'month';

export interface ReportConfig {
  from?: string;        // ISO date string or undefined for no lower bound
  to?: string;          // ISO date string or undefined for no upper bound
  accountTypes?: string[]; // e.g. ['asset','expense'] — all types if omitted/empty
  groupBy: GroupBy;
  status?: 'posted';    // default 'posted'; only posted entries supported for now
}

export interface ReportRow {
  key: string;          // dimension value (accountId, type name, or "YYYY-MM")
  label: string;        // human-readable label
  debit: string;        // total debits in group (2dp)
  credit: string;       // total credits in group (2dp)
  net: string;          // debit - credit (may be negative, 2dp)
}

export interface ReportResult {
  rows: ReportRow[];
  totals: {
    debit: string;
    credit: string;
    net: string;
  };
  config: ReportConfig;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

export async function runReport(
  ctx: ServiceContext,
  config: ReportConfig,
): Promise<ReportResult> {
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
  ];

  if (config.from) {
    const fromDate = new Date(config.from);
    conds.push(sql`${journalEntries.date} >= ${fromDate}`);
  }
  if (config.to) {
    // Include the whole to-day: the end of that UTC calendar day (stored dates are UTC; a
    // local-time setHours ended the day hours early west of UTC, dropping e.g. the 23:59:59Z
    // year-end closing entry).
    const toDate = new Date(config.to);
    const toEnd = new Date(
      Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate() + 1) - 1,
    );
    conds.push(sql`${journalEntries.date} <= ${toEnd}`);
  }

  // Filter by account types if specified
  const validTypes = config.accountTypes?.filter(Boolean) ?? [];
  if (validTypes.length > 0) {
    // Get account ids belonging to those types for this company
    // Cast to the enum literal union that Drizzle expects for this column
    type AcctType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
    const typesForQuery = validTypes as [AcctType, ...AcctType[]];
    const matchingAccounts = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.companyId, ctx.companyId),
          inArray(accounts.type, typesForQuery),
        ),
      );

    if (matchingAccounts.length === 0) {
      // No accounts of those types — return empty
      return {
        rows: [],
        totals: { debit: '0.00', credit: '0.00', net: '0.00' },
        config,
        generatedAt: new Date().toISOString(),
      };
    }

    const accountIds = matchingAccounts.map((a) => a.id);
    conds.push(inArray(journalEntryLines.accountId, accountIds));
  }

  // Pull all matching lines with account metadata
  const rawRows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
      entryDate: journalEntries.date,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(...conds));

  // Aggregate into groups
  type GroupAccum = { label: string; debit: ReturnType<typeof Money.zero>; credit: ReturnType<typeof Money.zero> };
  const groups = new Map<string, GroupAccum>();

  function ensureGroup(key: string, label: string): GroupAccum {
    if (!groups.has(key)) {
      groups.set(key, { label, debit: Money.zero(), credit: Money.zero() });
    }
    return groups.get(key)!;
  }

  for (const row of rawRows) {
    let key: string;
    let label: string;

    if (config.groupBy === 'account') {
      key = row.accountId;
      label = `${row.accountCode} — ${row.accountName}`;
    } else if (config.groupBy === 'type') {
      key = row.accountType;
      label = row.accountType.charAt(0).toUpperCase() + row.accountType.slice(1);
    } else {
      // 'month'
      const d = new Date(row.entryDate);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      key = `${yyyy}-${mm}`;
      label = new Date(`${yyyy}-${mm}-01`).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      });
    }

    const g = ensureGroup(key, label);
    g.debit = g.debit.plus(Money.of(row.debit));
    g.credit = g.credit.plus(Money.of(row.credit));
  }

  // Build output rows, sorted by key
  const sortedKeys = [...groups.keys()].sort();
  let totalDebit = Money.zero();
  let totalCredit = Money.zero();

  const rows: ReportRow[] = sortedKeys.map((key) => {
    const g = groups.get(key)!;
    const net = g.debit.minus(g.credit);
    totalDebit = totalDebit.plus(g.debit);
    totalCredit = totalCredit.plus(g.credit);
    return {
      key,
      label: g.label,
      debit: toAmountString(g.debit),
      credit: toAmountString(g.credit),
      net: toAmountString(net),
    };
  });

  return {
    rows,
    totals: {
      debit: toAmountString(totalDebit),
      credit: toAmountString(totalCredit),
      net: toAmountString(totalDebit.minus(totalCredit)),
    },
    config,
    generatedAt: new Date().toISOString(),
  };
}
