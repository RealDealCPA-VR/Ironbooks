/**
 * p1 fx — reading the ledger in an account's own currency.
 *
 * A foreign-currency bank / credit-card account keeps its home-currency debit/credit on every line
 * (the ledger of record) plus the amount in the account's currency (journal_entry_lines.
 * foreign_amount, see fxLines.ts). QuickBooks shows such a register, its bank feed and its
 * reconciliation in the account's currency; these helpers give the services the account-currency
 * debit / credit of a line, and decorate the register with account-currency columns.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { accounts, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { foreignCode, homeCode } from './fxLines';
import type { AccountRegisterOptions, AccountRegisterResult, RegisterRow } from './journal';

/** The account's foreign currency (null = home currency). */
export async function foreignCurrencyOfAccount(ctx: ServiceContext, accountId: string): Promise<string | null> {
  const [a] = await ctx.db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!a?.currency) return null;
  return foreignCode(a.currency, await homeCode(ctx));
}

/**
 * SQL for a line's debit / credit in the account's currency. For a foreign account that is the
 * foreign amount on the line's side (a revaluation line with foreign amount 0 counts as 0); a
 * line without one (only possible for data older than 0043 that could not be back-filled) falls
 * back to its home amount.
 */
export function accountDebitSql(foreign: boolean) {
  return foreign
    ? sql<string | null>`CASE WHEN ${journalEntryLines.debit} IS NOT NULL THEN COALESCE(${journalEntryLines.foreignAmount}, ${journalEntryLines.debit}) END`
    : sql<string | null>`${journalEntryLines.debit}`;
}
export function accountCreditSql(foreign: boolean) {
  return foreign
    ? sql<string | null>`CASE WHEN ${journalEntryLines.credit} IS NOT NULL THEN COALESCE(${journalEntryLines.foreignAmount}, ${journalEntryLines.credit}) END`
    : sql<string | null>`${journalEntryLines.credit}`;
}

/** Normalise "0"/"0.00" amounts from the SQL above to null (a zero side is not a side). */
export function nz(v: string | null | undefined): string | null {
  if (v == null) return null;
  return Money.of(v).isZero() ? null : toAmountString(v);
}

/** debit - credit of a line in the account's currency. */
export function accountSigned(
  row: { debit: string | null; credit: string | null; foreignAmount?: string | null },
  foreign: boolean,
): Decimal {
  if (!foreign) return Money.sub(row.debit ?? 0, row.credit ?? 0);
  const amt = Money.of(row.foreignAmount ?? (row.debit ?? row.credit ?? 0));
  return row.debit != null && Money.gt(row.debit, 0) ? amt : amt.negated();
}

const DEBIT_NORMAL = new Set(['asset', 'expense']);
function natural(type: string, signed: Decimal): Decimal {
  return DEBIT_NORMAL.has(type) ? signed : signed.negated();
}

export interface ForeignRegisterRow extends RegisterRow {
  /** Debit / credit / running balance in the account's currency. */
  foreignDebit: string | null;
  foreignCredit: string | null;
  foreignRunningBalance: string;
  /** Home units per 1 account unit on this line (null for a home-only revaluation line). */
  exchangeRate: string | null;
  /** A Home Currency Adjustment line: changes the home value only. */
  homeOnly: boolean;
}

export interface ForeignRegisterResult extends Omit<AccountRegisterResult, 'rows'> {
  /** Account currency (null = home: the register is unchanged). */
  currency: string | null;
  homeCurrency: string | null;
  foreignOpeningBalance: string | null;
  foreignClosingBalance: string | null;
  rows: Array<RegisterRow | ForeignRegisterRow>;
}

/**
 * Add account-currency columns to an account register (QB shows a foreign-currency register in
 * the account's currency, with the home value alongside). Home-currency accounts are returned
 * unchanged apart from `currency: null`.
 */
