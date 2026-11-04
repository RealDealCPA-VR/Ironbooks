/**
 * Loan Manager (QB "Loan Manager", wave2 F1).
 *
 * A loan is tracked against a LIABILITY account (e.g. "2600 Truck Loan"). Setting up a loan does
 * not post anything — the loan proceeds are recorded the normal way (deposit / journal entry),
 * exactly like QB. The Loan Manager then:
 *   - computes the payment and the amortization schedule (principal vs interest, plus escrow),
 *   - "Set up payment" writes the NEXT payment as a check (Write Checks) or a bill (Enter Bills)
 *     whose lines split the payment:
 *         Dr  loan liability     principal
 *         Dr  interest expense   interest
 *         Dr  escrow account     escrow        (optional)
 *         Cr  bank (check)  or  A/P (bill)     total
 *     The document is created through createExpense / createBill, so it posts through
 *     postJournalEntry like any other check or bill (balanced, closing-date checked, audited).
 *
 * p1 fx — foreign-currency loans: a loan is in its lender's currency (or a stated currency). The
 * schedule and loan_payments are kept in that currency; `exchangeRate` is the rate the loan was
 * booked at (home units per 1 unit). A payment is written as a check from a bank account in the
 * loan's currency (or a bill to the lender) and converted at the payment's rate; the principal is
 * taken off the liability at the BOOKED rate, so the difference is posted as a realized exchange
 * gain/loss (sourceRef loan:<id>, stored on loan_payments.fx_entry_id). Voiding the payment
 * through voidLoanPayment voids that entry too.
 *
 * The remaining balance is derived from the payments whose check/bill is NOT void, so voiding a
 * loan payment's check automatically puts that principal back on the schedule.
 */
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { accounts, bills, expenses, journalEntries, journalEntryLines, loanPayments, loans, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { createExpense, voidExpense } from './expenses';
import { requirePermission } from './access';
import { companyToday } from './salesDates';
import { createBill, voidBill } from './bills';
import { homeAmounts } from './currencies';
import { effectiveHomeCurrency } from './multiCurrency';
import { postJournalEntry, voidJournalEntry } from './posting';
import { currencyRate, exchangeGainLossLine, foreignCode, toHome } from './exchangeRates';
import { subledgerAccountReason } from '@/lib/registerEntryPlan';
import { isBankAccount } from '@/lib/accountTypes';

export const PAYMENT_FREQUENCIES: Record<number, string> = {
  1: 'Annually',
  2: 'Semi-annually',
  4: 'Quarterly',
  12: 'Monthly',
  24: 'Semi-monthly',
  26: 'Every two weeks',
  52: 'Weekly',
};

export interface LoanInput {
  name: string;
  lenderVendorId?: string | null;
  liabilityAccountId: string;
  interestAccountId: string;
  escrowAccountId?: string | null;
  paymentAccountId?: string | null;
  originalAmount: string | number;
  /** Annual interest rate in percent (6.5 = 6.5%). */
  annualRate: string | number;
  termMonths: number;
  paymentsPerYear?: number;
  originDate: Date;
  firstPaymentDate: Date;
  escrowAmount?: string | number | null;
  notes?: string | null;
  /** p1 fx: loan currency (default: the lender's currency) and the rate it was booked at. */
  currency?: string | null;
  exchangeRate?: string | number | null;
  /** QB "Balloon Payment": paid with the last payment (blank = none). */
  balloonAmount?: string | number | null;
  /** QB "Compounding Period": 'monthly' (per payment period, default) or 'exact_days'. */
  compounding?: LoanCompounding | null;
  /** Exact-days compounding: days in the interest year, 365 (default) or 360. */
  dayCount?: number | null;
  /** QB "Payment Amount" the lender set (principal + interest); blank = worked out from the terms. */
  paymentAmount?: string | number | null;
  /**
   * Loan in progress (QB "Next Payment Number" / "Due Date of Next Payment"): the first payment
   * the Loan Manager tracks and its due date. The balance owed comes from the loan's liability
   * account. Default: payment 1 on the first payment date.
   */
  nextPaymentNumber?: number | null;
  nextPaymentDate?: Date | null;
}

export interface ScheduleRow {
  number: number;
  date: Date;
  payment: string;
  principal: string;
  interest: string;
  escrow: string;
  total: string;
  balance: string;
}

// ---------------------------------------------------------------------------
// Pure amortization math
// ---------------------------------------------------------------------------

/**
 * How interest is worked out for each payment (QB Loan Manager "Compounding Period"):
 *  - 'monthly'    — per payment period: balance x annual rate / payments per year;
 *  - 'exact_days' — on the days since the previous payment (or since the loan date for the first
 *                   one): balance x annual rate x days / dayCount (365, or 360 for a bank year).
 */
export type LoanCompounding = 'monthly' | 'exact_days';
export const LOAN_COMPOUNDING: LoanCompounding[] = ['monthly', 'exact_days'];
export const LOAN_DAY_COUNTS = [365, 360] as const;

export function numberOfPayments(termMonths: number, paymentsPerYear: number): number {
  return Math.max(1, Math.round((termMonths * paymentsPerYear) / 12));
}

/**
 * Level periodic payment (principal + interest), rounded to the cent. With a balloon the level
 * payment pays the loan down to the balloon, which is paid with the last payment:
 * payment = (P - B / (1 + r)^n) x r / (1 - (1 + r)^-n).
 */
export function periodicPayment(
  principal: string | number | Decimal,
  annualRatePercent: string | number | Decimal,
  n: number,
  paymentsPerYear: number,
  balloon?: string | number | Decimal | null,
): Decimal {
  const p = Money.of(principal);
  const b = Money.of(balloon ?? 0);
  const r = Money.of(annualRatePercent).dividedBy(100).dividedBy(paymentsPerYear);
  if (r.isZero()) return Money.round2(p.minus(b).dividedBy(n));
  const discount = Money.of(1).plus(r).pow(-n);
  const factor = Money.of(1).minus(discount);
  return Money.round2(p.minus(b.times(discount)).times(r).dividedBy(factor));
}

/** Add whole months, clamping to the last day of the target month (Jan 31 + 1 month = Feb 28/29). */
function addMonthsClamped(base: Date, months: number): Date {
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(base.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(y, m, day, base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds()),
  );
}

/**
 * Date of payment #k (1-based) given the first payment date and frequency. `k` may be 0 or less
 * (the period before the first payment), which a loan in progress needs.
 */
export function paymentDate(first: Date, k: number, paymentsPerYear: number): Date {
  const i = k - 1; // periods after the first payment
  if (12 % paymentsPerYear === 0) {
    return addMonthsClamped(first, i * (12 / paymentsPerYear));
  }
  if (paymentsPerYear === 24) {
    // semi-monthly: alternate the 1st/16th-style half-month steps
    const d = addMonthsClamped(first, Math.floor(i / 2));
    if (((i % 2) + 2) % 2 === 1) d.setUTCDate(d.getUTCDate() + 15);
    return d;
  }
  const d = new Date(first);
  d.setUTCDate(d.getUTCDate() + i * Math.round(364 / paymentsPerYear));
  return d;
}

export interface LoanScheduleParams {
  /** Balance still owed before payment `nextNumber`. */
  balance: string | number | Decimal;
  annualRate: string | number | Decimal;
  paymentsPerYear: number;
  totalPayments: number;
  nextNumber: number;
  /** Date of payment #1 (used when no `anchor` is given). */
  firstPaymentDate: Date;
  /** Principal + interest per payment (the level payment, or the lender's payment amount). */
  payment: string | number | Decimal;
  escrow?: string | number | Decimal | null;
  /** Default 'monthly' (per payment period). */
  compounding?: LoanCompounding | string | null;
  /** Days in the interest year for exact-days compounding (default 365). */
  dayCount?: number | null;
  /** The loan date: interest on payment #1 runs from it (exact days). */
  originDate?: Date | null;
  /** Loan in progress: payment `number` falls due on `date`; the other dates follow from it. */
  anchor?: { number: number; date: Date } | null;
  /** What-if: extra principal paid with every payment. */
  extraPrincipal?: string | number | Decimal | null;
}

/** Due date of payment #k under the schedule's anchor (or its first payment date). */
export function scheduleDate(p: Pick<LoanScheduleParams, 'firstPaymentDate' | 'paymentsPerYear' | 'anchor'>, k: number): Date {
  if (p.anchor) return paymentDate(p.anchor.date, k - p.anchor.number + 1, p.paymentsPerYear);
  return paymentDate(p.firstPaymentDate, k, p.paymentsPerYear);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole calendar days from `a` to `b` (UTC dates; never negative). */
function daysBetween(a: Date, b: Date): number {
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.max(0, Math.round((db - da) / DAY_MS));
}

/** Interest charged with payment #k on `balance` (see LoanCompounding). */
export function periodInterest(p: LoanScheduleParams, balance: Decimal, k: number): Decimal {
  const annual = Money.of(p.annualRate).dividedBy(100);
  if (p.compounding === 'exact_days') {
    const start = k === 1 && p.originDate ? p.originDate : scheduleDate(p, k - 1);
    const days = daysBetween(start, scheduleDate(p, k));
    const dayCount = p.dayCount && p.dayCount > 0 ? p.dayCount : 365;
    return Money.round2(balance.times(annual).times(days).dividedBy(dayCount));
  }
  return Money.round2(balance.times(annual.dividedBy(p.paymentsPerYear)));
}

/**
 * Amortization schedule from the CURRENT position: `balance` still owed, the next payment
 * number, the level payment. The last payment (number totalPayments — with a balloon, the
 * balloon too) or any payment that would overshoot takes exactly the remaining balance, so the
 * schedule always ends at 0.00.
 */
export function amortizationSchedule(params: LoanScheduleParams): ScheduleRow[] {
  const pay = Money.of(params.payment);
  const extra = Money.round2(params.extraPrincipal ?? 0);
  const escrow = Money.round2(params.escrow ?? 0);
  let bal = Money.round2(params.balance);
  const rows: ScheduleRow[] = [];
  // Allow a few extra rows beyond the nominal term if payments were short (never infinite).
  const maxNumber = Math.max(params.totalPayments, params.nextNumber) + 600;
  for (let k = params.nextNumber; bal.greaterThan(0) && k <= maxNumber; k++) {
    const interest = periodInterest(params, bal, k);
    let principal = pay.minus(interest).plus(extra);
    const isLast = k >= params.totalPayments;
    if (isLast || principal.greaterThan(bal)) principal = bal;
    if (principal.isNegative()) principal = Money.zero();
    principal = Money.round2(principal);
    bal = Money.round2(bal.minus(principal));
    const p_i = principal.plus(interest);
    rows.push({
      number: k,
      date: scheduleDate(params, k),
      payment: toAmountString(p_i),
      principal: toAmountString(principal),
      interest: toAmountString(interest),
      escrow: toAmountString(escrow),
      total: toAmountString(p_i.plus(escrow)),
      balance: toAmountString(bal),
    });
    if (principal.isZero() && !isLast) break; // payment does not even cover interest: stop
  }
  return rows;
}

/** Totals of a schedule: what is left to pay and when the loan is paid off. */
export interface ScheduleTotals {
  payments: number;
  principal: string;
  interest: string;
  escrow: string;
  total: string;
  payoffDate: Date | null;
}

export function scheduleTotals(rows: ReadonlyArray<ScheduleRow>): ScheduleTotals {
  const sum = (k: 'principal' | 'interest' | 'escrow' | 'total') =>
    toAmountString(rows.reduce((s, r) => s.plus(Money.of(r[k])), Money.zero()));
  return {
    payments: rows.length,
    principal: sum('principal'),
    interest: sum('interest'),
    escrow: sum('escrow'),
    total: sum('total'),
    payoffDate: rows.length ? rows[rows.length - 1].date : null,
  };
}

/** The loan terms the schedule is built from (a loans row, or terms typed for a new loan). */
export interface LoanTerms {
  originalAmount: string | number;
  annualRate: string | number;
  termMonths: number;
  paymentsPerYear: number;
  originDate: Date;
  firstPaymentDate: Date;
  escrowAmount?: string | number | null;
  balloonAmount?: string | number | null;
  compounding?: string | null;
  dayCount?: number | null;
  /** The lender's payment (principal + interest); null = the level payment. */
  paymentAmount?: string | number | null;
  /** Loan in progress: the first payment the Loan Manager tracks, and its due date. */
  scheduleStartNumber?: number | null;
  scheduleStartDate?: Date | null;
}

/** Principal + interest per payment: the lender's amount, else the level payment (balloon included). */
export function loanPaymentAmount(t: LoanTerms): Decimal {
  if (t.paymentAmount != null && String(t.paymentAmount).trim() !== '' && Money.of(t.paymentAmount).greaterThan(0)) {
    return Money.round2(t.paymentAmount);
  }
  return periodicPayment(t.originalAmount, t.annualRate, numberOfPayments(t.termMonths, t.paymentsPerYear), t.paymentsPerYear, t.balloonAmount);
}

/** Schedule parameters of a loan's terms, before payment `nextNumber` with `balance` owed. */
export function loanScheduleParams(t: LoanTerms, position: { balance: string | number | Decimal; nextNumber: number }): LoanScheduleParams {
  const start = Math.max(1, t.scheduleStartNumber ?? 1);
  return {
    balance: position.balance,
    annualRate: t.annualRate,
    paymentsPerYear: t.paymentsPerYear,
    totalPayments: numberOfPayments(t.termMonths, t.paymentsPerYear),
    nextNumber: position.nextNumber,
    firstPaymentDate: t.firstPaymentDate,
    payment: loanPaymentAmount(t),
    escrow: t.escrowAmount ?? 0,
    compounding: t.compounding === 'exact_days' ? 'exact_days' : 'monthly',
    dayCount: t.dayCount ?? 365,
    originDate: t.originDate,
    anchor: t.scheduleStartDate ? { number: start, date: t.scheduleStartDate } : null,
  };
}

/**
 * The balance owed before payment `number` on the loan's own schedule (from the original
 * amount). For a loan in progress this is what the earlier payments left, as the Loan Manager
 * would have tracked them.
 */
export function scheduledBalanceBefore(t: LoanTerms, number: number): Decimal {
  if (number <= 1) return Money.round2(t.originalAmount);
  const rows = amortizationSchedule(loanScheduleParams(t, { balance: t.originalAmount, nextNumber: 1 }));
  const row = rows.find((r) => r.number === number - 1);
  return row ? Money.of(row.balance) : Money.zero();
}

/** What-if changes (QB Loan Manager "What If Scenarios"). Blank = as the loan is now. */
export interface WhatIfChanges {
  /** A different interest rate (% per year). */
  annualRate?: string | number | null;
  /** A different payment (principal + interest) from now on. */
  paymentAmount?: string | number | null;
  /** A different term (months, from the loan date): the payment is worked out again. */
  termMonths?: number | null;
  /** A lump sum paid now, off the balance. */
  lumpSum?: string | number | null;
  /** Extra principal paid with every payment. */
  extraPrincipal?: string | number | null;
  /** A different balloon at the end. */
  balloonAmount?: string | number | null;
}

export interface WhatIfResult {
  payment: string;
  balance: string;
  totals: ScheduleTotals;
  schedule: ScheduleRow[];
}

/**
 * Run a what-if on a loan's position (balance owed before payment `nextNumber`). A new term or
 * rate recomputes the level payment over the payments that are left (unless a payment is given).
 */
export function whatIfSchedule(
  t: LoanTerms,
  position: { balance: string | number | Decimal; nextNumber: number },
  changes: WhatIfChanges = {},
): WhatIfResult {
  const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
  const rate = has(changes.annualRate) ? Money.of(changes.annualRate!) : Money.of(t.annualRate);
  const term = has(changes.termMonths) ? Number(changes.termMonths) : t.termMonths;
  const balloon = has(changes.balloonAmount) ? Money.of(changes.balloonAmount!) : Money.of(t.balloonAmount ?? 0);
  let balance = Money.round2(position.balance);
  if (has(changes.lumpSum)) balance = Money.round2(Decimal.max(Money.zero(), balance.minus(Money.of(changes.lumpSum!))));
  const totalPayments = numberOfPayments(term, t.paymentsPerYear);
  const left = Math.max(1, totalPayments - position.nextNumber + 1);
  const termsChanged = has(changes.annualRate) || has(changes.termMonths) || has(changes.balloonAmount);
  const payment = has(changes.paymentAmount)
    ? Money.round2(changes.paymentAmount!)
    : termsChanged
      ? periodicPayment(balance, rate, left, t.paymentsPerYear, balloon)
      : loanPaymentAmount(t);
  // A payment typed for the what-if has to pay the loan down: below the interest the schedule
  // stopped after one payment and read as a big saving although the loan never gets paid off.
  if (has(changes.paymentAmount)) {
    assertPaymentCoversInterest(balance, rate, t.paymentsPerYear, payment, has(changes.extraPrincipal) ? Money.of(changes.extraPrincipal!) : null);
  }
  const params: LoanScheduleParams = {
    ...loanScheduleParams({ ...t, annualRate: rate.toString(), termMonths: term, balloonAmount: balloon.toString() }, {
      balance,
      nextNumber: position.nextNumber,
    }),
    payment,
    extraPrincipal: has(changes.extraPrincipal) ? Money.of(changes.extraPrincipal!) : null,
  };
  const schedule = amortizationSchedule(params);
  return { payment: toAmountString(payment), balance: toAmountString(balance), totals: scheduleTotals(schedule), schedule };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * A payment (plus any extra principal) has to be more than the first period's interest on the
 * balance owed, or the loan is never paid off (the Loan Manager setup refuses it the same way).
 */
function assertPaymentCoversInterest(
  balance: Decimal,
  annualRate: Decimal,
  paymentsPerYear: number,
  payment: Decimal,
  extraPrincipal: Decimal | null = null,
) {
  if (!balance.greaterThan(0)) return;
  const firstInterest = Money.round2(balance.times(annualRate).dividedBy(100).dividedBy(paymentsPerYear));
  if (!payment.plus(extraPrincipal ?? 0).greaterThan(firstInterest)) {
    throw validation(
      `A payment of ${toAmountString(payment)} does not cover the interest (${toAmountString(firstInterest)} a payment), so the loan would never be paid off.`,
    );
  }
}

async function accountOf(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
  if (!row) throw notFound('Account');
  return row;
}

async function validateLoanInput(
  ctx: ServiceContext,
  input: LoanInput,
  existing?: { currency: string | null; exchangeRate: string | null },
) {
  if (!input.name?.trim()) throw validation('Give the loan a name.');
  const amount = Money.of(input.originalAmount);
  if (!amount.greaterThan(0)) throw validation('The loan amount must be greater than zero.');
  const rate = Money.of(input.annualRate);
  if (rate.isNegative() || rate.greaterThan(100)) throw validation('The interest rate must be between 0 and 100%.');
  if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 600) {
    throw validation('The loan term must be between 1 and 600 months.');
  }
  const ppy = input.paymentsPerYear ?? 12;
  if (!PAYMENT_FREQUENCIES[ppy]) throw validation('Choose a payment frequency from the list.');
  const liab = await accountOf(ctx, input.liabilityAccountId);
  if (liab.type !== 'liability') throw validation('The loan account must be a liability account (e.g. Notes Payable).');
  const intr = await accountOf(ctx, input.interestAccountId);
  if (intr.type !== 'expense') throw validation('The interest account must be an expense account (e.g. Interest Expense).');
  if (input.escrowAccountId) {
    // Each payment debits the escrow account on its check / bill line. Undeposited Funds or an
    // inventory asset account there moved a balance that Make Deposits / the inventory valuation
    // can never show; A/R or A/P was refused only when the payment was set up.
    const esc = await accountOf(ctx, input.escrowAccountId);
    const reason =
      subledgerAccountReason(esc) ??
      (esc.subtype === 'accounts_receivable' || esc.subtype === 'accounts_payable'
        ? `"${esc.name}" needs a customer or vendor on every amount, so it can't be the escrow account.`
        : null);
    if (reason) throw validation(`${reason} Pick the escrow (or prepaid) account for the escrow part of each payment.`);
  }
  if (input.paymentAccountId) {
    // Each loan check is a Write Checks payment, which comes from a bank account. Any asset used
    // to be accepted here (Undeposited Funds, Inventory Asset, A/R), and then every payment set up
    // from the loan failed with "Checks ... must be paid from a bank/cash account".
    const pay = await accountOf(ctx, input.paymentAccountId);
    if (!isBankAccount(pay)) {
      throw validation(`"${pay.name}" is not a bank account. Loan payments must come from a checking or savings (bank) account.`);
    }
  }
  const escrow = Money.of(input.escrowAmount ?? 0);
  if (escrow.isNegative()) throw validation('Escrow cannot be negative.');
  // F1: balloon, compounding, the lender's payment amount and a loan already in progress.
  const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
  const balloon = blank(input.balloonAmount) ? null : Money.round2(input.balloonAmount!);
  if (balloon && (balloon.isNegative() || !balloon.lessThan(amount))) {
    throw validation('The balloon payment must be more than zero and less than the loan amount.');
  }
  const compounding: LoanCompounding = input.compounding ?? 'monthly';
  if (!LOAN_COMPOUNDING.includes(compounding)) throw validation("Compounding must be 'monthly' or 'exact_days'.");
  const dayCount = input.dayCount ?? 365;
  if (!(LOAN_DAY_COUNTS as readonly number[]).includes(dayCount)) throw validation('Days in the interest year must be 365 or 360.');
  const n = numberOfPayments(input.termMonths, ppy);
  const startNumber = input.nextPaymentNumber ?? 1;
  if (!Number.isInteger(startNumber) || startNumber < 1 || startNumber > n) {
    throw validation(`The next payment number must be between 1 and ${n} (the number of payments in the loan's term).`);
  }
  const startDate = input.nextPaymentDate ?? (startNumber > 1 ? paymentDate(input.firstPaymentDate, startNumber, ppy) : null);
  if (startDate && isNaN(new Date(startDate).getTime())) throw validation('Enter a valid due date for the next payment.');
  const paymentAmount = blank(input.paymentAmount) ? null : Money.round2(input.paymentAmount!);
  if (paymentAmount && !paymentAmount.greaterThan(0)) throw validation('The payment amount must be more than zero.');
  if (paymentAmount) {
    // The payment has to cover the first period's interest, or the loan never gets paid down.
    const firstInterest = Money.round2(amount.times(rate).dividedBy(100).dividedBy(ppy));
    if (!paymentAmount.greaterThan(firstInterest)) {
      throw validation(`A payment of ${toAmountString(paymentAmount)} does not cover the interest (${toAmountString(firstInterest)} a payment), so the loan would never be paid off.`);
    }
  }
  if (escrow.greaterThan(0) && !input.escrowAccountId) {
    throw validation('Pick an escrow account for the escrow part of each payment.');
  }
  let lenderCurrency: string | null = null;
  const home = await effectiveHomeCurrency(ctx); // review5 fx: also without a base row
  if (input.lenderVendorId) {
    const [v] = await ctx.db
      .select({ id: vendors.id, currency: vendors.currency })
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, input.lenderVendorId)));
    if (!v) throw notFound('Lender');
    lenderCurrency = foreignCode(v.currency, home);
  }
  // p1 fx: the loan's currency is the lender's (QB: a vendor's transactions are in its currency).
  const stated = input.currency !== undefined && input.currency !== null && String(input.currency).trim() !== ''
    ? foreignCode(input.currency, home)
    : undefined;
  const currency = stated !== undefined ? stated : lenderCurrency;
  if (input.lenderVendorId && currency !== lenderCurrency) {
    throw validation(
      `The lender uses ${lenderCurrency ?? home ?? 'your home currency'}, so the loan must be in ${lenderCurrency ?? home ?? 'your home currency'} too.`,
    );
  }
  // review5 fx: an edit that leaves the rate blank keeps the rate the loan was booked at (the
  // form's "Blank = list rate" is for a new loan). Taking today's list rate re-booked the loan:
  // its carrying value in Home Currency Adjustment and the realized gain / loss of every later
  // payment were then measured against a rate the liability was never posted at.
  const blankRate = input.exchangeRate == null || String(input.exchangeRate).trim() === '';
  const keptRate =
    blankRate && existing?.exchangeRate && currency && foreignCode(existing.currency, home) === currency
      ? existing.exchangeRate
      : input.exchangeRate;
  const fx = currency ? await currencyRate(ctx, currency, keptRate) : null;
  // The payment account's currency is checked when a payment is set up (assertLoanPaymentCurrency).
  return {
    amount,
    rate,
    ppy,
    escrow,
    currency,
    fxRate: fx ? fx.rate.toFixed(8) : null,
    balloon: balloon ? toAmountString(balloon) : null,
    compounding,
    dayCount,
    paymentAmount: paymentAmount ? toAmountString(paymentAmount) : null,
    startNumber,
    startDate: startDate ? new Date(startDate) : null,
  };
}

