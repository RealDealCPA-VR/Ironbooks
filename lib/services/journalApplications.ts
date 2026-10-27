/**
 * General Journal open items: paying and applying named A/R / A/P journal-entry lines
 * (QuickBooks Desktop parity, invariant I11).
 *
 * In QuickBooks a journal-entry line on Accounts Receivable that names a customer is an open
 * "General Journal" item of that customer, and one on Accounts Payable that names a vendor is an
 * open item of that vendor:
 *  - an A/R DEBIT (a charge) shows in Receive Payments and can be paid, in full or in part;
 *  - an A/R CREDIT shows as an available credit and can be applied to the customer's invoices;
 *  - an A/P CREDIT (an amount owed) shows in Pay Bills and can be paid, in full or in part;
 *  - an A/P DEBIT shows as a vendor credit and can be applied to the vendor's bills.
 *
 * Every application is a row in journal_item_applications (0037). Applications post NO journal
 * entry: both sides already sit in A/R (or A/P), so the control account does not move — only the
 * subledger items close out. The received payment / bill payment that pays a journal item posts
 * its own entry as usual (Dr bank / Cr A/R, Dr A/P / Cr bank).
 *
 * Effects that keep A/R (A/P) == aging == customer (vendor) balances:
 *  - 'payment':        the JE charge's open amount drops, the payment's `unapplied` drops;
 *  - 'invoice_credit': the JE credit's open amount drops, the invoice's balance drops
 *                      (markPaidAmount, like a credit memo);
 *  - 'bill_payment':   the JE payable's open amount drops (the bill payment's amount includes it);
 *  - 'bill_credit':    the JE vendor credit's open amount drops, the bill's `amountCredited` grows;
 *  - 'journal_offset': (P1, 0041) a JE credit applied to a JE charge of the same customer / vendor —
 *                      two rows sharing `pairId`, one on each line, both lines' open amounts drop.
 *
 * A journal entry with applications cannot be voided or edited until they are removed (QB asks
 * you to unapply first) — enforced here with a plain message and by a DB trigger (0037).
 * Journal items are home-currency only (journal entries have no exchange rate), so they can only
 * be applied with home-currency payments, invoices and bills.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  accounts,
  bills,
  invoices,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  paymentsReceived,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { isSubledgerSource } from './posting';
import { assertPeriodOpen } from './fiscalPeriods';
import { assertAccountantDatesOpen } from './accountantCopy/guard';
import { effectiveHomeCurrency } from './multiCurrency';
import { foreignCode } from './fxLines';
import { journalOpenItems, resolveEntityNames } from './journal';
import { markPaidAmount } from './invoices';

/**
 * Accountant's Copy (I1): in the accountant's copy an application may only touch records dated on
 * or before the dividing date (the journal entries, invoice, bill or payment involved).
 */
async function assertCopyDates(
  tx: ServiceContext,
  refs: { lineIds?: Array<string | null | undefined>; invoiceId?: string | null; billId?: string | null; paymentId?: string | null },
): Promise<void> {
  const dates: Date[] = [];
  const lineIds = (refs.lineIds ?? []).filter((x): x is string => !!x);
  if (lineIds.length) {
    for (const r of await tx.db
      .select({ date: journalEntries.date })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(and(inArray(journalEntryLines.id, lineIds), eq(journalEntries.companyId, tx.companyId)))) {
      dates.push(r.date);
    }
  }
  if (refs.invoiceId) {
    const [r] = await tx.db.select({ date: invoices.date }).from(invoices).where(and(eq(invoices.id, refs.invoiceId), eq(invoices.companyId, tx.companyId)));
    if (r) dates.push(r.date);
  }
  if (refs.billId) {
    const [r] = await tx.db.select({ date: bills.date }).from(bills).where(and(eq(bills.id, refs.billId), eq(bills.companyId, tx.companyId)));
    if (r) dates.push(r.date);
  }
  if (refs.paymentId) {
    const [r] = await tx.db
      .select({ date: paymentsReceived.date })
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.id, refs.paymentId), eq(paymentsReceived.companyId, tx.companyId)));
    if (r) dates.push(r.date);
  }
  await assertAccountantDatesOpen(tx, dates, 'A record this application changes');
}

export type JournalApplicationKind = 'payment' | 'invoice_credit' | 'bill_payment' | 'bill_credit' | 'journal_offset';
type Side = 'ar' | 'ap';

const SIDE_NAME: Record<Side, { entity: 'customer' | 'vendor'; account: string }> = {
  ar: { entity: 'customer', account: 'Accounts Receivable' },
  ap: { entity: 'vendor', account: 'Accounts Payable' },
};

/** A journal line paid by cash (Receive Payments / Pay Bills). */
export interface JournalItemPaymentInput {
  journalLineId: string;
  amount: string | number;
}

