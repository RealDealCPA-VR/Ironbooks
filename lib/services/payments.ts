/**
 * Payments Received (A/R) service.
 *
 * receivePayment (base currency):
 *   Dr  deposit account (bank or Undeposited Funds)   amount
 *   Cr  Accounts Receivable (1200)                    amount
 *
 * Foreign-currency payments: the payment carries its own currency + exchangeRate.
 * The deposit account is debited at the SETTLEMENT rate (amount * paymentRate), but
 * A/R is credited at the rate each invoice was BOOKED at (amountApplied * invoice
 * exchangeRate) so the A/R control account clears to exactly zero when an FX invoice
 * is fully paid. Any difference between the two is realized FX, posted to a
 * find-or-create "Exchange Gain/Loss" expense account (6900): credit = gain,
 * debit = loss.
 *
 * Then for each application, the invoice's amountPaid / balanceDue / status are updated
 * (in transaction currency, via invoices.markPaidAmount).
 * The returned paymentsReceived row's `postedEntryId` links back to the journal entry.
 */
import { isDepositTargetAccount } from '@/lib/accountTypes';
import { and, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  accounts,
  bouncedChecks,
  creditApplications,
  creditMemos,
  currencies,
  customers,
  depositLines,
  deposits,
  invoices,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  paymentsReceived,
  paymentApplications,
} from '@/lib/db/schema';
import type Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertNotControlAccount, postJournalEntry, postPaymentCreditFxPlugs, voidJournalEntry } from './posting';
import { paymentCreditEvents, unappliedAsOf } from './customerCredits'; // p1 fx
import { assertPeriodOpen } from './fiscalPeriods';
import { createInvoice, markPaidAmount } from './invoices';
import { applyToInvoice, unapplyCreditApplication } from './creditMemos';
import { docRef } from './docNumbers';
import { removePaymentFromDeposit } from './deposits';
import { computeDiscount, findTermsRef, type TermsLike, type TermsRow } from './lists/terms';
import { getHomeCurrencyCode } from './currencies';
import {
  type JournalCreditToInvoiceInput,
  type JournalItemPaymentInput,
  type JournalOffsetInput,
  applyJournalCreditsToInvoices,
  applyJournalOffsets,
  applyPaymentToJournalCharges,
  journalOffsetsOf,
  isForeignCurrency,
  listJournalApplications,
  listJournalOpenItems,
  recordJournalChargesPaid,
  reverseJournalApplicationsForPayment,
  validateJournalChargesForPayment,
} from './journalApplications';
import { clearPaymentFxReliefs, ensureLegacyFxRelief, homeAt, invoiceHomeOpenNow, recordPaymentFxRelief } from './fxSubledger'; // p1 fx

// ---- Types ------------------------------------------------------------------

export interface PaymentApplication {
  invoiceId: string;
  /** Cash applied to the invoice (may be 0 when only a discount/credit is taken). */
  amountApplied: string | number;
  /**
   * wave2 sales (C3): early-payment discount taken on this invoice. Reduces the invoice's
   * balance like cash does, and is posted Dr discount account / Cr A/R.
   */
  discountAmount?: string | number | null;
}

/** wave2 sales (C4): apply an open credit memo to an invoice as part of this payment. */
export interface PaymentCreditInput {
  creditMemoId: string;
  invoiceId: string;
  amount: string | number;
}

export interface ReceivePaymentInput {
  customerId: string;
  date: Date;
  /** Payment method (cash|check|credit_card|ach|bank_transfer|other). */
  method: 'cash' | 'check' | 'credit_card' | 'ach' | 'bank_transfer' | 'other';
  reference?: string | null;
  /**
   * Total payment amount received from the customer. May be 0 when the "payment" only applies
   * credits and/or discounts (QB lets you apply credits with a zero payment).
   */
  amount: string | number;
  /**
   * GL account where the funds land. Defaults to Undeposited Funds (code 1050).
   * Pass a checking account ID to deposit directly to the bank.
   */
  depositAccountId?: string | null;
  /**
   * Which open invoices this payment covers. Sum may be ≤ amount; any remainder
   * is recorded as `unapplied` on the payment.
   */
  applications: PaymentApplication[];
  /** wave2 sales (C4): credit memos applied to invoices together with this payment. */
  credits?: PaymentCreditInput[] | null;
  /**
   * wave2 sales (C3): account early-payment discounts post to. Defaults to a find-or-create
   * "Sales Discounts" income account (4950) — a contra-income line, like QB's Discounts Given.
   */
  discountAccountId?: string | null;
  memo?: string | null;
  /**
   * ISO 4217 currency code of the payment (e.g. 'EUR'). Defaults to base currency.
   * Each applied invoice must be in the same currency as the payment.
   */
  currency?: string | null;
  /**
   * Exchange rate: base-currency units per 1 payment-currency unit, at settlement.
   * Defaults to 1 (base currency).
   */
  exchangeRate?: string | number | null;
  /**
   * wave2 sales (C4): earlier unapplied payments (customer credit left over from a previous
   * overpayment) applied to invoices from inside Receive Payments. New payments only.
   */
  paymentCredits?: PaymentCreditFromPaymentInput[] | null;
  /**
   * General Journal charges paid by this payment (QB I11): named A/R debits from journal entries,
   * listed in Receive Payments next to the invoices. Home-currency payments only.
   */
  journalItems?: JournalItemPaymentInput[] | null;
  /** General Journal A/R credits applied to invoices together with this payment (no GL). */
  journalCredits?: JournalCreditToInvoiceInput[] | null;
  /**
   * P1: General Journal A/R credits applied to General Journal A/R charges of the same customer
   * (no GL — both lines sit in A/R). QB lets any open credit be applied to any open charge.
   */
  journalOffsets?: JournalOffsetInput[] | null;
  /**
   * Edit only (C1): the payment is in a bank deposit and its amount (or customer, currency,
   * deposit account) changes — take it out of the deposit first, then save the edit. Without it
   * such an edit is refused; edits that keep the amount never need it.
   */
  removeFromDeposit?: boolean;
}

export interface PaymentCreditFromPaymentInput {
  /** The earlier payment that still has an unapplied balance. */
  paymentId: string;
  /** The invoice it is applied to — or `journalLineId`, a General Journal charge (P1). */
  invoiceId?: string | null;
  journalLineId?: string | null;
  amount: string | number;
}

// ---- Helpers ----------------------------------------------------------------

/** Resolve the Undeposited Funds account id for the company (code 1050). */
async function getUndepositedFundsId(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1050')));
  if (!row) throw new ServiceError('NOT_FOUND', 'Undeposited Funds account (1050) not found.');
  return row.id;
}

/** Resolve the A/R account id for the company (code 1200). */
async function getArAccountId(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1200')));
  if (!row) throw new ServiceError('NOT_FOUND', 'Accounts Receivable account (1200) not found.');
  return row.id;
}

/** Home A/R a stored application relieved (legacy rows: each part converted at the invoice rate). */
function applicationHome(
  a: { amountApplied: string; discountAmount: string | null; amountHome: string | null },
  rate: Decimal,
): Decimal {
  if (a.amountHome !== null && a.amountHome !== undefined) return Money.of(a.amountHome);
  return Money.round2(Money.of(a.amountApplied).times(rate)).plus(
    Money.round2(Money.of(a.discountAmount ?? 0).times(rate)),
  );
}

/** Find an account by code, creating it when missing (new accounts start at a zero balance). */
async function getOrCreateAccount(
  ctx: ServiceContext,
  code: string,
  def: { name: string; type: string; subtype: string },
): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (row) return row.id;
  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code,
      name: def.name,
      type: def.type as never,
      subtype: def.subtype as never,
    })
    .returning();
  return created.id;
}

/** Find or create the Exchange Gain/Loss expense account (code 6900) for realized FX. */
async function getOrCreateExchangeGainLossId(ctx: ServiceContext): Promise<string> {
  return getOrCreateAccount(ctx, '6900', {
    name: 'Exchange Gain/Loss',
    type: 'expense',
    subtype: 'operating_expenses',
  });
}

/** Default early-payment discount account (contra income, QB "Discounts Given"). */
export async function getOrCreateSalesDiscountAccountId(ctx: ServiceContext): Promise<string> {
  return getOrCreateAccount(ctx, '4950', { name: 'Sales Discounts', type: 'revenue', subtype: 'sales' });
}

/** Company-owned account of an allowed type, or a plain-language error. */
async function assertAccount(
  ctx: ServiceContext,
  id: string,
  what: string,
  allowedTypes: string[],
): Promise<{ id: string; type: string; subtype: string | null; code: string | null; name: string }> {
  const [acct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.companyId, ctx.companyId)));
  if (!acct) throw notFound(what);
  if (!allowedTypes.includes(acct.type)) {
    throw validation(`${what} must be ${allowedTypes.map((t) => (t === 'revenue' ? 'an income' : `an ${t}`)).join(' or ')} account.`);
  }
  return acct;
}

// ---- Early-payment discount terms (C3) ----------------------------------------

/** Parsed early-payment terms, e.g. "2% 10 Net 30" → { percent: 2, discountDays: 10, netDays: 30 }. */
export interface DiscountTerms {
  percent: string;
  discountDays: number;
  netDays: number | null;
}

/**
 * Parse a terms code/name carrying an early-payment discount: '2_10_net_30', '2% 10 Net 30',
 * '2/10 n/30', '1% 15 net 45'. Returns null for terms without a discount ('net_30', …).
 *
 * Legacy fallback: suggestEarlyPaymentDiscounts resolves the terms on the Terms list first
 * (lib/services/lists/terms.ts) and only parses free text that is not on the list.
 */
export function parseDiscountTerms(terms: string | null | undefined): DiscountTerms | null {
  if (!terms) return null;
  const t = terms.toLowerCase().replace(/_/g, ' ').trim();
  const m =
    /^(\d+(?:\.\d+)?)\s*%?\s*(?:\/|\s)\s*(\d+)(?:\s*(?:,|\s)\s*(?:net|n)\s*\/?\s*(\d+))?/.exec(t);
  if (!m) return null;
  const percent = Number(m[1]);
  const days = Number(m[2]);
  if (!(percent > 0 && percent < 100) || !(days > 0)) return null;
  return { percent: m[1], discountDays: days, netDays: m[3] ? Number(m[3]) : null };
}

const DAY_MS = 86_400_000;

export interface DiscountSuggestion {
  invoiceId: string;
  terms: string | null;
  /** Last day the discount can be taken (ISO), or null when the terms carry no discount. */
  discountDate: string | null;
  eligible: boolean;
  /** Suggested discount (0 when not eligible). */
  suggested: string;
}

/**
 * Suggest the early-payment discount for paying `invoiceIds` on `paymentDate`, from the
 * customer's terms (QB computes it from the invoice's terms; invoices here carry the customer's).
 * The discount is a percent of the invoice's current balance, rounded to cents.
 */