/** The F1 columns a create / edit writes. */
function termColumns(v: Awaited<ReturnType<typeof validateLoanInput>>) {
  return {
    balloonAmount: v.balloon,
    compounding: v.compounding,
    dayCount: v.dayCount,
    paymentAmount: v.paymentAmount,
    scheduleStartNumber: v.startNumber,
    scheduleStartDate: v.startDate,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createLoan(ctx: ServiceContext, input: LoanInput) {
  const v = await validateLoanInput(ctx, input);
  return inTransaction(ctx, async (tx) => {
    const [loan] = await tx.db
      .insert(loans)
      .values({
        companyId: tx.companyId,
        name: input.name.trim(),
        lenderVendorId: input.lenderVendorId ?? null,
        liabilityAccountId: input.liabilityAccountId,
        interestAccountId: input.interestAccountId,
        escrowAccountId: input.escrowAccountId ?? null,
        paymentAccountId: input.paymentAccountId ?? null,
        originalAmount: toAmountString(v.amount),
        annualRate: v.rate.toFixed(6),
        termMonths: input.termMonths,
        paymentsPerYear: v.ppy,
        originDate: input.originDate,
        firstPaymentDate: input.firstPaymentDate,
        escrowAmount: toAmountString(v.escrow),
        notes: input.notes ?? null,
        currency: v.currency,
        exchangeRate: v.fxRate,
        ...termColumns(v),
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'loan', entityId: loan.id, newValues: loan });
    return loan;
  });
}

export async function updateLoan(ctx: ServiceContext, id: string, input: LoanInput) {
  const [existing] = await ctx.db
    .select()
    .from(loans)
    .where(and(eq(loans.companyId, ctx.companyId), eq(loans.id, id)));
  if (!existing) throw notFound('Loan');
  // Fields an older form does not send keep what the loan has (null clears them).
  input = {
    ...input,
    balloonAmount: input.balloonAmount === undefined ? existing.balloonAmount : input.balloonAmount,
    compounding: input.compounding === undefined ? (existing.compounding as LoanCompounding) : input.compounding,
    dayCount: input.dayCount === undefined ? existing.dayCount : input.dayCount,
    paymentAmount: input.paymentAmount === undefined ? existing.paymentAmount : input.paymentAmount,
    nextPaymentNumber: input.nextPaymentNumber === undefined ? existing.scheduleStartNumber : input.nextPaymentNumber,
    nextPaymentDate: input.nextPaymentDate === undefined ? existing.scheduleStartDate : input.nextPaymentDate,
  };
  const v = await validateLoanInput(ctx, input, existing);
  // Payments already made through the Loan Manager carry their numbers: the loan's starting point
  // can't move under them.
  if (v.startNumber !== existing.scheduleStartNumber) {
    const made = (await paymentsFor(ctx, id)).filter((p) => p.active);
    if (made.length > 0) {
      throw new ServiceError(
        'CONFLICT',
        'Payments were already made on this loan in the Loan Manager, so its next payment number follows them and cannot be changed here.',
      );
    }
  }
  return inTransaction(ctx, async (tx) => {
    const [loan] = await tx.db
      .update(loans)
      .set({
        name: input.name.trim(),
        lenderVendorId: input.lenderVendorId ?? null,
        liabilityAccountId: input.liabilityAccountId,
        interestAccountId: input.interestAccountId,
        escrowAccountId: input.escrowAccountId ?? null,
        paymentAccountId: input.paymentAccountId ?? null,
        originalAmount: toAmountString(v.amount),
        annualRate: v.rate.toFixed(6),
        termMonths: input.termMonths,
        paymentsPerYear: v.ppy,
        originDate: input.originDate,
        firstPaymentDate: input.firstPaymentDate,
        escrowAmount: toAmountString(v.escrow),
        notes: input.notes ?? null,
        currency: v.currency,
        exchangeRate: v.fxRate,
        ...termColumns(v),
        updatedAt: new Date(),
      })
      .where(eq(loans.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'loan', entityId: id, oldValues: existing, newValues: loan });
    return loan;
  });
}

/** Remove a loan from the Loan Manager (its checks/bills stay on the books). */
export async function deactivateLoan(ctx: ServiceContext, id: string) {
  const [existing] = await ctx.db
    .select()
    .from(loans)
    .where(and(eq(loans.companyId, ctx.companyId), eq(loans.id, id)));
  if (!existing) throw notFound('Loan');
  return inTransaction(ctx, async (tx) => {
    const [loan] = await tx.db
      .update(loans)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(loans.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'loan', entityId: id, oldValues: { isActive: true }, newValues: { isActive: false } });
    return loan;
  });
}

// ---------------------------------------------------------------------------
// Reads: payments, summary, schedule
// ---------------------------------------------------------------------------

/** Loan payments with their check/bill status; `active` = document not void. */
async function paymentsFor(ctx: ServiceContext, loanId: string) {
  const rows = await ctx.db
    .select({
      payment: loanPayments,
      expenseVoidedAt: expenses.voidedAt,
      expenseRef: expenses.reference,
      billStatus: bills.status,
      billNumber: bills.billNumber,
    })
    .from(loanPayments)
    .leftJoin(expenses, eq(loanPayments.expenseId, expenses.id))
    .leftJoin(bills, eq(loanPayments.billId, bills.id))
    .where(and(eq(loanPayments.companyId, ctx.companyId), eq(loanPayments.loanId, loanId)))
    .orderBy(asc(loanPayments.paymentNumber), asc(loanPayments.createdAt));
  return rows.map((r) => ({
    ...r.payment,
    reference: r.payment.kind === 'check' ? (r.expenseRef ?? null) : (r.billNumber ?? null),
    active: r.payment.kind === 'check' ? !r.expenseVoidedAt : r.billStatus !== 'void',
  }));
}

/**
 * Where a loan's balance comes from (QB Loan Manager reads it from the loan's liability account):
 *  - 'account'  — the liability account's balance (credits - debits of its posted lines): the
 *                 proceeds or opening balance recorded there, less every payment, also the ones
 *                 written outside the Loan Manager;
 *  - 'schedule' — the Loan Manager's own figures (the amount at the first tracked payment less
 *                 its payments' principal) when the account can't tell this loan's balance.
 * `reason` says why: 'shared' (another loan uses the same account), 'currency' (a foreign
 * currency loan is tracked in its own currency) or 'not_recorded' (nothing was ever recorded in
 * the account — record the loan proceeds or its opening balance there).
 */
export type LoanBalanceSource =
  | { source: 'account'; balance: Decimal; reason: null }
  | { source: 'schedule'; balance: null; reason: 'shared' | 'currency' | 'not_recorded' };

async function liabilityAccountBalance(ctx: ServiceContext, loan: typeof loans.$inferSelect): Promise<LoanBalanceSource> {
  const others = await ctx.db
    .select({ id: loans.id })
    .from(loans)
    .where(
      and(
        eq(loans.companyId, ctx.companyId),
        eq(loans.liabilityAccountId, loan.liabilityAccountId),
        eq(loans.isActive, true),
        ne(loans.id, loan.id),
      ),
    )
    .limit(1);
  if (others.length > 0) return { source: 'schedule', balance: null, reason: 'shared' };
  const home = await effectiveHomeCurrency(ctx);
  const [acct] = await ctx.db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, loan.liabilityAccountId)));
  if (foreignCode(loan.currency ?? null, home) || foreignCode(acct?.currency ?? null, home)) {
    return { source: 'schedule', balance: null, reason: 'currency' };
  }
  const [row] = await ctx.db
    .select({
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, loan.liabilityAccountId),
      ),
    );
  const credit = Money.of(row?.credit ?? 0);
  if (!credit.greaterThan(0)) return { source: 'schedule', balance: null, reason: 'not_recorded' };
  return { source: 'account', balance: Money.round2(credit.minus(Money.of(row?.debit ?? 0))), reason: null };
}

