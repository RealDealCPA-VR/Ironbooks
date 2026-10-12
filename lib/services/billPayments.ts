/**
 * Bill Payments (A/P) service — Pay Bills workflow.
 *
 * A bill payment settles one or more open bills for a vendor. The GL impact is:
 *   Dr  Accounts Payable  (2000)  [reduce liability]
 *   Cr  Payment Account          [reduce asset, e.g. Checking 1000]
 *   Cr  Discount account         [early-payment discounts taken, when any]
 *
 * Multi-currency (wave2 J10): a payment is in the currency of the bills it pays (all applied
 * bills must share one currency). A/P is relieved at the rate each bill was BOOKED at (the final
 * payment of a bill relieves exactly what is left of its home-currency A/P, so A/P clears to the
 * penny); cash and discounts are converted at the payment's rate; the difference is realized
 * exchange gain/loss on 6900 Exchange Gain/Loss.
 *
 * Print queue (wave2 D3): a check payment saved with toPrint has no number until it is printed
 * (markBillPaymentPrinted stamps the number on the payment and its journal entry).
 *
 * Edit after save (wave2 D1): updateBillPayment re-applies the payment in ONE transaction —
 * a header-only change (number / print flag) keeps the entry; anything else voids the entry,
 * rolls the bills back, and posts the new payment on the same document.
 *
 * All GL writes go through postJournalEntry; the returned entry.id is stored on
 * billPayments.postedEntryId so every payment is traceable to its journal entry.
 *
 * Multi-tenant safety: every query is scoped by ctx.companyId.
 * Money: all arithmetic uses Money/toAmountString — never JS floats.
 */