export async function suggestEarlyPaymentDiscounts(
  ctx: ServiceContext,
  input: { customerId: string; paymentDate: Date; invoiceIds?: string[] },
): Promise<DiscountSuggestion[]> {
  const [cust] = await ctx.db
    .select({ terms: customers.terms })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!cust) throw notFound('Customer');
  const conds = [
    eq(invoices.companyId, ctx.companyId),
    eq(invoices.customerId, input.customerId),
    inArray(invoices.status, ['open', 'partial', 'overdue']),
  ];
  if (input.invoiceIds?.length) conds.push(inArray(invoices.id, input.invoiceIds));
  const rows = await ctx.db
    .select({ id: invoices.id, date: invoices.date, terms: invoices.terms, balanceDue: invoices.balanceDue })
    .from(invoices)
    .where(and(...conds));
  // Terms list entries (standard / date-driven) by reference, resolved once per distinct string.
  const termsCache = new Map<string, TermsRow | null>();
  for (const r of rows) {
    const ref = r.terms ?? cust.terms ?? null;
    if (ref && !termsCache.has(ref)) termsCache.set(ref, await findTermsRef(ctx, ref));
  }
  return rows.map((r) => {
    const terms = r.terms ?? cust.terms ?? null;
    const row = terms ? termsCache.get(terms) : null;
    if (row) {
      const d = computeDiscount(row as TermsLike, r.date, input.paymentDate, r.balanceDue);
      return {
        invoiceId: r.id,
        terms,
        discountDate: d.discountDate ? d.discountDate.toISOString().slice(0, 10) : null,
        eligible: d.eligible,
        suggested: d.amount ?? '0.00',
      };
    }
    const parsed = parseDiscountTerms(terms);
    if (!parsed) {
      return { invoiceId: r.id, terms, discountDate: null, eligible: false, suggested: '0.00' };
    }
    const last = new Date(r.date.getTime() + parsed.discountDays * DAY_MS);
    const eligible = input.paymentDate.getTime() < last.getTime() + DAY_MS;
    const suggested = eligible
      ? Money.round2(Money.mul(r.balanceDue, Money.div(parsed.percent, 100)))
      : Money.zero();
    return {
      invoiceId: r.id,
      terms,
      discountDate: last.toISOString().slice(0, 10),
      eligible,
      suggested: toAmountString(suggested),
    };
  });
}

// ---- Available credits (C4) ---------------------------------------------------

export interface AvailableCredit {
  /** 'journal_entry': a General Journal A/R credit; `id` is the journal LINE id. */
  kind: 'credit_memo' | 'payment' | 'journal_entry';
  id: string;
  /** Credit memo number, or the payment's reference. */
  ref: string;
  date: string;
  available: string;
}

/**
 * Open credits a customer can use in Receive Payments: credit memos, unapplied payments and
 * General Journal A/R credits (I11).
 */
export async function listAvailableCredits(ctx: ServiceContext, customerId: string): Promise<AvailableCredit[]> {
  const memos = await ctx.db
    .select({ id: creditMemos.id, memoNumber: creditMemos.memoNumber, refNumber: creditMemos.refNumber, date: creditMemos.date, unapplied: creditMemos.unapplied })
    .from(creditMemos)
    .where(
      and(
        eq(creditMemos.companyId, ctx.companyId),
        eq(creditMemos.customerId, customerId),
        ne(creditMemos.status, 'void'),
        sql`CAST(${creditMemos.unapplied} AS NUMERIC) > 0`,
      ),
    );
  const pays = await ctx.db
    .select({ id: paymentsReceived.id, reference: paymentsReceived.reference, date: paymentsReceived.date, unapplied: paymentsReceived.unapplied })
    .from(paymentsReceived)
    .where(
      and(
        eq(paymentsReceived.companyId, ctx.companyId),
        eq(paymentsReceived.customerId, customerId),
        isNull(paymentsReceived.voidedAt),
        isNull(paymentsReceived.bouncedAt),
        isNull(paymentsReceived.currency),
        sql`CAST(${paymentsReceived.unapplied} AS NUMERIC) > 0`,
      ),
    );
  return [
    ...memos.map((m) => ({
      kind: 'credit_memo' as const,
      id: m.id,
      ref: `Credit Memo #${docRef(m.refNumber, m.memoNumber)}`,
      date: m.date.toISOString().slice(0, 10),
      available: toAmountString(m.unapplied),
    })),
    ...pays.map((p) => ({
      kind: 'payment' as const,
      id: p.id,
      ref: p.reference ? `Unapplied payment ${p.reference}` : 'Unapplied payment',
      date: p.date.toISOString().slice(0, 10),
      available: toAmountString(p.unapplied),
    })),
    ...(await listJournalOpenItems(ctx, 'ar', customerId)).credits.map((j) => ({
      kind: 'journal_entry' as const,
      id: j.journalLineId,
      ref: j.ref,
      date: j.date,
      available: j.open,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Public API -------------------------------------------------------------

/**
 * Record a payment received from a customer, post the GL entry, and apply the
 * payment to one or more open invoices.
 *
 * Posting:
 *   Dr  depositAccount    amount     (asset increases — cash/undeposited funds)
 *   Dr  discount account  discounts  (early-payment discounts taken, C3)
 *   Cr  A/R (1200)        amount + discounts
 *
 * Credit memos listed in `credits` are applied in the same transaction (no GL — the memo
 * credited A/R when it was saved). Every invoice's cash + discount + credits must fit its
 * balance due.
 */
export async function receivePayment(ctx: ServiceContext, input: ReceivePaymentInput) {
  return inTransaction(ctx, async (tx) => {
    const paymentCredits = input.paymentCredits ?? [];
    if (paymentCredits.length === 0) return postPayment(tx, input, null);

    // C4: apply earlier unapplied payments first (no new GL — that money already credited A/R
    // when it was received). postPayment then re-reads invoice balances, so cash + discounts +
    // credits + earlier payments together can never exceed what an invoice owes.
    const lastPaymentId = await applyEarlierPayments(tx, input.customerId, paymentCredits, null);

    if (hasNewMoney(input)) return postPayment(tx, { ...input, paymentCredits: null }, null);
    // Only earlier payments were used: no new payment is recorded (as in QuickBooks).
    const [payment] = await tx.db
      .select()
      .from(paymentsReceived)
      .where(eq(paymentsReceived.id, lastPaymentId!));
    return { payment, entry: null };
  });
}

/** True when the request does more than re-use earlier payments (so a payment is recorded). */
function hasNewMoney(input: ReceivePaymentInput): boolean {
  return (
    Money.round2(input.amount).greaterThan(0) ||
    input.applications.length > 0 ||
    (input.credits ?? []).length > 0 ||
    (input.journalItems ?? []).length > 0 ||
    (input.journalCredits ?? []).length > 0 ||
    (input.journalOffsets ?? []).length > 0
  );
}

/**
 * C4: apply earlier unapplied payments of the customer to invoices or General Journal charges
 * (inside the caller's transaction). `excludeId` is the payment being edited — it can't be its
 * own credit. Returns the id of the last earlier payment used.
 */
async function applyEarlierPayments(
  tx: ServiceContext,
  customerId: string,
  paymentCredits: PaymentCreditFromPaymentInput[],
  excludeId: string | null,
): Promise<string | null> {
  type Use = {
    invoices: Array<{ invoiceId: string; amountApplied: string }>;
    journal: Array<{ journalLineId: string; amount: string }>;
  };
  const byPayment = new Map<string, Use>();
  for (const pc of paymentCredits) {
    const amt = Money.round2(pc.amount);
    if (!amt.greaterThan(0)) throw validation('Each earlier payment used must be greater than zero.');
    if (Boolean(pc.invoiceId) === Boolean(pc.journalLineId)) {
      throw validation('Pick the invoice or General Journal charge each earlier payment is applied to.');
    }
    if (excludeId && pc.paymentId === excludeId) {
      throw validation('A payment cannot be used as a credit on itself.');
    }
    const use = byPayment.get(pc.paymentId) ?? { invoices: [], journal: [] };
    if (pc.invoiceId) {
      const same = use.invoices.find((l) => l.invoiceId === pc.invoiceId);
      if (same) same.amountApplied = toAmountString(Money.of(same.amountApplied).plus(amt));
      else use.invoices.push({ invoiceId: pc.invoiceId, amountApplied: toAmountString(amt) });
    } else {
      use.journal.push({ journalLineId: pc.journalLineId!, amount: toAmountString(amt) });
    }
    byPayment.set(pc.paymentId, use);
  }
  let last: string | null = null;
  for (const [paymentId, use] of byPayment) {
    const [earlier] = await tx.db
      .select({
        customerId: paymentsReceived.customerId,
        bouncedAt: paymentsReceived.bouncedAt,
        voidedAt: paymentsReceived.voidedAt,
      })
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.id, paymentId), eq(paymentsReceived.companyId, tx.companyId)));
    if (!earlier) throw notFound('Earlier payment');
    if (earlier.customerId !== customerId) {
      throw validation('An earlier payment you tried to use belongs to a different customer.');
    }
    if (earlier.voidedAt) throw validation('An earlier payment you tried to use is void, so it has no credit left.');
    if (earlier.bouncedAt) throw validation('An earlier payment you tried to use bounced, so it has no credit left.');
    if (use.invoices.length > 0) await applyPayment(tx, { paymentId, applications: use.invoices });
    if (use.journal.length > 0) await applyPaymentToJournalCharges(tx, { paymentId, items: use.journal });
    last = paymentId;
  }
  return last;
}

/** Normalise a currency code: upper case; the home currency (or blank) becomes null. */
async function normalizeCurrency(ctx: ServiceContext, code: string | null | undefined): Promise<string | null> {
  const v = (code ?? '').trim().toUpperCase();
  if (!v) return null;
  const home = ((await getHomeCurrencyCode(ctx)) ?? '').toUpperCase();
  return v === home ? null : v;
}

/**
 * Currency + settlement rate of a received payment. A home-currency payment always settles at 1.
 * A foreign one uses the rate typed on the payment, or the currency list's current rate (QB fills
 * the exchange rate in from the currency list). Rounded to the column's 6 decimals so every later
 * calculation (refunds, apply-later) uses exactly the stored rate.
 */
export async function resolvePaymentCurrency(
  ctx: ServiceContext,
  input: { currency?: string | null; exchangeRate?: string | number | null },
): Promise<{ currency: string | null; rate: ReturnType<typeof Money.of> }> {
  const currency = await normalizeCurrency(ctx, input.currency);
  if (!currency) return { currency: null, rate: Money.of(1) };
  let rate: ReturnType<typeof Money.of>;
  if (input.exchangeRate !== undefined && input.exchangeRate !== null && String(input.exchangeRate).trim() !== '') {
    rate = Money.of(input.exchangeRate);
  } else {
    const [row] = await ctx.db
      .select({ rateToBase: currencies.rateToBase })
      .from(currencies)
      .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, currency)));
    if (!row) {
      throw validation(
        `${currency} is not in your currency list. Add it under Currencies (with an exchange rate) or type the exchange rate.`,
      );
    }
    rate = Money.of(row.rateToBase);
  }
  if (!rate.isFinite() || !rate.greaterThan(0)) throw validation('Exchange rate must be positive.');
  rate = Money.of(rate.toFixed(6));
  if (!rate.greaterThan(0)) throw validation('Exchange rate must be positive.');
  return { currency, rate };
}

/**
 * Validate + post a payment (create, or re-post an edited one onto `existingId`). Runs INSIDE
 * the caller's transaction so an edit's reversal and re-post commit or roll back together.
 */