/** A journal credit line applied to an invoice (A/R). */
export interface JournalCreditToInvoiceInput {
  journalLineId: string;
  invoiceId: string;
  amount: string | number;
}

/**
 * A General Journal credit line applied to a General Journal charge line of the same customer
 * (A/R credit -> A/R debit) or vendor (A/P debit -> A/P credit). QuickBooks lists JE charges in
 * Receive Payments / Pay Bills next to invoices and bills, and lets any open credit be applied.
 */
export interface JournalOffsetInput {
  /** The credit line (A/R credit / A/P debit). */
  journalLineId: string;
  /** The charge line it is applied to (A/R debit / A/P credit). */
  chargeLineId: string;
  amount: string | number;
}

/** A journal vendor-credit line applied to a bill (A/P). */
export interface JournalCreditToBillInput {
  journalLineId: string;
  billId: string;
  amount: string | number;
}

interface LoadedItem {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: Date;
  entityId: string;
  /** Signed full amount (A/R: debit +; A/P: credit +). */
  original: Decimal;
  /** Unsigned amount still open. */
  open: Decimal;
}

function label(item: { entryNumber: number }) {
  return `General Journal #${item.entryNumber}`;
}

/** Load + validate one named General Journal line on the A/R or A/P side. */
async function loadItem(ctx: ServiceContext, side: Side, lineId: string): Promise<LoadedItem> {
  const [row] = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      status: journalEntries.status,
      sourceRef: journalEntries.sourceRef,
      entityType: journalEntryLines.entityType,
      entityId: journalEntryLines.entityId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      accountType: accounts.type,
      accountSubtype: accounts.subtype,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(eq(journalEntryLines.id, lineId), eq(journalEntries.companyId, ctx.companyId)));
  if (!row) throw notFound('Journal entry line');
  const isSide =
    side === 'ar'
      ? row.accountType === 'asset' && row.accountSubtype === 'accounts_receivable'
      : row.accountType === 'liability' && row.accountSubtype === 'accounts_payable';
  if (!isSide || row.entityType !== SIDE_NAME[side].entity || !row.entityId || isSubledgerSource(row.sourceRef)) {
    throw validation(
      `That line is not a General Journal ${SIDE_NAME[side].account} line for a ${SIDE_NAME[side].entity}, so it can't be used here.`,
    );
  }
  if (row.status !== 'posted') {
    throw new ServiceError('CONFLICT', `${label(row)} is void, so it has nothing left to apply.`);
  }
  const [applied] = await ctx.db
    .select({ sum: sql<string>`COALESCE(SUM(CAST(${journalItemApplications.amount} AS NUMERIC)), 0)` })
    .from(journalItemApplications)
    .where(eq(journalItemApplications.journalLineId, lineId));
  const dr = Money.of(row.debit);
  const cr = Money.of(row.credit);
  const original = side === 'ar' ? dr.minus(cr) : cr.minus(dr);
  const left = original.abs().minus(Money.of(applied?.sum ?? 0));
  return {
    lineId: row.lineId,
    entryId: row.entryId,
    entryNumber: row.entryNumber,
    date: row.date,
    entityId: row.entityId,
    original,
    open: left.isNegative() ? Money.zero() : left,
  };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The latest of the given dates (an application can't happen before both sides exist). */
function latest(...dates: Date[]): Date {
  return dates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
}

/**
 * A payment can only pay a General Journal amount that already existed on the payment date —
 * otherwise A/R or A/P would hold the payment with nothing to show it against in between.
 */
function assertPaidOnOrAfter(item: LoadedItem, paymentDate: Date, what: string) {
  if (day(paymentDate) < day(item.date)) {
    throw validation(
      `${label(item)} is dated ${day(item.date)}, after this ${what} (${day(paymentDate)}). Date the ${what} on or after the entry.`,
    );
  }
}

/** Sum requested amounts per journal line; every amount must be positive. */
function sumByLine(rows: Array<{ journalLineId: string; amount: string | number }>) {
  const by = new Map<string, Decimal>();
  for (const r of rows) {
    const amt = Money.round2(r.amount);
    if (!amt.greaterThan(0)) throw validation('Each General Journal amount must be greater than zero.');
    by.set(r.journalLineId, (by.get(r.journalLineId) ?? Money.zero()).plus(amt));
  }
  return by;
}

/**
 * Validate that every requested journal line belongs to `entityId`, has the right direction
 * ('charge' = A/R debit / A/P credit, 'credit' = A/R credit / A/P debit) and enough left open.
 */
async function validateItems(
  ctx: ServiceContext,
  side: Side,
  entityId: string,
  want: 'charge' | 'credit',
  requested: Map<string, Decimal>,
): Promise<Map<string, LoadedItem>> {
  const loaded = new Map<string, LoadedItem>();
  for (const [lineId, amount] of requested) {
    const item = await loadItem(ctx, side, lineId);
    if (item.entityId !== entityId) {
      throw validation(`${label(item)} is for a different ${SIDE_NAME[side].entity}.`);
    }
    const isCharge = item.original.greaterThan(0);
    if (want === 'charge' && !isCharge) {
      throw validation(
        side === 'ar'
          ? `${label(item)} is a credit to the customer, not an amount they owe. Apply it to an invoice as a credit instead.`
          : `${label(item)} is a credit from the vendor, not an amount you owe. Apply it to a bill as a credit instead.`,
      );
    }
    if (want === 'credit' && isCharge) {
      throw validation(
        side === 'ar'
          ? `${label(item)} is an amount the customer owes, not a credit. Receive a payment against it instead.`
          : `${label(item)} is an amount you owe the vendor, not a credit. Pay it in Pay Bills instead.`,
      );
    }
    if (amount.greaterThan(item.open)) {
      throw validation(
        `${label(item)} only has ${toAmountString(item.open)} left open (tried to use ${toAmountString(amount)}).`,
      );
    }
    loaded.set(lineId, item);
  }
  return loaded;
}

export async function isForeignCurrency(ctx: ServiceContext, code: string | null | undefined): Promise<boolean> {
  if (!(code ?? '').trim()) return false;
  // review5 fx: the home code also without a base row in the currency list.
  return foreignCode(code, await effectiveHomeCurrency(ctx)) !== null;
}

// ---------------------------------------------------------------------------
// Validation helpers for the payment services (run BEFORE any write)
// ---------------------------------------------------------------------------

/** Validate journal charges paid by a received payment; returns the total. */
export async function validateJournalChargesForPayment(
  ctx: ServiceContext,
  input: { customerId: string; items: JournalItemPaymentInput[]; foreignPayment: boolean },
): Promise<Decimal> {
  if (input.items.length === 0) return Money.zero();
  if (input.foreignPayment) {
    throw validation('General Journal charges are in your home currency, so they can only be paid with a home-currency payment.');
  }
  const requested = sumByLine(input.items);
  await validateItems(ctx, 'ar', input.customerId, 'charge', requested);
  return [...requested.values()].reduce((s, v) => s.plus(v), Money.zero());
}

/** Validate journal amounts owed paid by a bill payment; returns the total. */
export async function validateJournalPayablesForBillPayment(
  ctx: ServiceContext,
  input: { vendorId: string; items: JournalItemPaymentInput[] },
): Promise<Decimal> {
  if (input.items.length === 0) return Money.zero();
  const requested = sumByLine(input.items);
  await validateItems(ctx, 'ap', input.vendorId, 'charge', requested);
  return [...requested.values()].reduce((s, v) => s.plus(v), Money.zero());
}

// ---------------------------------------------------------------------------
// Writers (inside the caller's transaction)
// ---------------------------------------------------------------------------

/** Record journal charges paid by a received payment (no GL — the payment credited A/R). */
export async function recordJournalChargesPaid(
  tx: ServiceContext,
  input: { paymentId: string; customerId: string; date: Date; items: JournalItemPaymentInput[] },
) {
  if (input.items.length === 0) return [];
  const requested = sumByLine(input.items);
  const loaded = await validateItems(tx, 'ar', input.customerId, 'charge', requested);
  const out = [];
  for (const [lineId, amount] of requested) {
    const item = loaded.get(lineId)!;
    assertPaidOnOrAfter(item, input.date, 'payment');
    const [row] = await tx.db
      .insert(journalItemApplications)
      .values({
        companyId: tx.companyId,
        side: 'ar',
        kind: 'payment',
        journalEntryId: item.entryId,
        journalLineId: lineId,
        paymentId: input.paymentId,
        amount: toAmountString(amount),
        date: input.date,
      })
      .returning();
    out.push(row);
  }
  return out;
}

/** Record journal amounts owed paid by a bill payment (no GL — the bill payment debited A/P). */
export async function recordJournalPayablesPaid(
  tx: ServiceContext,
  input: { billPaymentId: string; vendorId: string; date: Date; items: JournalItemPaymentInput[] },
) {
  if (input.items.length === 0) return [];
  const requested = sumByLine(input.items);
  const loaded = await validateItems(tx, 'ap', input.vendorId, 'charge', requested);
  const out = [];
  for (const [lineId, amount] of requested) {
    const item = loaded.get(lineId)!;
    assertPaidOnOrAfter(item, input.date, 'bill payment');
    const [row] = await tx.db
      .insert(journalItemApplications)
      .values({
        companyId: tx.companyId,
        side: 'ap',
        kind: 'bill_payment',
        journalEntryId: item.entryId,
        journalLineId: lineId,
        billPaymentId: input.billPaymentId,
        amount: toAmountString(amount),
        date: input.date,
      })
      .returning();
    out.push(row);
  }
  return out;
}

/**
 * Apply journal A/R credits to invoices (no GL). Each invoice must belong to the customer, be
 * posted, in home currency, and have enough balance left. `paymentId` links the application to a
 * Receive Payments transaction so voiding / editing that payment undoes it.
 */
export async function applyJournalCreditsToInvoices(
  tx: ServiceContext,
  input: { customerId: string; date: Date; paymentId?: string | null; credits: JournalCreditToInvoiceInput[] },
) {
  if (input.credits.length === 0) return [];
  const requested = sumByLine(input.credits);
  const loaded = await validateItems(tx, 'ar', input.customerId, 'credit', requested);
  const byInvoice = new Map<string, Decimal>();
  const invoiceDate = new Map<string, Date>();
  for (const c of input.credits) {
    byInvoice.set(c.invoiceId, (byInvoice.get(c.invoiceId) ?? Money.zero()).plus(Money.round2(c.amount)));
  }
  for (const [invoiceId, amount] of byInvoice) {
    const [inv] = await tx.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, tx.companyId)));
    if (!inv) throw notFound('Invoice');
    if (inv.customerId !== input.customerId) throw validation(`Invoice #${inv.invoiceNumber} belongs to a different customer.`);
    invoiceDate.set(invoiceId, inv.date);
    if (inv.status === 'void') throw validation(`Invoice #${inv.invoiceNumber} is void.`);
    if (inv.status === 'draft') {
      throw validation(`Invoice #${inv.invoiceNumber} is still a draft. Post it before applying a credit to it.`);
    }
    if (await isForeignCurrency(tx, inv.currency)) {
      throw validation(`General Journal credits can only be applied to invoices in your home currency (invoice #${inv.invoiceNumber}).`);
    }
    if (amount.greaterThan(Money.of(inv.balanceDue))) {
      throw validation(
        `Credits applied to invoice #${inv.invoiceNumber} (${toAmountString(amount)}) are more than its balance due (${toAmountString(inv.balanceDue)}).`,
      );
    }
  }
  const out = [];
  for (const c of input.credits) {
    const amount = Money.round2(c.amount);
    const item = loaded.get(c.journalLineId)!;
    await markPaidAmount(tx, c.invoiceId, toAmountString(amount));
    const [row] = await tx.db
      .insert(journalItemApplications)
      .values({
        companyId: tx.companyId,
        side: 'ar',
        kind: 'invoice_credit',
        journalEntryId: item.entryId,
        journalLineId: c.journalLineId,
        invoiceId: c.invoiceId,
        paymentId: input.paymentId ?? null,
        amount: toAmountString(amount),
        // Dated when it could first apply: never before the credit or the invoice existed, so
        // as-of aging (journalAppliedByLine / journalCreditsAppliedAfter) moves both together.
        date: latest(input.date, item.date, invoiceDate.get(c.invoiceId)!),
      })
      .returning();
    out.push(row);
  }
  return out;
}