import { isPaymentSourceAccount } from '@/lib/accountTypes';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';
import {
  accounts,
  bills,
  billPayments,
  billPaymentApplications,
  journalEntries,
  journalEntryLines,
  vendors,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { assertCheckNumberAvailable, nextCheckNumber } from './checkNumbers';
import {
  getHomeCurrencyCode,
  getOrCreateExchangeGainLossAccount,
  resolveDocumentCurrency,
} from './currencies';
import { entryHasReconciledLines } from './postedEdit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentMethod = 'cash' | 'check' | 'credit_card' | 'ach' | 'bank_transfer' | 'other';

export interface BillApplication {
  billId: string;
  /** CASH amount to apply from this payment toward that bill (decimal string, bill currency). */
  amountApplied: string | number;
  /**
   * Early-payment discount taken on this bill (QB "Set Discount").
   * The bill is settled for amountApplied + discountTaken, but only amountApplied
   * leaves the bank; discountTaken is credited to input.discountAccountId.
   */
  discountTaken?: string | number | null;
}

export interface PayBillsInput {
  vendorId: string;
  date: Date;
  method: PaymentMethod;
  reference?: string | null;
  /** GL account that funds come from — e.g. Checking (1000), Credit Card (2100). */
  paymentAccountId: string;
  /**
   * Account credited with discounts taken (income "Discounts Taken" or an
   * expense contra account). Required when any application has discountTaken > 0.
   */
  discountAccountId?: string | null;
  applications: BillApplication[];
  /** Check payments only: queue for Print Checks; the number is assigned when printed. */
  toPrint?: boolean;
  /** Home units per 1 unit of the bills' currency at payment (foreign-currency bills only). */
  exchangeRate?: string | number | null;
  /** Refuse a check number already used on the account unless the user confirmed (A3). */
  checkDuplicateNumber?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the A/P account (code '2000') for a company. */
async function resolveApAccount(ctx: ServiceContext): Promise<string> {
  const [apRow] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2000')));
  if (!apRow) {
    throw new ServiceError(
      'NOT_FOUND',
      'Accounts Payable account (code 2000) not found. Seed the default chart of accounts first.',
    );
  }
  return apRow.id;
}

/** Derive a bill's docStatus from its post-payment balances. */
function deriveBillStatus(
  balanceDue: string | number,
  amountPaid: string | number,
  amountCredited: string | number,
): 'open' | 'partial' | 'paid' {
  if (Money.of(balanceDue).lessThanOrEqualTo(0)) return 'paid';
  if (Money.add(amountPaid, amountCredited).greaterThan(0)) return 'partial';
  return 'open';
}

interface PreparedRow {
  id: string;
  applied: string; // cash from this payment (bill currency)
  discount: string; // discount taken on this bill (bill currency)
  settled: string; // applied + discount — total reduction of balanceDue
  apHome: string; // home-currency A/P relieved
}

interface PreparedPayment {
  vendor: { id: string; name: string };
  apAccountId: string;
  currency: string | null;
  rate: Decimal;
  rows: PreparedRow[];
  totalStr: string; // cash, payment currency
  discountTotalStr: string;
  cashHome: Decimal;
  discountHome: Decimal;
  apHomeTotal: Decimal;
  fxAccountId: string | null;
  fxDiff: Decimal; // > 0 gain, < 0 loss
}

/**
 * Validate a Pay Bills request against CURRENT bill balances (call inside the transaction when
 * editing, after the old applications were rolled back) and compute the home-currency split.
 */
async function preparePayment(ctx: ServiceContext, input: PayBillsInput): Promise<PreparedPayment> {
  if (!input.applications || input.applications.length === 0) {
    throw validation('At least one bill application is required.');
  }
  // Reject duplicate billIds — two applications against the same bill would each be
  // validated against the bill's ORIGINAL balance, bypassing the over-application guard.
  const appBillIds = input.applications.map((a) => a.billId);
  if (new Set(appBillIds).size !== appBillIds.length) {
    throw validation('Duplicate billId in applications. Combine amounts into a single application per bill.');
  }

  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName, currency: vendors.currency })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');

  const [payAcct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, input.paymentAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!payAcct) throw notFound('Payment account');
  // The funding source must be a bank/cash asset or a credit-card liability — not, say, A/R
  // or a revenue account, which would post a nonsensical bill-payment credit.
  // QB parity: bills are paid from a Bank or Credit Card account (lib/accountTypes.ts).
  const isFundable = isPaymentSourceAccount(payAcct);
  if (!isFundable) {
    throw validation('Payment account must be a bank/cash or credit-card account.');
  }

  const apAccountId = await resolveApAccount(ctx);

  // ── load + validate each bill ───────────────────────────────────────────
  type BillRow = {
    id: string;
    vendorId: string;
    total: string;
    balanceDue: string;
    status: string;
    currency: string | null;
    exchangeRate: string | null;
  };
  const billRows: Array<{ bill: BillRow; applied: Decimal; discount: Decimal }> = [];
  for (const app of input.applications) {
    const applied = Money.of(app.amountApplied);
    const discount = Money.of(app.discountTaken ?? 0);
    if (applied.lessThanOrEqualTo(0)) {
      throw validation(`amountApplied must be positive for bill ${app.billId}.`);
    }
    if (discount.lessThan(0)) {
      throw validation(`discountTaken cannot be negative for bill ${app.billId}.`);
    }
    const [bill] = await ctx.db
      .select({
        id: bills.id,
        vendorId: bills.vendorId,
        total: bills.total,
        balanceDue: bills.balanceDue,
        status: bills.status,
        currency: bills.currency,
        exchangeRate: bills.exchangeRate,
      })
      .from(bills)
      .where(and(eq(bills.id, app.billId), eq(bills.companyId, ctx.companyId)));
    if (!bill) throw notFound(`Bill ${app.billId}`);
    if (bill.vendorId !== input.vendorId) {
      throw validation(`Bill ${app.billId} does not belong to the specified vendor.`);
    }
    if (bill.status === 'void') {
      throw new ServiceError('VALIDATION', `Bill ${app.billId} is void and cannot be paid.`);
    }
    if (bill.status === 'paid') {
      throw new ServiceError('CONFLICT', `Bill ${app.billId} is already fully paid.`);
    }
    const balance = Money.of(bill.balanceDue);
    const settled = applied.plus(discount);
    if (settled.greaterThan(balance)) {
      throw validation(
        `Amount applied plus discount (${toAmountString(settled)}) exceeds balance due ` +
          `(${toAmountString(balance)}) on bill ${app.billId}.`,
      );
    }
    billRows.push({ bill, applied, discount });
  }

  // ── currency: one currency per payment (the bills') ─────────────────────
  const currencies = [...new Set(billRows.map((r) => r.bill.currency ?? null))];
  if (currencies.length > 1) {
    throw validation('Bills in different currencies must be paid with separate payments.');
  }
  let fx: { currency: string | null; rate: Decimal };
  if (currencies[0]) {
    fx = await resolveDocumentCurrency(ctx, {
      currency: currencies[0],
      exchangeRate: input.exchangeRate,
      accountCurrency: payAcct.currency ?? null,
    });
  } else {
    const home = await getHomeCurrencyCode(ctx);
    const acctCur = (payAcct.currency ?? '').toUpperCase();
    if (acctCur && acctCur !== home) {
      throw validation(
        `The selected account is a ${acctCur} account. Pay home-currency bills from a home-currency account.`,
      );
    }
    fx = { currency: null, rate: Money.of(1) };
  }
  // A home payment account may pay foreign bills (converted at the payment rate); a foreign
  // account only pays bills in its own currency — resolveDocumentCurrency enforced that.

  // ── home-currency A/P relief per bill ────────────────────────────────────
  let total = Money.zero();
  let discountTotal = Money.zero();
  let apHomeTotal = Money.zero();
  const rows: PreparedRow[] = [];
  for (const { bill, applied, discount } of billRows) {
    const settled = applied.plus(discount);
    let apHome: Decimal;
    if (!bill.currency) {
      apHome = Money.round2(settled);
    } else {
      const billRate = Money.of(bill.exchangeRate ?? 1);
      if (settled.equals(Money.of(bill.balanceDue))) {
        // Final payment: relieve exactly the bill's remaining home A/P (anchor - prior relief).
        const billHome = Money.round2(Money.of(bill.total).times(billRate));
        const [prior] = await ctx.db
          .select({
            sum: sql<string>`COALESCE(SUM(COALESCE(${billPaymentApplications.amountHome}, ${billPaymentApplications.amountApplied})), 0)`,
          })
          .from(billPaymentApplications)
          .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
          .where(and(eq(billPaymentApplications.billId, bill.id), isNull(billPayments.voidedAt)));
        apHome = Money.round2(billHome.minus(Money.of(prior?.sum ?? 0)));
      } else {
        apHome = Money.round2(settled.times(billRate));
      }
    }
    total = total.plus(applied);
    discountTotal = discountTotal.plus(discount);
    apHomeTotal = apHomeTotal.plus(apHome);
    rows.push({
      id: bill.id,
      applied: toAmountString(applied),
      discount: toAmountString(discount),
      settled: toAmountString(settled),
      apHome: toAmountString(apHome),
    });
  }
  if (total.isZero()) throw validation('Total payment amount must be greater than zero.');

  if (discountTotal.greaterThan(0)) {
    if (!input.discountAccountId) {
      throw validation('discountAccountId is required when a discount is taken.');
    }
    const [discAcct] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, input.discountAccountId), eq(accounts.companyId, ctx.companyId)));
    if (!discAcct) throw notFound('Discount account');
  }

  const cashHome = Money.round2(total.times(fx.rate));
  const discountHome = Money.round2(discountTotal.times(fx.rate));
  if (!cashHome.greaterThan(0)) throw validation('The payment is too small to convert to your home currency.');
  const fxDiff = Money.round2(apHomeTotal.minus(cashHome).minus(discountHome));
  const fxAccountId = fxDiff.isZero() ? null : await getOrCreateExchangeGainLossAccount(ctx);

  return {
    vendor: { id: vendor.id, name: vendor.name },
    apAccountId,
    currency: fx.currency,
    rate: fx.rate,
    rows,
    totalStr: toAmountString(total),
    discountTotalStr: toAmountString(discountTotal),
    cashHome,
    discountHome,
    apHomeTotal,
    fxAccountId,
    fxDiff,
  };
}