async function postPayment(
  tx: ServiceContext,
  input: ReceivePaymentInput,
  existingId: string | null,
) {
  // --- Validate customer belongs to this company ---
  const [customer] = await tx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.companyId, tx.companyId)));
  if (!customer) throw notFound('Customer');

  // --- Validate amount ---
  const totalAmount = Money.round2(input.amount);
  if (totalAmount.lessThan(0)) throw validation('Payment amount cannot be negative.');
  const credits = input.credits ?? [];

  // --- Validate currency / exchange rate (defaults: home currency at 1.0; a foreign payment
  //     without a rate takes the currency list's rate) ---
  const { currency: paymentCurrency, rate: paymentRate } = await resolvePaymentCurrency(tx, input);

  // --- Validate and sum applications ---
  let sumApplied = Money.zero();
  let sumDiscount = Money.zero();
  for (const app of input.applications) {
    const applied = Money.round2(app.amountApplied ?? 0);
    const discount = Money.round2(app.discountAmount ?? 0);
    if (applied.lessThan(0)) throw validation('Applied amounts cannot be negative.');
    if (discount.lessThan(0)) throw validation('A discount cannot be negative.');
    if (!applied.greaterThan(0) && !discount.greaterThan(0)) {
      throw validation('Each applied amount must be greater than zero.');
    }
    sumApplied = sumApplied.plus(applied);
    sumDiscount = sumDiscount.plus(discount);
  }
  // I11: General Journal charges paid with this payment (cash, like an invoice application).
  const journalItems = input.journalItems ?? [];
  const journalCredits = input.journalCredits ?? [];
  const journalOffsets = input.journalOffsets ?? [];
  const sumJournal = await validateJournalChargesForPayment(tx, {
    customerId: input.customerId,
    items: journalItems,
    foreignPayment: await isForeignCurrency(tx, paymentCurrency),
  });
  if (sumApplied.plus(sumJournal).greaterThan(totalAmount)) {
    throw validation(
      `Sum of applications (${toAmountString(sumApplied.plus(sumJournal))}) exceeds payment amount (${toAmountString(totalAmount)}).`,
    );
  }
  let sumCredits = Money.zero();
  for (const c of [...credits, ...journalCredits, ...journalOffsets]) {
    const amt = Money.round2(c.amount);
    if (!amt.greaterThan(0)) throw validation('Each credit applied must be greater than zero.');
    sumCredits = sumCredits.plus(amt);
  }
  if (!totalAmount.greaterThan(0) && !sumDiscount.greaterThan(0) && !sumCredits.greaterThan(0)) {
    throw validation('Payment amount must be greater than zero.');
  }

  // --- Verify all referenced invoices belong to this company and customer ---
  const invoiceIds = input.applications.map((a) => a.invoiceId);

  // Reject duplicate invoice ids: two applications against the same invoice would each
  // be validated against the SAME original balanceDue, bypassing the over-application
  // guard and desyncing the A/R control account from the open-invoice subledger.
  if (new Set(invoiceIds).size !== invoiceIds.length) {
    throw validation(
      'Duplicate invoiceId in applications — combine the amounts into a single application per invoice.',
    );
  }

  const allInvoiceIds = [
    ...new Set([...invoiceIds, ...credits.map((c) => c.invoiceId), ...journalCredits.map((c) => c.invoiceId)]),
  ];
  const invoiceRows =
    allInvoiceIds.length > 0
      ? await tx.db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            customerId: invoices.customerId,
            balanceDue: invoices.balanceDue,
            amountPaid: invoices.amountPaid,
            status: invoices.status,
            refNumber: invoices.refNumber,
            currency: invoices.currency,
            exchangeRate: invoices.exchangeRate,
          })
          .from(invoices)
          .where(and(eq(invoices.companyId, tx.companyId), inArray(invoices.id, allInvoiceIds)))
      : [];
  for (const r of invoiceRows) r.currency = await normalizeCurrency(tx, r.currency);

  const invoiceById = new Map(invoiceRows.map((r) => [r.id, r]));
  const requestedByInvoice = new Map<string, ReturnType<typeof Money.zero>>();
  const addRequested = (id: string, amt: ReturnType<typeof Money.zero>) =>
    requestedByInvoice.set(id, (requestedByInvoice.get(id) ?? Money.zero()).plus(amt));
  const checkInvoice = (invoiceId: string) => {
    const inv = invoiceById.get(invoiceId);
    if (!inv) throw notFound(`Invoice ${invoiceId}`);
    if (inv.customerId !== input.customerId) {
      throw validation(`Invoice ${invoiceId} does not belong to the specified customer.`);
    }
    if (inv.status === 'void') {
      throw validation(`Invoice ${invoiceId} is voided and cannot receive payments.`);
    }
    if (inv.status === 'draft') {
      // A draft (pending) invoice has not been posted to A/R yet, so paying it would take
      // money off A/R that was never put there.
      throw validation(`Invoice #${docRef(inv.refNumber, inv.invoiceNumber)} is still a draft. Post it before receiving a payment against it.`);
    }
    return inv;
  };
  for (const app of input.applications) {
    const inv = checkInvoice(app.invoiceId);
    // The balanceDue comparison below is in TRANSACTION currency, so the invoice's
    // currency must match the payment's currency.
    if ((inv.currency ?? null) !== paymentCurrency) {
      throw validation(
        `Invoice #${docRef(inv.refNumber, inv.invoiceNumber)} is in ${inv.currency ?? 'your home currency'}, but this payment is in ${paymentCurrency ?? 'your home currency'}. Receive it in the invoice's currency.`,
      );
    }
    addRequested(app.invoiceId, Money.round2(app.amountApplied ?? 0).plus(Money.round2(app.discountAmount ?? 0)));
  }
  for (const c of [...credits, ...journalCredits]) {
    const inv = checkInvoice(c.invoiceId);
    if (inv.currency) {
      throw validation(`Credits can only be applied to invoices in your home currency (invoice #${docRef(inv.refNumber, inv.invoiceNumber)}).`);
    }
    addRequested(c.invoiceId, Money.round2(c.amount));
  }
  // Reject over-application: cash + discount + credits on one invoice cannot exceed its balance
  // due, otherwise amountPaid is inflated above the invoice total and funds are lost.
  for (const [invoiceId, requested] of requestedByInvoice) {
    const inv = invoiceById.get(invoiceId)!;
    if (requested.greaterThan(Money.of(inv.balanceDue))) {
      throw validation(
        `Cash, discount and credits on invoice #${docRef(inv.refNumber, inv.invoiceNumber)} (${toAmountString(requested)}) add up to more than its balance due (${toAmountString(inv.balanceDue)}).`,
      );
    }
  }

  // Credit memos: same customer, not void, enough unapplied credit.
  const memoIds = [...new Set(credits.map((c) => c.creditMemoId))];
  if (memoIds.length > 0) {
    const memoRows = await tx.db
      .select({ id: creditMemos.id, customerId: creditMemos.customerId, status: creditMemos.status, unapplied: creditMemos.unapplied, memoNumber: creditMemos.memoNumber, refNumber: creditMemos.refNumber })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, tx.companyId), inArray(creditMemos.id, memoIds)));
    const memoById = new Map(memoRows.map((m) => [m.id, m]));
    for (const id of memoIds) {
      const found = memoById.get(id);
      if (!found) throw notFound(`Credit memo ${id}`);
      const m = { ...found, memoNumber: docRef(found.refNumber, found.memoNumber) };
      if (m.customerId !== input.customerId) {
        throw validation(`Credit Memo #${m.memoNumber} belongs to a different customer.`);
      }
      if (m.status === 'void') throw validation(`Credit Memo #${m.memoNumber} is voided.`);
      const want = credits
        .filter((c) => c.creditMemoId === id)
        .reduce((s, c) => s.plus(Money.round2(c.amount)), Money.zero());
      if (want.greaterThan(Money.of(m.unapplied))) {
        throw validation(
          `Credit Memo #${m.memoNumber} only has ${toAmountString(m.unapplied)} of credit left (tried to use ${toAmountString(want)}).`,
        );
      }
    }
  }

  // --- Resolve deposit account (default: Undeposited Funds) ---
  const depositAccountId = input.depositAccountId ?? (await getUndepositedFundsId(tx));
  const depAcct = await assertAccount(tx, depositAccountId, 'Deposit account', ['asset']);
  // A/R and A/P can never be the "Deposit to" account (QB invariant I11).
  assertNotControlAccount(depAcct, 'Deposit to');
  if (depAcct.subtype === 'accounts_receivable' || depAcct.subtype === 'inventory') {
    throw validation('Deposit account must be a bank account or Undeposited Funds.');
  }

  // --- Discount account (only when a discount is taken) ---
  let discountAccountId: string | null = null;
  if (sumDiscount.greaterThan(0)) {
    if (input.discountAccountId) {
      await assertAccount(tx, input.discountAccountId, 'Discount account', ['revenue', 'expense']);
      discountAccountId = input.discountAccountId;
    } else {
      discountAccountId = await getOrCreateSalesDiscountAccountId(tx);
    }
  }

  const arAccountId = await getArAccountId(tx);
  const amountStr = toAmountString(totalAmount);
  const unapplied = Money.sub(totalAmount, sumApplied).minus(sumJournal);

  // --- Base-currency GL amounts ---
  // Deposit account is debited at the settlement rate. A/R is credited at the rate each
  // invoice was BOOKED at (plus any unapplied remainder at the settlement rate), so the
  // A/R control account clears exactly what createInvoice debited. The difference is
  // realized FX gain/loss. Discounts are converted at the invoice's booked rate on both sides.
  const cashBase = Money.round2(Money.mul(totalAmount, paymentRate));
  let arBase = Money.zero();
  let discountBase = Money.zero();
  // A foreign invoice is relieved at its booked rate, except by the application that pays it off,
  // which relieves whatever home A/R is still open on it (part-payment rounding goes to Exchange
  // Gain/Loss, as QuickBooks clears it on the final payment). p1 fx records each relief
  // (payment_fx_reliefs, fxSubledger.ts) so as-of reports read the A/R actually relieved.
  const fxInvoiceIds = input.applications
    .filter((a) => invoiceById.get(a.invoiceId)?.currency)
    .map((a) => a.invoiceId);
  const homeOpenNow = await invoiceHomeOpenNow(tx, fxInvoiceIds);
  const fxReliefs: Array<{ invoiceId: string; amount: ReturnType<typeof Money.zero>; home: ReturnType<typeof Money.zero> }> = [];
  // Home A/R each application relieves (stored on the application row as amountHome).
  const reliefHomeByInvoice = new Map<string, Decimal>();
  for (const app of input.applications) {
    const inv = invoiceById.get(app.invoiceId)!;
    const rate = Money.of(inv.exchangeRate ?? 1);
    const applied = Money.round2(app.amountApplied ?? 0);
    const disc = Money.round2(app.discountAmount ?? 0);
    const discHome = Money.round2(Money.mul(disc, rate));
    let relief = Money.round2(Money.mul(applied, rate)).plus(discHome);
    if (inv.currency) {
      const settled = applied.plus(disc);
      relief = settled.equals(Money.round2(inv.balanceDue))
        ? (homeOpenNow.get(app.invoiceId) ?? Money.round2(Money.mul(inv.balanceDue, rate)))
        : Money.round2(Money.mul(settled, rate));
      fxReliefs.push({ invoiceId: app.invoiceId, amount: applied.plus(disc), home: relief });
    }
    reliefHomeByInvoice.set(app.invoiceId, relief);
    arBase = arBase.plus(relief.minus(discHome));
    discountBase = discountBase.plus(discHome);
  }
  if (unapplied.greaterThan(0)) {
    arBase = arBase.plus(Money.round2(Money.mul(unapplied, paymentRate)));
  }
  // Journal charges are home currency (validated above: home-currency payments only).
  arBase = arBase.plus(sumJournal);
  const fxDiff = Money.round2(cashBase.minus(arBase)); // > 0 = gain, < 0 = loss
  const fxAccountId = fxDiff.isZero() ? null : await getOrCreateExchangeGainLossId(tx);

  // 1. Post the GL entry: Dr deposit / Dr discount / Cr A/R (+ FX gain/loss plug). A payment
  //    that only applies credits posts nothing (the credits already relieved A/R).
  const postingLines: Array<{
    accountId: string;
    debit?: string;
    credit?: string;
    memo?: string;
    controlLine?: boolean;
    foreignAmount?: string;
  }> = [];
  if (cashBase.greaterThan(0)) {
    // p1 fx: deposited straight into a bank in the payment's currency -> the register shows the
    // amount received in that currency (not a list-rate conversion of the home amount).
    const [depCurRow] = paymentCurrency
      ? await tx.db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, depositAccountId))
      : [];
    postingLines.push({
      accountId: depositAccountId,
      debit: toAmountString(cashBase),
      memo: 'Payment received',
      ...(paymentCurrency && depCurRow?.currency === paymentCurrency ? { foreignAmount: amountStr } : {}),
    });
  }
  if (discountAccountId && discountBase.greaterThan(0)) {
    postingLines.push({ accountId: discountAccountId, debit: toAmountString(discountBase), memo: 'Early-payment discount' });
  }
  const arCredit = arBase.plus(discountBase);
  if (arCredit.greaterThan(0)) {
    postingLines.push({ accountId: arAccountId, credit: toAmountString(arCredit), memo: 'A/R reduction', controlLine: true });
  }
  if (fxAccountId && fxDiff.greaterThan(0)) {
    postingLines.push({ accountId: fxAccountId, credit: toAmountString(fxDiff), memo: 'Realized exchange gain' });
  } else if (fxAccountId && fxDiff.lessThan(0)) {
    postingLines.push({ accountId: fxAccountId, debit: toAmountString(Money.abs(fxDiff)), memo: 'Realized exchange loss' });
  }

  // A payment that only applies credits posts no journal entry, so the closing-date check
  // inside postJournalEntry never runs. Check it here so it cannot be dated in a closed period.
  if (postingLines.length < 2) await assertPeriodOpen(tx, input.date);

  const entry =
    postingLines.length >= 2
      ? await postJournalEntry(tx, {
          date: input.date,
          description: `Payment received from customer`,
          reference: input.reference ?? null,
          sourceRef: `customer:${input.customerId}`,
          lines: postingLines,
        })
      : null;

  // 2. Insert (or, for an edit, rewrite) the paymentsReceived record
  const header = {
    customerId: input.customerId,
    date: input.date,
    method: input.method,
    reference: input.reference ?? null,
    amount: amountStr,
    unapplied: toAmountString(unapplied),
    currency: paymentCurrency,
    exchangeRate: paymentRate.toFixed(6),
    depositAccountId,
    discountAccountId,
    memo: input.memo ?? null,
    postedEntryId: entry?.id ?? null,
  };
  const [payment] = existingId
    ? await tx.db.update(paymentsReceived).set(header).where(eq(paymentsReceived.id, existingId)).returning()
    : await tx.db.insert(paymentsReceived).values({ companyId: tx.companyId, ...header }).returning();

  // 3. Insert payment applications and update invoices
  for (const app of input.applications) {
    const applied = Money.round2(app.amountApplied ?? 0);
    const discount = Money.round2(app.discountAmount ?? 0);
    await tx.db.insert(paymentApplications).values({
      paymentId: payment.id,
      invoiceId: app.invoiceId,
      amountApplied: toAmountString(applied),
      discountAmount: toAmountString(discount),
      amountHome: toAmountString(reliefHomeByInvoice.get(app.invoiceId) ?? applied.plus(discount)),
    });
    // Update invoice via the canonical helper — it re-reads the row inside this
    // transaction (no stale snapshots) and computes balanceDue against the billed
    // base (total minus retainage), keeping the subledger in sync with the GL.
    await markPaidAmount(tx, app.invoiceId, toAmountString(applied.plus(discount)));
  }
  // p1 fx: home A/R relieved on each foreign invoice (fxSubledger.ts).
  for (const r of fxReliefs) {
    await recordPaymentFxRelief(tx, { paymentId: payment.id, invoiceId: r.invoiceId, date: input.date, amount: r.amount, homeAmount: r.home });
  }

  // 4. Credits applied with this payment (recorded against it so a void/edit undoes them).
  for (const c of credits) {
    await applyToInvoice(tx, {
      creditMemoId: c.creditMemoId,
      invoiceId: c.invoiceId,
      amount: c.amount,
      paymentId: payment.id,
      date: input.date,
    });
  }

  // 4b. I11: General Journal charges paid by this payment, and General Journal credits applied
  //     to invoices with it (linked to the payment so a void/edit undoes them).
  await recordJournalChargesPaid(tx, {
    paymentId: payment.id,
    customerId: input.customerId,
    date: input.date,
    items: journalItems,
  });
  await applyJournalCreditsToInvoices(tx, {
    customerId: input.customerId,
    date: input.date,
    paymentId: payment.id,
    credits: journalCredits,
  });
  // P1: General Journal credits applied to General Journal charges (after the cash above, so the
  // charge's open amount already reflects what this payment paid on it).
  await applyJournalOffsets(tx, {
    side: 'ar',
    entityId: input.customerId,
    date: input.date,
    paymentId: payment.id,
    offsets: journalOffsets,
  });

  // 5. Audit log
  await writeAudit(tx, {
    action: existingId ? 'update' : 'create',
    entityType: 'payment_received',
    entityId: payment.id,
    newValues: {
      customerId: input.customerId,
      amount: amountStr,
      method: input.method,
      applications: input.applications,
      journalItems,
      journalCredits,
      journalOffsets,
      credits,
      currency: paymentCurrency,
      exchangeRate: paymentRate.toFixed(6),
      discountTotal: toAmountString(sumDiscount),
      discountAccountId,
      postedEntryId: entry?.id ?? null,
    },
  });

  return { payment, entry };
}

