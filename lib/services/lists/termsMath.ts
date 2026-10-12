/**
 * Pure payment-terms arithmetic (QB "Terms" list) — no database, safe to import from client code.
 *
 *  Standard:     due = txnDate + netDays; discount when paid within discountDays of txnDate.
 *  Date-driven:  due on `dueDayOfMonth` of the transaction's month — or the following month when
 *                the transaction is dated within `dueNextMonthWithinDays` days of (or after) that
 *                day; discount when paid on/before the first `discountDayOfMonth` on/after the
 *                transaction date (never later than the due date).
 *
 * Dates are calendar days: computed on UTC components and returned as UTC midnight, matching how
 * the rest of the app stores document dates (`new Date('2025-01-15')`). Day-of-month values past
 * the end of a month clamp to its last day (31 → Feb 28/29).
 */
import Decimal from 'decimal.js';

export interface TermsLike {
  kind: string; // 'standard' | 'date_driven'
  netDays?: number | null;
  discountPercent?: string | number | null;
  discountDays?: number | null;
  dueDayOfMonth?: number | null;
  dueNextMonthWithinDays?: number | null;
  discountDayOfMonth?: number | null;
}

const DAY_MS = 86_400_000;

/** Calendar day (UTC midnight) of a date. */
export function calendarDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(calendarDay(d).getTime() + days * DAY_MS);
}

function dayInMonth(year: number, month: number, day: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last)));
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((calendarDay(b).getTime() - calendarDay(a).getTime()) / DAY_MS);
}

/** Due date for a transaction dated `txnDate` under `terms`. */
export function computeDueDate(terms: TermsLike, txnDate: Date): Date {
  const txn = calendarDay(txnDate);
  if (terms.kind === 'date_driven') {
    const dueDay = terms.dueDayOfMonth ?? 1;
    const within = Math.max(0, terms.dueNextMonthWithinDays ?? 0);
    let y = txn.getUTCFullYear();
    let m = txn.getUTCMonth();
    let due = dayInMonth(y, m, dueDay);
    // Issued after the due day, or too close to it → due the next month (loop guards short months).
    for (let i = 0; i < 3 && daysBetween(txn, due) < within; i++) {
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      due = dayInMonth(y, m, dueDay);
    }
    if (daysBetween(txn, due) < 0) {
      // within = 0 and the due day already passed this month.
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      due = dayInMonth(y, m, dueDay);
    }
    return due;
  }
  return addDays(txn, Math.max(0, terms.netDays ?? 0));
}

export interface DiscountResult {
  /** Paid in time for the early-payment discount. */
  eligible: boolean;
  /** Discount percent offered by the terms ('0' when none). */
  percent: string;
  /** Last day the discount applies (null when the terms carry no discount). */
  discountDate: Date | null;
  /** Discount on `amount` when eligible (2dp), else '0.00'. Present only when an amount was given. */
  amount?: string;
}

/** Last day an early-payment discount applies, or null when the terms have no discount. */
export function computeDiscountDate(terms: TermsLike, txnDate: Date): Date | null {
  const pct = new Decimal(terms.discountPercent ?? 0);
  if (pct.lte(0)) return null;
  const txn = calendarDay(txnDate);
  if (terms.kind === 'date_driven') {
    if (!terms.discountDayOfMonth) return null;
    let y = txn.getUTCFullYear();
    let m = txn.getUTCMonth();
    let d = dayInMonth(y, m, terms.discountDayOfMonth);
    if (daysBetween(txn, d) < 0) {
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      d = dayInMonth(y, m, terms.discountDayOfMonth);
    }
    const due = computeDueDate(terms, txn);
    return d.getTime() > due.getTime() ? due : d;
  }
  if (terms.discountDays == null) return null;
  return addDays(txn, Math.max(0, terms.discountDays));
}

/**
 * Early-payment discount for a payment made on `payDate` against a transaction dated `txnDate`.
 * Pass `amount` (the open balance the discount applies to) to get the discount amount.
 */
export function computeDiscount(
  terms: TermsLike,
  txnDate: Date,
  payDate: Date,
  amount?: string | number | null,
): DiscountResult {
  const pct = new Decimal(terms.discountPercent ?? 0);
  const discountDate = computeDiscountDate(terms, txnDate);
  const eligible = !!discountDate && calendarDay(payDate).getTime() <= discountDate.getTime();
  const result: DiscountResult = {
    eligible,
    percent: discountDate ? pct.toString() : '0',
    discountDate,
  };
  if (amount !== undefined && amount !== null) {
    result.amount = eligible
      ? new Decimal(amount).times(pct).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : '0.00';
  }
  return result;
}

/** Plain-language description, e.g. "2% 10, Net 30" or "Due on the 15th (next month if within 5 days)". */
export function describeTerms(terms: TermsLike): string {
  const pct = new Decimal(terms.discountPercent ?? 0);
  const ord = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  if (terms.kind === 'date_driven') {
    let out = `Due on the ${ord(terms.dueDayOfMonth ?? 1)} of the month`;
    if (terms.dueNextMonthWithinDays) out += ` (next month if issued within ${terms.dueNextMonthWithinDays} days)`;
    if (pct.gt(0) && terms.discountDayOfMonth) out += `; ${pct.toString()}% off if paid by the ${ord(terms.discountDayOfMonth)}`;
    return out;
  }
  const net = terms.netDays ?? 0;
  const base = net === 0 ? 'Due on receipt' : `Net ${net}`;
  if (pct.gt(0) && terms.discountDays != null) return `${pct.toString()}% ${terms.discountDays}, ${base}`;
  return base;
}