function buildPaymentLines(prep: PreparedPayment, input: PayBillsInput, reference: string | null): PostingLine[] {
  // Dr A/P full settlement (home, at the bills' booked rates) / Cr payment account (cash) /
  // Cr discount account (discounts) / FX gain (Cr) or loss (Dr) plug on 6900.
  const lines: PostingLine[] = [
    // The payment's own A/P line (posting.ts PostingLine.controlLine).
    {
      accountId: prep.apAccountId,
      debit: toAmountString(prep.apHomeTotal),
      memo: `A/P payment to vendor ${prep.vendor.name}`,
      controlLine: true,
    },
    { accountId: input.paymentAccountId, credit: toAmountString(prep.cashHome), memo: `Bill payment — ref: ${reference ?? 'n/a'}` },
  ];
  if (prep.discountHome.greaterThan(0) && input.discountAccountId) {
    lines.push({
      accountId: input.discountAccountId,
      credit: toAmountString(prep.discountHome),
      memo: `Early-payment discounts taken — ${prep.vendor.name}`,
    });
  }
  if (prep.fxAccountId && prep.fxDiff.greaterThan(0)) {
    lines.push({ accountId: prep.fxAccountId, credit: toAmountString(prep.fxDiff), memo: 'Realized exchange gain' });
  } else if (prep.fxAccountId && prep.fxDiff.lessThan(0)) {
    lines.push({ accountId: prep.fxAccountId, debit: toAmountString(prep.fxDiff.abs()), memo: 'Realized exchange loss' });
  }
  return lines;
}