export interface PaymentListOptions {
  customerId?: string;
  /** Payments dated on/after this day. */
  from?: Date;
  /** Payments dated on/before this day (the whole day counts). */
  to?: Date;
  /**
   * Free-text search: the reference / check number, memo or customer name (contains), or the
   * amount (exact, e.g. "1250" or "1,250.00").
   */
  search?: string;
  /** Max rows (1–500, default 50). */
  limit?: number;
  offset?: number;
}

/** A payment row on the Receive Payments list, with what can still be done to it. */
export type PaymentListRow = typeof paymentsReceived.$inferSelect & {
  customerName: string | null;
  /** Swept into a (non-void) bank deposit. */
  deposited: boolean;
  /** Part of the unapplied balance was refunded. */
  refunded: boolean;
  /**
   * Record Bounced Check is possible: a check whose money reached a bank account (directly or
   * through a deposit), home currency, not refunded. Mirrors recordBouncedCheck's own checks.
   */
  canBounce: boolean;
};

function paymentListConditions(ctx: ServiceContext, opts: PaymentListOptions): SQL[] {
  const conds: SQL[] = [eq(paymentsReceived.companyId, ctx.companyId)];
  if (opts.customerId) conds.push(eq(paymentsReceived.customerId, opts.customerId));
  if (opts.from) conds.push(gte(paymentsReceived.date, startOfUtcDay(opts.from)));
  if (opts.to) conds.push(lt(paymentsReceived.date, new Date(startOfUtcDay(opts.to).getTime() + 86_400_000)));
  const q = opts.search?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const text = or(
      ilike(paymentsReceived.reference, like),
      ilike(paymentsReceived.memo, like),
      ilike(customers.displayName, like),
    )!;
    const asAmount = q.replace(/[$,\s]/g, '');
    conds.push(
      /^\d+(\.\d{1,2})?$/.test(asAmount)
        ? or(text, sql`CAST(${paymentsReceived.amount} AS NUMERIC) = ${asAmount}::numeric`)!
        : text,
    );
  }
  return conds;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Receive Payments list: newest first (date, then entry time), one page at a time, with the total
 * number of matching payments so the page can offer paging. Filters: customer, date range and a
 * search over reference / check number, memo, customer name and amount.
 */
export async function searchPayments(
  ctx: ServiceContext,
  opts: PaymentListOptions = {},
): Promise<{ payments: PaymentListRow[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const where = and(...paymentListConditions(ctx, opts));
  const [{ n }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentsReceived)
    .leftJoin(customers, eq(customers.id, paymentsReceived.customerId))
    .where(where);
  const rows = await ctx.db
    .select({ p: paymentsReceived, customerName: customers.displayName })
    .from(paymentsReceived)
    .leftJoin(customers, eq(customers.id, paymentsReceived.customerId))
    .where(where)
    .orderBy(desc(paymentsReceived.date), desc(paymentsReceived.createdAt), desc(paymentsReceived.id))
    .limit(limit)
    .offset(offset);

  const ids = rows.map((r) => r.p.id);
  const depositedTo = new Map<string, string>();
  const refunded = new Set<string>();
  if (ids.length > 0) {
    for (const d of await ctx.db
      .select({ paymentId: depositLines.paymentId, bankAccountId: deposits.depositAccountId })
      .from(depositLines)
      .innerJoin(deposits, eq(deposits.id, depositLines.depositId))
      .where(and(inArray(depositLines.paymentId, ids), isNull(deposits.voidedAt)))) {
      if (d.paymentId) depositedTo.set(d.paymentId, d.bankAccountId);
    }
    for (const j of await ctx.db
      .select({ sourceRef: journalEntries.sourceRef })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          inArray(journalEntries.sourceRef, ids.map((id) => `refund:${id}`)),
        ),
      )) {
      if (j.sourceRef) refunded.add(j.sourceRef.slice('refund:'.length));
    }
  }
  const ufId = await getUndepositedFundsId(ctx).catch(() => null);
  const payments = rows.map(({ p, customerName }) => {
    const deposited = depositedTo.has(p.id);
    const reachedBank = deposited || (!!p.depositAccountId && p.depositAccountId !== ufId);
    const home = !p.currency && Money.of(p.exchangeRate ?? 1).equals(1);
    return {
      ...p,
      customerName,
      deposited,
      refunded: refunded.has(p.id),
      canBounce:
        !p.voidedAt &&
        !p.bouncedAt &&
        p.method === 'check' &&
        Money.of(p.amount).greaterThan(0) &&
        home &&
        reachedBank &&
        !refunded.has(p.id),
    };
  });
  return { payments, total: n, limit, offset };
}

/** List payments received for the company, newest first (one page; see searchPayments). */
export async function listPayments(ctx: ServiceContext, opts?: PaymentListOptions) {
  return (await searchPayments(ctx, { limit: 100, ...opts })).payments;
}