export async function loanSummary(ctx: ServiceContext, loan: typeof loans.$inferSelect) {
  const payments = await paymentsFor(ctx, loan.id);
  const active = payments.filter((p) => p.active);
  const principalPaid = active.reduce((s, p) => s.plus(Money.of(p.principal)), Money.zero());
  const interestPaid = active.reduce((s, p) => s.plus(Money.of(p.interest)), Money.zero());
  const n = numberOfPayments(loan.termMonths, loan.paymentsPerYear);
  const payment = loanPaymentAmount(loan);
  // A loan added while it was already being paid starts at its next payment number (F1).
  const startNumber = Math.max(1, loan.scheduleStartNumber ?? 1);
  const nextNumber = active.length === 0 ? startNumber : Math.max(...active.map((p) => p.paymentNumber)) + 1;
  // The Loan Manager's own figure: the balance at the first tracked payment less its payments.
  const scheduleBalance = Money.round2(scheduledBalanceBefore(loan, startNumber).minus(principalPaid));
  const fromAccount = await liabilityAccountBalance(ctx, loan);
  const balance = fromAccount.source === 'account' ? fromAccount.balance : scheduleBalance;
  const schedule = amortizationSchedule(loanScheduleParams(loan, { balance: Decimal.max(balance, Money.zero()), nextNumber }));
  const totals = scheduleTotals(schedule);
  return {
    payments,
    numberOfPayments: n,
    payment: toAmountString(payment),
    balance: toAmountString(balance),
    /** 'account' (the liability account's balance) or 'schedule' (see LoanBalanceSource). */
    balanceSource: fromAccount.source,
    balanceReason: fromAccount.reason,
    /** What the Loan Manager's own payments leave (shown next to the account balance). */
    scheduleBalance: toAmountString(scheduleBalance),
    principalPaid: toAmountString(principalPaid),
    interestPaid: toAmountString(interestPaid),
    paymentsMade: active.length,
    nextNumber,
    next: schedule[0] ?? null,
    /** Interest still to pay, payments left and the payoff date on the current schedule. */
    remaining: totals,
    schedule,
  };
}