/** Insert applications + bump each bill's paid/balance (relative increments) for a payment. */
async function applyRows(tx: ServiceContext, paymentId: string, rows: PreparedRow[]) {
  for (const row of rows) {
    // amountApplied stores the FULL settlement (cash + discount) so voiding reverses the bill's
    // balanceDue and amountPaid symmetrically; amountHome is the home A/P it relieved.
    await tx.db.insert(billPaymentApplications).values({
      billPaymentId: paymentId,
      billId: row.id,
      amountApplied: row.settled,
      amountHome: row.apHome,
    });
    const [updatedBill] = await tx.db
      .update(bills)
      .set({
        amountPaid: sql`${bills.amountPaid} + ${row.settled}`,
        balanceDue: sql`${bills.balanceDue} - ${row.settled}`,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, row.id))
      .returning({
        amountPaid: bills.amountPaid,
        amountCredited: bills.amountCredited,
        balanceDue: bills.balanceDue,
      });
    const newStatus = deriveBillStatus(updatedBill.balanceDue, updatedBill.amountPaid, updatedBill.amountCredited);
    await tx.db.update(bills).set({ status: newStatus }).where(eq(bills.id, row.id));
  }
}

/** Roll every bill applied by a payment back and delete the application rows. */
async function rollbackApplications(tx: ServiceContext, paymentId: string) {
  const applications = await tx.db
    .select()
    .from(billPaymentApplications)
    .where(eq(billPaymentApplications.billPaymentId, paymentId));
  for (const app of applications) {
    const [updatedBill] = await tx.db
      .update(bills)
      .set({
        amountPaid: sql`${bills.amountPaid} - ${app.amountApplied}`,
        balanceDue: sql`${bills.balanceDue} + ${app.amountApplied}`,
        updatedAt: new Date(),
      })
      .where(and(eq(bills.id, app.billId), eq(bills.companyId, tx.companyId)))
      .returning({
        amountPaid: bills.amountPaid,
        amountCredited: bills.amountCredited,
        balanceDue: bills.balanceDue,
      });
    if (!updatedBill) throw notFound(`Bill ${app.billId}`);
    if (Money.of(updatedBill.amountPaid).lessThan(0)) {
      // Should be impossible unless the subledger was already desynced; refuse to persist a
      // negative amountPaid (the transaction rolls back).
      throw new ServiceError(
        'CONFLICT',
        `Voiding this payment would make bill ${app.billId} amountPaid negative.`,
      );
    }
    const newStatus = deriveBillStatus(updatedBill.balanceDue, updatedBill.amountPaid, updatedBill.amountCredited);
    await tx.db.update(bills).set({ status: newStatus }).where(eq(bills.id, app.billId));
  }
  await tx.db.delete(billPaymentApplications).where(eq(billPaymentApplications.billPaymentId, paymentId));
  return applications;
}