/** Fetch a single payment (and its applications) by id. Throws NOT_FOUND if missing. */
export async function getPayment(ctx: ServiceContext, id: string) {
  const [payment] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.id, id), eq(paymentsReceived.companyId, ctx.companyId)));
  if (!payment) throw notFound('Payment');

  const applications = await ctx.db
    .select()
    .from(paymentApplications)
    .where(eq(paymentApplications.paymentId, id));

  // wave2 sales: credits applied with this payment + bounced-check record (if any).
  const credits = await ctx.db
    .select({
      id: creditApplications.id,
      creditMemoId: creditApplications.creditMemoId,
      invoiceId: creditApplications.invoiceId,
      amount: creditApplications.amount,
    })
    .from(creditApplications)
    .where(and(eq(creditApplications.companyId, ctx.companyId), eq(creditApplications.paymentId, id)));
  const [bounced] = await ctx.db
    .select()
    .from(bouncedChecks)
    .where(and(eq(bouncedChecks.companyId, ctx.companyId), eq(bouncedChecks.paymentId, id)));

  // I11: General Journal charges this payment paid, and General Journal credits applied with it.
  const journalApplications = await listJournalApplications(ctx, { paymentId: id });
  // P1: General Journal credits it applied to General Journal charges (credit line -> charge line).
  const journalOffsets = await journalOffsetsOf(ctx, { paymentId: id });

  // C1: the bank deposit it is in (an edit then has to keep the amount).
  const deposit = await paymentDepositOf(ctx, id);

  return { ...payment, applications, credits, journalApplications, journalOffsets, bounced: bounced ?? null, deposit };
}

// ---- Corrections: void / unapply / apply-later / refund -----------------------

/**
 * Post an FX adjustment when an application moves between "unapplied at the
 * payment's settlement rate" and "applied at the invoice's booked rate".
 *
 * At receivePayment time the unapplied remainder was credited to A/R at the
 * PAYMENT rate, but clearing an invoice requires crediting A/R at the rate the
 * invoice was BOOKED at. When the two differ, the base-currency A/R control
 * account needs a plug to keep control == subledger; the plug lands in the
 * Exchange Gain/Loss account (6900).
 *
 * `sign = 1` for applying (unapplied -> invoice), `sign = -1` for unapplying.
 */
async function postFxAdjustmentForApplication(
  tx: ServiceContext,
  params: {
    /** Invoice-currency amount moved from the payment's credit onto the invoice (apply) or back (unapply). */
    amount: Parameters<typeof Money.of>[0];
    invoiceId: string;
    invoiceCurrency: string | null | undefined;
    invoiceRate: string | number | null | undefined;
    /** The invoice's balance due BEFORE this apply / unapply (invoice currency). */
    invoiceBalanceBefore: Parameters<typeof Money.of>[0];
    /** Unapply only: home A/R put back on the invoice (default: amount x invoice rate). */
    unapplyHome?: Decimal;
    paymentId: string;
    paymentRate: string | number | null | undefined;
    /** The payment's unapplied amount BEFORE this apply / unapply (payment currency). */
    unappliedBefore: Parameters<typeof Money.of>[0];
    arAccountId: string;
    date: Date;
    sign: 1 | -1;
    description: string;
    sourceRef: string;
  },
) {
  const amt = Money.of(params.amount);
  let delta: ReturnType<typeof Money.zero>;
  /** Home A/R moved on the invoice: relieved (apply) or put back (unapply), as a positive amount. */
  let invoiceHome: Decimal;
  if (params.invoiceCurrency) {
    // p1 fx: the invoice is relieved by (home still on A/R for it) - home(balance after), and the
    // payment's credit by home(unapplied before) - home(unapplied after) at the payment's rate, so
    // both the invoice and the credit left keep exactly the home amount the aging shows for them.
    const invRate = Money.of(params.invoiceRate ?? 1);
    const payRate = Money.of(params.paymentRate ?? 1);
    await ensureLegacyFxRelief(tx, { paymentId: params.paymentId, invoiceId: params.invoiceId, invoiceRate: invRate });
    // + = A/R credited on the invoice. Apply: the booked rate, or (the payoff) all the home A/R
    // still open on it. Unapply: the home A/R the caller puts back (part of what it relieved).
    let invoiceRelief: Decimal;
    if (params.sign === -1) {
      invoiceRelief = Money.round2(params.unapplyHome ?? Money.mul(amt, invRate)).negated();
    } else if (amt.equals(Money.round2(params.invoiceBalanceBefore))) {
      invoiceRelief =
        (await invoiceHomeOpenNow(tx, [params.invoiceId])).get(params.invoiceId) ??
        Money.round2(Money.mul(params.invoiceBalanceBefore, invRate));
    } else {
      invoiceRelief = Money.round2(Money.mul(amt, invRate));
    }
    const uBefore = Money.of(params.unappliedBefore);
    const uAfter = uBefore.minus(amt.times(params.sign));
    const creditUsed = homeAt(uBefore, payRate).minus(homeAt(uAfter, payRate)); // + = A/R debited (credit used up)
    await recordPaymentFxRelief(tx, {
      paymentId: params.paymentId,
      invoiceId: params.invoiceId,
      date: params.date,
      amount: amt.times(params.sign),
      homeAmount: invoiceRelief,
    });
    delta = Money.round2(invoiceRelief.minus(creditUsed));
    invoiceHome = Money.round2(invoiceRelief.times(params.sign));
  } else {
    invoiceHome = Money.round2(Money.mul(amt, Money.of(params.invoiceRate ?? 1)));
    delta = Money.round2(
      Money.mul(amt, Money.of(params.invoiceRate ?? 1)).minus(Money.mul(amt, Money.of(params.paymentRate ?? 1))),
    ).times(params.sign);
  }
  if (delta.isZero()) return { entry: null, invoiceHome };

  const fxAccountId = await getOrCreateExchangeGainLossId(tx);
  // delta > 0: A/R needs an EXTRA credit (loss); delta < 0: A/R credit shrinks (gain).
  const lines =
    delta.greaterThan(0)
      ? [
          { accountId: fxAccountId, debit: toAmountString(delta), memo: 'Realized exchange loss' },
          { accountId: params.arAccountId, credit: toAmountString(delta), memo: 'A/R FX adjustment', controlLine: true },
        ]
      : [
          { accountId: params.arAccountId, debit: toAmountString(Money.abs(delta)), memo: 'A/R FX adjustment', controlLine: true },
          { accountId: fxAccountId, credit: toAmountString(Money.abs(delta)), memo: 'Realized exchange gain' },
        ];
  const entry = await postJournalEntry(tx, {
    date: params.date,
    description: params.description,
    sourceRef: params.sourceRef,
    lines,
  });
  return { entry, invoiceHome };
}

/**
 * Guards shared by void and edit: a payment swept into a deposit, refunded, or recorded as
 * bounced cannot be reversed here (the later transaction depends on it).
 */
async function assertPaymentReversible(
  ctx: ServiceContext,
  payment: { id: string; bouncedAt: Date | null },
  verb: 'voided' | 'edited',
  opts: { allowDeposited?: boolean } = {},
) {
  if (payment.bouncedAt) {
    throw new ServiceError(
      'CONFLICT',
      `This payment was recorded as a bounced check, so it cannot be ${verb}.`,
    );
  }
  // Guard: payment already swept into a deposit (a void deposit releases it again). An edit that
  // keeps the deposited amount is checked by assertDepositedEditAllowed instead (C1).
  const deposited = opts.allowDeposited ? null : await paymentDepositOf(ctx, payment.id);
  if (deposited) {
    throw new ServiceError(
      'CONFLICT',
      verb === 'voided'
        ? 'This payment has been included in a deposit and cannot be voided. Remove or void the deposit first.'
        : 'This payment has been included in a deposit and cannot be edited. Remove or void the deposit first.',
    );
  }
  const [refund] = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.sourceRef, `refund:${payment.id}`),
        eq(journalEntries.status, 'posted'),
      ),
    )
    .limit(1);
  if (refund) {
    throw new ServiceError(
      'CONFLICT',
      `Part of this payment was refunded to the customer, so it cannot be ${verb}. Void the refund first.`,
    );
  }
}