function billStatus(balanceDue: Decimal, paidOrCredited: Decimal): 'open' | 'partial' | 'paid' {
  if (balanceDue.lessThanOrEqualTo(0)) return 'paid';
  if (paidOrCredited.greaterThan(0)) return 'partial';
  return 'open';
}

/** Move `delta` (positive = apply, negative = unapply) of vendor credit onto a bill. */
async function creditBill(tx: ServiceContext, billId: string, delta: Decimal) {
  const [b] = await tx.db
    .update(bills)
    .set({
      amountCredited: sql`${bills.amountCredited} + ${toAmountString(delta)}`,
      balanceDue: sql`${bills.balanceDue} - ${toAmountString(delta)}`,
      updatedAt: new Date(),
    })
    .where(and(eq(bills.id, billId), eq(bills.companyId, tx.companyId)))
    .returning({ amountPaid: bills.amountPaid, amountCredited: bills.amountCredited, balanceDue: bills.balanceDue });
  if (!b) throw notFound('Bill');
  if (Money.of(b.amountCredited).lessThan(0) || Money.of(b.balanceDue).lessThan(0)) {
    throw new ServiceError('CONFLICT', 'That would take the bill past zero. Refresh and try again.');
  }
  const status = billStatus(Money.of(b.balanceDue), Money.of(b.amountPaid).plus(Money.of(b.amountCredited)));
  await tx.db.update(bills).set({ status }).where(eq(bills.id, billId));
}

