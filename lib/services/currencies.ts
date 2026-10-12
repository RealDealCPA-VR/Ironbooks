/**
 * Multi-currency service.
 *
 * The `currencies` table (see schema.ts) tracks every currency a company uses, each with a
 * `rateToBase` (units of base currency per 1 unit of this currency). The base currency always
 * has rateToBase = 1 and isBase = true.
 *
 * Conversions:
 *   amount in foreign → amount in base : amount * fromRate
 *   amount in base    → amount in foreign: amount / toRate
 *   cross-rate (foreign A → foreign B)  : amount * fromRate / toRate
 *
 * FX gain/loss entries are posted through postJournalEntry so the GL remains the single source
 * of truth:
 *   Gain: Dr <asset/liability account>  /  Cr 4900 Other Income
 *   Loss: Dr 6100 Bank & Merchant Fees  /  Cr <asset/liability account>
 */
import { and, eq, ne } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { currencies, accounts, journalEntryLines } from '@/lib/db/schema';
import { Money, allocate, toAmountString } from '@/lib/money';
import { postJournalEntry } from './posting';
import { type ServiceContext, ServiceError, validation, notFound, writeAudit } from './_base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CurrencyRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  rateToBase: string;
  isBase: boolean;
  updatedAt: Date;
}

export interface UpsertCurrencyInput {
  code: string;
  name: string;
  /** Exchange rate: how many base-currency units equal 1 unit of this currency. */
  rateToBase: string | number;
}

export interface SetBaseCurrencyInput {
  code: string;
  name: string;
}