/** The (non-void) bank deposit a received payment was swept into, or null. */
export async function paymentDepositOf(
  ctx: ServiceContext,
  paymentId: string,
): Promise<{ id: string; date: Date; total: string } | null> {
  const [row] = await ctx.db
    .select({ id: deposits.id, date: deposits.date, total: deposits.total })
    .from(depositLines)
    .innerJoin(deposits, eq(deposits.id, depositLines.depositId))
    .where(
      and(
        eq(depositLines.paymentId, paymentId),
        eq(deposits.companyId, ctx.companyId),
        isNull(deposits.voidedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

const ymd = (d: Date) => new Date(d).toISOString().slice(0, 10);

/**
 * C1: what may change on a payment that is already in a bank deposit (QB lets you re-apply it,
 * change the date, method, reference and memo). The deposit took exactly this amount out of
 * Undeposited Funds, so the edit must put the same home amount back there: same amount, currency,
 * exchange rate and "Deposit to" account (Undeposited Funds), same customer, dated on or before
 * the deposit. Anything else is refused with a plain message (details.canRemoveFromDeposit tells
 * the form it can offer "take it out of the deposit and save").
 */
async function assertDepositedEditAllowed(
  ctx: ServiceContext,
  payment: typeof paymentsReceived.$inferSelect,
  deposit: { id: string; date: Date },
  input: ReceivePaymentInput,
) {
  const on = ymd(deposit.date);
  const refuse = (why: string) =>
    new ServiceError(
      'CONFLICT',
      `This payment is part of the bank deposit made on ${on}, so ${why} To change that, take the payment out of the deposit (Save with "Remove from deposit"), or edit the deposit first.`,
      { deposited: true, depositId: deposit.id, canRemoveFromDeposit: true },
    );
  if (!Money.round2(input.amount).equals(Money.round2(payment.amount))) {
    throw refuse(`its amount must stay ${toAmountString(payment.amount)}.`);
  }
  if (input.customerId !== payment.customerId) {
    throw refuse('it must stay with the same customer.');
  }
  const { currency, rate } = await resolvePaymentCurrency(ctx, {
    currency: input.currency,
    exchangeRate: input.exchangeRate,
  });
  const oldCurrency = await normalizeCurrency(ctx, payment.currency);
  if (currency !== oldCurrency || !rate.equals(Money.of(payment.exchangeRate ?? 1))) {
    throw refuse('its currency and exchange rate cannot change.');
  }
  const depositTo = input.depositAccountId ?? (await getUndepositedFundsId(ctx));
  if (depositTo !== payment.depositAccountId) {
    throw refuse('it must stay in Undeposited Funds (the deposit moved it to the bank).');
  }
  if (ymd(input.date) > on) {
    throw new ServiceError(
      'CONFLICT',
      `This payment is part of the bank deposit made on ${on}, so its date cannot be later than the deposit date.`,
      { deposited: true, depositId: deposit.id },
    );
  }
}

/**
 * Undo everything a payment posted (inside the caller's transaction): its GL entry and any
 * FX adjustment entries made when it was applied/unapplied later, every invoice application
 * (cash + discount), and the credit memos applied with it.
 */
async function reversePaymentEffects(
  tx: ServiceContext,
  payment: { id: string; postedEntryId: string | null; date: Date },
) {
  const applications = await tx.db
    .select()
    .from(paymentApplications)
    .where(eq(paymentApplications.paymentId, payment.id));

  // 1. Reverse the GL entry (includes any FX gain/loss and discount lines posted with it).
  if (payment.postedEntryId) {
    await voidJournalEntry(tx, payment.postedEntryId);
  } else {
    // Credits-only payment: no entry to void, so check the closing date here.
    await assertPeriodOpen(tx, payment.date);
  }
  // FX plugs posted by later apply/unapply of this payment.
  const fxEntries = await tx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, tx.companyId),
        eq(journalEntries.sourceRef, `payment:${payment.id}`),
        eq(journalEntries.status, 'posted'),
      ),
    );
  for (const e of fxEntries) await voidJournalEntry(tx, e.id);

  // 2. Roll back each invoice's amountPaid / balanceDue / status (cash + discount).
  for (const app of applications) {
    const back = Money.of(app.amountApplied).plus(Money.of(app.discountAmount ?? 0));
    if (back.greaterThan(0)) await markPaidAmount(tx, app.invoiceId, toAmountString(back.negated()));
  }

  // 3. Remove application rows (history is preserved in the audit log).
  await tx.db.delete(paymentApplications).where(eq(paymentApplications.paymentId, payment.id));
  await clearPaymentFxReliefs(tx, payment.id); // p1 fx: its A/R relief entries were voided above

  // 4. Undo credit memos applied with this payment.
  const creditApps = await tx.db
    .select({ id: creditApplications.id })
    .from(creditApplications)
    .where(and(eq(creditApplications.companyId, tx.companyId), eq(creditApplications.paymentId, payment.id)));
  for (const ca of creditApps) await unapplyCreditApplication(tx, ca.id);

  // 5. I11: General Journal charges it paid reopen; General Journal credits applied with it are
  //    taken back off their invoices.
  await reverseJournalApplicationsForPayment(tx, payment.id);

  return applications;
}

/**
 * Void a received payment.
 *
 * Reverses the GL entry (voidJournalEntry — guards closed periods and lines cleared
 * in a completed reconciliation), rolls every applied invoice back via markPaidAmount
 * with a negative delta (cash + discount), undoes credit memos applied with it, deletes
 * the application rows, and stamps voidedAt.
 *
 * Blocked while the payment is included in a deposit (void/undo the deposit first),
 * otherwise the deposit's GL entry would reference funds that no longer exist; also blocked
 * once part of it was refunded, or after it was recorded as a bounced check.
 */
export async function voidPayment(ctx: ServiceContext, id: string) {
  const [payment] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.id, id), eq(paymentsReceived.companyId, ctx.companyId)));
  if (!payment) throw notFound('Payment');
  if (payment.voidedAt) return { ...payment, applications: [] }; // idempotent

  await assertPaymentReversible(ctx, payment, 'voided');

  return inTransaction(ctx, async (tx) => {
    const applications = await reversePaymentEffects(tx, payment);

    // Stamp the payment void.
    const [updated] = await tx.db
      .update(paymentsReceived)
      .set({ voidedAt: new Date(), unapplied: '0.00' })
      .where(eq(paymentsReceived.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'payment_received',
      entityId: id,
      oldValues: {
        amount: payment.amount,
        unapplied: payment.unapplied,
        applications: applications.map((a) => ({
          invoiceId: a.invoiceId,
          amountApplied: a.amountApplied,
          discountAmount: a.discountAmount,
        })),
      },
      newValues: { voided: true },
    });

    return { ...updated, applications: [] };
  });
}

/**
 * Edit a received payment (wave2 sales, C1): amount, date, method, deposit account,
 * applications, discounts and credits can all change.
 *
 * Sanctioned void/repost pattern inside ONE transaction: the old version's GL entry is voided
 * (closing-date check on the old date), its applications/credits are rolled back, and the new
 * version is validated against the restored invoice balances and posted onto the SAME payment
 * record (closing-date check on the new date). If anything is invalid — e.g. an applied amount
 * larger than an invoice's balance — the whole edit rolls back with a plain-language error.
 * The audit trail / transaction log records old and new values.
 */
export async function updatePayment(ctx: ServiceContext, id: string, input: ReceivePaymentInput) {
  const [payment] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.id, id), eq(paymentsReceived.companyId, ctx.companyId)));
  if (!payment) throw notFound('Payment');
  if (payment.voidedAt) throw new ServiceError('CONFLICT', 'Cannot edit a voided payment.');
  // C1: a deposited payment can still be re-applied / re-dated (same amount); otherwise it has to
  // come out of the deposit first, which removeFromDeposit does inside the same transaction.
  const deposit = await paymentDepositOf(ctx, id);
  const takeOut = !!deposit && input.removeFromDeposit === true;
  // A deposited foreign payment keeps its stored rate unless one is typed (the list rate may have
  // moved since, which would change the home amount the deposit took out of Undeposited Funds).
  if (deposit && !takeOut && (input.exchangeRate === undefined || input.exchangeRate === null || String(input.exchangeRate).trim() === '')) {
    input = { ...input, exchangeRate: payment.exchangeRate };
  }
  if (deposit && !takeOut) await assertDepositedEditAllowed(ctx, payment, deposit, input);
  await assertPaymentReversible(ctx, payment, 'edited', { allowDeposited: !!deposit });

  return inTransaction(ctx, async (tx) => {
    if (deposit && takeOut) await removePaymentFromDeposit(tx, deposit.id, id);
    const oldCredits = await tx.db
      .select({ creditMemoId: creditApplications.creditMemoId, invoiceId: creditApplications.invoiceId, amount: creditApplications.amount })
      .from(creditApplications)
      .where(and(eq(creditApplications.companyId, tx.companyId), eq(creditApplications.paymentId, id)));
    // P1: an edit that does not mention General Journal credit -> charge applications keeps them.
    const keptOffsets = input.journalOffsets === undefined ? await journalOffsetsOf(tx, { paymentId: id }) : null;
    const oldApps = await reversePaymentEffects(tx, payment);
    await writeAudit(tx, {
      action: 'update',
      entityType: 'payment_received',
      entityId: id,
      oldValues: {
        customerId: payment.customerId,
        date: payment.date,
        method: payment.method,
        reference: payment.reference,
        amount: payment.amount,
        unapplied: payment.unapplied,
        depositAccountId: payment.depositAccountId,
        postedEntryId: payment.postedEntryId,
        applications: oldApps.map((a) => ({ invoiceId: a.invoiceId, amountApplied: a.amountApplied, discountAmount: a.discountAmount })),
        credits: oldCredits,
        depositId: deposit?.id ?? null,
      },
      newValues: { action: 'edit', ...(deposit ? { deposit: takeOut ? 'removed' : 'kept' } : {}) },
    });
    // C4: earlier unapplied payments picked while editing are applied too (they used to be
    // dropped silently). They are applied from their own payment, exactly as on a new payment.
    if ((input.paymentCredits ?? []).length > 0) {
      await applyEarlierPayments(tx, input.customerId, input.paymentCredits!, id);
    }
    return postPayment(tx, { ...input, paymentCredits: null, journalOffsets: keptOffsets ?? input.journalOffsets }, id);
  });
}

// ---- Record Bounced Check (F2) -------------------------------------------------

export interface RecordBouncedCheckInput {
  paymentId: string;
  /** Date the bank returned the check (defaults to today). */
  date?: Date | null;
  /** Fee the BANK charged you (posted Dr bank-fee expense / Cr bank). */
  bankFee?: string | number | null;
  bankFeeAccountId?: string | null;
  /** Fee you charge the CUSTOMER (a new invoice, income to `customerFeeAccountId`). */
  customerFee?: string | number | null;
  customerFeeAccountId?: string | null;
  memo?: string | null;
}

/**
 * Record a bounced (NSF) customer check — QB "Record Bounced Check".
 *
 *  1. Takes the money back out of the bank it was deposited to and puts the amount back on the
 *     customer's A/R:  Dr A/R (amount + discounts) / Cr bank (amount) / Cr discount account
 *     (early-payment discounts are cancelled too — the customer did not pay on time after all).
 *  2. Reopens every invoice the payment paid (their balances come back; the application rows
 *     are snapshotted on the bounced-check record).
 *  3. Optional bank fee: Dr bank-fee expense (default 6100 Bank & Merchant Fees) / Cr bank.
 *  4. Optional customer fee: a new invoice to the customer (income default 4900 Other Income).
 *
 * The original payment entry stays posted (the deposit that included it is untouched) and the
 * payment is stamped `bouncedAt`. Credits applied with the payment stay applied (they are real).
 * Only payments whose money reached a bank account can bounce; one still sitting in Undeposited
 * Funds should simply be voided. Home-currency payments only.
 */
