/**
 * Money — centralized decimal-safe money handling for the accounting engine.
 *
 * RULE: never use JS floating point for money. All amounts are stored in the DB as
 * fixed-precision decimal strings (precision 15, scale 2). All arithmetic goes through
 * decimal.js here. UI formatting also lives here so currency rendering is consistent.
 */
import Decimal from 'decimal.js';
import { ServiceError } from '@/lib/services/errors';

// Banker-friendly config: 2dp results, round-half-up (standard for accounting display),
// enough precision headroom for intermediate calc (e.g. tax, multi-line allocation).
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = string | number | Decimal | null | undefined;

/**
 * Coerce any money-ish input to a Decimal, treating null/undefined/'' (and whitespace-only
 * strings) as 0. Strings are normalized first: surrounding whitespace of any kind (spaces, tabs,
 * NBSP and other Unicode separators) is ignored, so " 7.25 " is 7.25. Anything still not a
 * number throws (see `MoneyParseError`), never silently becomes 0.
 */
export function toDecimal(value: MoneyInput): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === 'string') {
    const s = value.replace(/^[\s\p{Z}﻿]+|[\s\p{Z}﻿]+$/gu, '');
    if (s === '') return new Decimal(0);
    try {
      return new Decimal(s);
    } catch {
      throw new MoneyParseError(value);
    }
  }
  try {
    return new Decimal(value);
  } catch {
    throw new MoneyParseError(String(value));
  }
}

/**
 * An amount that is not a decimal number. It IS a ServiceError (VALIDATION): every API route
 * answers it with a 400 and the message, even where no caller translated it — an action body with
 * `amount: "abc"` (payments apply / refund, credit memo apply, progress percent) used to surface as
 * a 500.
 */
export class MoneyParseError extends ServiceError {
  constructor(public readonly input: string) {
    super('VALIDATION', `"${input}" is not a valid amount.`, { input });
    this.name = 'MoneyParseError';
  }
}

/** Largest absolute value a numeric(15,2) column (amounts and cached balances) can hold. */
export const MAX_LEDGER_AMOUNT = new Decimal('9999999999999.99');

/** Normalize to a 2dp string suitable for DB decimal columns. */
export function toAmountString(value: MoneyInput): string {
  return toDecimal(value).toFixed(2);
}

export const Money = {
  zero: () => new Decimal(0),
  of: (v: MoneyInput) => toDecimal(v),
  add: (...vals: MoneyInput[]) => vals.reduce<Decimal>((a, v) => a.plus(toDecimal(v)), new Decimal(0)),
  sub: (a: MoneyInput, b: MoneyInput) => toDecimal(a).minus(toDecimal(b)),
  mul: (a: MoneyInput, b: MoneyInput) => toDecimal(a).times(toDecimal(b)),
  div: (a: MoneyInput, b: MoneyInput) => toDecimal(a).dividedBy(toDecimal(b)),
  neg: (a: MoneyInput) => toDecimal(a).negated(),
  abs: (a: MoneyInput) => toDecimal(a).abs(),
  round2: (a: MoneyInput) => new Decimal(toDecimal(a).toFixed(2)),

  isZero: (a: MoneyInput) => toDecimal(a).isZero(),
  isPositive: (a: MoneyInput) => toDecimal(a).greaterThan(0),
  isNegative: (a: MoneyInput) => toDecimal(a).lessThan(0),
  eq: (a: MoneyInput, b: MoneyInput) => toDecimal(a).equals(toDecimal(b)),
  gt: (a: MoneyInput, b: MoneyInput) => toDecimal(a).greaterThan(toDecimal(b)),
  gte: (a: MoneyInput, b: MoneyInput) => toDecimal(a).greaterThanOrEqualTo(toDecimal(b)),
  lt: (a: MoneyInput, b: MoneyInput) => toDecimal(a).lessThan(toDecimal(b)),
  lte: (a: MoneyInput, b: MoneyInput) => toDecimal(a).lessThanOrEqualTo(toDecimal(b)),

  /** Are two amounts equal within a 1-cent tolerance? (balanced-entry checks) */
  equalWithinCent: (a: MoneyInput, b: MoneyInput) =>
    toDecimal(a).minus(toDecimal(b)).abs().lessThan('0.005'),

  toString: (a: MoneyInput) => toAmountString(a),
};

/**
 * Allocate a total across n weights without losing pennies (largest-remainder method).
 * Used for splitting discounts/tax across invoice lines, payment application, etc.
 */
export function allocate(total: MoneyInput, weights: MoneyInput[]): Decimal[] {
  const t = Money.round2(total);
  // A negative total is the mirror image of the positive one: allocate |total| and negate, so the
  // leftover cents go to the largest remainders exactly as they do for the positive amount (a
  // credit memo splits its tax over agencies the same way as the invoice it reverses). Rounding
  // a negative share toward zero and then handing out the remainder by fractional part would
  // otherwise give the extra cent to the SMALLEST remainder.
  if (t.isNegative()) {
    return allocateNonNegative(t.negated(), weights).map((v) => (v.isZero() ? new Decimal(0) : v.negated()));
  }
  return allocateNonNegative(t, weights);
}

function allocateNonNegative(t: Decimal, weights: MoneyInput[]): Decimal[] {
  const ws = weights.map(toDecimal);
  const sum = ws.reduce<Decimal>((a, w) => a.plus(w), new Decimal(0));
  if (sum.isZero()) {
    // even split
    const even = t.dividedBy(ws.length);
    const base = new Decimal(even.toFixed(2, Decimal.ROUND_DOWN));
    const out = ws.map(() => base);
    return distributeRemainder(t, out);
  }
  const raw = ws.map((w) => t.times(w).dividedBy(sum));
  const floored = raw.map((r) => new Decimal(r.toFixed(2, Decimal.ROUND_DOWN)));
  return distributeRemainder(t, floored, raw);
}

function distributeRemainder(total: Decimal, floored: Decimal[], raw?: Decimal[]): Decimal[] {
  const out = [...floored];
  const allocated = out.reduce<Decimal>((a, v) => a.plus(v), new Decimal(0));
  let remainderCents = total.minus(allocated).times(100).round().toNumber();
  // hand out the leftover cents to the entries with the largest fractional remainder
  const order = out
    .map((_, i) => i)
    .sort((a, b) => {
      const fa = raw ? raw[a].minus(floored[a]).toNumber() : 0;
      const fb = raw ? raw[b].minus(floored[b]).toNumber() : 0;
      return fb - fa;
    });
  let k = 0;
  while (remainderCents > 0 && out.length > 0) {
    const idx = order[k % order.length];
    out[idx] = out[idx].plus('0.01');
    remainderCents -= 1;
    k += 1;
  }
  while (remainderCents < 0 && out.length > 0) {
    const idx = order[k % order.length];
    out[idx] = out[idx].minus('0.01');
    remainderCents += 1;
    k += 1;
  }
  return out;
}

/** Format for display. Defaults to USD; pass currency/locale per company settings. */
export function formatCurrency(
  value: MoneyInput,
  currency = 'USD',
  locale = 'en-US',
): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
    toDecimal(value).toNumber(),
  );
}

/** Accounting-style: negatives in parentheses, e.g. (1,234.56). */
export function formatAccounting(value: MoneyInput, currency = 'USD', locale = 'en-US'): string {
  const d = toDecimal(value);
  const formatted = formatCurrency(d.abs(), currency, locale);
  return d.isNegative() ? `(${formatted})` : formatted;
}
