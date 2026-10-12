/**
 * Vendor Credits (A/P credits) service.
 *
 * A vendor credit records an amount that a vendor owes the company (e.g. returned goods,
 * negotiated discount after the fact). The posting pattern is the reverse of a bill:
 *
 *   Dr  Accounts Payable  2000      (total — reduces the A/P liability)
 *   Cr  <expense/asset account per line>   (line.amount)
 *
 * Application to a bill (applyToBill) reduces the bill's balanceDue and the credit's
 * unapplied balance.  No new GL entry is needed because the A/P balance was already
 * reduced when the credit was posted; the application is a bookkeeping memo only.
 *
 * Voiding calls voidJournalEntry and flips the document status to 'void'.
 */

import { isDepositTargetAccount } from '@/lib/accountTypes';
import { and, asc, desc, eq } from 'drizzle-orm';
import { accounts, bills, vendorCredits, vendorCreditLines, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { postJournalEntry, voidJournalEntry } from '@/lib/services/posting';
import { planPostedEdit, retitleEntry } from './postedEdit';
import { getHomeCurrencyCode } from './currencies';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface VendorCreditLineInput {
  /** GL account to credit (typically an expense or asset account). */
  accountId: string;
  description?: string | null;
  /** The dollar amount for this line (must be > 0). */
  amount: string | number;
}

export interface CreateVendorCreditInput {
  vendorId: string;
  date: Date;
  memo?: string | null;
  lines: VendorCreditLineInput[];
}

export interface ApplyToBillInput {
  vendorCreditId: string;
  billId: string;
  /** Amount to apply (must be <= credit.unapplied and <= bill.balanceDue). */
  amount: string | number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the Accounts Payable account (code '2000') for this company. */
async function resolveApAccount(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2000')));
  if (!row) {
    throw new ServiceError(
      'NOT_FOUND',
      'Accounts Payable account (code 2000) not found. Ensure the default chart of accounts is seeded.',
    );
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// createVendorCredit
// ---------------------------------------------------------------------------

/**
 * J10: vendor credits are recorded in HOME currency only (vendor_credits has no exchange rate, and
 * applying a foreign credit to a foreign bill would need a realized gain/loss). A vendor or bank
 * account in another currency is refused with a plain message so A/P never takes an unconverted
 * amount.
 */
async function foreignCurrencyOf(ctx: ServiceContext, code: string | null | undefined): Promise<string | null> {
  const v = (code ?? '').trim().toUpperCase();
  if (!v) return null;
  const home = await getHomeCurrencyCode(ctx);
  return home && v === home ? null : v;
}

async function assertHomeCurrencyVendor(ctx: ServiceContext, vendorId: string) {
  const [v] = await ctx.db
    .select({ currency: vendors.currency })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, ctx.companyId)));
  const cur = await foreignCurrencyOf(ctx, v?.currency);
  if (cur) {
    throw validation(
      `This vendor uses ${cur}. Vendor credits can only be entered for home-currency vendors — for a ${cur} vendor, enter the credit as a bill with a negative adjustment or ask the vendor for a refund.`,
    );
  }
}

export async function createVendorCredit(ctx: ServiceContext, input: CreateVendorCreditInput) {
  // Verify vendor belongs to this company.
  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');
  await assertHomeCurrencyVendor(ctx, input.vendorId);

  // Validate lines.
  if (!input.lines || input.lines.length === 0) {
    throw validation('A vendor credit must have at least one line.');
  }

  let total = Money.zero();
  for (const [i, line] of input.lines.entries()) {
    const amt = Money.of(line.amount);
    if (!amt.greaterThan(0)) {
      throw validation(`Line ${i + 1}: amount must be greater than zero.`);
    }
    total = total.plus(amt);
  }
  const totalStr = toAmountString(total);

  // Resolve A/P before opening the transaction.
  const apAccountId = await resolveApAccount(ctx);

  return inTransaction(ctx, async (tx) => {
    // 1) Insert the vendor credit header.
    const [credit] = await tx.db
      .insert(vendorCredits)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId,
        date: input.date,
        memo: input.memo ?? null,
        status: 'open',
        total: totalStr,
        unapplied: totalStr,
      })
      .returning();

    // 2) Insert lines.
    await tx.db.insert(vendorCreditLines).values(
      input.lines.map((line, idx) => ({
        vendorCreditId: credit.id,
        accountId: line.accountId,
        description: line.description ?? null,
        amount: toAmountString(line.amount),
        lineOrder: idx,
      })),
    );

    // 3) Build and post the GL entry.
    //
    //   Dr  2000 Accounts Payable   total   (reduces A/P liability — Dr on liability = decrease)
    //   Cr  <expense account>       each line amount
    //
    // Debits == Credits because sum(line amounts) = total.

    const postingLines = [
      // Debit A/P to reduce the liability.
      {
        accountId: apAccountId,
        debit: totalStr,
        memo: `Vendor credit ${credit.id}`,
        controlLine: true,
      },
      // Credit each expense/asset account for its line amount.
      ...input.lines.map((line) => ({
        accountId: line.accountId,
        credit: toAmountString(line.amount),
        memo: line.description ?? null,
      })),
    ];

    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Vendor Credit — ${vendor.name}`,
      sourceRef: `vendor_credit:${credit.id}`,
      lines: postingLines,
    });

    // 4) Stamp postedEntryId.
    const [updated] = await tx.db
      .update(vendorCredits)
      .set({ postedEntryId: entry.id })
      .where(eq(vendorCredits.id, credit.id))
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'vendor_credit',
      entityId: credit.id,
      newValues: { ...updated, linesCount: input.lines.length, total: totalStr },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// updateVendorCredit — edit a saved vendor credit (D1)
// ---------------------------------------------------------------------------

/**
 * Edit a saved vendor credit in ONE transaction. A ledger-neutral edit (memo, line
 * descriptions — same date, accounts and amounts) keeps the journal entry. Changing amounts,
 * accounts, the vendor or the date voids the entry and re-posts it; that is only allowed while
 * nothing of the credit has been applied to a bill or refunded (unapply first, like QB).
 */
export async function updateVendorCredit(ctx: ServiceContext, id: string, input: CreateVendorCreditInput) {
  const [existing] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, id), eq(vendorCredits.companyId, ctx.companyId)));
  if (!existing) throw notFound('Vendor credit');
  if (existing.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided vendor credit.');

  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');
  await assertHomeCurrencyVendor(ctx, input.vendorId);
  if (!input.lines || input.lines.length === 0) {
    throw validation('A vendor credit must have at least one line.');
  }
  let total = Money.zero();
  for (const [i, line] of input.lines.entries()) {
    const amt = Money.of(line.amount);
    if (!amt.greaterThan(0)) throw validation(`Line ${i + 1}: amount must be greater than zero.`);
    total = total.plus(amt);
  }
  const totalStr = toAmountString(total);
  const apAccountId = await resolveApAccount(ctx);

  const postingLines = [
    // The credit's own A/P line (posting.ts PostingLine.controlLine).
    { accountId: apAccountId, debit: totalStr, memo: `Vendor credit ${id}`, controlLine: true },
    ...input.lines.map((line) => ({
      accountId: line.accountId,
      credit: toAmountString(line.amount),
      memo: line.description ?? null,
    })),
  ];

  return inTransaction(ctx, async (tx) => {
    const [cur] = await tx.db.select().from(vendorCredits).where(eq(vendorCredits.id, id));
    if (!cur || cur.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided vendor credit.');
    const oldLines = await tx.db
      .select()
      .from(vendorCreditLines)
      .where(eq(vendorCreditLines.vendorCreditId, id))
      .orderBy(asc(vendorCreditLines.lineOrder));

    let plan = await planPostedEdit(tx, { entryId: cur.postedEntryId, date: input.date, lines: postingLines, what: 'vendor credit' });
    if (plan === 'unchanged' && cur.vendorId !== input.vendorId) plan = 'repost';

    let entryId = cur.postedEntryId;
    if (plan === 'unchanged') {
      await tx.db.update(vendorCredits).set({ memo: input.memo ?? null }).where(eq(vendorCredits.id, id));
      await tx.db.delete(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, id));
      await tx.db.insert(vendorCreditLines).values(
        input.lines.map((line, idx) => ({
          vendorCreditId: id,
          accountId: line.accountId,
          description: line.description ?? null,
          amount: toAmountString(line.amount),
          lineOrder: idx,
        })),
      );
      await retitleEntry(tx, entryId, { description: `Vendor Credit — ${vendor.name}` });
    } else {
      const used = Money.of(cur.total).minus(Money.of(cur.unapplied));
      if (used.greaterThan(0) || Money.of(cur.refundedAmount).greaterThan(0)) {
        throw new ServiceError(
          'CONFLICT',
          'Part of this credit was already applied to a bill or refunded. Unapply it first, then change the amount or accounts.',
        );
      }
      if (cur.postedEntryId) await voidJournalEntry(tx, cur.postedEntryId);
      await tx.db.delete(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, id));
      await tx.db.insert(vendorCreditLines).values(
        input.lines.map((line, idx) => ({
          vendorCreditId: id,
          accountId: line.accountId,
          description: line.description ?? null,
          amount: toAmountString(line.amount),
          lineOrder: idx,
        })),
      );
      const entry = await postJournalEntry(tx, {
        date: input.date,
        description: `Vendor Credit — ${vendor.name}`,
        sourceRef: `vendor_credit:${id}`,
        lines: postingLines,
      });
      entryId = entry.id;
      await tx.db
        .update(vendorCredits)
        .set({
          vendorId: input.vendorId,
          date: input.date,
          memo: input.memo ?? null,
          total: totalStr,
          unapplied: totalStr,
          status: 'open',
          postedEntryId: entry.id,
        })
        .where(eq(vendorCredits.id, id));
    }

    const [updated] = await tx.db.select().from(vendorCredits).where(eq(vendorCredits.id, id));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: id,
      oldValues: {
        vendorId: cur.vendorId,
        date: cur.date,
        memo: cur.memo,
        total: cur.total,
        postedEntryId: cur.postedEntryId,
        lines: oldLines.map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description })),
      },
      newValues: {
        vendorId: input.vendorId,
        date: input.date,
        memo: input.memo ?? null,
        total: updated.total,
        ledger: plan === 'unchanged' ? 'unchanged' : 'reposted',
        postedEntryId: entryId,
        lines: input.lines,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// listVendorCredits
// ---------------------------------------------------------------------------

export async function listVendorCredits(
  ctx: ServiceContext,
  opts?: { vendorId?: string; status?: string },
) {
  const conditions = [eq(vendorCredits.companyId, ctx.companyId)];
  if (opts?.vendorId) conditions.push(eq(vendorCredits.vendorId, opts.vendorId));
  if (opts?.status) conditions.push(eq(vendorCredits.status, opts.status as never));

  return ctx.db
    .select()
    .from(vendorCredits)
    .where(and(...conditions))
    .orderBy(desc(vendorCredits.date), asc(vendorCredits.createdAt));
}

// ---------------------------------------------------------------------------
// getVendorCredit (with lines)
// ---------------------------------------------------------------------------

export async function getVendorCredit(ctx: ServiceContext, id: string) {
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, id), eq(vendorCredits.companyId, ctx.companyId)));
  if (!credit) throw notFound('Vendor credit');

  const lines = await ctx.db
    .select()
    .from(vendorCreditLines)
    .where(eq(vendorCreditLines.vendorCreditId, id))
    .orderBy(asc(vendorCreditLines.lineOrder));

  return { ...credit, lines };
}

// ---------------------------------------------------------------------------
// applyToBill
// ---------------------------------------------------------------------------

/**
 * Apply a vendor credit to an open bill.
 *
 * This does NOT post a new GL entry — the credit already reduced A/P when it
 * was created.  Here we just track the application so reporting shows the
 * bill is reduced and the credit is consumed.
 */
export async function applyToBill(ctx: ServiceContext, input: ApplyToBillInput) {
  const applyAmount = Money.round2(input.amount);

  if (!applyAmount.greaterThan(0)) {
    throw validation('Apply amount must be greater than zero.');
  }

  // Load the vendor credit (scoped to company).
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, input.vendorCreditId), eq(vendorCredits.companyId, ctx.companyId)));
  if (!credit) throw notFound('Vendor credit');

  if (credit.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot apply a voided vendor credit.');
  }

  const unapplied = Money.of(credit.unapplied);
  if (applyAmount.greaterThan(unapplied)) {
    throw validation(
      `Apply amount ${toAmountString(applyAmount)} exceeds the credit's unapplied balance ${toAmountString(unapplied)}.`,
    );
  }

  // Load the bill (scoped to company).
  const [bill] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.id, input.billId), eq(bills.companyId, ctx.companyId)));
  if (!bill) throw notFound('Bill');

  if (bill.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot apply a credit to a voided bill.');
  }

  const balanceDue = Money.of(bill.balanceDue);
  if (applyAmount.greaterThan(balanceDue)) {
    throw validation(
      `Apply amount ${toAmountString(applyAmount)} exceeds the bill's balance due ${toAmountString(balanceDue)}.`,
    );
  }

  // Verify the credit and bill belong to the same vendor.
  if (credit.vendorId !== bill.vendorId) {
    throw validation('Vendor credit and bill must belong to the same vendor.');
  }

  // Vendor credits are recorded in home currency; a foreign-currency bill is settled through
  // Pay Bills (which converts at the booked rate and posts realized exchange gain/loss).
  if (bill.currency) {
    throw validation(
      `This bill is in ${bill.currency}. Home-currency vendor credits can't be applied to it — settle it with Pay Bills instead.`,
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Update credit's unapplied balance.
    const newUnapplied = unapplied.minus(applyAmount);
    const newCreditStatus = newUnapplied.isZero() ? 'closed' : 'partial';

    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        status: newCreditStatus as never,
      })
      .where(eq(vendorCredits.id, input.vendorCreditId))
      .returning();

    // Update bill's amountCredited and balanceDue. Credits are tracked separately
    // from cash payments (amountPaid) so reports/void-guards don't conflate them:
    // balanceDue = total - amountPaid - amountCredited.
    const newAmountCredited = Money.round2(Money.of(bill.amountCredited).plus(applyAmount));
    const newBalanceDue = Money.round2(balanceDue.minus(applyAmount));
    const newBillStatus = newBalanceDue.isZero()
      ? 'paid'
      : Money.of(bill.amountPaid).plus(newAmountCredited).greaterThan(0)
        ? 'partial'
        : 'open';

    const [updatedBill] = await tx.db
      .update(bills)
      .set({
        amountCredited: toAmountString(newAmountCredited),
        balanceDue: toAmountString(newBalanceDue),
        status: newBillStatus as never,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, input.billId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: input.vendorCreditId,
      newValues: {
        action: 'applied_to_bill',
        billId: input.billId,
        amount: toAmountString(applyAmount),
        newUnapplied: toAmountString(newUnapplied),
      },
    });

    return { credit: updatedCredit, bill: updatedBill };
  });
}