/**
 * QB Loan Manager "What If Scenarios" for a saved loan: the schedule as it is and with the
 * changes (another rate, payment, term or balloon, a lump sum now, extra principal each payment),
 * from the loan's current balance and next payment. Nothing is saved.
 */
export async function whatIfLoan(ctx: ServiceContext, id: string, changes: WhatIfChanges) {
  assertWhatIfChanges(changes);
  const loan = await getLoan(ctx, id);
  const position = { balance: Decimal.max(Money.of(loan.balance), Money.zero()), nextNumber: loan.nextNumber };
  if (changes.balloonAmount != null && String(changes.balloonAmount).trim() !== '') {
    const owed = position.balance.minus(Money.of(changes.lumpSum != null && String(changes.lumpSum).trim() !== '' ? changes.lumpSum : 0));
    if (!Money.of(changes.balloonAmount).lessThan(owed)) {
      throw validation(`The balloon payment must be less than the balance owed (${toAmountString(Decimal.max(owed, Money.zero()))}).`);
    }
  }
  const current = whatIfSchedule(loan, position);
  const scenario = whatIfSchedule(loan, position, changes);
  return {
    loanId: id,
    current,
    scenario,
    /** scenario - current: negative = the change saves interest / payments. */
    interestDifference: toAmountString(Money.of(scenario.totals.interest).minus(Money.of(current.totals.interest))),
    paymentsDifference: scenario.totals.payments - current.totals.payments,
  };
}