export interface RecordFxAdjustmentInput {
  /** The account being revalued (must belong to this company). */
  accountId: string;
  /** Absolute amount of the gain or loss in base currency. */
  amount: string | number;
  /** true = FX gain, false = FX loss. */
  gain: boolean;
  date: Date;
  memo?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a GL account by code, scoped to the company. Throws NOT_FOUND if missing. */
async function resolveAccountByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account ${code}`);
  return row.id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all currencies for the company (base currency first). */
export async function listCurrencies(ctx: ServiceContext): Promise<CurrencyRow[]> {
  const rows = await ctx.db
    .select()
    .from(currencies)
    .where(eq(currencies.companyId, ctx.companyId));
  // Put base currency first for convenience
  return rows.sort((a, b) => (b.isBase ? 1 : 0) - (a.isBase ? 1 : 0));
}

/**
 * Set (or replace) the base currency for a company.
 * - If a base already exists its isBase flag is cleared.
 * - The new base is inserted/updated with rateToBase = 1.
 */
export async function setBaseCurrency(
  ctx: ServiceContext,
  input: SetBaseCurrencyInput,
): Promise<CurrencyRow> {
  const { code, name } = input;
  if (!code || code.length > 3) throw validation('Currency code must be 1–3 characters.');
  if (!name) throw validation('Currency name is required.');

  // Clear any existing base flag
  await ctx.db
    .update(currencies)
    .set({ isBase: false, updatedAt: new Date() })
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.isBase, true)));

  // Upsert the new base
  const [existing] = await ctx.db
    .select()
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, code.toUpperCase())));

  let row: CurrencyRow;
  if (existing) {
    const [updated] = await ctx.db
      .update(currencies)
      .set({ name, rateToBase: '1', isBase: true, updatedAt: new Date() })
      .where(eq(currencies.id, existing.id))
      .returning();
    row = updated as CurrencyRow;
  } else {
    const [inserted] = await ctx.db
      .insert(currencies)
      .values({
        companyId: ctx.companyId,
        code: code.toUpperCase(),
        name,
        rateToBase: '1',
        isBase: true,
      })
      .returning();
    row = inserted as CurrencyRow;
  }

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'currency',
    entityId: row.id,
    newValues: { code: row.code, name: row.name, isBase: true },
  });

  return row;
}

/**
 * Insert or update a foreign currency and its exchange rate.
 * Cannot be used to (re-)set the base currency — use setBaseCurrency for that.
 * rateToBase must be positive (> 0).
 */
export async function upsertCurrency(
  ctx: ServiceContext,
  input: UpsertCurrencyInput,
): Promise<CurrencyRow> {
  const { code, name, rateToBase } = input;
  if (!code || code.length > 3) throw validation('Currency code must be 1–3 characters.');
  if (!name) throw validation('Currency name is required.');

  const rate = Money.of(rateToBase);
  if (!rate.greaterThan(0)) throw validation('rateToBase must be greater than zero.');

  const [existing] = await ctx.db
    .select()
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, code.toUpperCase())));

  let row: CurrencyRow;
  if (existing) {
    if (existing.isBase) {
      throw new ServiceError(
        'CONFLICT',
        `${code.toUpperCase()} is the base currency. Use setBaseCurrency to change the base.`,
      );
    }
    const [updated] = await ctx.db
      .update(currencies)
      .set({ name, rateToBase: rate.toFixed(8), updatedAt: new Date() })
      .where(eq(currencies.id, existing.id))
      .returning();
    row = updated as CurrencyRow;
  } else {
    const [inserted] = await ctx.db
      .insert(currencies)
      .values({
        companyId: ctx.companyId,
        code: code.toUpperCase(),
        name,
        rateToBase: rate.toFixed(8),
        isBase: false,
      })
      .returning();
    row = inserted as CurrencyRow;
  }

  await writeAudit(ctx, {
    action: existing ? 'update' : 'create',
    entityType: 'currency',
    entityId: row.id,
    oldValues: existing ? { rateToBase: existing.rateToBase } : undefined,
    newValues: { code: row.code, name: row.name, rateToBase: row.rateToBase },
  });

  return row;
}

/**
 * Convert an amount between currencies via their rateToBase values.
 *
 * @param amount    The source amount.
 * @param fromRate  rateToBase of the source currency  (1.0 if source is base).
 * @param toRate    rateToBase of the target currency  (1.0 if target is base).
 * @returns         The converted amount as a Decimal-string (toFixed(2)).
 *
 * Formula: amount * fromRate / toRate
 */
export function convert(
  amount: string | number,
  fromRate: string | number,
  toRate: string | number = '1',
): string {
  const result = Money.of(amount).times(Money.of(fromRate)).dividedBy(Money.of(toRate));
  return toAmountString(result);
}

/**
 * Return the revaluation snapshot: all non-base currencies with their current rate.
 * This is the data foundation for an FX revaluation report — callers can combine it
 * with account balances to compute unrealised gains/losses.
 */
export async function revaluation(
  ctx: ServiceContext,
): Promise<Array<{ id: string; code: string; name: string; rateToBase: string }>> {
  const rows = await ctx.db
    .select({ id: currencies.id, code: currencies.code, name: currencies.name, rateToBase: currencies.rateToBase })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), ne(currencies.isBase, true)));
  return rows;
}

/**
 * Post a balanced FX gain/loss journal entry through the posting engine.
 *
 *   Gain: Dr <accountId>       /  Cr 4900 (Other Income)
 *   Loss: Dr 6100 (Bank Fees)  /  Cr <accountId>
 *
 * Both lines are equal to `amount` so the entry is always balanced.
 */
export async function recordFxAdjustment(
  ctx: ServiceContext,
  input: RecordFxAdjustmentInput,
): Promise<{ entryId: string }> {
  const { accountId, amount, gain, date, memo } = input;

  const absAmount = Money.abs(amount);
  if (absAmount.isZero()) throw validation('FX adjustment amount must be non-zero.');

  // Verify the target account belongs to this company
  const [targetAcct] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!targetAcct) throw notFound(`Account ${accountId}`);

  const otherIncomeId = await resolveAccountByCode(ctx, '4900');
  const bankFeesId = await resolveAccountByCode(ctx, '6100');

  const amtStr = toAmountString(absAmount);
  const description = memo ?? (gain ? 'FX gain adjustment' : 'FX loss adjustment');

  let lines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string }>;

  if (gain) {
    // Gain: Dr the subject account / Cr Other Income (4900)
    lines = [
      { accountId, debit: amtStr, memo: description },
      { accountId: otherIncomeId, credit: amtStr, memo: description },
    ];
  } else {
    // Loss: Dr Bank & Merchant Fees (6100) / Cr the subject account
    lines = [
      { accountId: bankFeesId, debit: amtStr, memo: description },
      { accountId, credit: amtStr, memo: description },
    ];
  }

  const entry = await postJournalEntry(ctx, {
    date,
    description,
    lines,
    sourceRef: 'fx_adjustment',
  });

  return { entryId: entry.id };
}

// ---------------------------------------------------------------------------
// wave2 purchases — multi-currency purchase documents
// ---------------------------------------------------------------------------
//
// Purchase documents (bills, checks / credit-card charges, bill payments) carry their own
// `currency` (null = home) and `exchangeRate` (home units per 1 transaction unit). The document
// stores amounts in its TRANSACTION currency; every GL line is posted in HOME currency. To keep
// the trial balance balanced to the penny, the home-currency total is computed ONCE
// (anchor = round2(total x rate)) and the lines are penny-allocated against it with `allocate`
// (largest remainder), exactly like invoices do. For rate = 1 the amounts are used as-is, so
// home-currency documents post exactly as before.

/** The company's home (base) currency code, or null when multi-currency was never set up. */
export async function getHomeCurrencyCode(ctx: ServiceContext): Promise<string | null> {
  const [row] = await ctx.db
    .select({ code: currencies.code })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.isBase, true)));
  return row?.code ?? null;
}

export interface ResolvedCurrency {
  /** Transaction currency code; null = home currency. */
  currency: string | null;
  /** Home units per 1 transaction unit (exactly 1 for home documents). */
  rate: Decimal;
}

function hasText(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Decide a purchase document's currency + exchange rate.
 *  - `currency` defaults to the payment account's currency, then the vendor's currency.
 *  - A vendor or bank/credit-card account with a foreign currency only takes documents in that
 *    currency (QuickBooks rule: a vendor's transactions are in the vendor's currency).
 *  - A currency equal to the home currency is normalised to null (rate 1).
 *  - Foreign documents use `exchangeRate` when given, else the currency list's current rate.
 */
export async function resolveDocumentCurrency(
  ctx: ServiceContext,
  input: {
    currency?: string | null;
    exchangeRate?: string | number | null;
    /** The vendor's currency; null = a home-currency vendor; undefined = no vendor (free-text payee). */
    vendorCurrency?: string | null;
    accountCurrency?: string | null;
  },
): Promise<ResolvedCurrency> {
  const homeVendor = input.vendorCurrency === null;
  const anyForeign = hasText(input.currency) || hasText(input.vendorCurrency) || hasText(input.accountCurrency);
  if (!anyForeign) return { currency: null, rate: Money.of(1) };

  const home = await getHomeCurrencyCode(ctx);
  const norm = (c: string | null | undefined): string | null => {
    const v = (c ?? '').trim().toUpperCase();
    return v === '' || (home != null && v === home) ? null : v;
  };
  const vendorCur = norm(input.vendorCurrency);
  const accountCur = norm(input.accountCurrency);
  const currency = hasText(input.currency) ? norm(input.currency) : (accountCur ?? vendorCur ?? null);

  if (homeVendor && !vendorCur && currency) {
    throw validation(
      `This vendor uses your home currency, so it can't be paid from a ${currency} account. Pick a home-currency account (or set up the vendor in ${currency}).`,
    );
  }
  if (vendorCur && currency !== vendorCur) {
    throw validation(
      `This vendor uses ${vendorCur}. Enter the transaction in ${vendorCur} (or change the vendor's currency).`,
    );
  }
  if (accountCur && currency !== accountCur) {
    throw validation(
      `The selected account is a ${accountCur} account. Transactions in it must be in ${accountCur}.`,
    );
  }
  if (!currency) return { currency: null, rate: Money.of(1) };

  let rate: Decimal;
  if (hasText(input.exchangeRate)) {
    rate = Money.of(input.exchangeRate);
  } else {
    const [row] = await ctx.db
      .select({ rateToBase: currencies.rateToBase })
      .from(currencies)
      .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, currency)));
    if (!row) {
      throw validation(
        `${currency} is not in your currency list. Add it under Currencies (with an exchange rate) first.`,
      );
    }
    rate = Money.of(row.rateToBase);
  }
  if (!rate.isFinite() || !rate.greaterThan(0)) throw validation('Exchange rate must be greater than zero.');
  return { currency, rate: new Decimal(rate.toFixed(8)) };
}

