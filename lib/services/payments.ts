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
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  accounts,
  bouncedChecks,
  creditApplications,
  creditMemos,
  customers,
  depositLines,
  deposits,
  invoices,
  journalEntries,
  paymentsReceived,
  paymentApplications,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry } from './posting';
import { createInvoice, markPaidAmount } from './invoices';
import { applyToInvoice, unapplyCreditApplication } from './creditMemos';

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
): Promise<{ id: string; type: string; subtype: string | null; code: string | null }> {
  const [acct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, code: accounts.code })
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
 * TODO(wave2 lists): when lib/services/lists/terms.ts (the Terms list with discountPercent /
 * discountDays) lands on main, resolve the customer's terms record there first and fall back to
 * this parser for legacy free-text terms.
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
  return rows.map((r) => {
    const terms = r.terms ?? cust.terms ?? null;
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
  kind: 'credit_memo' | 'payment';
  id: string;
  /** Credit memo number, or the payment's reference. */
  ref: string;
  date: string;
  available: string;
}

/** Open credits a customer can use in Receive Payments: credit memos + unapplied payments. */
export async function listAvailableCredits(ctx: ServiceContext, customerId: string): Promise<AvailableCredit[]> {
  const memos = await ctx.db
    .select({ id: creditMemos.id, memoNumber: creditMemos.memoNumber, date: creditMemos.date, unapplied: creditMemos.unapplied })
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
      ref: `Credit Memo #${m.memoNumber}`,
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
  return inTransaction(ctx, (tx) => postPayment(tx, input, null));
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

  // --- Validate currency / exchange rate (defaults: base currency at 1.0) ---
  const paymentCurrency = input.currency ?? null;
  const paymentRate = Money.of(input.exchangeRate ?? 1);
  if (paymentRate.lessThanOrEqualTo(0)) throw validation('Exchange rate must be positive.');

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
  if (sumApplied.greaterThan(totalAmount)) {
    throw validation(
      `Sum of applications (${toAmountString(sumApplied)}) exceeds payment amount (${toAmountString(totalAmount)}).`,
    );
  }
  let sumCredits = Money.zero();
  for (const c of credits) {
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

  const allInvoiceIds = [...new Set([...invoiceIds, ...credits.map((c) => c.invoiceId)])];
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
            currency: invoices.currency,
            exchangeRate: invoices.exchangeRate,
          })
          .from(invoices)
          .where(and(eq(invoices.companyId, tx.companyId), inArray(invoices.id, allInvoiceIds)))
      : [];

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
    return inv;
  };
  for (const app of input.applications) {
    const inv = checkInvoice(app.invoiceId);
    // The balanceDue comparison below is in TRANSACTION currency, so the invoice's
    // currency must match the payment's currency.
    if ((inv.currency ?? null) !== paymentCurrency) {
      throw validation(
        `Invoice ${app.invoiceId} currency (${inv.currency ?? 'base'}) does not match payment currency (${paymentCurrency ?? 'base'}).`,
      );
    }
    addRequested(app.invoiceId, Money.round2(app.amountApplied ?? 0).plus(Money.round2(app.discountAmount ?? 0)));
  }
  for (const c of credits) {
    const inv = checkInvoice(c.invoiceId);
    if (inv.currency) {
      throw validation(`Credits can only be applied to invoices in your home currency (invoice #${inv.invoiceNumber}).`);
    }
    addRequested(c.invoiceId, Money.round2(c.amount));
  }
  // Reject over-application: cash + discount + credits on one invoice cannot exceed its balance
  // due, otherwise amountPaid is inflated above the invoice total and funds are lost.
  for (const [invoiceId, requested] of requestedByInvoice) {
    const inv = invoiceById.get(invoiceId)!;
    if (requested.greaterThan(Money.of(inv.balanceDue))) {
      throw validation(
        `Applied amount (${toAmountString(requested)}) for invoice ${invoiceId} exceeds its balance due (${toAmountString(inv.balanceDue)}).`,
      );
    }
  }

  // Credit memos: same customer, not void, enough unapplied credit.
  const memoIds = [...new Set(credits.map((c) => c.creditMemoId))];
  if (memoIds.length > 0) {
    const memoRows = await tx.db
      .select({ id: creditMemos.id, customerId: creditMemos.customerId, status: creditMemos.status, unapplied: creditMemos.unapplied, memoNumber: creditMemos.memoNumber })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, tx.companyId), inArray(creditMemos.id, memoIds)));
    const memoById = new Map(memoRows.map((m) => [m.id, m]));
    for (const id of memoIds) {
      const m = memoById.get(id);
      if (!m) throw notFound(`Credit memo ${id}`);
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
  const unapplied = Money.sub(totalAmount, sumApplied);

  // --- Base-currency GL amounts ---
  // Deposit account is debited at the settlement rate. A/R is credited at the rate each
  // invoice was BOOKED at (plus any unapplied remainder at the settlement rate), so the
  // A/R control account clears exactly what createInvoice debited. The difference is
  // realized FX gain/loss. Discounts are converted at the invoice's booked rate on both sides.
  const cashBase = Money.round2(Money.mul(totalAmount, paymentRate));
  let arBase = Money.zero();
  let discountBase = Money.zero();
  for (const app of input.applications) {
    const inv = invoiceById.get(app.invoiceId)!;
    const rate = Money.of(inv.exchangeRate ?? 1);
    arBase = arBase.plus(Money.round2(Money.mul(Money.round2(app.amountApplied ?? 0), rate)));
    discountBase = discountBase.plus(Money.round2(Money.mul(Money.round2(app.discountAmount ?? 0), rate)));
  }
  if (unapplied.greaterThan(0)) {
    arBase = arBase.plus(Money.round2(Money.mul(unapplied, paymentRate)));
  }
  const fxDiff = Money.round2(cashBase.minus(arBase)); // > 0 = gain, < 0 = loss
  const fxAccountId = fxDiff.isZero() ? null : await getOrCreateExchangeGainLossId(tx);

  // 1. Post the GL entry: Dr deposit / Dr discount / Cr A/R (+ FX gain/loss plug). A payment
  //    that only applies credits posts nothing (the credits already relieved A/R).
  const postingLines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string }> = [];
  if (cashBase.greaterThan(0)) {
    postingLines.push({ accountId: depositAccountId, debit: toAmountString(cashBase), memo: 'Payment received' });
  }
  if (discountAccountId && discountBase.greaterThan(0)) {
    postingLines.push({ accountId: discountAccountId, debit: toAmountString(discountBase), memo: 'Early-payment discount' });
  }
  const arCredit = arBase.plus(discountBase);
  if (arCredit.greaterThan(0)) {
    postingLines.push({ accountId: arAccountId, credit: toAmountString(arCredit), memo: 'A/R reduction' });
  }
  if (fxAccountId && fxDiff.greaterThan(0)) {
    postingLines.push({ accountId: fxAccountId, credit: toAmountString(fxDiff), memo: 'Realized exchange gain' });
  } else if (fxAccountId && fxDiff.lessThan(0)) {
    postingLines.push({ accountId: fxAccountId, debit: toAmountString(Money.abs(fxDiff)), memo: 'Realized exchange loss' });
  }

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
    });
    // Update invoice via the canonical helper — it re-reads the row inside this
    // transaction (no stale snapshots) and computes balanceDue against the billed
    // base (total minus retainage), keeping the subledger in sync with the GL.
    await markPaidAmount(tx, app.invoiceId, toAmountString(applied.plus(discount)));
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
      credits,
      discountTotal: toAmountString(sumDiscount),
      discountAccountId,
      postedEntryId: entry?.id ?? null,
    },
  });

  return { payment, entry };
}