/**
 * Apply journal A/P debits (vendor credits) to bills (no GL). Each bill must belong to the vendor,
 * be open, in home currency, and have enough balance left. `billPaymentId` links the application
 * to a Pay Bills transaction so voiding / editing that payment undoes it.
 */
export async function applyJournalCreditsToBills(
  tx: ServiceContext,
  input: { vendorId: string; date: Date; billPaymentId?: string | null; credits: JournalCreditToBillInput[] },
) {
  if (input.credits.length === 0) return [];
  const requested = sumByLine(input.credits);
  const loaded = await validateItems(tx, 'ap', input.vendorId, 'credit', requested);
  const byBill = new Map<string, Decimal>();
  const billDate = new Map<string, Date>();
  for (const c of input.credits) {
    byBill.set(c.billId, (byBill.get(c.billId) ?? Money.zero()).plus(Money.round2(c.amount)));
  }
  for (const [billId, amount] of byBill) {
    const [bill] = await tx.db
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.companyId, tx.companyId)));
    if (!bill) throw notFound('Bill');
    const name = bill.billNumber ? `Bill ${bill.billNumber}` : 'That bill';
    if (bill.vendorId !== input.vendorId) throw validation(`${name} belongs to a different vendor.`);
    billDate.set(billId, bill.date);
    if (bill.status === 'void') throw validation(`${name} is void.`);
    if (await isForeignCurrency(tx, bill.currency)) {
      throw validation(`General Journal credits can only be applied to bills in your home currency (${name.toLowerCase()}).`);
    }
    if (amount.greaterThan(Money.of(bill.balanceDue))) {
      throw validation(
        `Credits applied to ${name.toLowerCase()} (${toAmountString(amount)}) are more than its balance due (${toAmountString(bill.balanceDue)}).`,
      );
    }
  }
  const out = [];
  for (const c of input.credits) {
    const amount = Money.round2(c.amount);
    const item = loaded.get(c.journalLineId)!;
    await creditBill(tx, c.billId, amount);
    const [row] = await tx.db
      .insert(journalItemApplications)
      .values({
        companyId: tx.companyId,
        side: 'ap',
        kind: 'bill_credit',
        journalEntryId: item.entryId,
        journalLineId: c.journalLineId,
        billId: c.billId,
        billPaymentId: input.billPaymentId ?? null,
        amount: toAmountString(amount),
        date: latest(input.date, item.date, billDate.get(c.billId)!),
      })
      .returning();
    out.push(row);
  }
  return out;
}