/**
 * Home-currency amounts for a document: anchor = round2(total x rate); each line gets its
 * penny-allocated share so the lines sum to the anchor exactly. Line amounts are positive
 * 2dp values in the transaction currency.
 */
export function homeAmounts(
  lineAmounts: Array<string | number | Decimal>,
  rate: string | number | Decimal,
): { total: Decimal; lines: Decimal[] } {
  const r = Money.of(rate);
  const totalTxn = lineAmounts.reduce<Decimal>((a, v) => a.plus(Money.of(v)), Money.zero());
  if (r.equals(1)) {
    return { total: Money.round2(totalTxn), lines: lineAmounts.map((v) => Money.round2(v)) };
  }
  const anchor = Money.round2(totalTxn.times(r));
  return { total: anchor, lines: allocate(anchor, lineAmounts.map((v) => Money.of(v))) };
}

/** Find-or-create the Exchange Gain/Loss account (code 6900) used for realized FX. */
export async function getOrCreateExchangeGainLossAccount(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6900')));
  if (row) return row.id;
  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code: '6900',
      name: 'Exchange Gain/Loss',
      type: 'expense' as never,
      subtype: 'operating_expenses' as never,
    })
    .returning();
  return created.id;
}

/**
 * Set the currency of a bank / credit-card account (QB: a foreign-currency bank account).
 * Allowed only while the account has no transactions - changing it later would re-denominate
 * history.
 */