export interface EvaluateLoanInput {
  originalAmount: string | number;
  annualRate: string | number;
  termMonths: number;
  paymentsPerYear?: number;
  originDate: Date;
  firstPaymentDate: Date;
  balloonAmount?: string | number | null;
  compounding?: LoanCompounding | null;
  dayCount?: number | null;
  paymentAmount?: string | number | null;
  escrowAmount?: string | number | null;
}

/** QB Loan Manager "What If" for a new loan: its payment, total interest and payoff date. */
export function evaluateLoan(input: EvaluateLoanInput): WhatIfResult {
  const amount = Money.of(input.originalAmount);
  if (!amount.greaterThan(0)) throw validation('The loan amount must be greater than zero.');
  const rate = Money.of(input.annualRate);
  if (rate.isNegative() || rate.greaterThan(100)) throw validation('The interest rate must be between 0 and 100%.');
  if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 600) {
    throw validation('The loan term must be between 1 and 600 months.');
  }
  const ppy = input.paymentsPerYear ?? 12;
  if (!PAYMENT_FREQUENCIES[ppy]) throw validation('Choose a payment frequency from the list.');
  const balloon = Money.of(input.balloonAmount ?? 0);
  if (balloon.isNegative() || (balloon.greaterThan(0) && !balloon.lessThan(amount))) {
    throw validation('The balloon payment must be more than zero and less than the loan amount.');
  }
  if (input.compounding && !LOAN_COMPOUNDING.includes(input.compounding)) {
    throw validation("Compounding must be 'monthly' or 'exact_days'.");
  }
  if (input.dayCount != null && !(LOAN_DAY_COUNTS as readonly number[]).includes(input.dayCount)) {
    throw validation('Days in the interest year must be 365 or 360.');
  }
  const terms: LoanTerms = { ...input, paymentsPerYear: ppy };
  if (input.paymentAmount != null && String(input.paymentAmount).trim() !== '') {
    const payment = Money.round2(input.paymentAmount);
    if (!payment.greaterThan(0)) throw validation('The payment amount must be more than zero.');
    assertPaymentCoversInterest(amount, rate, ppy, payment);
  }
  return whatIfSchedule(terms, { balance: amount, nextNumber: 1 });
}