/**
 * Apply General Journal credits to General Journal charges of the same customer / vendor (no GL —
 * both lines already sit in A/R or A/P, so only the two open items close out). Each application
 * writes two rows sharing a `pairId`. `paymentId` / `billPaymentId` link them to a Receive
 * Payments / Pay Bills transaction so voiding or editing it undoes them. Validated against the
 * amounts open at the moment of writing, so cash this payment already put on a charge counts.
 */
export async function applyJournalOffsets(
  tx: ServiceContext,
  input: {
    side: Side;
    entityId: string;
    date: Date;
    paymentId?: string | null;
    billPaymentId?: string | null;
    offsets: JournalOffsetInput[];
  },
) {
  if (input.offsets.length === 0) return [];
  for (const o of input.offsets) {
    if (o.journalLineId === o.chargeLineId) throw validation('A General Journal line cannot be applied to itself.');
  }
  const credits = await validateItems(tx, input.side, input.entityId, 'credit', sumByLine(input.offsets));
  const charges = await validateItems(
    tx,
    input.side,
    input.entityId,
    'charge',
    sumByLine(input.offsets.map((o) => ({ journalLineId: o.chargeLineId, amount: o.amount }))),
  );
  const out: ApplicationRow[] = [];
  for (const o of input.offsets) {
    const amount = toAmountString(Money.round2(o.amount));
    const credit = credits.get(o.journalLineId)!;
    const charge = charges.get(o.chargeLineId)!;
    const pairId = randomUUID();
    // Dated when it could first apply: never before either entry existed, so as-of aging moves
    // both lines on the same day (journalAppliedByLine).
    const date = latest(input.date, credit.date, charge.date);
    const base = {
      companyId: tx.companyId,
      side: input.side,
      kind: 'journal_offset',
      paymentId: input.side === 'ar' ? (input.paymentId ?? null) : null,
      billPaymentId: input.side === 'ap' ? (input.billPaymentId ?? null) : null,
      amount,
      date,
      pairId,
    };
    const rows = await tx.db
      .insert(journalItemApplications)
      .values([
        { ...base, journalEntryId: credit.entryId, journalLineId: credit.lineId },
        { ...base, journalEntryId: charge.entryId, journalLineId: charge.lineId },
      ])
      .returning();
    out.push(...rows);
  }
  return out;
}

/**
 * The General Journal credit -> charge applications made by one received payment / bill payment,
 * as offset inputs (credit line, charge line, amount) — so an edit can show and re-post them.
 */