/** List all payments received for the company, newest first. */
export async function listPayments(
  ctx: ServiceContext,
  opts?: { customerId?: string; limit?: number; offset?: number },
) {
  // Build conditions
  const rows = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(
      opts?.customerId
        ? and(
            eq(paymentsReceived.companyId, ctx.companyId),
            eq(paymentsReceived.customerId, opts.customerId),
          )
        : eq(paymentsReceived.companyId, ctx.companyId),
    )
    .limit(opts?.limit ?? 100)
    .offset(opts?.offset ?? 0);
  return rows;
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

  return { ...payment, applications, credits, bounced: bounced ?? null };
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
    amount: Parameters<typeof Money.of>[0];
    invoiceRate: string | number | null | undefined;
    paymentRate: string | number | null | undefined;
    arAccountId: string;
    date: Date;
    sign: 1 | -1;
    description: string;
    sourceRef: string;
  },
) {
  const amt = Money.of(params.amount);
  const delta = Money.round2(
    Money.mul(amt, Money.of(params.invoiceRate ?? 1)).minus(
      Money.mul(amt, Money.of(params.paymentRate ?? 1)),
    ),
  ).times(params.sign);
  if (delta.isZero()) return null;

  const fxAccountId = await getOrCreateExchangeGainLossId(tx);
  // delta > 0: A/R needs an EXTRA credit (loss); delta < 0: A/R credit shrinks (gain).
  const lines =
    delta.greaterThan(0)
      ? [
          { accountId: fxAccountId, debit: toAmountString(delta), memo: 'Realized exchange loss' },
          { accountId: params.arAccountId, credit: toAmountString(delta), memo: 'A/R FX adjustment' },
        ]
      : [
          { accountId: params.arAccountId, debit: toAmountString(Money.abs(delta)), memo: 'A/R FX adjustment' },
          { accountId: fxAccountId, credit: toAmountString(Money.abs(delta)), memo: 'Realized exchange gain' },
        ];
  return postJournalEntry(tx, {
    date: params.date,
    description: params.description,
    sourceRef: params.sourceRef,
    lines,
  });
}

