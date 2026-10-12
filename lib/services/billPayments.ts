/**
 * Bill Payments (A/P) service — Pay Bills workflow.
 *
 * A bill payment settles one or more open bills for a vendor. The GL impact is:
 *   Dr  Accounts Payable  (2000)  [reduce liability]
 *   Cr  Payment Account          [reduce asset, e.g. Checking 1000]
 *
 * All GL writes go through postJournalEntry; the returned entry.id is stored on
 * billPayments.postedEntryId so every payment is traceable to its journal entry.
 *
 * Multi-tenant safety: every query is scoped by ctx.companyId.
 * Money: all arithmetic uses Money/toAmountString — never JS floats.
 */
import { isPaymentSourceAccount } from '@/lib/accountTypes';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import {
  accounts,
  bills,
  billPayments,
  billPaymentApplications,
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentMethod = 'cash' | 'check' | 'credit_card' | 'ach' | 'bank_transfer' | 'other';

export interface BillApplication {
  billId: string;
  /** CASH amount to apply from this payment toward that bill (decimal string). */
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

// ---------------------------------------------------------------------------
// payBills
// ---------------------------------------------------------------------------

/**
 * Pay one or more open bills for a vendor in a single payment.
 *
 * Steps (all inside one transaction):
 *  1. Validate vendor belongs to company.
 *  2. Validate payment account belongs to company.
 *  3. Validate each bill: belongs to company + same vendor + has remaining balance.
 *  4. Validate amountApplied + discountTaken <= bill.balanceDue for each bill.
 *  5. Compute cash total = sum(amountApplied) and discount total = sum(discountTaken).
 *  6. Post GL: Dr A/P (cash + discounts), Cr paymentAccountId (cash),
 *     Cr discountAccountId (discounts, when any were taken).
 *  7. Insert billPayments row.
 *  8. Insert billPaymentApplications rows.
 *  9. Update each bill's amountPaid / balanceDue / status.
 * 10. Write audit log.
 */
export async function payBills(ctx: ServiceContext, input: PayBillsInput) {
  // ── basic input validation ───────────────────────────────────────────────
  if (!input.applications || input.applications.length === 0) {
    throw validation('At least one bill application is required.');
  }

  // Reject duplicate billIds — two applications against the same bill would each be
  // validated against the bill's ORIGINAL balance, bypassing the over-application guard.
  const appBillIds = input.applications.map((a) => a.billId);
  if (new Set(appBillIds).size !== appBillIds.length) {
    throw validation('Duplicate billId in applications. Combine amounts into a single application per bill.');
  }

  // ── vendor ownership check ───────────────────────────────────────────────
  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');

  // ── payment account ownership + type check ──────────────────────────────
  const [payAcct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(
      and(eq(accounts.id, input.paymentAccountId), eq(accounts.companyId, ctx.companyId)),
    );
  if (!payAcct) throw notFound('Payment account');
  // The funding source must be a bank/cash asset or a credit-card liability — not, say, A/R
  // or a revenue account, which would post a nonsensical bill-payment credit.
  // QB parity: bills are paid from a Bank or Credit Card account (lib/accountTypes.ts).
  const isFundable = isPaymentSourceAccount(payAcct);
  if (!isFundable) {
    throw validation('Payment account must be a bank/cash or credit-card account.');
  }

  // ── A/P account ─────────────────────────────────────────────────────────
  const apAccountId = await resolveApAccount(ctx);

  // ── validate each bill + accumulate totals ──────────────────────────────
  let total = Money.zero(); // cash leaving the payment account
  let discountTotal = Money.zero(); // early-payment discounts taken
  const billRows: Array<{
    id: string;
    total: string;
    amountPaid: string;
    balanceDue: string;
    applied: string; // cash from this payment
    discount: string; // discount taken on this bill
    settled: string; // applied + discount — total reduction of balanceDue
  }> = [];

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
        amountPaid: bills.amountPaid,
        balanceDue: bills.balanceDue,
        status: bills.status,
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

    total = total.plus(applied);
    discountTotal = discountTotal.plus(discount);
    billRows.push({
      id: bill.id,
      total: bill.total,
      amountPaid: bill.amountPaid,
      balanceDue: bill.balanceDue,
      applied: toAmountString(applied),
      discount: toAmountString(discount),
      settled: toAmountString(settled),
    });
  }

  if (total.isZero()) {
    throw validation('Total payment amount must be greater than zero.');
  }

  // ── discount account (required only when discounts were taken) ───────────
  if (discountTotal.greaterThan(0)) {
    if (!input.discountAccountId) {
      throw validation('discountAccountId is required when a discount is taken.');
    }
    const [discAcct] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.id, input.discountAccountId), eq(accounts.companyId, ctx.companyId)),
      );
    if (!discAcct) throw notFound('Discount account');
  }

  const totalStr = toAmountString(total);
  const discountTotalStr = toAmountString(discountTotal);
  /** Total A/P relieved = cash + discounts. */
  const settledTotalStr = toAmountString(total.plus(discountTotal));

  // ── all good — run inside one transaction ────────────────────────────────
  return inTransaction(ctx, async (tx) => {
    // 1. Post the journal entry
    //    Dr A/P full settlement (cash + discounts) — reduces liability
    //    Cr Payment Account (cash only)
    //    Cr Discount Account (discounts taken, if any)
    const entryLines: PostingLine[] = [
      {
        accountId: apAccountId,
        debit: settledTotalStr,
        memo: `A/P payment to vendor ${vendor.name}`,
        controlLine: true,
      },
      {
        accountId: input.paymentAccountId,
        credit: totalStr,
        memo: `Bill payment — ref: ${input.reference ?? 'n/a'}`,
      },
    ];
    if (discountTotal.greaterThan(0) && input.discountAccountId) {
      entryLines.push({
        accountId: input.discountAccountId,
        credit: discountTotalStr,
        memo: `Early-payment discounts taken — ${vendor.name}`,
      });
    }
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Bill payment — ${vendor.name}`,
      reference: input.reference ?? null,
      sourceRef: `vendor:${input.vendorId}`,
      lines: entryLines,
    });

    // 2. Insert billPayments header
    const [payment] = await tx.db
      .insert(billPayments)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId,
        date: input.date,
        method: input.method,
        reference: input.reference ?? null,
        amount: totalStr,
        paymentAccountId: input.paymentAccountId,
        postedEntryId: entry.id,
      })
      .returning();

    // 3. Insert applications + update each bill
    for (const row of billRows) {
      // Insert the application link. amountApplied stores the FULL settlement
      // (cash + discount) so voidBillPayment reverses the bill's balanceDue and
      // amountPaid symmetrically; the cash/discount split lives in the GL entry
      // and the audit log.
      await tx.db.insert(billPaymentApplications).values({
        billPaymentId: payment.id,
        billId: row.id,
        amountApplied: row.settled,
      });

      // Update the bill with RELATIVE increments (amountPaid += settled,
      // balanceDue -= settled) so a concurrent/duplicate path can never clobber
      // the row from a stale snapshot; status is derived from the post-update row.
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

      const newStatus = deriveBillStatus(
        updatedBill.balanceDue,
        updatedBill.amountPaid,
        updatedBill.amountCredited,
      );
      await tx.db.update(bills).set({ status: newStatus }).where(eq(bills.id, row.id));
    }

    // 4. Audit log
    await writeAudit(tx, {
      action: 'create',
      entityType: 'bill_payment',
      entityId: payment.id,
      newValues: {
        vendorId: input.vendorId,
        amount: totalStr,
        discountTotal: discountTotalStr,
        discountAccountId: discountTotal.greaterThan(0) ? input.discountAccountId : null,
        method: input.method,
        reference: input.reference,
        postedEntryId: entry.id,
        applications: billRows.map((r) => ({
          billId: r.id,
          amountApplied: r.applied,
          discountTaken: r.discount,
          settled: r.settled,
        })),
      },
    });

    return payment;
  });
}

// ---------------------------------------------------------------------------
// listBillPayments
// ---------------------------------------------------------------------------

export interface ListBillPaymentsOptions {
  vendorId?: string;
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

  return { ...payment, applications };
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

  const applications = await ctx.db
    .select()
    .from(billPaymentApplications)
    .where(eq(billPaymentApplications.billPaymentId, id));

  return inTransaction(ctx, async (tx) => {
    // 1. Reverse the GL entry.
    if (payment.postedEntryId) {
      await voidJournalEntry(tx, payment.postedEntryId);
    }

    // 2. Roll back each bill with relative increments.
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
        // Should be impossible unless the subledger was already desynced; refuse
        // to persist a negative amountPaid (the transaction rolls back).
        throw new ServiceError(
          'CONFLICT',
          `Voiding this payment would make bill ${app.billId} amountPaid negative.`,
        );
      }

      const newStatus = deriveBillStatus(
        updatedBill.balanceDue,
        updatedBill.amountPaid,
        updatedBill.amountCredited,
      );
      await tx.db.update(bills).set({ status: newStatus }).where(eq(bills.id, app.billId));
    }

    // 3. Delete application rows.
    await tx.db
      .delete(billPaymentApplications)
      .where(eq(billPaymentApplications.billPaymentId, id));

    // 4. Stamp the payment void.
    const [updated] = await tx.db
      .update(billPayments)
      .set({ voidedAt: new Date() })
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