// ---------------------------------------------------------------------------
// unapplyFromBill
// ---------------------------------------------------------------------------

export interface UnapplyFromBillInput {
  vendorCreditId: string;
  billId: string;
  /** Amount to unapply (must be <= credit's applied amount and <= bill.amountCredited). */
  amount: string | number;
}

/**
 * Reverse a previous applyToBill: restore the credit's unapplied balance and
 * give the bill back its balanceDue. No GL entry is involved (same as apply).
 * This makes the "unapply first" instructions in voidBill / voidVendorCredit
 * actually satisfiable.
 */
export async function unapplyFromBill(ctx: ServiceContext, input: UnapplyFromBillInput) {
  const unapplyAmount = Money.round2(input.amount);

  if (!unapplyAmount.greaterThan(0)) {
    throw validation('Unapply amount must be greater than zero.');
  }

  // Load the vendor credit (scoped to company).
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, input.vendorCreditId), eq(vendorCredits.companyId, ctx.companyId)));
  if (!credit) throw notFound('Vendor credit');

  if (credit.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot unapply a voided vendor credit.');
  }

  const appliedTotal = Money.of(credit.total).minus(Money.of(credit.unapplied));
  if (unapplyAmount.greaterThan(appliedTotal)) {
    throw validation(
      `Unapply amount ${toAmountString(unapplyAmount)} exceeds the credit's applied amount ${toAmountString(appliedTotal)}.`,
    );
  }

  // Load the bill (scoped to company).
  const [bill] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.id, input.billId), eq(bills.companyId, ctx.companyId)));
  if (!bill) throw notFound('Bill');

  if (bill.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot unapply a credit from a voided bill.');
  }
  if (credit.vendorId !== bill.vendorId) {
    throw validation('Vendor credit and bill must belong to the same vendor.');
  }

  const billCredited = Money.of(bill.amountCredited);
  if (unapplyAmount.greaterThan(billCredited)) {
    throw validation(
      `Unapply amount ${toAmountString(unapplyAmount)} exceeds the bill's credited amount ${toAmountString(billCredited)}.`,
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Restore the credit's unapplied balance.
    const newUnapplied = Money.round2(Money.of(credit.unapplied).plus(unapplyAmount));
    const newCreditStatus = newUnapplied.greaterThanOrEqualTo(Money.of(credit.total))
      ? 'open'
      : 'partial';

    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        status: newCreditStatus as never,
      })
      .where(eq(vendorCredits.id, input.vendorCreditId))
      .returning();

    // Restore the bill's balanceDue and reduce amountCredited.
    const newAmountCredited = Money.round2(billCredited.minus(unapplyAmount));
    const newBalanceDue = Money.round2(Money.of(bill.balanceDue).plus(unapplyAmount));
    const newBillStatus = newBalanceDue.isZero()
      ? 'paid'
      : Money.of(bill.amountPaid).plus(newAmountCredited).greaterThan(0)
        ? 'partial'
        : 'open';

    const [updatedBill] = await tx.db
      .update(bills)
      .set({
        amountCredited: toAmountString(newAmountCredited),
        balanceDue: toAmountString(newBalanceDue),
        status: newBillStatus as never,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, input.billId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: input.vendorCreditId,
      newValues: {
        action: 'unapplied_from_bill',
        billId: input.billId,
        amount: toAmountString(unapplyAmount),
        newUnapplied: toAmountString(newUnapplied),
      },
    });

    return { credit: updatedCredit, bill: updatedBill };
  });
}