/**
 * Guards shared by void and edit: a payment swept into a deposit, refunded, or recorded as
 * bounced cannot be reversed here (the later transaction depends on it).
 */
async function assertPaymentReversible(
  ctx: ServiceContext,
  payment: { id: string; bouncedAt: Date | null },
  verb: 'voided' | 'edited',
) {
  if (payment.bouncedAt) {
    throw new ServiceError(
      'CONFLICT',
      `This payment was recorded as a bounced check, so it cannot be ${verb}.`,
    );
  }
  // Guard: payment already swept into a deposit (a void deposit releases it again).
  const [deposited] = await ctx.db
    .select({ id: depositLines.id })
    .from(depositLines)
    .innerJoin(deposits, eq(deposits.id, depositLines.depositId))
    .where(and(eq(depositLines.paymentId, payment.id), isNull(deposits.voidedAt)))
    .limit(1);
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

/**
 * Undo everything a payment posted (inside the caller's transaction): its GL entry and any
 * FX adjustment entries made when it was applied/unapplied later, every invoice application
 * (cash + discount), and the credit memos applied with it.
 */
async function reversePaymentEffects(
  tx: ServiceContext,
  payment: { id: string; postedEntryId: string | null },
) {
  const applications = await tx.db
    .select()
    .from(paymentApplications)
    .where(eq(paymentApplications.paymentId, payment.id));

  // 1. Reverse the GL entry (includes any FX gain/loss and discount lines posted with it).
  if (payment.postedEntryId) {
    await voidJournalEntry(tx, payment.postedEntryId);
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

  // 4. Undo credit memos applied with this payment.
  const creditApps = await tx.db
    .select({ id: creditApplications.id })
    .from(creditApplications)
    .where(and(eq(creditApplications.companyId, tx.companyId), eq(creditApplications.paymentId, payment.id)));
  for (const ca of creditApps) await unapplyCreditApplication(tx, ca.id);

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
  await assertPaymentReversible(ctx, payment, 'edited');

  return inTransaction(ctx, async (tx) => {
    const oldCredits = await tx.db
      .select({ creditMemoId: creditApplications.creditMemoId, invoiceId: creditApplications.invoiceId, amount: creditApplications.amount })
      .from(creditApplications)
      .where(and(eq(creditApplications.companyId, tx.companyId), eq(creditApplications.paymentId, id)));
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
      },
      newValues: { action: 'edit' },
    });
    return postPayment(tx, input, id);
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
    .select({ bankAccountId: deposits.depositAccountId })
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
    const lines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string }> = [
      { accountId: arAccountId, debit: toAmountString(amount.plus(discountTotal)), memo: 'Bounced check — amount owed again' },
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
    .select({ exchangeRate: invoices.exchangeRate })
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, ctx.companyId)));
  if (!invoice) throw notFound('Invoice');

  const arAccountId = await getArAccountId(ctx);

  return inTransaction(ctx, async (tx) => {
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
        .set({ amountApplied: toAmountString(remaining) })
        .where(eq(paymentApplications.id, app.id));
    }

    // 3. Free the amount back onto the payment.
    const newUnapplied = Money.round2(Money.of(payment.unapplied).plus(amount));
    const [updatedPayment] = await tx.db
      .update(paymentsReceived)
      .set({ unapplied: toAmountString(newUnapplied) })
      .where(eq(paymentsReceived.id, input.paymentId))
      .returning();

    // 4. FX plug if the invoice was booked at a different rate than the payment.
    await postFxAdjustmentForApplication(tx, {
      amount,
      invoiceRate: invoice.exchangeRate,
      paymentRate: payment.exchangeRate,
      arAccountId,
      date: new Date(),
      sign: -1,
      description: 'FX adjustment — payment unapplied from invoice',
      sourceRef: `payment:${input.paymentId}`,
    });

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
    if ((inv.currency ?? null) !== (payment.currency ?? null)) {
      throw validation(
        `Invoice ${app.invoiceId} currency (${inv.currency ?? 'base'}) does not match payment currency (${payment.currency ?? 'base'}).`,
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
    for (const app of input.applications) {
      const applied = Money.round2(app.amountApplied);
      const appliedStr = toAmountString(applied);
      const inv = invoiceById.get(app.invoiceId)!;

      const existing = existingByInvoice.get(app.invoiceId);
      if (existing) {
        await tx.db
          .update(paymentApplications)
          .set({
            amountApplied: toAmountString(Money.of(existing.amountApplied).plus(applied)),
          })
          .where(eq(paymentApplications.id, existing.id));
      } else {
        await tx.db.insert(paymentApplications).values({
          paymentId: input.paymentId,
          invoiceId: app.invoiceId,
          amountApplied: appliedStr,
        });
      }

      await markPaidAmount(tx, app.invoiceId, appliedStr);

      // FX plug if the invoice was booked at a different rate than the payment settled at.
      await postFxAdjustmentForApplication(tx, {
        amount: applied,
        invoiceRate: inv.exchangeRate,
        paymentRate: payment.exchangeRate,
        arAccountId,
        date: new Date(),
        sign: 1,
        description: 'FX adjustment — unapplied payment applied to invoice',
        sourceRef: `payment:${input.paymentId}`,
      });
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
 * Posting (base currency, at the payment's original settlement rate):
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
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.id, input.bankAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!bankAcct) throw notFound('Bank account');
  if (
    bankAcct.type !== 'asset' ||
    bankAcct.subtype === 'accounts_receivable' ||
    bankAcct.subtype === 'inventory'
  ) {
    throw validation('Refunds must be paid from a bank/cash account.');
  }

  const arAccountId = await getArAccountId(ctx);
  const rate = Money.of(payment.exchangeRate ?? 1);
  const baseAmount = Money.round2(Money.mul(amount, rate));
  const refundDate = input.date ?? new Date();

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
        },
        {
          accountId: input.bankAccountId,
          credit: toAmountString(baseAmount),
          memo: 'Refund paid to customer',
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

    return { payment: updatedPayment, entry };
  });
}