function assertWhatIfChanges(c: WhatIfChanges) {
  const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
  const money = (v: unknown, what: string, allowZero = false) => {
    if (blank(v)) return;
    const m = Money.of(v as string);
    if (m.isNegative() || (!allowZero && m.isZero())) throw validation(`${what} must be more than zero.`);
  };
  money(c.annualRate, 'The interest rate', true);
  if (!blank(c.annualRate) && Money.of(c.annualRate!).greaterThan(100)) {
    throw validation('The interest rate must be between 0 and 100%.');
  }
  money(c.paymentAmount, 'The payment');
  money(c.lumpSum, 'The lump sum');
  money(c.extraPrincipal, 'The extra principal');
  money(c.balloonAmount, 'The balloon payment', true);
  if (c.termMonths != null && (!Number.isInteger(c.termMonths) || c.termMonths < 1 || c.termMonths > 600)) {
    throw validation('The loan term must be between 1 and 600 months.');
  }
}

export async function listLoans(ctx: ServiceContext, opts?: { includeInactive?: boolean }) {
  const rows = await ctx.db
    .select({ loan: loans, lenderName: vendors.displayName, accountName: accounts.name, accountBalance: accounts.balance })
    .from(loans)
    .leftJoin(vendors, eq(loans.lenderVendorId, vendors.id))
    .leftJoin(accounts, eq(loans.liabilityAccountId, accounts.id))
    .where(
      and(eq(loans.companyId, ctx.companyId), ...(opts?.includeInactive ? [] : [eq(loans.isActive, true)])),
    )
    .orderBy(desc(loans.createdAt));
  const out = [];
  for (const r of rows) {
    const s = await loanSummary(ctx, r.loan);
    out.push({
      ...r.loan,
      lenderName: r.lenderName ?? null,
      liabilityAccountName: r.accountName ?? null,
      liabilityAccountBalance: r.accountBalance ?? null,
      payment: s.payment,
      balance: s.balance,
      paymentsMade: s.paymentsMade,
      numberOfPayments: s.numberOfPayments,
      next: s.next,
    });
  }
  return out;
}