// ---------------------------------------------------------------------------
// refundVendorCredit
// ---------------------------------------------------------------------------

export interface RefundVendorCreditInput {
  vendorCreditId: string;
  /** Bank account the vendor's refund is deposited into. */
  bankAccountId: string;
  /** Refund amount; must be <= the credit's unapplied balance. */
  amount: string | number;
  date?: Date | null;
  memo?: string | null;
}

/**
 * Record a vendor refund (cash back) against a vendor credit's unapplied balance.
 *
 * Posting:
 *   Dr  bank account              amount   — money arrives in the bank
 *   Cr  2000 Accounts Payable     amount   — restores the A/P the credit debited
 *
 * The original credit debited A/P (reducing the liability); the vendor settling
 * that credit in cash restores A/P by the same amount while the credit's
 * unapplied balance is consumed (refundedAmount += amount). Net A/P from the
 * credit + refund pair is zero, and the A/P control account stays equal to the
 * open-bill / open-credit subledger.
 */
export async function refundVendorCredit(ctx: ServiceContext, input: RefundVendorCreditInput) {
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(
      and(eq(vendorCredits.id, input.vendorCreditId), eq(vendorCredits.companyId, ctx.companyId)),
    );
  if (!credit) throw notFound('Vendor credit');
  if (credit.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot refund a voided vendor credit.');
  }

  const amount = Money.round2(input.amount);
  if (!amount.greaterThan(0)) throw validation('Refund amount must be greater than zero.');
  const unapplied = Money.of(credit.unapplied);
  if (amount.greaterThan(unapplied)) {
    throw validation(
      `Refund amount ${toAmountString(amount)} exceeds the credit's unapplied balance ${toAmountString(unapplied)}.`,
    );
  }

  // Validate the bank account: company-owned bank/cash asset.
  const [bankAcct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, input.bankAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!bankAcct) throw notFound('Bank account');
  const refundCur = await foreignCurrencyOf(ctx, bankAcct.currency);
  if (refundCur) {
    throw validation(`This is a ${refundCur} account. Vendor refunds can only go into a home-currency bank account.`);
  }
  // Bank accounts, Undeposited Funds or another cash-like current asset (lib/accountTypes.ts).
  if (!isDepositTargetAccount(bankAcct)) {
    throw validation('Vendor refunds must be deposited into a bank/cash account.');
  }

  const apAccountId = await resolveApAccount(ctx);
  const refundDate = input.date ?? new Date();

  return inTransaction(ctx, async (tx) => {
    // 1. Post the refund receipt.
    const entry = await postJournalEntry(tx, {
      date: refundDate,
      description: input.memo ?? 'Vendor refund received',
      sourceRef: `refund:${input.vendorCreditId}`,
      lines: [
        {
          accountId: input.bankAccountId,
          debit: toAmountString(amount),
          memo: 'Vendor refund deposited',
        },
        {
          accountId: apAccountId,
          credit: toAmountString(amount),
          memo: 'Vendor credit settled in cash',
          controlLine: true,
        },
      ],
    });

    // 2. Consume the credit's unapplied balance.
    const newUnapplied = Money.round2(unapplied.minus(amount));
    const newRefunded = Money.round2(Money.of(credit.refundedAmount).plus(amount));
    const newStatus = newUnapplied.isZero() ? 'closed' : 'partial';

    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        refundedAmount: toAmountString(newRefunded),
        status: newStatus as never,
      })
      .where(eq(vendorCredits.id, input.vendorCreditId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: input.vendorCreditId,
      oldValues: {
        unapplied: toAmountString(unapplied),
        refundedAmount: credit.refundedAmount,
        status: credit.status,
      },
      newValues: {
        action: 'refund',
        amount: toAmountString(amount),
        bankAccountId: input.bankAccountId,
        unapplied: toAmountString(newUnapplied),
        refundedAmount: toAmountString(newRefunded),
        postedEntryId: entry.id,
      },
    });

    return { credit: updatedCredit, entry };
  });
}

// ---------------------------------------------------------------------------
// voidVendorCredit
// ---------------------------------------------------------------------------

export async function voidVendorCredit(ctx: ServiceContext, id: string) {
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, id), eq(vendorCredits.companyId, ctx.companyId)));
  if (!credit) throw notFound('Vendor credit');

  if (credit.status === 'void') {
    // Idempotent.
    return credit;
  }

  // Block voiding if the credit has been partially or fully applied.
  const appliedAmount = Money.of(credit.total).minus(Money.of(credit.unapplied));
  if (appliedAmount.greaterThan(0)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void a vendor credit that has been applied to a bill. Unapply first.',
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Reverse the GL entry.
    if (credit.postedEntryId) {
      await voidJournalEntry(tx, credit.postedEntryId);
    }

    const [updated] = await tx.db
      .update(vendorCredits)
      .set({ status: 'void', unapplied: '0.00' })
      .where(eq(vendorCredits.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'vendor_credit',
      entityId: id,
      oldValues: { status: credit.status },
      newValues: { status: 'void' },
    });

    return updated;
  });
}