export async function recordBouncedCheck(ctx: ServiceContext, input: RecordBouncedCheckInput) {
  const [payment] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.id, input.paymentId), eq(paymentsReceived.companyId, ctx.companyId)));
  if (!payment) throw notFound('Payment');
  if (payment.voidedAt) throw new ServiceError('CONFLICT', 'This payment is voided — there is nothing to bounce.');
  if (payment.bouncedAt) throw new ServiceError('CONFLICT', 'This payment is already recorded as bounced.');
  if (payment.currency || !Money.eq(Money.of(payment.exchangeRate ?? 1), 1)) {
    throw validation('Bounced checks can only be recorded for payments in your home currency.');
  }
  const amount = Money.of(payment.amount);
  if (!amount.greaterThan(0)) throw validation('This payment received no money, so it cannot bounce.');

  const [refund] = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.sourceRef, `refund:${payment.id}`),
        eq(journalEntries.status, 'posted'),
      ),
    )
    .limit(1);
  if (refund) {
    throw new ServiceError('CONFLICT', 'Part of this payment was refunded, so it cannot be recorded as bounced. Void the refund first.');
  }

  // Which bank did the money reach? Directly, or through a (non-void) deposit.
  const ufId = await getUndepositedFundsId(ctx).catch(() => null);
  const [dep] = await ctx.db
    .select({ bankAccountId: deposits.depositAccountId, depositDate: deposits.date })
    .from(depositLines)
    .innerJoin(deposits, eq(deposits.id, depositLines.depositId))
    .where(and(eq(depositLines.paymentId, payment.id), isNull(deposits.voidedAt)))
    .limit(1);
  let bankAccountId: string | null = dep?.bankAccountId ?? null;
  if (!bankAccountId && payment.depositAccountId && payment.depositAccountId !== ufId) {
    bankAccountId = payment.depositAccountId;
  }
  if (!bankAccountId) {
    throw new ServiceError(
      'CONFLICT',
      'This payment has not been deposited to a bank yet, so it cannot bounce. If the check is no good, void the payment instead.',
    );
  }

  const bankFee = Money.round2(input.bankFee ?? 0);
  const customerFee = Money.round2(input.customerFee ?? 0);
  if (bankFee.lessThan(0) || customerFee.lessThan(0)) throw validation('Fees cannot be negative.');
  if (input.bankFeeAccountId) await assertAccount(ctx, input.bankFeeAccountId, 'Bank fee account', ['expense']);
  if (input.customerFeeAccountId) await assertAccount(ctx, input.customerFeeAccountId, 'Customer fee account', ['revenue']);

  const arAccountId = await getArAccountId(ctx);
  const date = input.date ?? new Date();
  // A check cannot come back before it was received (or before the deposit that carried it).
  const day = (d: Date) => d.toISOString().slice(0, 10);
  if (day(date) < day(payment.date)) {
    throw validation(`The bounce date can't be before the payment date (${day(payment.date)}).`);
  }
  if (dep?.depositDate && day(date) < day(dep.depositDate)) {
    throw validation(`The bounce date can't be before the check was deposited (${day(dep.depositDate)}).`);
  }

  return inTransaction(ctx, async (tx) => {
    const applications = await tx.db
      .select()
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentId, payment.id));
    const discountTotal = applications.reduce((s, a) => s.plus(Money.of(a.discountAmount ?? 0)), Money.zero());
    const discountAccountId =
      discountTotal.greaterThan(0)
        ? (payment.discountAccountId ?? (await getOrCreateSalesDiscountAccountId(tx)))
        : null;

    // 1. Reverse the money: Dr A/R / Cr bank (+ cancel discounts).
    const lines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string; controlLine?: boolean }> = [
      {
        accountId: arAccountId,
        debit: toAmountString(amount.plus(discountTotal)),
        memo: 'Bounced check — amount owed again',
        controlLine: true,
      },
      { accountId: bankAccountId!, credit: toAmountString(amount), memo: 'Bounced check returned by bank' },
    ];
    if (discountAccountId) {
      lines.push({ accountId: discountAccountId, credit: toAmountString(discountTotal), memo: 'Early-payment discount cancelled' });
    }
    const reversal = await postJournalEntry(tx, {
      date,
      description: `Bounced check${payment.reference ? ` #${payment.reference}` : ''}`,
      reference: payment.reference ?? null,
      sourceRef: `bounced:${payment.id}`,
      lines,
    });

    // 2. Reopen the invoices the payment paid.
    for (const app of applications) {
      const back = Money.of(app.amountApplied).plus(Money.of(app.discountAmount ?? 0));
      if (back.greaterThan(0)) await markPaidAmount(tx, app.invoiceId, toAmountString(back.negated()));
    }
    await tx.db.delete(paymentApplications).where(eq(paymentApplications.paymentId, payment.id));
    // I11: General Journal charges the payment paid are owed again too (the reversal above
    // re-charged the whole payment to A/R). Credits applied with it stay applied.
    const reopenedJournal = await tx.db
      .delete(journalItemApplications)
      .where(
        and(
          eq(journalItemApplications.companyId, tx.companyId),
          eq(journalItemApplications.paymentId, payment.id),
          eq(journalItemApplications.kind, 'payment'),
        ),
      )
      .returning();
    await tx.db
      .update(paymentsReceived)
      .set({ unapplied: '0.00', bouncedAt: date })
      .where(eq(paymentsReceived.id, payment.id));

    // 3. Bank fee.
    let bankFeeEntryId: string | null = null;
    let bankFeeAccountId: string | null = null;
    if (bankFee.greaterThan(0)) {
      bankFeeAccountId =
        input.bankFeeAccountId ??
        (await getOrCreateAccount(tx, '6100', { name: 'Bank & Merchant Fees', type: 'expense', subtype: 'operating_expenses' }));
      const feeEntry = await postJournalEntry(tx, {
        date,
        description: 'Bank fee — bounced customer check',
        sourceRef: `bounced:${payment.id}`,
        lines: [
          { accountId: bankFeeAccountId, debit: toAmountString(bankFee), memo: 'Returned check fee charged by bank' },
          { accountId: bankAccountId!, credit: toAmountString(bankFee), memo: 'Returned check fee charged by bank' },
        ],
      });
      bankFeeEntryId = feeEntry.id;
    }

    // 4. Customer fee invoice.
    let customerFeeInvoiceId: string | null = null;
    if (customerFee.greaterThan(0)) {
      const feeIncomeId =
        input.customerFeeAccountId ??
        (await getOrCreateAccount(tx, '4900', { name: 'Other Income', type: 'revenue', subtype: 'other_income' }));
      const feeInvoice = await createInvoice(tx, {
        customerId: payment.customerId,
        date,
        dueDate: date,
        memo: `Returned check fee${payment.reference ? ` (check #${payment.reference})` : ''}`,
        overrideCreditLimit: true,
        lines: [
          {
            accountId: feeIncomeId,
            description: 'Returned check fee',
            quantity: 1,
            rate: toAmountString(customerFee),
            taxable: false,
          },
        ],
      });
      customerFeeInvoiceId = feeInvoice.id;
    }

    const [row] = await tx.db
      .insert(bouncedChecks)
      .values({
        companyId: tx.companyId,
        paymentId: payment.id,
        customerId: payment.customerId,
        date,
        amount: toAmountString(amount),
        bankAccountId: bankAccountId!,
        reversalEntryId: reversal.id,
        bankFee: toAmountString(bankFee),
        bankFeeAccountId,
        bankFeeEntryId,
        customerFee: toAmountString(customerFee),
        customerFeeInvoiceId,
        applications: applications.map((a) => ({
          invoiceId: a.invoiceId,
          amountApplied: a.amountApplied,
          discountAmount: a.discountAmount,
        })),
        memo: input.memo ?? null,
      })
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'payment_received',
      entityId: payment.id,
      oldValues: { unapplied: payment.unapplied, applications: row.applications },
      newValues: {
        action: 'bounced',
        bouncedCheckId: row.id,
        reversalEntryId: reversal.id,
        bankFee: toAmountString(bankFee),
        customerFee: toAmountString(customerFee),
        customerFeeInvoiceId,
        journalChargesReopened: reopenedJournal.map((j) => ({
          journalEntryId: j.journalEntryId,
          journalLineId: j.journalLineId,
          amount: j.amount,
        })),
      },
    });

    return row;
  });
}

export async function listBouncedChecks(ctx: ServiceContext, opts?: { customerId?: string }) {
  const conds = [eq(bouncedChecks.companyId, ctx.companyId)];
  if (opts?.customerId) conds.push(eq(bouncedChecks.customerId, opts.customerId));
  return ctx.db.select().from(bouncedChecks).where(and(...conds));
}

export interface UnapplyFromInvoiceInput {
  paymentId: string;
  invoiceId: string;
  /** Amount to unapply; defaults to the full applied amount. */
  amount?: string | number | null;
}

/**
 * Unapply (part of) a payment application from an invoice — a partial correction
 * that keeps the payment itself posted. The freed amount becomes `unapplied` on
 * the payment (an available customer credit), and the invoice's balanceDue is
 * restored via markPaidAmount with a negative delta.
 *
 * GL note: the FULL payment amount (applied + unapplied) was credited to A/R at
 * receive time, so moving an amount between "applied" and "unapplied" does not
 * itself change the A/R control account — except for an FX plug when the invoice
 * was booked at a different rate than the payment settled at.
 */
export async function unapplyFromInvoice(ctx: ServiceContext, input: UnapplyFromInvoiceInput) {
  const [payment] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(
      and(eq(paymentsReceived.id, input.paymentId), eq(paymentsReceived.companyId, ctx.companyId)),
    );
  if (!payment) throw notFound('Payment');
  if (payment.voidedAt) {
    throw new ServiceError('CONFLICT', 'Cannot unapply a voided payment.');
  }

  const [app] = await ctx.db
    .select()
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.paymentId, input.paymentId),
        eq(paymentApplications.invoiceId, input.invoiceId),
      ),
    );
  if (!app) throw notFound('Payment application for that invoice');

  const applied = Money.of(app.amountApplied);
  const amount = Money.round2(input.amount ?? applied);
  if (!amount.greaterThan(0)) throw validation('Unapply amount must be greater than zero.');
  if (amount.greaterThan(applied)) {
    throw validation(
      `Unapply amount (${toAmountString(amount)}) exceeds the applied amount (${toAmountString(applied)}).`,
    );
  }

  const [invoice] = await ctx.db
    .select({ exchangeRate: invoices.exchangeRate, currency: invoices.currency, balanceDue: invoices.balanceDue })
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, ctx.companyId)));
  if (!invoice) throw notFound('Invoice');

  const arAccountId = await getArAccountId(ctx);

  // Home A/R this unapply puts back on the invoice: all of what the application relieved when the
  // whole application goes, else the part at the invoice's booked rate.
  const invRate = Money.of(invoice.exchangeRate ?? 1);
  const appHome = applicationHome(app, invRate);
  const discountLeft = Money.of(app.discountAmount ?? 0);
  const homeBack =
    amount.equals(applied) && !discountLeft.greaterThan(0)
      ? appHome
      : (() => {
          const part = Money.round2(amount.times(invRate));
          return part.greaterThan(appHome) ? appHome : part;
        })();
  const homeLeft = Money.round2(appHome.minus(homeBack));

  return inTransaction(ctx, async (tx) => {
    // 0. FX plug if the invoice was booked at a different rate than the payment (p1 fx: before the
    //    application row changes, so the home amount still open is read as it was).
    await postFxAdjustmentForApplication(tx, {
      unapplyHome: homeBack,
      amount,
      invoiceId: input.invoiceId,
      invoiceCurrency: invoice.currency,
      invoiceRate: invoice.exchangeRate,
      invoiceBalanceBefore: invoice.balanceDue,
      paymentId: input.paymentId,
      paymentRate: payment.exchangeRate,
      unappliedBefore: payment.unapplied,
      arAccountId,
      date: new Date(),
      sign: -1,
      description: 'FX adjustment — payment unapplied from invoice',
      sourceRef: `payment:${input.paymentId}`,
    });

    // 1. Restore the invoice's balanceDue / status.
    await markPaidAmount(tx, input.invoiceId, toAmountString(Money.neg(amount)));

    // 2. Shrink or delete the application row.
    const remaining = Money.round2(applied.minus(amount));
    // A row that still carries an early-payment discount is kept (amountApplied 0) so a later
    // void/edit/bounce can roll the discount back too.
    if (remaining.isZero() && !Money.gt(app.discountAmount ?? 0, 0)) {
      await tx.db.delete(paymentApplications).where(eq(paymentApplications.id, app.id));
    } else {
      await tx.db
        .update(paymentApplications)
        .set({ amountApplied: toAmountString(remaining), amountHome: toAmountString(homeLeft) })
        .where(eq(paymentApplications.id, app.id));
    }

    // 3. Free the amount back onto the payment.
    const newUnapplied = Money.round2(Money.of(payment.unapplied).plus(amount));
    const [updatedPayment] = await tx.db
      .update(paymentsReceived)
      .set({ unapplied: toAmountString(newUnapplied) })
      .where(eq(paymentsReceived.id, input.paymentId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'payment_received',
      entityId: input.paymentId,
      oldValues: { invoiceId: input.invoiceId, amountApplied: toAmountString(applied) },
      newValues: {
        action: 'unapply',
        invoiceId: input.invoiceId,
        amountUnapplied: toAmountString(amount),
        unapplied: toAmountString(newUnapplied),
      },
    });

    return updatedPayment;
  });
}

export interface ApplyPaymentInput {
  paymentId: string;
  applications: PaymentApplication[];
}

/**
 * Apply a payment's unapplied (overpaid) balance to open invoices after the fact.
 * Validates exactly like receivePayment (duplicate-id guard, over-application guard,
 * same customer, currency match); sum of applications must be <= the payment's
 * unapplied balance. No new A/R entry is needed — the full amount was already
 * credited to A/R at receive time — except for an FX plug when rates differ.
 */