export async function journalOffsetsOf(
  ctx: ServiceContext,
  opts: { paymentId?: string; billPaymentId?: string },
): Promise<JournalOffsetInput[]> {
  const conds = [eq(journalItemApplications.companyId, ctx.companyId), eq(journalItemApplications.kind, 'journal_offset')];
  if (opts.paymentId) conds.push(eq(journalItemApplications.paymentId, opts.paymentId));
  else if (opts.billPaymentId) conds.push(eq(journalItemApplications.billPaymentId, opts.billPaymentId));
  else return [];
  const rows = await ctx.db
    .select({
      pairId: journalItemApplications.pairId,
      side: journalItemApplications.side,
      lineId: journalItemApplications.journalLineId,
      amount: journalItemApplications.amount,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalItemApplications)
    .innerJoin(journalEntryLines, eq(journalEntryLines.id, journalItemApplications.journalLineId))
    .where(and(...conds))
    .orderBy(asc(journalItemApplications.createdAt));
  const byPair = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.pairId) continue;
    byPair.set(r.pairId, [...(byPair.get(r.pairId) ?? []), r]);
  }
  const out: JournalOffsetInput[] = [];
  for (const pair of byPair.values()) {
    // A/R: the credit line is the one with more credit than debit; A/P: the one with more debit.
    const isCreditLine = (r: (typeof rows)[number]) => {
      const net = Money.of(r.debit ?? 0).minus(Money.of(r.credit ?? 0));
      return r.side === 'ar' ? net.lessThan(0) : net.greaterThan(0);
    };
    const creditRow = pair.find(isCreditLine);
    const chargeRow = pair.find((r) => !isCreditLine(r));
    if (!creditRow || !chargeRow) continue;
    out.push({ journalLineId: creditRow.lineId, chargeLineId: chargeRow.lineId, amount: toAmountString(creditRow.amount) });
  }
  return out;
}

type ApplicationRow = typeof journalItemApplications.$inferSelect;

/**
 * Undo applications (inside the caller's transaction): invoices / bills get their balance back;
 * with `restorePaymentUnapplied`, cash a payment had applied to a journal charge becomes unapplied
 * credit on that payment again (when the payment itself is being voided / reposted, it is not).
 */
async function reverseApplications(
  tx: ServiceContext,
  rows: ApplicationRow[],
  opts: { restorePaymentUnapplied: boolean },
) {
  for (const app of rows) {
    const amount = Money.of(app.amount);
    if (app.kind === 'invoice_credit' && app.invoiceId) {
      await markPaidAmount(tx, app.invoiceId, toAmountString(amount.negated()));
    } else if (app.kind === 'bill_credit' && app.billId) {
      await creditBill(tx, app.billId, amount.negated());
    } else if (app.kind === 'payment' && app.paymentId && opts.restorePaymentUnapplied) {
      await tx.db
        .update(paymentsReceived)
        .set({ unapplied: sql`${paymentsReceived.unapplied} + ${toAmountString(amount)}` })
        .where(eq(paymentsReceived.id, app.paymentId));
    }
  }
  if (rows.length > 0) {
    await tx.db.delete(journalItemApplications).where(inArray(journalItemApplications.id, rows.map((r) => r.id)));
  }
  return rows;
}

/**
 * Undo every journal application made by a received payment (its cash on journal charges and the
 * journal credits applied together with it). Used when the payment is voided, edited or bounced.
 */
export async function reverseJournalApplicationsForPayment(tx: ServiceContext, paymentId: string) {
  const rows = await tx.db
    .select()
    .from(journalItemApplications)
    .where(and(eq(journalItemApplications.companyId, tx.companyId), eq(journalItemApplications.paymentId, paymentId)));
  return reverseApplications(tx, rows, { restorePaymentUnapplied: false });
}

/** Undo every journal application made by a bill payment (void / edit). */
export async function reverseJournalApplicationsForBillPayment(tx: ServiceContext, billPaymentId: string) {
  const rows = await tx.db
    .select()
    .from(journalItemApplications)
    .where(
      and(eq(journalItemApplications.companyId, tx.companyId), eq(journalItemApplications.billPaymentId, billPaymentId)),
    );
  return reverseApplications(tx, rows, { restorePaymentUnapplied: false });
}

// ---------------------------------------------------------------------------
// Public API (standalone apply / unapply, lists)
// ---------------------------------------------------------------------------

/**
 * Apply a General Journal credit outside a payment: an A/R credit to an invoice, or an A/P debit
 * (vendor credit) to a bill. Respects the closing date (the application is dated `date`, default
 * today).
 */