export async function getLoan(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select({ loan: loans, lenderName: vendors.displayName })
    .from(loans)
    .leftJoin(vendors, eq(loans.lenderVendorId, vendors.id))
    .where(and(eq(loans.companyId, ctx.companyId), eq(loans.id, id)));
  if (!row) throw notFound('Loan');
  const s = await loanSummary(ctx, row.loan);
  return { ...row.loan, lenderName: row.lenderName ?? null, ...s };
}

// ---------------------------------------------------------------------------
// Set up payment
// ---------------------------------------------------------------------------

export interface SetUpPaymentInput {
  /** 'check' writes a check now; 'bill' enters a bill to pay later. */
  kind: 'check' | 'bill';
  /** Defaults to the scheduled date of the next payment. */
  date?: Date | null;
  /** Bank account for a check (defaults to the loan's payment account). */
  paymentAccountId?: string | null;
  /** Override the scheduled split (e.g. extra principal). */
  principal?: string | number | null;
  interest?: string | number | null;
  escrow?: string | number | null;
  /** Check number / bill number. */
  reference?: string | null;
  toPrint?: boolean;
  memo?: string | null;
  dueDate?: Date | null;
  /** p1 fx: foreign loan — home units per 1 unit on the payment date (default: the list rate). */
  exchangeRate?: string | number | null;
}

/**
 * Create the next loan payment as a check or a bill, split between principal (loan liability),
 * interest (expense) and escrow, and record it on the loan — all in one transaction.
 */
/**
 * Loan payments are kept in home currency (the schedule, loan_payments and the liability all
 * agree). Refuse a foreign-currency lender or payment account rather than post converted amounts.
 */
async function assertLoanPaymentCurrency(
  ctx: ServiceContext,
  loanCurrency: string | null,
  refs: { lenderVendorId: string | null; paymentAccountId: string | null },
) {
  const home = await effectiveHomeCurrency(ctx); // review5 fx: also without a base row
  const loanLabel = loanCurrency ?? home ?? 'your home currency';
  if (refs.lenderVendorId) {
    const [v] = await ctx.db
      .select({ currency: vendors.currency })
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, refs.lenderVendorId)));
    const cur = foreignCode(v?.currency ?? null, home);
    if (cur !== loanCurrency) {
      throw validation(
        `This loan is in ${loanLabel} but its lender uses ${cur ?? 'your home currency'}. Edit the loan so both use the same currency.`,
      );
    }
  }
  if (refs.paymentAccountId) {
    const [a] = await ctx.db
      .select({ currency: accounts.currency, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, refs.paymentAccountId)));
    const cur = foreignCode(a?.currency ?? null, home);
    if (cur !== loanCurrency) {
      throw validation(
        `This loan is in ${loanLabel}, so its payments must come from a ${loanCurrency ?? 'home-currency'} bank account. "${a?.name ?? 'That account'}" uses ${cur ?? 'your home currency'}.`,
      );
    }
  }
}

/**
 * p1 fx: a loan payment whose check / bill was voided outside the Loan Manager leaves its realized
 * exchange gain/loss entry behind — void those (called before every new payment and by HCA).
 */
export async function voidOrphanLoanFx(ctx: ServiceContext, loanId?: string): Promise<number> {
  const rows = await ctx.db
    .select({
      id: loanPayments.id,
      fxEntryId: loanPayments.fxEntryId,
      kind: loanPayments.kind,
      expenseVoidedAt: expenses.voidedAt,
      billStatus: bills.status,
      entryStatus: journalEntries.status,
    })
    .from(loanPayments)
    .leftJoin(expenses, eq(loanPayments.expenseId, expenses.id))
    .leftJoin(bills, eq(loanPayments.billId, bills.id))
    .innerJoin(journalEntries, eq(loanPayments.fxEntryId, journalEntries.id))
    .where(and(eq(loanPayments.companyId, ctx.companyId), ...(loanId ? [eq(loanPayments.loanId, loanId)] : [])));
  let n = 0;
  for (const r of rows) {
    const docVoid = r.kind === 'check' ? !!r.expenseVoidedAt : r.billStatus === 'void';
    if (docVoid && r.entryStatus === 'posted' && r.fxEntryId) {
      await voidJournalEntry(ctx, r.fxEntryId);
      n += 1;
    }
  }
  return n;
}

/** Void a Loan Manager payment: its check or bill and its exchange gain/loss entry together. */
export async function voidLoanPayment(ctx: ServiceContext, loanId: string, paymentId: string) {
  const [lp] = await ctx.db
    .select()
    .from(loanPayments)
    .where(and(eq(loanPayments.companyId, ctx.companyId), eq(loanPayments.loanId, loanId), eq(loanPayments.id, paymentId)));
  if (!lp) throw notFound('Loan payment');
  // Voiding a payment entered as a bill voids that bill (A/P).
  if (lp.kind === 'bill') requirePermission(ctx, 'vendors.bills', 'delete');
  return inTransaction(ctx, async (tx) => {
    if (lp.kind === 'check' && lp.expenseId) await voidExpense(tx, lp.expenseId);
    if (lp.kind === 'bill' && lp.billId) await voidBill(tx, lp.billId);
    if (lp.fxEntryId) {
      const [e] = await tx.db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, lp.fxEntryId));
      if (e?.status === 'posted') await voidJournalEntry(tx, lp.fxEntryId);
    }
    await writeAudit(tx, {
      action: 'void',
      entityType: 'loan_payment',
      entityId: lp.id,
      oldValues: { loanId, paymentNumber: lp.paymentNumber, total: lp.total },
      newValues: { voided: true },
    });
    return lp;
  });
}

export async function setUpLoanPayment(ctx: ServiceContext, loanId: string, input: SetUpPaymentInput) {
  // The Loan Manager is a Banking screen, but a payment entered as a bill is an Enter Bills
  // transaction (A/P): it needs the Vendors & Payables permission, like Enter Bills itself.
  if (input.kind === 'bill') requirePermission(ctx, 'vendors.bills', 'create');
  // Load the balance / next payment in the same transaction as the payment: a double-submitted
  // payment must see the first one (no second payment #N, no principal beyond what is owed).
  return inTransaction(ctx, (tx) => setUpLoanPaymentInTx(tx, loanId, input));
}