function referenceFor(input: PayBillsInput): { reference: string | null; toPrint: boolean } {
  const toPrint = Boolean(input.toPrint) && input.method === 'check';
  return { reference: toPrint ? null : input.reference?.trim() || null, toPrint };
}

// ---------------------------------------------------------------------------
// payBills
// ---------------------------------------------------------------------------

/**
 * Pay one or more open bills for a vendor in a single payment.
 *
 * Steps (all inside one transaction):
 *  1. Validate vendor / payment account / each bill (same vendor, open balance,
 *     amountApplied + discountTaken <= balanceDue, one currency).
 *  2. Post GL: Dr A/P (cash + discounts, home at booked rates), Cr payment account (cash),
 *     Cr discount account (discounts), FX gain/loss plug for foreign bills.
 *  3. Insert billPayments + billPaymentApplications rows, update each bill.
 *  4. Write audit log.
 */
export async function payBills(ctx: ServiceContext, input: PayBillsInput) {
  const { reference, toPrint } = referenceFor(input);
  if (reference && input.method === 'check' && input.checkDuplicateNumber) {
    await assertCheckNumberAvailable(ctx, { paymentAccountId: input.paymentAccountId, number: reference });
  }

  return inTransaction(ctx, async (tx) => {
    const prep = await preparePayment(tx, input);
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Bill payment — ${prep.vendor.name}`,
      reference,
      sourceRef: `vendor:${input.vendorId}`,
      lines: buildPaymentLines(prep, input, reference),
    });

    const [payment] = await tx.db
      .insert(billPayments)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId,
        date: input.date,
        method: input.method,
        reference,
        amount: prep.totalStr,
        paymentAccountId: input.paymentAccountId,
        postedEntryId: entry.id,
        toPrint,
        currency: prep.currency,
        exchangeRate: prep.currency ? prep.rate.toFixed(8) : null,
      })
      .returning();

    await applyRows(tx, payment.id, prep.rows);

    await writeAudit(tx, {
      action: 'create',
      entityType: 'bill_payment',
      entityId: payment.id,
      newValues: {
        vendorId: input.vendorId,
        amount: prep.totalStr,
        discountTotal: prep.discountTotalStr,
        discountAccountId: Money.gt(prep.discountTotalStr, 0) ? input.discountAccountId : null,
        method: input.method,
        reference,
        toPrint,
        currency: prep.currency,
        exchangeRate: prep.currency ? prep.rate.toFixed(8) : null,
        realizedFx: toAmountString(prep.fxDiff),
        postedEntryId: entry.id,
        applications: prep.rows.map((r) => ({
          billId: r.id,
          amountApplied: r.applied,
          discountTaken: r.discount,
          settled: r.settled,
          amountHome: r.apHome,
        })),
      },
    });

    return payment;
  });
}

// ---------------------------------------------------------------------------
// updateBillPayment — edit a saved bill payment (D1)
// ---------------------------------------------------------------------------

/**
 * Edit a saved bill payment (same vendor). In ONE transaction:
 *  - number / print-flag only (same date, account, method, bills and amounts): header update,
 *    the journal entry is kept (allowed on a check cleared in a completed reconciliation);
 *  - anything else: refused if the check was cleared in a completed reconciliation; otherwise
 *    the old entry is voided (closing date on the OLD date), the bills are rolled back, and the
 *    new payment is validated and posted on the same document (closing date on the NEW date).
 */
export async function updateBillPayment(ctx: ServiceContext, id: string, input: PayBillsInput) {
  const [existing] = await ctx.db
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.id, id), eq(billPayments.companyId, ctx.companyId)));
  if (!existing) throw notFound('Bill payment');
  if (existing.voidedAt) throw new ServiceError('CONFLICT', 'This payment is void and cannot be edited.');
  if (existing.vendorId !== input.vendorId) {
    throw validation('A bill payment cannot be moved to another vendor. Void it and pay the other vendor’s bills instead.');
  }

  const { reference, toPrint } = referenceFor(input);
  if (
    reference &&
    input.method === 'check' &&
    input.checkDuplicateNumber &&
    reference !== (existing.reference ?? '').trim()
  ) {
    await assertCheckNumberAvailable(ctx, {
      paymentAccountId: input.paymentAccountId,
      number: reference,
      exclude: { source: 'bill_payment', id },
    });
  }

  return inTransaction(ctx, async (tx) => {
    const [cur] = await tx.db.select().from(billPayments).where(eq(billPayments.id, id));
    if (!cur || cur.voidedAt) throw new ServiceError('CONFLICT', 'This payment is void and cannot be edited.');
    const oldApps = await tx.db
      .select()
      .from(billPaymentApplications)
      .where(eq(billPaymentApplications.billPaymentId, id));

    // Header-only edit? Compare the financial shape (discounts live in the GL, so any
    // discount on the old payment forces the full path — it cannot be compared cheaply).
    const oldByBill = new Map(oldApps.map((a) => [a.billId, Money.of(a.amountApplied)]));
    const sameApps =
      input.applications.length === oldApps.length &&
      input.applications.every(
        (a) =>
          Money.of(a.discountTaken ?? 0).isZero() &&
          oldByBill.has(a.billId) &&
          oldByBill.get(a.billId)!.equals(Money.of(a.amountApplied)),
      ) &&
      Money.of(cur.amount).equals(
        oldApps.reduce((s, a) => s.plus(Money.of(a.amountApplied)), Money.zero()),
      );
    const sameRate =
      !cur.currency || input.exchangeRate == null || Money.of(input.exchangeRate).equals(Money.of(cur.exchangeRate ?? 1));
    const headerOnly =
      sameApps &&
      sameRate &&
      cur.paymentAccountId === input.paymentAccountId &&
      cur.method === input.method &&
      new Date(cur.date).toISOString().slice(0, 10) === new Date(input.date).toISOString().slice(0, 10);

    let entryId = cur.postedEntryId;
    if (headerOnly) {
      await tx.db.update(billPayments).set({ reference, toPrint }).where(eq(billPayments.id, id));
      if (entryId) {
        await tx.db
          .update(journalEntries)
          .set({ reference, updatedAt: new Date() })
          .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, tx.companyId)));
      }
    } else {
      if (cur.postedEntryId && (await entryHasReconciledLines(tx, cur.postedEntryId))) {
        throw new ServiceError(
          'CONFLICT',
          "This bill payment was cleared in a completed bank reconciliation, so its amount, bills, account and date can't be changed. " +
            'You can still change the check number. To change the amount, undo that reconciliation first.',
        );
      }
      if (cur.postedEntryId) await voidJournalEntry(tx, cur.postedEntryId);
      await rollbackApplications(tx, id);
      const prep = await preparePayment(tx, input);
      const entry = await postJournalEntry(tx, {
        date: input.date,
        description: `Bill payment — ${prep.vendor.name}`,
        reference,
        sourceRef: `vendor:${input.vendorId}`,
        lines: buildPaymentLines(prep, input, reference),
      });
      entryId = entry.id;
      await tx.db
        .update(billPayments)
        .set({
          date: input.date,
          method: input.method,
          reference,
          amount: prep.totalStr,
          paymentAccountId: input.paymentAccountId,
          postedEntryId: entry.id,
          toPrint,
          currency: prep.currency,
          exchangeRate: prep.currency ? prep.rate.toFixed(8) : null,
        })
        .where(eq(billPayments.id, id));
      await applyRows(tx, id, prep.rows);
    }

    const [updated] = await tx.db.select().from(billPayments).where(eq(billPayments.id, id));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'bill_payment',
      entityId: id,
      oldValues: {
        date: cur.date,
        method: cur.method,
        reference: cur.reference,
        amount: cur.amount,
        paymentAccountId: cur.paymentAccountId,
        postedEntryId: cur.postedEntryId,
        applications: oldApps.map((a) => ({ billId: a.billId, amountApplied: a.amountApplied })),
      },
      newValues: {
        date: updated.date,
        method: updated.method,
        reference: updated.reference,
        amount: updated.amount,
        paymentAccountId: updated.paymentAccountId,
        ledger: headerOnly ? 'unchanged' : 'reposted',
        postedEntryId: entryId,
        applications: input.applications,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// markBillPaymentPrinted — Print Checks (D3)
// ---------------------------------------------------------------------------

/** Stamp a printed bill-payment check: assign its number and clear the print flag. */
export async function markBillPaymentPrinted(
  ctx: ServiceContext,
  input: { billPaymentId: string; checkNumber?: string; allowDuplicateNumber?: boolean },
) {
  const [payment] = await ctx.db
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.id, input.billPaymentId), eq(billPayments.companyId, ctx.companyId)));
  if (!payment) throw notFound('Bill payment');
  if (payment.voidedAt) throw new ServiceError('CONFLICT', 'This payment is void and cannot be printed.');
  if (!payment.toPrint) throw new ServiceError('CONFLICT', 'This payment is not in the print queue.');
  if (!payment.paymentAccountId) throw validation('This payment has no bank account to print a check on.');

  const checkNumber = input.checkNumber?.trim() || (await nextCheckNumber(ctx, payment.paymentAccountId));
  await assertCheckNumberAvailable(ctx, {
    paymentAccountId: payment.paymentAccountId,
    number: checkNumber,
    exclude: { source: 'bill_payment', id: payment.id },
    allowDuplicate: input.allowDuplicateNumber,
  });

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(billPayments)
      .set({ toPrint: false, reference: checkNumber })
      .where(eq(billPayments.id, payment.id))
      .returning();
    if (payment.postedEntryId) {
      await tx.db
        .update(journalEntries)
        .set({ reference: checkNumber, updatedAt: new Date() })
        .where(and(eq(journalEntries.id, payment.postedEntryId), eq(journalEntries.companyId, tx.companyId)));
    }
    await writeAudit(tx, {
      action: 'update',
      entityType: 'bill_payment',
      entityId: payment.id,
      oldValues: { toPrint: true, reference: payment.reference },
      newValues: { toPrint: false, reference: checkNumber },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// listBillPayments
// ---------------------------------------------------------------------------

export interface ListBillPaymentsOptions {
  vendorId?: string;
  /** Only check payments waiting in the print queue. */
  toPrint?: boolean;
  /** Max rows; defaults to 100. */
  limit?: number;
  offset?: number;
}

/**
 * List bill payments for the company, optionally filtered by vendor.
 * Returns payments newest-first (by date desc, then createdAt desc).
 */
export async function listBillPayments(
  ctx: ServiceContext,
  opts?: ListBillPaymentsOptions,
) {
  const conditions = [eq(billPayments.companyId, ctx.companyId)];
  if (opts?.vendorId) {
    conditions.push(eq(billPayments.vendorId, opts.vendorId));
  }
  if (opts?.toPrint) {
    conditions.push(eq(billPayments.toPrint, true));
    conditions.push(isNull(billPayments.voidedAt));
  }

  const rows = await ctx.db
    .select()
    .from(billPayments)
    .where(and(...conditions))
    .limit(opts?.limit ?? 100)
    .offset(opts?.offset ?? 0)
    .orderBy(desc(billPayments.date), desc(billPayments.createdAt));

  return rows;
}

// ---------------------------------------------------------------------------
// getBillPayment
// ---------------------------------------------------------------------------

/** Fetch a single bill payment (with its bill applications). Throws NOT_FOUND. */
export async function getBillPayment(ctx: ServiceContext, id: string) {
  const [payment] = await ctx.db
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.id, id), eq(billPayments.companyId, ctx.companyId)));
  if (!payment) throw notFound('Bill payment');

  const applications = await ctx.db
    .select()
    .from(billPaymentApplications)
    .where(eq(billPaymentApplications.billPaymentId, id));

  // Discounts are not stored per application; recover the discount total from the GL entry
  // (credit lines other than the payment account / FX) so the edit form can show it.
  let discountTotal = '0.00';
  let discountAccountId: string | null = null;
  if (payment.postedEntryId && applications.length > 0) {
    const lines = await ctx.db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, payment.postedEntryId));
    const discLine = lines.find(
      (l) => l.credit && l.accountId !== payment.paymentAccountId && (l.memo ?? '').startsWith('Early-payment discounts'),
    );
    if (discLine) {
      discountTotal = toAmountString(discLine.credit);
      discountAccountId = discLine.accountId;
    }
  }

  return { ...payment, applications, discountTotal, discountAccountId };
}

/** Bills (ids) for a set of payments — used by the edit form to show the paid bills. */
export async function billIdsForPayments(ctx: ServiceContext, paymentIds: string[]) {
  if (paymentIds.length === 0) return [];
  return ctx.db
    .select({ billPaymentId: billPaymentApplications.billPaymentId, billId: billPaymentApplications.billId })
    .from(billPaymentApplications)
    .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
    .where(and(eq(billPayments.companyId, ctx.companyId), inArray(billPaymentApplications.billPaymentId, paymentIds)));
}

// ---------------------------------------------------------------------------
// voidBillPayment
// ---------------------------------------------------------------------------

/**
 * Void a bill payment — the symmetric correction path to voidPayment (A/R).
 *
 * Steps (all inside one transaction):
 *  1. Reverse the GL entry via voidJournalEntry (guards closed periods and lines
 *     cleared in a completed reconciliation).
 *  2. Roll back each applied bill with RELATIVE SQL increments
 *     (amountPaid -= applied, balanceDue += applied) and re-derive its status.
 *  3. Delete the application rows (history preserved in the audit log).
 *  4. Stamp voidedAt on the bill payment.
 */
export async function voidBillPayment(ctx: ServiceContext, id: string) {
  const [payment] = await ctx.db
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.id, id), eq(billPayments.companyId, ctx.companyId)));
  if (!payment) throw notFound('Bill payment');
  if (payment.voidedAt) return { ...payment, applications: [] }; // idempotent

  return inTransaction(ctx, async (tx) => {
    // 1. Reverse the GL entry.
    if (payment.postedEntryId) {
      await voidJournalEntry(tx, payment.postedEntryId);
    }

    // 2 + 3. Roll back each bill and delete the application rows.
    const applications = await rollbackApplications(tx, id);

    // 4. Stamp the payment void.
    const [updated] = await tx.db
      .update(billPayments)
      .set({ voidedAt: new Date(), toPrint: false })
      .where(eq(billPayments.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'bill_payment',
      entityId: id,
      oldValues: {
        amount: payment.amount,
        applications: applications.map((a) => ({
          billId: a.billId,
          amountApplied: a.amountApplied,
        })),
      },
      newValues: { voided: true },
    });

    return { ...updated, applications: [] };
  });
}