export async function applyJournalCredit(
  ctx: ServiceContext,
  input: {
    journalLineId: string;
    invoiceId?: string | null;
    billId?: string | null;
    /** P1: a General Journal charge line (same customer / vendor) to apply the credit to. */
    chargeLineId?: string | null;
    amount: string | number;
    date?: Date | null;
  },
) {
  const date = input.date ?? new Date();
  const targets = [input.invoiceId, input.billId, input.chargeLineId].filter(Boolean).length;
  if (targets !== 1) {
    throw validation('Pick the invoice, bill or General Journal charge to apply the credit to.');
  }
  return inTransaction(ctx, async (tx) => {
    await assertCopyDates(tx, { lineIds: [input.journalLineId, input.chargeLineId], invoiceId: input.invoiceId, billId: input.billId });
    await assertPeriodOpen(tx, date);
    let rows: ApplicationRow[];
    if (input.chargeLineId) {
      const [line] = await tx.db
        .select({ subtype: accounts.subtype })
        .from(journalEntryLines)
        .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
        .where(eq(journalEntryLines.id, input.journalLineId));
      const side: Side = line?.subtype === 'accounts_payable' ? 'ap' : 'ar';
      const item = await loadItem(tx, side, input.journalLineId);
      rows = await applyJournalOffsets(tx, {
        side,
        entityId: item.entityId,
        date,
        offsets: [{ journalLineId: input.journalLineId, chargeLineId: input.chargeLineId, amount: input.amount }],
      });
    } else if (input.invoiceId) {
      const item = await loadItem(tx, 'ar', input.journalLineId);
      rows = await applyJournalCreditsToInvoices(tx, {
        customerId: item.entityId,
        date,
        credits: [{ journalLineId: input.journalLineId, invoiceId: input.invoiceId, amount: input.amount }],
      });
    } else {
      const item = await loadItem(tx, 'ap', input.journalLineId);
      rows = await applyJournalCreditsToBills(tx, {
        vendorId: item.entityId,
        date,
        credits: [{ journalLineId: input.journalLineId, billId: input.billId!, amount: input.amount }],
      });
    }
    await writeAudit(tx, {
      action: 'update',
      entityType: 'journal_entry',
      entityId: rows[0].journalEntryId,
      newValues: {
        action: 'apply_credit',
        journalLineId: input.journalLineId,
        invoiceId: input.invoiceId ?? null,
        billId: input.billId ?? null,
        chargeLineId: input.chargeLineId ?? null,
        amount: rows[0].amount,
        applicationId: rows[0].id,
      },
    });
    return rows[0];
  });
}

/**
 * Remove one application. A received payment's cash becomes unapplied credit on that payment again;
 * an invoice / bill gets its balance back. Cash a bill payment applied to a journal item is part of
 * the bill payment — edit or void the bill payment instead. Respects the closing date (the
 * application's date).
 */
export async function unapplyJournalApplication(ctx: ServiceContext, applicationId: string) {
  return inTransaction(ctx, async (tx) => {
    const [app] = await tx.db
      .select()
      .from(journalItemApplications)
      .where(and(eq(journalItemApplications.id, applicationId), eq(journalItemApplications.companyId, tx.companyId)));
    if (!app) throw notFound('Application');
    if (app.kind === 'bill_payment') {
      throw new ServiceError(
        'CONFLICT',
        'This amount was paid by a bill payment. Edit or void the bill payment to change what it paid.',
      );
    }
    if (app.kind === 'payment' && app.paymentId) {
      const [p] = await tx.db.select().from(paymentsReceived).where(eq(paymentsReceived.id, app.paymentId));
      if (p?.voidedAt || p?.bouncedAt) throw new ServiceError('CONFLICT', 'That payment is void or bounced.');
    }
    await assertCopyDates(tx, { lineIds: [app.journalLineId], invoiceId: app.invoiceId, billId: app.billId, paymentId: app.paymentId });
    await assertPeriodOpen(tx, app.date, { movable: false });
    // A General Journal credit applied to a General Journal charge is one application in two rows.
    const rows =
      app.kind === 'journal_offset' && app.pairId
        ? await tx.db
            .select()
            .from(journalItemApplications)
            .where(and(eq(journalItemApplications.companyId, tx.companyId), eq(journalItemApplications.pairId, app.pairId)))
        : [app];
    await reverseApplications(tx, rows, { restorePaymentUnapplied: true });
    await writeAudit(tx, {
      action: 'update',
      entityType: 'journal_entry',
      entityId: app.journalEntryId,
      oldValues: {
        applicationId: app.id,
        kind: app.kind,
        amount: app.amount,
        paymentId: app.paymentId,
        invoiceId: app.invoiceId,
        billId: app.billId,
      },
      newValues: { action: 'unapply' },
    });
    return app;
  });
}

/**
 * Apply part of an earlier payment's unapplied credit to General Journal charges (Receive Payments
 * "apply later"). No GL — the payment already credited A/R in full.
 */