async function setUpLoanPaymentInTx(ctx: ServiceContext, loanId: string, input: SetUpPaymentInput) {
  const loan = await getLoan(ctx, loanId);
  if (!loan.isActive) throw new ServiceError('CONFLICT', 'This loan is no longer in the Loan Manager.');
  const next = loan.next;
  if (!next && input.principal == null) {
    throw new ServiceError('CONFLICT', 'This loan is paid off — there is no next payment.');
  }
  const principal = Money.round2(input.principal ?? next?.principal ?? 0);
  const interest = Money.round2(input.interest ?? next?.interest ?? 0);
  const escrow = Money.round2(input.escrow ?? next?.escrow ?? loan.escrowAmount ?? 0);
  if (principal.isNegative() || interest.isNegative() || escrow.isNegative()) {
    throw validation('Principal, interest and escrow cannot be negative.');
  }
  if (principal.greaterThan(Money.of(loan.balance))) {
    throw validation(`Principal ${toAmountString(principal)} is more than the ${loan.balance} still owed on this loan.`);
  }
  const total = principal.plus(interest).plus(escrow);
  if (!total.greaterThan(0)) throw validation('The payment total must be greater than zero.');
  if (escrow.greaterThan(0) && !loan.escrowAccountId) {
    throw validation('This loan has no escrow account. Edit the loan and pick one first.');
  }
  // Default: the scheduled due date (else today in the company's calendar, not the UTC day).
  const date = input.date ?? next?.date ?? (await companyToday(ctx));
  const number = next?.number ?? loan.nextNumber;
  const memo = input.memo ?? `${loan.name} — payment ${number}`;

  const accountLines: Array<{ accountId: string; amount: string; description: string }> = [];
  if (principal.greaterThan(0)) {
    accountLines.push({ accountId: loan.liabilityAccountId, amount: toAmountString(principal), description: `Principal — ${loan.name}` });
  }
  if (interest.greaterThan(0)) {
    accountLines.push({ accountId: loan.interestAccountId, amount: toAmountString(interest), description: `Interest — ${loan.name}` });
  }
  if (escrow.greaterThan(0) && loan.escrowAccountId) {
    accountLines.push({ accountId: loan.escrowAccountId, amount: toAmountString(escrow), description: `Escrow — ${loan.name}` });
  }

  const loanCurrency = loan.currency ?? null;
  await assertLoanPaymentCurrency(ctx, loanCurrency, {
    lenderVendorId: loan.lenderVendorId ?? null,
    paymentAccountId: input.kind === 'check' ? (input.paymentAccountId ?? loan.paymentAccountId ?? null) : null,
  });
  // p1 fx: the payment's rate; the principal comes off the liability at the loan's booked rate.
  const payFx = loanCurrency ? await currencyRate(ctx, loanCurrency, input.exchangeRate) : null;
  const fxDocFields = payFx ? { currency: payFx.currency, exchangeRate: payFx.rate.toFixed(8) } : {};

  return inTransaction(ctx, async (tx) => {
    await voidOrphanLoanFx(tx, loanId);
    let expenseId: string | null = null;
    let billId: string | null = null;
    if (input.kind === 'check') {
      const paymentAccountId = input.paymentAccountId ?? loan.paymentAccountId;
      if (!paymentAccountId) throw validation('Pick the bank account the loan payment comes from.');
      const exp = await createExpense(tx, {
        vendorId: loan.lenderVendorId ?? null,
        payeeName: loan.lenderVendorId ? null : loan.name,
        date,
        method: 'check',
        reference: input.reference ?? null,
        paymentAccountId,
        memo,
        toPrint: input.toPrint,
        lines: accountLines,
        checkDuplicateNumber: Boolean(input.reference),
        ...fxDocFields,
      });
      expenseId = exp.id;
    } else {
      if (!loan.lenderVendorId) {
        throw validation('To enter the payment as a bill, set the lender (a vendor) on the loan first.');
      }
      const bill = await createBill(tx, {
        vendorId: loan.lenderVendorId,
        billNumber: input.reference ?? null,
        date,
        dueDate: input.dueDate ?? date,
        memo,
        lines: accountLines,
        ...fxDocFields,
      });
      billId = bill.id;
    }
    // p1 fx: realized exchange gain/loss on the principal (paid at the payment's rate, booked at
    // the loan's rate). The check / bill credited the liability with its own home share of the
    // principal line; the difference goes to Exchange Gain/Loss.
    let fxEntryId: string | null = null;
    if (payFx && principal.greaterThan(0)) {
      const paidHome = homeAmounts(
        accountLines.map((l) => l.amount),
        payFx.rate,
      ).lines[0];
      const bookedRate = loan.exchangeRate ?? payFx.rate;
      // review5 fx: the payment that pays the loan off takes off what is left of its home value
      // (round2(original x rate) - what earlier payments took), so no rounding cents stay on the
      // liability once nothing is owed (QB clears it on the final payment).
      const bookedHome = principal.equals(Money.of(loan.balance))
        ? Money.round2(
            toHome(loan.originalAmount, bookedRate).minus(
              loan.payments
                .filter((p) => p.active)
                .reduce((s, p) => s.plus(toHome(p.principal, bookedRate)), Money.zero()),
            ),
          )
        : toHome(principal, bookedRate);
      const gain = Money.round2(bookedHome.minus(paidHome)); // > 0: cost less than booked
      if (!gain.isZero()) {
        const fxLine = await exchangeGainLossLine(tx, gain, gain.greaterThan(0) ? 'Realized exchange gain — loan principal' : 'Realized exchange loss — loan principal');
        const entry = await postJournalEntry(tx, {
          date,
          description: `Exchange gain/loss — ${loan.name} payment ${number}`,
          sourceRef: `loan:${loanId}`,
          lines: [
            gain.greaterThan(0)
              ? { accountId: loan.liabilityAccountId, debit: toAmountString(gain), memo: `Principal at booked rate — ${loan.name}` }
              : { accountId: loan.liabilityAccountId, credit: toAmountString(gain.abs()), memo: `Principal at booked rate — ${loan.name}` },
            fxLine!,
          ],
        });
        fxEntryId = entry.id;
      }
    }
    const [lp] = await tx.db
      .insert(loanPayments)
      .values({
        companyId: tx.companyId,
        loanId,
        paymentNumber: number,
        date,
        principal: toAmountString(principal),
        interest: toAmountString(interest),
        escrow: toAmountString(escrow),
        total: toAmountString(total),
        kind: input.kind,
        expenseId,
        billId,
        exchangeRate: payFx ? payFx.rate.toFixed(8) : null,
        fxEntryId,
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'loan_payment',
      entityId: lp.id,
      newValues: { loanId, paymentNumber: number, principal: lp.principal, interest: lp.interest, escrow: lp.escrow, total: lp.total, kind: input.kind, expenseId, billId, currency: loanCurrency, exchangeRate: lp.exchangeRate, fxEntryId },
    });
    return lp;
  });
}