export async function applyPayment(ctx: ServiceContext, input: ApplyPaymentInput) {
  if (!input.applications || input.applications.length === 0) {
    throw validation('At least one application is required.');
  }

  const [payment] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(
      and(eq(paymentsReceived.id, input.paymentId), eq(paymentsReceived.companyId, ctx.companyId)),
    );
  if (!payment) throw notFound('Payment');
  if (payment.voidedAt) {
    throw new ServiceError('CONFLICT', 'Cannot apply a voided payment.');
  }

  // Validate and sum amounts.
  let sumApplied = Money.zero();
  for (const app of input.applications) {
    const applied = Money.of(app.amountApplied);
    if (!applied.greaterThan(0)) throw validation('Each applied amount must be greater than zero.');
    sumApplied = sumApplied.plus(applied);
  }
  const unapplied = Money.of(payment.unapplied);
  if (sumApplied.greaterThan(unapplied)) {
    throw validation(
      `Sum of applications (${toAmountString(sumApplied)}) exceeds the payment's unapplied balance (${toAmountString(unapplied)}).`,
    );
  }

  // Duplicate-id guard (same rationale as receivePayment).
  const invoiceIds = input.applications.map((a) => a.invoiceId);
  if (new Set(invoiceIds).size !== invoiceIds.length) {
    throw validation(
      'Duplicate invoiceId in applications — combine the amounts into a single application per invoice.',
    );
  }

  const invoiceRows = await ctx.db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      balanceDue: invoices.balanceDue,
      status: invoices.status,
      currency: invoices.currency,
      exchangeRate: invoices.exchangeRate,
    })
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, invoiceIds)));
  // A Currency field holding the home code (any case) or a lower-case foreign code is the same
  // currency as the normalised code; compare normalised codes, as postPayment does.
  for (const r of invoiceRows) r.currency = await normalizeCurrency(ctx, r.currency);
  const paymentCurrency = await normalizeCurrency(ctx, payment.currency);
  const invoiceById = new Map(invoiceRows.map((r) => [r.id, r]));

  for (const app of input.applications) {
    const inv = invoiceById.get(app.invoiceId);
    if (!inv) throw notFound(`Invoice ${app.invoiceId}`);
    if (inv.customerId !== payment.customerId) {
      throw validation(`Invoice ${app.invoiceId} does not belong to the payment's customer.`);
    }
    if (inv.status === 'void') {
      throw validation(`Invoice ${app.invoiceId} is voided and cannot receive payments.`);
    }
    if (inv.status === 'draft') {
      // A pending invoice posted nothing to A/R; paying it would credit A/R with no matching charge.
      throw validation('That invoice is still a draft. Post it before applying a payment to it.');
    }
    if ((inv.currency ?? null) !== paymentCurrency) {
      throw validation(
        `Invoice ${app.invoiceId} currency (${inv.currency ?? 'home'}) does not match payment currency (${paymentCurrency ?? 'home'}).`,
      );
    }
    if (Money.of(app.amountApplied).greaterThan(inv.balanceDue)) {
      throw validation(
        `Applied amount (${toAmountString(app.amountApplied)}) for invoice ${app.invoiceId} exceeds its balance due (${toAmountString(inv.balanceDue)}).`,
      );
    }
  }

  // Existing application rows for this payment — merge instead of inserting duplicates.
  const existingApps = await ctx.db
    .select()
    .from(paymentApplications)
    .where(eq(paymentApplications.paymentId, input.paymentId));
  const existingByInvoice = new Map(existingApps.map((a) => [a.invoiceId, a]));

  const arAccountId = await getArAccountId(ctx);

  return inTransaction(ctx, async (tx) => {
    let unappliedLeft = unapplied; // p1 fx: running payment credit for the FX relief rule
    for (const app of input.applications) {
      const applied = Money.round2(app.amountApplied);
      const appliedStr = toAmountString(applied);
      const inv = invoiceById.get(app.invoiceId)!;

      // FX plug if the invoice was booked at a different rate than the payment settled at (p1 fx:
      // before the application row changes, so the home amount still open is read as it was).
      // Home A/R relieved on the invoice (the payoff application clears its whole open home amount).
      const { invoiceHome: relief } = await postFxAdjustmentForApplication(tx, {
        amount: applied,
        invoiceId: app.invoiceId,
        invoiceCurrency: inv.currency,
        invoiceRate: inv.exchangeRate,
        invoiceBalanceBefore: inv.balanceDue,
        paymentId: input.paymentId,
        paymentRate: payment.exchangeRate,
        unappliedBefore: unappliedLeft,
        arAccountId,
        date: new Date(),
        sign: 1,
        description: 'FX adjustment — unapplied payment applied to invoice',
        sourceRef: `payment:${input.paymentId}`,
      });
      const existing = existingByInvoice.get(app.invoiceId);
      if (existing) {
        const prevHome = applicationHome(existing, Money.of(inv.exchangeRate ?? 1));
        await tx.db
          .update(paymentApplications)
          .set({
            amountApplied: toAmountString(Money.of(existing.amountApplied).plus(applied)),
            amountHome: toAmountString(prevHome.plus(relief)),
          })
          .where(eq(paymentApplications.id, existing.id));
      } else {
        await tx.db.insert(paymentApplications).values({
          paymentId: input.paymentId,
          invoiceId: app.invoiceId,
          amountApplied: appliedStr,
          amountHome: toAmountString(relief),
        });
      }

      await markPaidAmount(tx, app.invoiceId, appliedStr);

      unappliedLeft = unappliedLeft.minus(applied);
    }

    const newUnapplied = Money.round2(unapplied.minus(sumApplied));
    const [updatedPayment] = await tx.db
      .update(paymentsReceived)
      .set({ unapplied: toAmountString(newUnapplied) })
      .where(eq(paymentsReceived.id, input.paymentId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'payment_received',
      entityId: input.paymentId,
      oldValues: { unapplied: toAmountString(unapplied) },
      newValues: {
        action: 'apply',
        applications: input.applications,
        unapplied: toAmountString(newUnapplied),
      },
    });

    return updatedPayment;
  });
}

export interface RefundPaymentInput {
  paymentId: string;
  /** Bank account the refund is paid from. */
  bankAccountId: string;
  /** Refund amount in the PAYMENT's currency; must be <= the payment's unapplied balance. */
  amount: string | number;
  date?: Date | null;
  memo?: string | null;
}

/**
 * Refund (part of) a payment's unapplied balance to the customer — e.g. an
 * overpayment returned by check.
 *
 * Posting (base currency; for a foreign payment the home value is the change in the credit's
 * home value, homeAt(unapplied before) - homeAt(unapplied after), at the payment rate):
 *   Dr  A/R (1200)      amount * rate   — removes the customer-credit sitting in A/R
 *   Cr  bank account    amount * rate   — money leaves the bank
 *
 * The unapplied remainder was credited to A/R at the settlement rate when the
 * payment was received, so debiting A/R at the same rate clears it exactly:
 * A/R control stays equal to the open-invoice / open-credit subledger.
 */
export async function refundPayment(ctx: ServiceContext, input: RefundPaymentInput) {
  const [payment] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(
      and(eq(paymentsReceived.id, input.paymentId), eq(paymentsReceived.companyId, ctx.companyId)),
    );
  if (!payment) throw notFound('Payment');
  if (payment.voidedAt) {
    throw new ServiceError('CONFLICT', 'Cannot refund a voided payment.');
  }

  const amount = Money.round2(input.amount);
  if (!amount.greaterThan(0)) throw validation('Refund amount must be greater than zero.');
  const unapplied = Money.of(payment.unapplied);
  if (amount.greaterThan(unapplied)) {
    throw validation(
      `Refund amount (${toAmountString(amount)}) exceeds the payment's unapplied balance (${toAmountString(unapplied)}).`,
    );
  }

  // Validate the bank account: must be a company-owned bank/cash asset.
  const [bankAcct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, input.bankAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!bankAcct) throw notFound('Bank account');
  // Bank accounts, Undeposited Funds or another cash-like current asset (lib/accountTypes.ts).
  if (!isDepositTargetAccount(bankAcct)) {
    throw validation('Refunds must be paid from a bank/cash account.');
  }

  const arAccountId = await getArAccountId(ctx);
  const rate = Money.of(payment.exchangeRate ?? 1);
  // p1 fx: the credit's home value is telescoped exactly like apply/unapply
  // (homeAt(unapplied before) - homeAt(unapplied after)), so A/R stays equal to the aging
  // after any number of partial refunds and a refund of the whole remainder clears it exactly.
  // `todayAmount` telescopes today's credit; the refund itself telescopes the credit AS OF its own
  // date (a refund backdated before applies / later refunds entered earlier), and dated plugs
  // (postPaymentCreditFxPlugs) re-telescope the later steps, so A/R equals the aging on every date.
  const refundDate = input.date ?? new Date();
  const todayAmount = Money.round2(homeAt(unapplied, rate).minus(homeAt(Money.round2(unapplied.minus(amount)), rate)));
  let baseAmount = todayAmount;
  if (!rate.equals(1)) {
    const events = (await paymentCreditEvents(ctx, [payment], { after: refundDate })).get(payment.id);
    const thenUnapplied = unappliedAsOf(unapplied, events, refundDate);
    if (thenUnapplied.greaterThanOrEqualTo(amount)) {
      baseAmount = Money.round2(homeAt(thenUnapplied, rate).minus(homeAt(Money.round2(thenUnapplied.minus(amount)), rate)));
    }
  }

  return inTransaction(ctx, async (tx) => {
    const entry = await postJournalEntry(tx, {
      date: refundDate,
      description: input.memo ?? 'Refund of unapplied customer payment',
      sourceRef: `refund:${input.paymentId}`,
      lines: [
        {
          accountId: arAccountId,
          debit: toAmountString(baseAmount),
          memo: 'Customer overpayment refunded',
          controlLine: true,
        },
        {
          accountId: input.bankAccountId,
          credit: toAmountString(baseAmount),
          memo: 'Refund paid to customer',
          // p1 fx: refunded from a bank in the payment's currency -> register shows the foreign amount.
          ...(payment.currency && bankAcct.currency === payment.currency ? { foreignAmount: toAmountString(amount) } : {}),
        },
      ],
    });

    const newUnapplied = Money.round2(unapplied.minus(amount));
    const [updatedPayment] = await tx.db
      .update(paymentsReceived)
      .set({ unapplied: toAmountString(newUnapplied) })
      .where(eq(paymentsReceived.id, input.paymentId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'payment_received',
      entityId: input.paymentId,
      oldValues: { unapplied: toAmountString(unapplied) },
      newValues: {
        action: 'refund',
        amount: toAmountString(amount),
        bankAccountId: input.bankAccountId,
        unapplied: toAmountString(newUnapplied),
        postedEntryId: entry.id,
      },
    });

    // p1 fx: later-dated steps of the credit (applies / unapplies / refunds entered before this
    // backdated refund) now telescope from a different credit: re-plug them on their own dates.
    if (!rate.equals(1)) {
      await postPaymentCreditFxPlugs(tx, {
        payment,
        arAccountId,
        from: refundDate,
        rate,
        unappliedNow: newUnapplied,
        total: Money.round2(baseAmount.minus(todayAmount)),
        description: 'Exchange rounding on refund of a foreign-currency payment',
      });
    }

    return { payment: updatedPayment, entry };
  });
}