export async function applyPaymentToJournalCharges(
  ctx: ServiceContext,
  input: { paymentId: string; items: JournalItemPaymentInput[] },
) {
  return inTransaction(ctx, async (tx) => {
    await assertCopyDates(tx, { lineIds: input.items.map((i) => i.journalLineId), paymentId: input.paymentId });
    const [payment] = await tx.db
      .select()
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.id, input.paymentId), eq(paymentsReceived.companyId, tx.companyId)));
    if (!payment) throw notFound('Payment');
    if (payment.voidedAt || payment.bouncedAt) throw new ServiceError('CONFLICT', 'That payment is void or bounced.');
    const total = await validateJournalChargesForPayment(tx, {
      customerId: payment.customerId,
      items: input.items,
      foreignPayment: await isForeignCurrency(tx, payment.currency),
    });
    if (total.greaterThan(Money.of(payment.unapplied))) {
      throw validation(
        `The payment only has ${toAmountString(payment.unapplied)} unapplied (tried to use ${toAmountString(total)}).`,
      );
    }
    await assertPeriodOpen(tx, payment.date, { movable: false });
    const rows = await recordJournalChargesPaid(tx, {
      paymentId: payment.id,
      customerId: payment.customerId,
      date: payment.date,
      items: input.items,
    });
    const newUnapplied = Money.round2(Money.of(payment.unapplied).minus(total));
    const [updated] = await tx.db
      .update(paymentsReceived)
      .set({ unapplied: toAmountString(newUnapplied) })
      .where(eq(paymentsReceived.id, payment.id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'payment_received',
      entityId: payment.id,
      oldValues: { unapplied: payment.unapplied },
      newValues: { action: 'apply_journal', items: input.items, unapplied: toAmountString(newUnapplied), applications: rows.map((r) => r.id) },
    });
    return updated;
  });
}

export interface JournalOpenItemRow {
  journalLineId: string;
  journalEntryId: string;
  entryNumber: number;
  /** "General Journal #12" */
  ref: string;
  date: string;
  memo: string | null;
  entityId: string;
  entityName: string | null;
  /** Full amount of the line (positive). */
  original: string;
  /** Amount still open (positive). */
  open: string;
}

/**
 * Open General Journal items of one customer (ar) / vendor (ap), split the way QuickBooks shows
 * them: `charges` can be paid (Receive Payments / Pay Bills), `credits` can be applied to invoices
 * / bills.
 */
export async function listJournalOpenItems(
  ctx: ServiceContext,
  side: Side,
  entityId: string,
): Promise<{ charges: JournalOpenItemRow[]; credits: JournalOpenItemRow[] }> {
  const items = await journalOpenItems(ctx, side, { entityId });
  const names = await resolveEntityNames(ctx, items);
  const charges: JournalOpenItemRow[] = [];
  const credits: JournalOpenItemRow[] = [];
  for (const it of items) {
    const open = Money.of(it.amount);
    const row: JournalOpenItemRow = {
      journalLineId: it.lineId,
      journalEntryId: it.journalEntryId,
      entryNumber: it.entryNumber,
      ref: `General Journal #${it.entryNumber}`,
      date: it.date.toISOString().slice(0, 10),
      memo: it.memo ?? it.description ?? null,
      entityId: it.entityId,
      entityName: names.get(`${it.entityType}:${it.entityId}`) ?? null,
      original: toAmountString(Money.of(it.original).abs()),
      open: toAmountString(open.abs()),
    };
    (open.greaterThan(0) ? charges : credits).push(row);
  }
  return { charges, credits };
}

/** Applications, filtered by payment / bill payment / journal entry / invoice / bill. */
export async function listJournalApplications(
  ctx: ServiceContext,
  opts: { paymentId?: string; billPaymentId?: string; journalEntryId?: string; invoiceId?: string; billId?: string },
) {
  const conds = [eq(journalItemApplications.companyId, ctx.companyId)];
  if (opts.paymentId) conds.push(eq(journalItemApplications.paymentId, opts.paymentId));
  if (opts.billPaymentId) conds.push(eq(journalItemApplications.billPaymentId, opts.billPaymentId));
  if (opts.journalEntryId) conds.push(eq(journalItemApplications.journalEntryId, opts.journalEntryId));
  if (opts.invoiceId) conds.push(eq(journalItemApplications.invoiceId, opts.invoiceId));
  if (opts.billId) conds.push(eq(journalItemApplications.billId, opts.billId));
  return ctx.db
    .select({
      id: journalItemApplications.id,
      side: journalItemApplications.side,
      kind: journalItemApplications.kind,
      journalEntryId: journalItemApplications.journalEntryId,
      journalLineId: journalItemApplications.journalLineId,
      entryNumber: journalEntries.entryNumber,
      paymentId: journalItemApplications.paymentId,
      billPaymentId: journalItemApplications.billPaymentId,
      invoiceId: journalItemApplications.invoiceId,
      billId: journalItemApplications.billId,
      amount: journalItemApplications.amount,
      date: journalItemApplications.date,
      pairId: journalItemApplications.pairId,
    })
    .from(journalItemApplications)
    .innerJoin(journalEntries, eq(journalItemApplications.journalEntryId, journalEntries.id))
    .where(and(...conds))
    .orderBy(asc(journalItemApplications.createdAt));
}
