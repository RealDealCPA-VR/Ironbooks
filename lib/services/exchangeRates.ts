/**
 * p1 fx — exchange-rate helpers shared by every multi-currency window.
 *
 * Rates are "home units per 1 foreign unit" (the currency list's rateToBase). These helpers are
 * the public API other teams call (e.g. Receive Payments):
 *  - `currencyRate`        the rate to use for a transaction: the stated rate, else the list rate
 *  - `toHome`              a foreign amount in home currency (rounded to the cent)
 *  - `realizedGainLoss`    the realized exchange gain/loss when an amount booked at one rate is
 *                          settled at another (+ the posting line for it)
 *  - `accountCurrencyOf`   the currency of a bank / credit-card account (null = home)
 *  - `exchangeGainLossLine` the Dr/Cr line on Exchange Gain/Loss for a difference
 *
 * Money math is Decimal-only (lib/money.ts). Nothing here writes to the ledger.
 */
import { and, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { accounts, currencies } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, notFound, validation } from './_base';
import { foreignCode, homeCode } from './fxLines';
import { getOrCreateExchangeGainLossAccount } from './currencies';
import type { PostingLine } from './posting';

export { foreignCode, homeCode };

export interface RateResult {
  /** Foreign currency code; null = home currency (rate exactly 1). */
  currency: string | null;
  rate: Decimal;
}

/** Parse an optional user-entered rate (> 0) or return null when blank. */
export function parseRate(v: string | number | Decimal | null | undefined, label = 'Exchange rate'): Decimal | null {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  let r: Decimal;
  try {
    r = Money.of(v);
  } catch {
    throw validation(`${label} is not a number.`);
  }
  if (!r.isFinite() || !r.greaterThan(0)) throw validation(`${label} must be greater than zero.`);
  if (r.greaterThan(1_000_000)) throw validation(`${label} is too large.`);
  return new Decimal(r.toFixed(8));
}

/**
 * The rate to use for a transaction in `code`: the stated rate when given, else the currency
 * list's current rate (QB fills in the rate from the currency list and lets you change it).
 * A blank code or the home currency returns { currency: null, rate: 1 }.
 */
export async function currencyRate(
  ctx: ServiceContext,
  code: string | null | undefined,
  stated?: string | number | Decimal | null,
): Promise<RateResult> {
  const home = await homeCode(ctx);
  const cur = foreignCode(code, home);
  if (!cur) return { currency: null, rate: Money.of(1) };
  const given = parseRate(stated);
  if (given) return { currency: cur, rate: given };
  const [row] = await ctx.db
    .select({ rate: currencies.rateToBase })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, cur)));
  if (!row) {
    throw validation(`${cur} is not in your currency list. Add it under Currencies (with an exchange rate) first.`);
  }
  const r = Money.of(row.rate);
  if (!r.greaterThan(0)) throw validation(`${cur} has no exchange rate. Enter one under Currencies.`);
  return { currency: cur, rate: new Decimal(r.toFixed(8)) };
}

/** Home-currency value of a foreign amount, rounded to the cent. */
export function toHome(amount: string | number | Decimal, rate: string | number | Decimal): Decimal {
  return Money.round2(Money.of(amount).times(Money.of(rate)));
}

/** Foreign value of a home amount, rounded to the cent. */
export function fromHome(homeAmount: string | number | Decimal, rate: string | number | Decimal): Decimal {
  const r = Money.of(rate);
  if (!r.greaterThan(0)) throw validation('Exchange rate must be greater than zero.');
  return Money.round2(Money.of(homeAmount).dividedBy(r));
}

export interface RealizedGainLoss {
  /** Home value at the rate the item was booked at. */
  bookedHome: Decimal;
  /** Home value at the settlement rate. */
  settledHome: Decimal;
  /**
   * settledHome - bookedHome for an ASSET being collected (A/R, a deposit): > 0 is a gain.
   * For a LIABILITY being paid (A/P, a loan) pass side 'liability': bookedHome - settledHome,
   * > 0 is a gain (it cost less home currency than it was booked at).
   */
  gain: Decimal;
}

/**
 * Realized exchange gain/loss when `amount` (foreign) booked at `bookedRate` is settled at
 * `settleRate`. Pass `bookedHome` when the exact home amount still carried is known (e.g. the
 * last payment that closes a document) so rounding never leaves a cent behind.
 */
export function realizedGainLoss(input: {
  amount: string | number | Decimal;
  bookedRate: string | number | Decimal;
  settleRate: string | number | Decimal;
  side: 'asset' | 'liability';
  bookedHome?: string | number | Decimal;
}): RealizedGainLoss {
  const bookedHome = input.bookedHome != null ? Money.round2(input.bookedHome) : toHome(input.amount, input.bookedRate);
  const settledHome = toHome(input.amount, input.settleRate);
  const gain = input.side === 'asset' ? settledHome.minus(bookedHome) : bookedHome.minus(settledHome);
  return { bookedHome, settledHome, gain: Money.round2(gain) };
}

/**
 * The Exchange Gain/Loss posting line for a gain (> 0, credit) or loss (< 0, debit). Returns
 * null for zero. The account (6900 Exchange Gain/Loss) is created on first use.
 */
export async function exchangeGainLossLine(
  ctx: ServiceContext,
  gain: Decimal,
  memo?: string,
): Promise<PostingLine | null> {
  const g = Money.round2(gain);
  if (g.isZero()) return null;
  const accountId = await getOrCreateExchangeGainLossAccount(ctx);
  return g.greaterThan(0)
    ? { accountId, credit: toAmountString(g), memo: memo ?? 'Realized exchange gain' }
    : { accountId, debit: toAmountString(g.abs()), memo: memo ?? 'Realized exchange loss' };
}

/** Currency of an account (null = home currency). Throws NOT_FOUND for another company's account. */
export async function accountCurrencyOf(
  ctx: ServiceContext,
  accountId: string,
): Promise<{ currency: string | null; home: string | null; name: string; type: string; subtype: string }> {
  const [a] = await ctx.db
    .select({ currency: accounts.currency, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!a) throw notFound('Account');
  const home = await homeCode(ctx);
  return { currency: foreignCode(a.currency, home), home, name: a.name, type: a.type, subtype: a.subtype };
}

/** Plain-language label for a currency (home currency shows its code or "home currency"). */
export function currencyLabel(code: string | null, home: string | null): string {
  return code ?? home ?? 'home currency';
}