export async function setAccountCurrency(
  ctx: ServiceContext,
  accountId: string,
  code: string | null,
): Promise<{ id: string; currency: string | null }> {
  const [acct] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!acct) throw notFound('Account');
  const isBankish = acct.type === 'asset' && ['checking', 'savings'].includes(acct.subtype);
  const isCard = acct.type === 'liability' && acct.subtype === 'credit_card';
  if (!isBankish && !isCard) {
    throw validation('Only bank and credit card accounts can have their own currency.');
  }
  const home = await getHomeCurrencyCode(ctx);
  let next: string | null = (code ?? '').trim().toUpperCase() || null;
  if (next && home && next === home) next = null;
  if (next) {
    const [cur] = await ctx.db
      .select({ id: currencies.id })
      .from(currencies)
      .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, next)));
    if (!cur) throw validation(`${next} is not in your currency list. Add it under Currencies first.`);
  }
  if ((acct.currency ?? null) === next) return { id: acct.id, currency: next };
  const [used] = await ctx.db
    .select({ id: journalEntryLines.id })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.accountId, accountId))
    .limit(1);
  if (used) {
    throw new ServiceError(
      'CONFLICT',
      'This account already has transactions, so its currency can no longer be changed. Create a new account in the other currency instead.',
    );
  }
  const [updated] = await ctx.db
    .update(accounts)
    .set({ currency: next, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'account',
    entityId: accountId,
    oldValues: { currency: acct.currency ?? null },
    newValues: { currency: next },
  });
  return { id: updated.id, currency: updated.currency ?? null };
}

/**
 * J10: documents that are recorded in home currency only (deposits, transfers, vendor credits,
 * Loan Manager payments) refuse a foreign-currency bank / credit-card account with a plain
 * message, so the ledger never takes a transaction-currency amount as if it were home currency.
 */
export async function assertHomeCurrencyAccounts(
  ctx: ServiceContext,
  accountIds: ReadonlyArray<string | null | undefined>,
  what: string,
): Promise<void> {
  const ids = [...new Set(accountIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  let home: string | null | undefined;
  for (const id of ids) {
    const [a] = await ctx.db
      .select({ name: accounts.name, currency: accounts.currency })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
    const cur = (a?.currency ?? '').trim().toUpperCase();
    if (!cur) continue;
    if (home === undefined) home = await getHomeCurrencyCode(ctx);
    if (home && cur === home) continue;
    throw validation(
      `"${a!.name}" is a ${cur} account. ${what} can only use home-currency accounts for now.`,
    );
  }
}
