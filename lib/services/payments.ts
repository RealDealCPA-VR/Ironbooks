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
import { and, eq, inArray } from 'drizzle-orm';
import {
  accounts,
  customers,
  depositLines,
  invoices,
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
import { markPaidAmount } from './invoices';

// ---- Types ------------------------------------------------------------------

export interface PaymentApplication {
  invoiceId: string;
  amountApplied: string | number;
}

export interface ReceivePaymentInput {
  customerId: string;
  date: Date;
  /** Payment method (cash|check|credit_card|ach|bank_transfer|other). */
  method: 'cash' | 'check' | 'credit_card' | 'ach' | 'bank_transfer' | 'other';
  reference?: string | null;
  /** Total payment amount received from the customer. */
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

/** Find or create the Exchange Gain/Loss expense account (code 6900) for realized FX. */
async function getOrCreateExchangeGainLossId(ctx: ServiceContext): Promise<string> {
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

// ---- Public API -------------------------------------------------------------

/**
 * Record a payment received from a customer, post the GL entry, and apply the
 * payment to one or more open invoices.
 *
 * Posting:
 *   Dr  depositAccount    amount   (asset increases — cash/undeposited funds)
 *   Cr  A/R (1200)        amount   (asset decreases — customer owes less)
 */
export async function receivePayment(ctx: ServiceContext, input: ReceivePaymentInput) {
  // --- Validate customer belongs to this company ---
  const [customer] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.companyId, ctx.companyId)));
  if (!customer) throw notFound('Customer');

  // --- Validate amount ---
  const totalAmount = Money.of(input.amount);
  if (!totalAmount.greaterThan(0)) throw validation('Payment amount must be greater than zero.');

  // --- Validate currency / exchange rate (defaults: base currency at 1.0) ---
  const paymentCurrency = input.currency ?? null;
  const paymentRate = Money.of(input.exchangeRate ?? 1);
  if (paymentRate.lessThanOrEqualTo(0)) throw validation('Exchange rate must be positive.');

  // --- Validate and sum applications ---
  let sumApplied = Money.zero();
  for (const app of input.applications) {
    const applied = Money.of(app.amountApplied);
    if (!applied.greaterThan(0)) throw validation('Each applied amount must be greater than zero.');
    sumApplied = sumApplied.plus(applied);
  }
  if (sumApplied.greaterThan(totalAmount)) {
    throw validation(
      `Sum of applications (${toAmountString(sumApplied)}) exceeds payment amount (${toAmountString(totalAmount)}).`,
    );
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

  const invoiceRows =
    invoiceIds.length > 0
      ? await ctx.db
          .select({
            id: invoices.id,
            customerId: invoices.customerId,
            balanceDue: invoices.balanceDue,
            amountPaid: invoices.amountPaid,
            status: invoices.status,
            currency: invoices.currency,
            exchangeRate: invoices.exchangeRate,
          })
          .from(invoices)
          .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, invoiceIds)))
      : [];

  const invoiceById = new Map(invoiceRows.map((r) => [r.id, r]));
  for (const app of input.applications) {
    const inv = invoiceById.get(app.invoiceId);
    if (!inv) throw notFound(`Invoice ${app.invoiceId}`);
    if (inv.customerId !== input.customerId) {
      throw validation(`Invoice ${app.invoiceId} does not belong to the specified customer.`);
    }
    if (inv.status === 'void') {
      throw validation(`Invoice ${app.invoiceId} is voided and cannot receive payments.`);
    }
    // The balanceDue comparison below is in TRANSACTION currency, so the invoice's
    // currency must match the payment's currency.
    if ((inv.currency ?? null) !== paymentCurrency) {
      throw validation(
        `Invoice ${app.invoiceId} currency (${inv.currency ?? 'base'}) does not match payment currency (${paymentCurrency ?? 'base'}).`,
      );
    }
    // Reject over-application: an application cannot exceed the invoice's balance due,
    // otherwise amountPaid is inflated above the invoice total and funds are lost.
    if (Money.of(app.amountApplied).greaterThan(inv.balanceDue)) {
      throw validation(
        `Applied amount (${toAmountString(app.amountApplied)}) for invoice ${app.invoiceId} exceeds its balance due (${toAmountString(inv.balanceDue)}).`,
      );
    }
  }

  // --- Resolve deposit account (default: Undeposited Funds) ---
  const depositAccountId =
    input.depositAccountId ?? (await getUndepositedFundsId(ctx));

  // Confirm the deposit account is actually in this company.
  const [depAcct] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, depositAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!depAcct) throw notFound('Deposit account');

  const arAccountId = await getArAccountId(ctx);
  const amountStr = toAmountString(totalAmount);
  const unapplied = Money.sub(totalAmount, sumApplied);

  // --- Base-currency GL amounts ---
  // Deposit account is debited at the settlement rate. A/R is credited at the rate each
  // invoice was BOOKED at (plus any unapplied remainder at the settlement rate), so the
  // A/R control account clears exactly what createInvoice debited. The difference is
  // realized FX gain/loss.
  const cashBase = Money.round2(Money.mul(totalAmount, paymentRate));
  let arBase = Money.zero();
  for (const app of input.applications) {
    const inv = invoiceById.get(app.invoiceId)!;
    arBase = arBase.plus(
      Money.round2(Money.mul(Money.of(app.amountApplied), Money.of(inv.exchangeRate ?? 1))),
    );
  }
  if (unapplied.greaterThan(0)) {
    arBase = arBase.plus(Money.round2(Money.mul(unapplied, paymentRate)));
  }
  const fxDiff = Money.round2(cashBase.minus(arBase)); // > 0 = gain, < 0 = loss

  // Resolve the FX gain/loss account only when there is a difference to post.
  const fxAccountId = fxDiff.isZero() ? null : await getOrCreateExchangeGainLossId(ctx);

  // --- Everything below runs atomically ---
  return inTransaction(ctx, async (tx) => {
    // 1. Post the GL entry: Dr deposit account / Cr A/R (+ FX gain/loss plug)
    const postingLines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string }> = [
      { accountId: depositAccountId, debit: toAmountString(cashBase), memo: 'Payment received' },
      { accountId: arAccountId, credit: toAmountString(arBase), memo: 'A/R reduction' },
    ];
    if (fxAccountId && fxDiff.greaterThan(0)) {
      postingLines.push({
        accountId: fxAccountId,
        credit: toAmountString(fxDiff),
        memo: 'Realized exchange gain',
      });
    } else if (fxAccountId && fxDiff.lessThan(0)) {
      postingLines.push({
        accountId: fxAccountId,
        debit: toAmountString(Money.abs(fxDiff)),
        memo: 'Realized exchange loss',
      });
    }

    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Payment received from customer`,
      reference: input.reference ?? null,
      sourceRef: `customer:${input.customerId}`,
      lines: postingLines,
    });

    // 2. Insert the paymentsReceived record
    const [payment] = await tx.db
      .insert(paymentsReceived)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        date: input.date,
        method: input.method,
        reference: input.reference ?? null,
        amount: amountStr,
        unapplied: toAmountString(unapplied),
        currency: paymentCurrency,
        exchangeRate: paymentRate.toFixed(6),
        depositAccountId,
        postedEntryId: entry.id,
      })
      .returning();

    // 3. Insert payment applications and update invoices
    for (const app of input.applications) {
      const applied = Money.of(app.amountApplied);
      const appliedStr = toAmountString(applied);

      // Insert application row
      await tx.db.insert(paymentApplications).values({
        paymentId: payment.id,
        invoiceId: app.invoiceId,
        amountApplied: appliedStr,
      });

      // Update invoice via the canonical helper — it re-reads the row inside this
      // transaction (no stale snapshots) and computes balanceDue against the billed
      // base (total minus retainage), keeping the subledger in sync with the GL.
      await markPaidAmount(tx, app.invoiceId, appliedStr);
    }

    // 4. Audit log
    await writeAudit(tx, {
      action: 'create',
      entityType: 'payment_received',
      entityId: payment.id,
      newValues: {
        customerId: input.customerId,
        amount: amountStr,
        method: input.method,
        applications: input.applications,
        postedEntryId: entry.id,
      },
    });

    return { payment, entry };
  });
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

  return { ...payment, applications };
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
 * Void a received payment.
 *
 * Reverses the GL entry (voidJournalEntry — guards closed periods and lines cleared
 * in a completed reconciliation), rolls every applied invoice back via markPaidAmount
 * with a negative delta, deletes the application rows, and stamps voidedAt.
 *
 * Blocked while the payment is included in a deposit (void/undo the deposit first),
 * otherwise the deposit's GL entry would reference funds that no longer exist.
 */
export async function voidPayment(ctx: ServiceContext, id: string) {
  const [payment] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.id, id), eq(paymentsReceived.companyId, ctx.companyId)));
  if (!payment) throw notFound('Payment');
  if (payment.voidedAt) return { ...payment, applications: [] }; // idempotent

  // Guard: payment already swept into a deposit.
  const [deposited] = await ctx.db
    .select({ id: depositLines.id })
    .from(depositLines)
    .where(eq(depositLines.paymentId, id))
    .limit(1);
  if (deposited) {
    throw new ServiceError(
      'CONFLICT',
      'This payment has been included in a deposit and cannot be voided. Remove or void the deposit first.',
    );
  }

  const applications = await ctx.db
    .select()
    .from(paymentApplications)
    .where(eq(paymentApplications.paymentId, id));

  return inTransaction(ctx, async (tx) => {
    // 1. Reverse the GL entry (includes any FX gain/loss lines posted with it).
    if (payment.postedEntryId) {
      await voidJournalEntry(tx, payment.postedEntryId);
    }

    // 2. Roll back each invoice's amountPaid / balanceDue / status.
    for (const app of applications) {
      await markPaidAmount(tx, app.invoiceId, toAmountString(Money.neg(app.amountApplied)));
    }

    // 3. Remove application rows (history is preserved in the audit log).
    await tx.db.delete(paymentApplications).where(eq(paymentApplications.paymentId, id));

    // 4. Stamp the payment void.
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
        })),
      },
      newValues: { voided: true },
    });

    return { ...updated, applications: [] };
  });
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
    if (remaining.isZero()) {
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
  // Bank accounts, Undeposited Funds or another cash-like current asset (lib/accountTypes.ts).
  if (!isDepositTargetAccount(bankAcct)) {
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