export async function withAccountCurrency(
  ctx: ServiceContext,
  register: AccountRegisterResult,
  opts: AccountRegisterOptions = {},
): Promise<ForeignRegisterResult> {
  const home = await homeCode(ctx);
  const currency = await foreignCurrencyOfAccount(ctx, register.account.id);
  if (!currency) {
    return { ...register, currency: null, homeCurrency: home, foreignOpeningBalance: null, foreignClosingBalance: null };
  }
  const type = register.account.type;

  // Opening balance in the account's currency (posted lines before `from`).
  let opening = Money.zero();
  if (opts.from) {
    const [prior] = await ctx.db
      .select({
        d: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntryLines.debit} IS NOT NULL THEN COALESCE(${journalEntryLines.foreignAmount}, ${journalEntryLines.debit}) ELSE 0 END), 0)`,
        c: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntryLines.credit} IS NOT NULL THEN COALESCE(${journalEntryLines.foreignAmount}, ${journalEntryLines.credit}) ELSE 0 END), 0)`,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntryLines.accountId, register.account.id),
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          lt(journalEntries.date, opts.from),
        ),
      );
    opening = natural(type, Money.sub(prior?.d ?? 0, prior?.c ?? 0));
  }

  // The register's own running order is over the full date range; the rows may be a search /
  // page subset, so recompute the foreign running balance over every line in the range.
  const conds = [
    eq(journalEntryLines.accountId, register.account.id),
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
  ];
  if (opts.from) conds.push(sql`${journalEntries.date} >= ${opts.from}`);
  if (opts.to) conds.push(sql`${journalEntries.date} <= ${opts.to}`);
  const all = await ctx.db
    .select({
      id: journalEntryLines.id,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      foreignAmount: journalEntryLines.foreignAmount,
      exchangeRate: journalEntryLines.exchangeRate,
      date: journalEntries.date,
      entryNumber: journalEntries.entryNumber,
      createdAt: journalEntryLines.createdAt,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conds));
  all.sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.entryNumber - b.entryNumber ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  let running = opening;
  const byLine = new Map<string, { fd: string | null; fc: string | null; run: string; rate: string | null; homeOnly: boolean }>();
  for (const l of all) {
    const signed = accountSigned(l, true);
    running = running.plus(natural(type, signed));
    const amt = toAmountString(signed.abs());
    const isDebit = l.debit != null && Money.gt(l.debit, 0);
    const homeOnly = l.foreignAmount != null && Money.of(l.foreignAmount).isZero();
    byLine.set(l.id, {
      fd: isDebit && !homeOnly ? amt : null,
      fc: !isDebit && !homeOnly ? amt : null,
      run: toAmountString(running),
      rate: l.exchangeRate ?? null,
      homeOnly,
    });
  }

  const rows: ForeignRegisterRow[] = register.rows.map((r) => {
    const f = byLine.get(r.lineId);
    return {
      ...r,
      foreignDebit: f?.fd ?? null,
      foreignCredit: f?.fc ?? null,
      foreignRunningBalance: f?.run ?? toAmountString(running),
      exchangeRate: f?.rate ?? null,
      homeOnly: f?.homeOnly ?? false,
    };
  });

  return {
    ...register,
    rows,
    currency,
    homeCurrency: home,
    foreignOpeningBalance: toAmountString(opening),
    foreignClosingBalance: toAmountString(running),
  };
}

/**
 * Natural balance of each foreign-currency bank / credit-card account in its own currency and in
 * home currency, as of a date (posted lines only). Used by Home Currency Adjustment.
 */
export async function foreignAccountBalances(
  ctx: ServiceContext,
  asOf: Date,
): Promise<
  Array<{ accountId: string; code: string; name: string; type: string; currency: string; foreign: Decimal; home: Decimal }>
> {
  const home = await homeCode(ctx);
  const accts = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.currency} IS NOT NULL`));
  const foreignAccts = accts.filter((a) => foreignCode(a.currency, home));
  if (foreignAccts.length === 0) return [];
  const sums = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
      fd: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntryLines.debit} IS NOT NULL THEN COALESCE(${journalEntryLines.foreignAmount}, ${journalEntryLines.debit}) ELSE 0 END), 0)`,
      fc: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntryLines.credit} IS NOT NULL THEN COALESCE(${journalEntryLines.foreignAmount}, ${journalEntryLines.credit}) ELSE 0 END), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        sql`${journalEntries.date} <= ${asOf}`,
        inArray(
          journalEntryLines.accountId,
          foreignAccts.map((a) => a.id),
        ),
      ),
    )
    .groupBy(journalEntryLines.accountId);
  const byId = new Map(sums.map((s) => [s.accountId, s]));
  return foreignAccts.map((a) => {
    const s = byId.get(a.id);
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      currency: foreignCode(a.currency, home)!,
      foreign: natural(a.type, Money.sub(s?.fd ?? 0, s?.fc ?? 0)),
      home: natural(a.type, Money.sub(s?.d ?? 0, s?.c ?? 0)),
    };
  });
}
