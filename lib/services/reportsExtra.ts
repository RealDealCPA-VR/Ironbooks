/**
 * Extended financial reports — aging schedules, cash flow (indirect), and
 * customer/vendor summary views. None of these touch the GL; they are pure
 * read-only projections over the invoices, bills, and journal_entry_lines tables.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import {
  accounts,
  auditLogs,
  bouncedChecks,
  billLines,
  billPaymentApplications,
  billPayments,
  bills,
  creditApplications,
  creditMemos,
  customers,
  deposits,
  depositLines,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  paymentApplications,
  paymentsReceived,
  salesReceiptLines,
  salesReceipts,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { balanceSheet, notFiscalCloseEntry, type BalanceSheet } from '@/lib/services/reports';
import type { ServiceContext } from './_base';
import { isCashAccount, isCurrentLiability } from '@/lib/accountTypes';
import { journalCreditsAppliedAfter, journalOpenItems, resolveEntityNames } from './journal';
import { docRef } from './docNumbers';
import { unappliedCustomerPayments } from './customerCredits';

/**
 * Credit-memo refunds dated AFTER the cutoff, per memo id. creditMemos.unapplied is today's
 * figure; a refund posted after the cutoff had not yet reduced the customer's credit on the
 * cutoff date, so a backdated aging adds it back (the same rule unappliedCustomerPayments
 * applies to refunded overpayments). Keeps aging == A/R GL == customer statement.
 */
async function creditMemoRefundsAfter(ctx: ServiceContext, cutoff: Date): Promise<Map<string, string>> {
  const rows = await ctx.db
    .select({
      sourceRef: journalEntries.sourceRef,
      amount: sql<string>`COALESCE(SUM(CAST(${journalEntryLines.debit} AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        sql`${journalEntries.sourceRef} LIKE 'refund:%'`,
        gt(journalEntries.date, cutoff),
      ),
    )
    .groupBy(journalEntries.sourceRef);
  const out = new Map<string, string>();
  for (const r of rows) if (r.sourceRef) out.set(r.sourceRef.slice('refund:'.length), r.amount);
  return out;
}

type Dec = ReturnType<typeof Money.zero>;
const addTo = (m: Map<string, Dec>, k: string, v: Dec) => m.set(k, (m.get(k) ?? Money.zero()).plus(v));

/**
 * Credit-memo applications to invoices that take effect AFTER the cutoff, per invoice and per
 * memo. invoices.amountPaid and creditMemos.unapplied carry every application undated (today's
 * figures); on the cutoff date a later application had not yet reduced the invoice or consumed the
 * memo, so as-of aging adds it back to both. An application is effective on its own date, never
 * before the memo or the invoice (QB ages each invoice at its open balance on the report date).
 */
async function creditMemoApplicationsAfter(
  ctx: ServiceContext,
  cutoff: Date,
): Promise<{ byInvoice: Map<string, Dec>; byMemo: Map<string, Dec> }> {
  const rows = await ctx.db
    .select({ invoiceId: creditApplications.invoiceId, memoId: creditApplications.creditMemoId, amount: creditApplications.amount })
    .from(creditApplications)
    .innerJoin(creditMemos, eq(creditMemos.id, creditApplications.creditMemoId))
    .innerJoin(invoices, eq(invoices.id, creditApplications.invoiceId))
    .where(
      and(
        eq(creditApplications.companyId, ctx.companyId),
        sql`GREATEST(${creditApplications.date}, ${creditMemos.date}, ${invoices.date}) > ${cutoff}`,
      ),
    );
  const byInvoice = new Map<string, Dec>();
  const byMemo = new Map<string, Dec>();
  for (const r of rows) {
    const a = Money.of(r.amount);
    addTo(byInvoice, r.invoiceId, a);
    addTo(byMemo, r.memoId, a);
  }
  return { byInvoice, byMemo };
}

/**
 * Vendor-credit applications to bills (vendorCredits.applyToBill / unapplyFromBill) that take
 * effect AFTER the cutoff, per bill and per credit. Those write no GL entry and no dated link row;
 * the audit trail records which (credit, bill, amount) pairs were applied or unapplied. The
 * application itself is undated (applyToBill takes no date), so it is effective from the later of
 * the credit's and the bill's own dates: before the credit existed it cannot have reduced the
 * bill, and from then on the bill and the credit move together, so aging always ties to the A/P
 * account. Applications and unapplications of the same pair net out.
 *
 * Known difference: the cash-basis engine (cashBasisLedger.ts) dates the same application by the
 * day it was entered (audit timestamp), not by the document dates. Both tie to A/P in their own
 * basis; a dated application row would let them agree exactly (deferred, outside this team).
 */
async function vendorCreditApplicationsAfter(
  ctx: ServiceContext,
  cutoff: Date,
): Promise<{ byBill: Map<string, Dec>; byCredit: Map<string, Dec> }> {
  const byBill = new Map<string, Dec>();
  const byCredit = new Map<string, Dec>();
  const rows = await ctx.db
    .select({ creditId: auditLogs.entityId, newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'vendor_credit'),
        sql`${auditLogs.newValues}->>'action' IN ('applied_to_bill', 'unapplied_from_bill')`,
      ),
    );
  if (!rows.length) return { byBill, byCredit };
  const creditDate = new Map(
    (await ctx.db.select({ id: vendorCredits.id, date: vendorCredits.date }).from(vendorCredits).where(eq(vendorCredits.companyId, ctx.companyId))).map((c) => [c.id, c.date]),
  );
  const billDate = new Map(
    (await ctx.db.select({ id: bills.id, date: bills.date }).from(bills).where(eq(bills.companyId, ctx.companyId))).map((b) => [b.id, b.date]),
  );
  for (const r of rows) {
    const nv = (r.newValues ?? {}) as { action?: string; billId?: string; amount?: string };
    if (!nv.billId || !r.creditId) continue;
    const cd = creditDate.get(r.creditId);
    const bd = billDate.get(nv.billId);
    if (!cd || !bd) continue;
    const eff = cd > bd ? cd : bd;
    if (!(eff > cutoff)) continue;
    const a = Money.of(nv.amount ?? '0');
    const signed = nv.action === 'applied_to_bill' ? a : a.negated();
    addTo(byBill, nv.billId, signed);
    addTo(byCredit, r.creditId, signed);
  }
  return { byBill, byCredit };
}

/**
 * A credit memo's open credit as of the cutoff: today's unapplied plus refunds and invoice
 * applications that happened after it.
 */
function memoCreditAsOf(
  m: { id: string; unapplied: string },
  laterRefunds: Map<string, string>,
  laterApplications?: Map<string, Dec>,
) {
  return Money.of(m.unapplied)
    .plus(Money.of(laterRefunds.get(m.id) ?? '0'))
    .plus(laterApplications?.get(m.id) ?? Money.zero());
}

/** Detail-report variant of addJournalItemsToAging: one 'General Journal' row per line. */
async function addJournalItemsToAgingDetail(
  ctx: ServiceContext,
  side: 'ar' | 'ap',
  cutoff: Date,
  detail: AgingDetailRow[],
): Promise<void> {
  const items = await journalOpenItems(ctx, side, { asOf: cutoff });
  if (items.length === 0) return;
  const names = await resolveEntityNames(ctx, items);
  for (const it of items) {
    const amount = Money.of(it.amount);
    const raw = ms_to_days(cutoff.getTime() - it.date.getTime());
    detail.push({
      docId: it.journalEntryId,
      docNumber: `General Journal #${it.entryNumber}`,
      docType: 'journal_entry',
      entityId: it.entityId,
      entityName: names.get(`${it.entityType}:${it.entityId}`) ?? '(unknown)',
      date: it.date.toISOString(),
      dueDate: it.date.toISOString(),
      daysPastDue: amount.isNegative() ? 0 : Math.max(0, raw),
      bucket: amount.isNegative() ? 'current' : agingKey(raw),
      openBalance: toAmountString(amount),
    });
  }
}

/**
 * Unapplied customer payments (customerCredits.ts) are credits in the A/R subledger: the full
 * payment was credited to A/R, so the unapplied part must reduce what the customer owes —
 * e.g. a payment received against a General Journal charge, which has no invoice to apply to.
 */
async function addUnappliedPaymentsToAging(
  ctx: ServiceContext,
  cutoff: Date,
  byCustomer: Map<string, { name: string; buckets: BucketAccum }>,
): Promise<void> {
  const credits = await unappliedCustomerPayments(ctx, { asOf: cutoff });
  if (credits.length === 0) return;
  const names = await resolveEntityNames(
    ctx,
    credits.map((c) => ({ entityType: 'customer', entityId: c.customerId })),
  );
  for (const c of credits) {
    if (!byCustomer.has(c.customerId)) {
      byCustomer.set(c.customerId, {
        name: names.get(`customer:${c.customerId}`) ?? '(unknown)',
        buckets: blankBuckets(),
      });
    }
    const b = byCustomer.get(c.customerId)!.buckets;
    b.current = b.current.minus(Money.of(c.amount));
  }
}

async function addUnappliedPaymentsToAgingDetail(
  ctx: ServiceContext,
  cutoff: Date,
  detail: AgingDetailRow[],
): Promise<void> {
  const credits = await unappliedCustomerPayments(ctx, { asOf: cutoff });
  if (credits.length === 0) return;
  const names = await resolveEntityNames(
    ctx,
    credits.map((c) => ({ entityType: 'customer', entityId: c.customerId })),
  );
  for (const c of credits) {
    detail.push({
      docId: c.paymentId,
      docNumber: c.reference ? `Payment ${c.reference}` : 'Payment',
      docType: 'payment',
      entityId: c.customerId,
      entityName: names.get(`customer:${c.customerId}`) ?? '(unknown)',
      date: c.date.toISOString(),
      dueDate: null,
      daysPastDue: 0,
      bucket: 'current',
      openBalance: toAmountString(Money.of(c.amount).negated()),
    });
  }
}

/**
 * Add named General Journal A/R or A/P lines (journal.ts journalOpenItems) to an aging map.
 * Each line is an open item dated and due on the entry date (QB "General Journal" rows).
 */
async function addJournalItemsToAging(
  ctx: ServiceContext,
  side: 'ar' | 'ap',
  cutoff: Date,
  byEntity: Map<string, { name: string; buckets: BucketAccum }>,
): Promise<void> {
  const items = await journalOpenItems(ctx, side, { asOf: cutoff });
  if (items.length === 0) return;
  const names = await resolveEntityNames(ctx, items);
  for (const it of items) {
    if (!byEntity.has(it.entityId)) {
      byEntity.set(it.entityId, {
        name: names.get(`${it.entityType}:${it.entityId}`) ?? '(unknown)',
        buckets: blankBuckets(),
      });
    }
    const amount = Money.of(it.amount);
    // Credits (negative items) sit in 'current' like unapplied credits; charges age by date.
    const key = amount.isNegative()
      ? 'current'
      : agingKey(ms_to_days(cutoff.getTime() - it.date.getTime()));
    const b = byEntity.get(it.entityId)!.buckets;
    b[key] = b[key].plus(amount);
  }
}
// wave2 prefs: Reports > "Aging reports: age from due date / transaction date".
import { getPreferences } from './company';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface AgingBucket {
  /** The entity (customer or vendor) id. */
  id: string;
  name: string;
  /** Current — not yet due as of asOf. */
  current: string;
  /** 1-30 days past due. */
  days1_30: string;
  /** 31-60 days past due. */
  days31_60: string;
  /** 61-90 days past due. */
  days61_90: string;
  /** 91+ days past due. */
  days91plus: string;
  /** Sum of all buckets. */
  total: string;
}

export interface AgingReport {
  asOf: string;
  rows: AgingBucket[];
  totals: Omit<AgingBucket, 'id' | 'name'>;
}

// ---------------------------------------------------------------------------
// Internal bucket helper
// ---------------------------------------------------------------------------

/** Classify a document (invoice / bill) into an aging bucket.
 *  daysPastDue = (asOf - dueDate) in whole days; negative means not yet due.
 */
function agingKey(daysPastDue: number): BucketKey {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'days1_30';
  if (daysPastDue <= 60) return 'days31_60';
  if (daysPastDue <= 90) return 'days61_90';
  return 'days91plus';
}

/** The five mutable aging bucket keys (excluding id/name/total). */
type BucketKey = 'current' | 'days1_30' | 'days31_60' | 'days61_90' | 'days91plus';

type BucketAccum = Record<BucketKey, ReturnType<typeof Money.zero>>;

/** Blank per-entity bucket accumulator. */
function blankBuckets(): BucketAccum {
  return {
    current: Money.zero(),
    days1_30: Money.zero(),
    days31_60: Money.zero(),
    days61_90: Money.zero(),
    days91plus: Money.zero(),
  };
}

function ms_to_days(ms: number): number {
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * wave2 sales (F2): a bounced check deletes its payment's application rows and keeps a
 * snapshot on the bounced_checks record. As of a date ON/AFTER the payment but BEFORE the
 * bounce, that payment still paid those invoices — add the snapshot back so past aging
 * does not change after the fact.
 */
async function addBouncedApplicationsAsOf(ctx: ServiceContext, upTo: Date, map: Map<string, string>) {
  const rows = await ctx.db
    .select({ applications: bouncedChecks.applications })
    .from(bouncedChecks)
    .innerJoin(paymentsReceived, eq(bouncedChecks.paymentId, paymentsReceived.id))
    .where(
      and(
        eq(bouncedChecks.companyId, ctx.companyId),
        lte(paymentsReceived.date, upTo),
        gt(bouncedChecks.date, upTo),
      ),
    );
  for (const r of rows) {
    for (const a of r.applications ?? []) {
      if (!a.invoiceId) continue;
      const add = Money.of(a.amountApplied ?? 0).plus(Money.of(a.discountAmount ?? 0));
      map.set(a.invoiceId, toAmountString(Money.of(map.get(a.invoiceId) ?? 0).plus(add)));
    }
  }
}

// ---------------------------------------------------------------------------
// A/R Aging
// ---------------------------------------------------------------------------

/**
 * Accounts-Receivable aging by customer, reconstructed AS OF the cutoff date.
 *
 * Each invoice's balance is rebuilt from its billed base (total minus retainage)
 * minus payment applications whose payment date is on/before the cutoff — the live
 * balanceDue column reflects payments received AFTER the cutoff and cannot be used
 * for a backdated aging. Invoices dated after the cutoff are excluded, and invoices
 * now 'paid' still appear if they were open as of the cutoff. Unapplied credit
 * memos dated on/before the cutoff are included as negative 'current' amounts so
 * the report nets to true receivables (QB parity).
 *
 * Note: credit-memo applications have no dated application record, so the credited
 * portion of amountPaid (anything beyond dated cash applications) is treated as
 * always applied — a best-effort approximation for backdated runs.
 */
export async function arAging(ctx: ServiceContext, asOf?: Date): Promise<AgingReport> {
  const cutoff = asOf ?? new Date();
  const ageFromTxnDate = (await getPreferences(ctx)).agingFrom === 'transaction_date';

  // Invoices dated on/before the cutoff. Do NOT exclude 'paid' — an invoice paid
  // after the cutoff was still receivable as of the cutoff.
  const rows = await ctx.db
    .select({
      invoiceId: invoices.id,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      total: invoices.total,
      retainageAmount: invoices.retainageAmount,
      amountPaid: invoices.amountPaid,
      dueDate: invoices.dueDate,
      date: invoices.date,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        ne(invoices.status, 'void'),
        // Drafts (pending invoices) post nothing to A/R — QB leaves them off the aging.
        ne(invoices.status, 'draft'),
        lte(invoices.date, cutoff),
      ),
    );

  // Cash payment applications per invoice: as of the cutoff and all-time.
  async function paymentAppliedByInvoice(upTo?: Date): Promise<Map<string, string>> {
    const conds = [eq(paymentsReceived.companyId, ctx.companyId)];
    if (upTo) conds.push(lte(paymentsReceived.date, upTo));
    const appRows = await ctx.db
      .select({
        invoiceId: paymentApplications.invoiceId,
        // wave2 sales: early-payment discounts are dated with their payment, like cash.
        applied: sql<string>`COALESCE(SUM(CAST(${paymentApplications.amountApplied} AS NUMERIC) + CAST(${paymentApplications.discountAmount} AS NUMERIC)), 0)`,
      })
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentApplications.paymentId, paymentsReceived.id))
      .where(and(...conds))
      .groupBy(paymentApplications.invoiceId);
    const map = new Map(appRows.map((r) => [r.invoiceId, r.applied]));
    if (upTo) await addBouncedApplicationsAsOf(ctx, upTo, map);
    return map;
  }

  const [appliedAsOf, appliedAllTime] = await Promise.all([
    paymentAppliedByInvoice(cutoff),
    paymentAppliedByInvoice(),
  ]);
  const journalCreditsLater = await journalCreditsAppliedAfter(ctx, 'ar', cutoff);
  const memoAppsLater = await creditMemoApplicationsAfter(ctx, cutoff);

  // Accumulate per customer.
  const byCustomer = new Map<string, { name: string; buckets: BucketAccum }>();

  for (const row of rows) {
    // Balance due is computed against the billed base (total minus retainage),
    // matching invoices.markPaidAmount.
    const billedBase = Money.of(row.total).minus(Money.of(row.retainageAmount ?? '0'));
    const cashAsOf = Money.of(appliedAsOf.get(row.invoiceId) ?? '0');
    const cashAllTime = Money.of(appliedAllTime.get(row.invoiceId) ?? '0');
    // Portion of amountPaid not backed by dated cash applications = credit memos
    // (undated) — treat as applied regardless of cutoff.
    // General Journal credits applied after the cutoff had not reduced the invoice yet.
    let creditResidual = Money.of(row.amountPaid)
      .minus(cashAllTime)
      .minus(journalCreditsLater.get(row.invoiceId) ?? Money.zero())
      // Credit memos applied after the cutoff had not reduced the invoice yet either.
      .minus(memoAppsLater.byInvoice.get(row.invoiceId) ?? Money.zero());
    if (creditResidual.lessThan(0)) creditResidual = Money.zero();

    const amount = billedBase.minus(cashAsOf).minus(creditResidual);
    if (!amount.greaterThan(0)) continue;

    const effectiveDue = ageFromTxnDate ? row.date : (row.dueDate ?? row.date);
    const daysPastDue = ms_to_days(cutoff.getTime() - effectiveDue.getTime());
    const key = agingKey(daysPastDue);

    if (!byCustomer.has(row.customerId)) {
      byCustomer.set(row.customerId, { name: row.customerName, buckets: blankBuckets() });
    }
    byCustomer.get(row.customerId)!.buckets[key] = byCustomer.get(row.customerId)!.buckets[key].plus(amount);
  }

  // Unapplied credit memos reduce net receivables — negative 'current' rows.
  // A memo refunded after the cutoff still held its credit on the cutoff date.
  const memoLaterRefunds = await creditMemoRefundsAfter(ctx, cutoff);
  const memoRows = await ctx.db
    .select({
      id: creditMemos.id,
      customerId: creditMemos.customerId,
      customerName: customers.displayName,
      unapplied: creditMemos.unapplied,
    })
    .from(creditMemos)
    .innerJoin(customers, eq(creditMemos.customerId, customers.id))
    .where(
      and(
        eq(creditMemos.companyId, ctx.companyId),
        ne(creditMemos.status, 'void'),
        lte(creditMemos.date, cutoff),
      ),
    );

  for (const memo of memoRows) {
    const credit = memoCreditAsOf(memo, memoLaterRefunds, memoAppsLater.byMemo);
    if (!credit.greaterThan(0)) continue;
    if (!byCustomer.has(memo.customerId)) {
      byCustomer.set(memo.customerId, { name: memo.customerName, buckets: blankBuckets() });
    }
    const buckets = byCustomer.get(memo.customerId)!.buckets;
    buckets.current = buckets.current.minus(credit);
  }

  await addJournalItemsToAging(ctx, 'ar', cutoff, byCustomer);
  await addUnappliedPaymentsToAging(ctx, cutoff, byCustomer);

  return buildAgingReport(byCustomer, cutoff);
}

// ---------------------------------------------------------------------------
// A/P Aging
// ---------------------------------------------------------------------------

/**
 * Accounts-Payable aging by vendor, reconstructed AS OF the cutoff date.
 * Mirrors arAging: bill balances are rebuilt from total minus bill-payment
 * applications dated on/before the cutoff (live balanceDue reflects later
 * payments); bills dated after the cutoff are excluded; unapplied vendor credits
 * dated on/before the cutoff appear as negative 'current' amounts.
 */
// ---------------------------------------------------------------------------
// J10 (wave2 purchases): home-currency open balance of a foreign-currency bill
// ---------------------------------------------------------------------------

/** Home A/P relieved per bill by bill-payment applications dated on/before `upTo`. */
async function billPaymentHomeAppliedByBill(ctx: ServiceContext, upTo: Date): Promise<Map<string, string>> {
  const appRows = await ctx.db
    .select({
      billId: billPaymentApplications.billId,
      applied: sql<string>`COALESCE(SUM(CAST(COALESCE(${billPaymentApplications.amountHome}, ${billPaymentApplications.amountApplied}) AS NUMERIC)), 0)`,
    })
    .from(billPaymentApplications)
    .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
    .where(and(eq(billPayments.companyId, ctx.companyId), lte(billPayments.date, upTo)))
    .groupBy(billPaymentApplications.billId);
  return new Map(appRows.map((r) => [r.billId, r.applied]));
}

/** Home open balance = round2(total x rate) - home A/P already relieved (same anchor billPayments uses). */
function billHomeOpen(row: { total: string; exchangeRate: string | null }, homeApplied: string | undefined) {
  const anchor = Money.round2(Money.of(row.total).times(Money.of(row.exchangeRate ?? 1)));
  return Money.round2(anchor.minus(Money.of(homeApplied ?? '0')));
}

export async function apAging(ctx: ServiceContext, asOf?: Date): Promise<AgingReport> {
  const cutoff = asOf ?? new Date();
  const ageFromTxnDate = (await getPreferences(ctx)).agingFrom === 'transaction_date';

  const rows = await ctx.db
    .select({
      billId: bills.id,
      vendorId: bills.vendorId,
      vendorName: vendors.displayName,
      total: bills.total,
      amountPaid: bills.amountPaid,
      amountCredited: bills.amountCredited,
      dueDate: bills.dueDate,
      date: bills.date,
      currency: bills.currency,
      exchangeRate: bills.exchangeRate,
    })
    .from(bills)
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        ne(bills.status, 'void'),
        lte(bills.date, cutoff),
      ),
    );

  // Cash bill-payment applications per bill: as of the cutoff and all-time.
  async function billPaymentAppliedByBill(upTo?: Date): Promise<Map<string, string>> {
    const conds = [eq(billPayments.companyId, ctx.companyId)];
    if (upTo) conds.push(lte(billPayments.date, upTo));
    const appRows = await ctx.db
      .select({
        billId: billPaymentApplications.billId,
        applied: sql<string>`COALESCE(SUM(CAST(${billPaymentApplications.amountApplied} AS NUMERIC)), 0)`,
      })
      .from(billPaymentApplications)
      .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
      .where(and(...conds))
      .groupBy(billPaymentApplications.billId);
    return new Map(appRows.map((r) => [r.billId, r.applied]));
  }

  const [appliedAsOf, appliedAllTime] = await Promise.all([
    billPaymentAppliedByBill(cutoff),
    billPaymentAppliedByBill(),
  ]);
  const journalCreditsLater = await journalCreditsAppliedAfter(ctx, 'ap', cutoff);
  const vcAppsLater = await vendorCreditApplicationsAfter(ctx, cutoff);
  // Vendor refunds dated after the cutoff (JE sourceRef 'refund:<vendorCreditId>', Dr Bank / Cr A/P,
  // so the debit sum is the refund amount) had not consumed the credit yet on the cutoff date.
  const vcRefundsLater = await creditMemoRefundsAfter(ctx, cutoff);
  const homeAppliedAsOf = await billPaymentHomeAppliedByBill(ctx, cutoff);

  const byVendor = new Map<string, { name: string; buckets: BucketAccum }>();

  for (const row of rows) {
    const cashAsOf = Money.of(appliedAsOf.get(row.billId) ?? '0');
    const cashAllTime = Money.of(appliedAllTime.get(row.billId) ?? '0');
    // Settled portion not backed by dated cash applications = vendor credits
    // (undated) — treat as applied regardless of cutoff.
    let creditResidual = Money.of(row.amountPaid)
      .plus(Money.of(row.amountCredited ?? '0'))
      .minus(cashAllTime)
      // General Journal vendor credits applied after the cutoff had not reduced the bill yet.
      .minus(journalCreditsLater.get(row.billId) ?? Money.zero())
      // Vendor credits applied after the cutoff had not reduced the bill yet either.
      .minus(vcAppsLater.byBill.get(row.billId) ?? Money.zero());
    if (creditResidual.lessThan(0)) creditResidual = Money.zero();

    let amount = Money.of(row.total).minus(cashAsOf).minus(creditResidual);
    if (!amount.greaterThan(0)) continue;
    // J10 (wave2 purchases): age foreign bills at their HOME open balance so the report ties to
    // the A/P control account: round2(total x bill rate) minus the home A/P each payment relieved.
    if (row.currency) amount = billHomeOpen(row, homeAppliedAsOf.get(row.billId));

    const effectiveDue = ageFromTxnDate ? row.date : (row.dueDate ?? row.date);
    const daysPastDue = ms_to_days(cutoff.getTime() - effectiveDue.getTime());
    const key = agingKey(daysPastDue);

    if (!byVendor.has(row.vendorId)) {
      byVendor.set(row.vendorId, { name: row.vendorName, buckets: blankBuckets() });
    }
    byVendor.get(row.vendorId)!.buckets[key] = byVendor.get(row.vendorId)!.buckets[key].plus(amount);
  }

  // Unapplied vendor credits reduce net payables — negative 'current' rows.
  // Applications and refunds made after the cutoff are added back (the credit was still open then).
  const creditRows = await ctx.db
    .select({
      id: vendorCredits.id,
      vendorId: vendorCredits.vendorId,
      vendorName: vendors.displayName,
      unapplied: vendorCredits.unapplied,
    })
    .from(vendorCredits)
    .innerJoin(vendors, eq(vendorCredits.vendorId, vendors.id))
    .where(
      and(
        eq(vendorCredits.companyId, ctx.companyId),
        ne(vendorCredits.status, 'void'),
        lte(vendorCredits.date, cutoff),
      ),
    );

  for (const credit of creditRows) {
    const open = Money.of(credit.unapplied)
      .plus(vcAppsLater.byCredit.get(credit.id) ?? Money.zero())
      .plus(Money.of(vcRefundsLater.get(credit.id) ?? '0'));
    if (!open.greaterThan(0)) continue;
    if (!byVendor.has(credit.vendorId)) {
      byVendor.set(credit.vendorId, { name: credit.vendorName, buckets: blankBuckets() });
    }
    const buckets = byVendor.get(credit.vendorId)!.buckets;
    buckets.current = buckets.current.minus(open);
  }

  await addJournalItemsToAging(ctx, 'ap', cutoff, byVendor);

  return buildAgingReport(byVendor, cutoff);
}

/** Convert the accumulated per-entity map into a sorted AgingReport. */
function buildAgingReport(
  byEntity: Map<string, { name: string; buckets: BucketAccum }>,
  cutoff: Date,
): AgingReport {
  const grandTotals = blankBuckets();
  const agingRows: AgingBucket[] = [];

  for (const [id, { name, buckets }] of byEntity) {
    const rowTotal = Object.values(buckets).reduce((sum, b) => sum.plus(b), Money.zero());
    if (rowTotal.isZero()) continue; // skip zero-balance rows

    // Accumulate into grand totals.
    for (const k of Object.keys(buckets) as BucketKey[]) {
      grandTotals[k] = grandTotals[k].plus(buckets[k]);
    }

    agingRows.push({
      id,
      name,
      current: toAmountString(buckets.current),
      days1_30: toAmountString(buckets.days1_30),
      days31_60: toAmountString(buckets.days31_60),
      days61_90: toAmountString(buckets.days61_90),
      days91plus: toAmountString(buckets.days91plus),
      total: toAmountString(rowTotal),
    });
  }

  // Sort descending by total for the most-at-risk entities first.
  agingRows.sort((a, b) => Money.of(b.total).comparedTo(Money.of(a.total)));

  const grandTotal = Object.values(grandTotals).reduce((sum, b) => sum.plus(b), Money.zero());

  return {
    asOf: cutoff.toISOString(),
    rows: agingRows,
    totals: {
      current: toAmountString(grandTotals.current),
      days1_30: toAmountString(grandTotals.days1_30),
      days31_60: toAmountString(grandTotals.days31_60),
      days61_90: toAmountString(grandTotals.days61_90),
      days91plus: toAmountString(grandTotals.days91plus),
      total: toAmountString(grandTotal),
    },
  };
}

// ---------------------------------------------------------------------------
// Cash Flow (indirect method)
// ---------------------------------------------------------------------------

/** A named cash-impact line in the investing/financing/other-operating sections. */
export interface CashFlowLine {
  accountId: string;
  code: string;
  name: string;
  /** Signed cash impact (positive = source of cash, negative = use of cash). */
  amount: string;
}

export interface CashFlowReport {
  from?: string;
  to?: string;
  /** Operating activities: net income adjusted for working-capital changes. */
  operating: {
    netIncome: string;
    changeInAR: string;      // increase in AR is a use of cash (negative)
    changeInAP: string;      // increase in AP is a source of cash (positive)
    changeInInventory: string; // increase in inventory is a use of cash (negative)
    /** Other non-cash current assets/liabilities (credit cards, sales tax, etc.). */
    otherChanges: CashFlowLine[];
    total: string;
  };
  investing: {
    /** Per-account cash impact of long-term asset movement (fixed assets etc.). */
    lines: CashFlowLine[];
    total: string;
  };
  financing: {
    /** Per-account cash impact of long-term debt + equity movement. */
    lines: CashFlowLine[];
    total: string;
  };
  /** Operating + Investing + Financing. */
  netCashChange: string;
  /** Measured movement of the cash accounts themselves — ties to netCashChange. */
  cashAccountsChange: string;
}

/**
 * Indirect-method cash-flow statement, classification-driven.
 *
 * One grouped query computes every account's net debit/credit movement over the
 * period from posted journal lines (year-end closing entries excluded so the
 * Retained Earnings rollover doesn't double-count net income as a financing
 * inflow). Each account is then bucketed by type/subtype — never by hardcoded
 * account code, so renumbered or imported charts of accounts work too:
 *
 *   cash       asset: checking / savings (incl. Undeposited Funds)
 *   operating  net income (revenue - expense) ± all other current assets and
 *              liabilities (AR, inventory, AP, credit cards, taxes payable, ...)
 *   investing  asset: fixed_assets
 *   financing  liability: long_term_liability, plus all equity
 *
 * Because every non-cash account lands in exactly one section, netCashChange ties
 * to the measured movement of the cash accounts by construction.
 */
export async function cashFlow(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<CashFlowReport> {
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    notFiscalCloseEntry(),
  ];
  if (range?.from) conds.push(sql`${journalEntries.date} >= ${range.from}`);
  if (range?.to) conds.push(lte(journalEntries.date, range.to));

  // Net movement per account over the period.
  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      totalDebit: sql<string>`COALESCE(SUM(CAST(${journalEntryLines.debit} AS NUMERIC)), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(CAST(${journalEntryLines.credit} AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(...conds))
    .groupBy(
      journalEntryLines.accountId,
      accounts.code,
      accounts.name,
      accounts.type,
      accounts.subtype,
    );

  let netIncome = Money.zero();
  let cashChange = Money.zero();
  let changeInAR = Money.zero();
  let changeInAP = Money.zero();
  let changeInInventory = Money.zero();
  const otherOperating: CashFlowLine[] = [];
  const investingLines: CashFlowLine[] = [];
  const financingLines: CashFlowLine[] = [];
  let otherOperatingTotal = Money.zero();
  let investingTotal = Money.zero();
  let financingTotal = Money.zero();

  const pushLine = (
    list: CashFlowLine[],
    row: (typeof rows)[number],
    cashImpact: ReturnType<typeof Money.zero>,
  ) => {
    if (cashImpact.isZero()) return;
    list.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      amount: toAmountString(cashImpact),
    });
  };

  for (const row of rows) {
    const debitNet = Money.of(row.totalDebit).minus(Money.of(row.totalCredit));

    if (row.type === 'revenue') {
      netIncome = netIncome.plus(debitNet.negated()); // credit-normal
    } else if (row.type === 'expense') {
      netIncome = netIncome.minus(debitNet); // debit-normal
    } else if (row.type === 'asset') {
      const naturalChange = debitNet; // debit-normal
      if (isCashAccount(row)) {
        cashChange = cashChange.plus(naturalChange);
      } else if (row.subtype === 'accounts_receivable') {
        changeInAR = changeInAR.plus(naturalChange);
      } else if (row.subtype === 'inventory') {
        changeInInventory = changeInInventory.plus(naturalChange);
      } else if (row.subtype === 'fixed_assets' || row.subtype === 'other_asset') {
        // Asset growth is a use of cash.
        const impact = naturalChange.negated();
        investingTotal = investingTotal.plus(impact);
        pushLine(investingLines, row, impact);
      } else {
        // Other (current) assets — operating use of cash when they grow.
        const impact = naturalChange.negated();
        otherOperatingTotal = otherOperatingTotal.plus(impact);
        pushLine(otherOperating, row, impact);
      }
    } else if (row.type === 'liability') {
      const naturalChange = debitNet.negated(); // credit-normal
      if (row.subtype === 'accounts_payable') {
        changeInAP = changeInAP.plus(naturalChange);
      } else if (!isCurrentLiability(row)) {
        // Long-term liabilities: loan draws/paydowns are financing.
        financingTotal = financingTotal.plus(naturalChange);
        pushLine(financingLines, row, naturalChange);
      } else {
        // Credit cards and other current liabilities — operating source when they grow.
        otherOperatingTotal = otherOperatingTotal.plus(naturalChange);
        pushLine(otherOperating, row, naturalChange);
      }
    } else if (row.type === 'equity') {
      const naturalChange = debitNet.negated(); // credit-normal
      financingTotal = financingTotal.plus(naturalChange);
      pushLine(financingLines, row, naturalChange);
    }
  }

  // Operating total = net income - ΔAR + ΔAP - ΔInventory + other current changes.
  const operatingTotal = netIncome
    .minus(changeInAR)
    .plus(changeInAP)
    .minus(changeInInventory)
    .plus(otherOperatingTotal);

  const netCashChange = operatingTotal.plus(investingTotal).plus(financingTotal);

  const byCode = (a: CashFlowLine, b: CashFlowLine) => a.code.localeCompare(b.code);
  otherOperating.sort(byCode);
  investingLines.sort(byCode);
  financingLines.sort(byCode);

  return {
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
    operating: {
      netIncome: toAmountString(netIncome),
      changeInAR: toAmountString(changeInAR.negated()), // sign: negative = AR grew (cash used)
      changeInAP: toAmountString(changeInAP),           // sign: positive = AP grew (cash source)
      changeInInventory: toAmountString(changeInInventory.negated()), // negative = inv grew (cash used)
      otherChanges: otherOperating,
      total: toAmountString(operatingTotal),
    },
    investing: {
      lines: investingLines,
      total: toAmountString(investingTotal),
    },
    financing: {
      lines: financingLines,
      total: toAmountString(financingTotal),
    },
    netCashChange: toAmountString(netCashChange),
    cashAccountsChange: toAmountString(cashChange),
  };
}

// ---------------------------------------------------------------------------
// Sales by Customer
// ---------------------------------------------------------------------------

export interface SalesByCustomerRow {
  customerId: string;
  customerName: string;
  /** Sum of invoice totals (not balanceDue) for the period. */
  totalSales: string;
  /** Count of invoices. */
  invoiceCount: number;
}

/**
 * Total invoiced amount per customer for the given date range.
 * Voided invoices are excluded.
 */
export async function salesByCustomer(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<SalesByCustomerRow[]> {
  // Build conditions array.
  const conds = [
    eq(invoices.companyId, ctx.companyId),
    ne(invoices.status, 'void'),
    // Drafts post no revenue — keep sales in step with the P&L (as salesByItem does).
    ne(invoices.status, 'draft'),
  ];
  if (range?.from) conds.push(sql`${invoices.date} >= ${range.from}`);
  if (range?.to) conds.push(lte(invoices.date, range.to));

  const rows = await ctx.db
    .select({
      customerId: invoices.customerId,
      customerName: customers.displayName,
      totalSales: sql<string>`COALESCE(SUM(CAST(${invoices.total} AS NUMERIC)), 0)`,
      invoiceCount: sql<number>`COUNT(${invoices.id})`,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(...conds))
    .groupBy(invoices.customerId, customers.displayName)
    .orderBy(sql`SUM(CAST(${invoices.total} AS NUMERIC)) DESC`);

  return rows.map((r) => ({
    customerId: r.customerId,
    customerName: r.customerName,
    totalSales: toAmountString(r.totalSales),
    invoiceCount: Number(r.invoiceCount),
  }));
}

// ---------------------------------------------------------------------------
// Expenses by Vendor
// ---------------------------------------------------------------------------

export interface ExpensesByVendorRow {
  vendorId: string;
  vendorName: string;
  /** Sum of bill totals for the period. */
  totalExpenses: string;
  /** Count of bills. */
  billCount: number;
}

/**
 * Total billed amount per vendor for the given date range.
 * Voided bills are excluded.
 */
export async function expensesByVendor(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<ExpensesByVendorRow[]> {
  const conds = [
    eq(bills.companyId, ctx.companyId),
    ne(bills.status, 'void'),
  ];
  if (range?.from) conds.push(sql`${bills.date} >= ${range.from}`);
  if (range?.to) conds.push(lte(bills.date, range.to));

  const rows = await ctx.db
    .select({
      vendorId: bills.vendorId,
      vendorName: vendors.displayName,
      totalExpenses: sql<string>`COALESCE(SUM(CAST(${bills.total} AS NUMERIC)), 0)`,
      billCount: sql<number>`COUNT(${bills.id})`,
    })
    .from(bills)
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .where(and(...conds))
    .groupBy(bills.vendorId, vendors.displayName)
    .orderBy(sql`SUM(CAST(${bills.total} AS NUMERIC)) DESC`);

  return rows.map((r) => ({
    vendorId: r.vendorId,
    vendorName: r.vendorName,
    totalExpenses: toAmountString(r.totalExpenses),
    billCount: Number(r.billCount),
  }));
}

// ---------------------------------------------------------------------------
// A/R & A/P Aging DETAIL — one row per open document under each bucket
// ---------------------------------------------------------------------------

/** Display order of the aging buckets, exported for UI/CSV rendering. */
export const AGING_BUCKET_ORDER: BucketKey[] = [
  'current',
  'days1_30',
  'days31_60',
  'days61_90',
  'days91plus',
];

export const AGING_BUCKET_LABELS: Record<BucketKey, string> = {
  current: 'Current',
  days1_30: '1-30 Days Past Due',
  days31_60: '31-60 Days Past Due',
  days61_90: '61-90 Days Past Due',
  days91plus: '91+ Days Past Due',
};

export interface AgingDetailRow {
  /** Source document id (invoice / bill / credit memo / vendor credit). */
  docId: string;
  /** Human-readable document label, e.g. "Invoice #12" or "Credit Memo #3". */
  docNumber: string;
  docType: 'invoice' | 'bill' | 'credit_memo' | 'vendor_credit' | 'journal_entry' | 'payment';
  entityId: string;
  entityName: string;
  date: string;
  dueDate: string | null;
  daysPastDue: number;
  bucket: BucketKey;
  /** Open balance as of the cutoff (negative for unapplied credits). */
  openBalance: string;
}

export interface AgingDetailReport {
  asOf: string;
  rows: AgingDetailRow[];
  bucketTotals: Record<BucketKey, string>;
  total: string;
}

function buildAgingDetailReport(rows: AgingDetailRow[], cutoff: Date): AgingDetailReport {
  const bucketTotals = blankBuckets();
  let total = Money.zero();
  for (const r of rows) {
    bucketTotals[r.bucket] = bucketTotals[r.bucket].plus(Money.of(r.openBalance));
    total = total.plus(Money.of(r.openBalance));
  }
  const order = (k: BucketKey) => AGING_BUCKET_ORDER.indexOf(k);
  rows.sort(
    (a, b) =>
      order(a.bucket) - order(b.bucket) ||
      a.entityName.localeCompare(b.entityName) ||
      a.date.localeCompare(b.date),
  );
  return {
    asOf: cutoff.toISOString(),
    rows,
    bucketTotals: {
      current: toAmountString(bucketTotals.current),
      days1_30: toAmountString(bucketTotals.days1_30),
      days31_60: toAmountString(bucketTotals.days31_60),
      days61_90: toAmountString(bucketTotals.days61_90),
      days91plus: toAmountString(bucketTotals.days91plus),
    },
    total: toAmountString(total),
  };
}

/**
 * A/R Aging Detail — per-invoice rows bucketed by days past due as of the cutoff.
 * Balance reconstruction matches arAging (billed base minus dated cash applications
 * minus undated credit residual). Unapplied credit memos appear as negative
 * 'current' rows, mirroring QB's AR Aging Detail.
 */
export async function arAgingDetail(ctx: ServiceContext, asOf?: Date): Promise<AgingDetailReport> {
  const cutoff = asOf ?? new Date();
  const ageFromTxnDate = (await getPreferences(ctx)).agingFrom === 'transaction_date';

  const rows = await ctx.db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      refNumber: invoices.refNumber,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      total: invoices.total,
      retainageAmount: invoices.retainageAmount,
      amountPaid: invoices.amountPaid,
      dueDate: invoices.dueDate,
      date: invoices.date,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
        lte(invoices.date, cutoff),
      ),
    );

  async function paymentAppliedByInvoice(upTo?: Date): Promise<Map<string, string>> {
    const conds = [eq(paymentsReceived.companyId, ctx.companyId)];
    if (upTo) conds.push(lte(paymentsReceived.date, upTo));
    const appRows = await ctx.db
      .select({
        invoiceId: paymentApplications.invoiceId,
        // wave2 sales: early-payment discounts are dated with their payment, like cash.
        applied: sql<string>`COALESCE(SUM(CAST(${paymentApplications.amountApplied} AS NUMERIC) + CAST(${paymentApplications.discountAmount} AS NUMERIC)), 0)`,
      })
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentApplications.paymentId, paymentsReceived.id))
      .where(and(...conds))
      .groupBy(paymentApplications.invoiceId);
    const map = new Map(appRows.map((r) => [r.invoiceId, r.applied]));
    if (upTo) await addBouncedApplicationsAsOf(ctx, upTo, map);
    return map;
  }

  const [appliedAsOf, appliedAllTime] = await Promise.all([
    paymentAppliedByInvoice(cutoff),
    paymentAppliedByInvoice(),
  ]);
  const journalCreditsLater = await journalCreditsAppliedAfter(ctx, 'ar', cutoff);
  const memoAppsLater = await creditMemoApplicationsAfter(ctx, cutoff);

  const detail: AgingDetailRow[] = [];
  for (const row of rows) {
    const billedBase = Money.of(row.total).minus(Money.of(row.retainageAmount ?? '0'));
    const cashAsOf = Money.of(appliedAsOf.get(row.invoiceId) ?? '0');
    const cashAllTime = Money.of(appliedAllTime.get(row.invoiceId) ?? '0');
    // General Journal credits applied after the cutoff had not reduced the invoice yet.
    let creditResidual = Money.of(row.amountPaid)
      .minus(cashAllTime)
      .minus(journalCreditsLater.get(row.invoiceId) ?? Money.zero())
      // Credit memos applied after the cutoff had not reduced the invoice yet either.
      .minus(memoAppsLater.byInvoice.get(row.invoiceId) ?? Money.zero());
    if (creditResidual.lessThan(0)) creditResidual = Money.zero();

    const amount = billedBase.minus(cashAsOf).minus(creditResidual);
    if (!amount.greaterThan(0)) continue;

    const effectiveDue = ageFromTxnDate ? row.date : (row.dueDate ?? row.date);
    const rawDaysPastDue = ms_to_days(cutoff.getTime() - effectiveDue.getTime());
    detail.push({
      docId: row.invoiceId,
      docNumber: `Invoice #${docRef(row.refNumber, row.invoiceNumber)}`,
      docType: 'invoice',
      entityId: row.customerId,
      entityName: row.customerName,
      date: row.date.toISOString(),
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      daysPastDue: Math.max(0, rawDaysPastDue),
      bucket: agingKey(rawDaysPastDue),
      openBalance: toAmountString(amount),
    });
  }

  // Unapplied credit memos — negative 'current' rows (refunds after the cutoff added back).
  const memoLaterRefunds = await creditMemoRefundsAfter(ctx, cutoff);
  const memoRows = await ctx.db
    .select({
      id: creditMemos.id,
      memoNumber: creditMemos.memoNumber,
      refNumber: creditMemos.refNumber,
      customerId: creditMemos.customerId,
      customerName: customers.displayName,
      date: creditMemos.date,
      unapplied: creditMemos.unapplied,
    })
    .from(creditMemos)
    .innerJoin(customers, eq(creditMemos.customerId, customers.id))
    .where(
      and(
        eq(creditMemos.companyId, ctx.companyId),
        ne(creditMemos.status, 'void'),
        lte(creditMemos.date, cutoff),
      ),
    );
  for (const m of memoRows) {
    const credit = memoCreditAsOf(m, memoLaterRefunds, memoAppsLater.byMemo);
    if (!credit.greaterThan(0)) continue;
    detail.push({
      docId: m.id,
      docNumber: `Credit Memo #${docRef(m.refNumber, m.memoNumber)}`,
      docType: 'credit_memo',
      entityId: m.customerId,
      entityName: m.customerName,
      date: m.date.toISOString(),
      dueDate: null,
      daysPastDue: 0,
      bucket: 'current',
      openBalance: toAmountString(credit.negated()),
    });
  }

  await addJournalItemsToAgingDetail(ctx, 'ar', cutoff, detail);
  await addUnappliedPaymentsToAgingDetail(ctx, cutoff, detail);
  return buildAgingDetailReport(detail, cutoff);
}

/**
 * A/P Aging Detail — per-bill rows bucketed by days past due as of the cutoff.
 * Mirrors apAging's balance reconstruction; unapplied vendor credits appear as
 * negative 'current' rows.
 */
export async function apAgingDetail(ctx: ServiceContext, asOf?: Date): Promise<AgingDetailReport> {
  const cutoff = asOf ?? new Date();
  const ageFromTxnDate = (await getPreferences(ctx)).agingFrom === 'transaction_date';

  const rows = await ctx.db
    .select({
      billId: bills.id,
      billNumber: bills.billNumber,
      vendorId: bills.vendorId,
      vendorName: vendors.displayName,
      total: bills.total,
      amountPaid: bills.amountPaid,
      amountCredited: bills.amountCredited,
      dueDate: bills.dueDate,
      date: bills.date,
      currency: bills.currency,
      exchangeRate: bills.exchangeRate,
    })
    .from(bills)
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .where(and(eq(bills.companyId, ctx.companyId), ne(bills.status, 'void'), lte(bills.date, cutoff)));

  async function billPaymentAppliedByBill(upTo?: Date): Promise<Map<string, string>> {
    const conds = [eq(billPayments.companyId, ctx.companyId)];
    if (upTo) conds.push(lte(billPayments.date, upTo));
    const appRows = await ctx.db
      .select({
        billId: billPaymentApplications.billId,
        applied: sql<string>`COALESCE(SUM(CAST(${billPaymentApplications.amountApplied} AS NUMERIC)), 0)`,
      })
      .from(billPaymentApplications)
      .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
      .where(and(...conds))
      .groupBy(billPaymentApplications.billId);
    return new Map(appRows.map((r) => [r.billId, r.applied]));
  }

  const [appliedAsOf, appliedAllTime] = await Promise.all([
    billPaymentAppliedByBill(cutoff),
    billPaymentAppliedByBill(),
  ]);
  const journalCreditsLater = await journalCreditsAppliedAfter(ctx, 'ap', cutoff);
  const vcAppsLater = await vendorCreditApplicationsAfter(ctx, cutoff);
  // Vendor refunds dated after the cutoff (JE sourceRef 'refund:<vendorCreditId>', Dr Bank / Cr A/P,
  // so the debit sum is the refund amount) had not consumed the credit yet on the cutoff date.
  const vcRefundsLater = await creditMemoRefundsAfter(ctx, cutoff);
  const homeAppliedAsOf = await billPaymentHomeAppliedByBill(ctx, cutoff);

  const detail: AgingDetailRow[] = [];
  for (const row of rows) {
    const cashAsOf = Money.of(appliedAsOf.get(row.billId) ?? '0');
    const cashAllTime = Money.of(appliedAllTime.get(row.billId) ?? '0');
    let creditResidual = Money.of(row.amountPaid)
      .plus(Money.of(row.amountCredited ?? '0'))
      .minus(cashAllTime)
      // General Journal vendor credits applied after the cutoff had not reduced the bill yet.
      .minus(journalCreditsLater.get(row.billId) ?? Money.zero())
      // Vendor credits applied after the cutoff had not reduced the bill yet either.
      .minus(vcAppsLater.byBill.get(row.billId) ?? Money.zero());
    if (creditResidual.lessThan(0)) creditResidual = Money.zero();

    let amount = Money.of(row.total).minus(cashAsOf).minus(creditResidual);
    if (!amount.greaterThan(0)) continue;
    // J10 (wave2 purchases): age foreign bills at their HOME open balance so the report ties to
    // the A/P control account: round2(total x bill rate) minus the home A/P each payment relieved.
    if (row.currency) amount = billHomeOpen(row, homeAppliedAsOf.get(row.billId));

    const effectiveDue = ageFromTxnDate ? row.date : (row.dueDate ?? row.date);
    const rawDaysPastDue = ms_to_days(cutoff.getTime() - effectiveDue.getTime());
    detail.push({
      docId: row.billId,
      docNumber: row.billNumber ? `Bill ${row.billNumber}` : 'Bill',
      docType: 'bill',
      entityId: row.vendorId,
      entityName: row.vendorName,
      date: row.date.toISOString(),
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      daysPastDue: Math.max(0, rawDaysPastDue),
      bucket: agingKey(rawDaysPastDue),
      openBalance: toAmountString(amount),
    });
  }

  const creditRows = await ctx.db
    .select({
      id: vendorCredits.id,
      vendorId: vendorCredits.vendorId,
      vendorName: vendors.displayName,
      date: vendorCredits.date,
      unapplied: vendorCredits.unapplied,
    })
    .from(vendorCredits)
    .innerJoin(vendors, eq(vendorCredits.vendorId, vendors.id))
    .where(
      and(
        eq(vendorCredits.companyId, ctx.companyId),
        ne(vendorCredits.status, 'void'),
        lte(vendorCredits.date, cutoff),
      ),
    );
  for (const c of creditRows) {
    // Applications and refunds made after the cutoff are added back (the credit was still open then).
    const open = Money.of(c.unapplied)
      .plus(vcAppsLater.byCredit.get(c.id) ?? Money.zero())
      .plus(Money.of(vcRefundsLater.get(c.id) ?? '0'));
    if (!open.greaterThan(0)) continue;
    detail.push({
      docId: c.id,
      docNumber: 'Vendor Credit',
      docType: 'vendor_credit',
      entityId: c.vendorId,
      entityName: c.vendorName,
      date: c.date.toISOString(),
      dueDate: null,
      daysPastDue: 0,
      bucket: 'current',
      openBalance: toAmountString(open.negated()),
    });
  }

  await addJournalItemsToAgingDetail(ctx, 'ap', cutoff, detail);
  return buildAgingDetailReport(detail, cutoff);
}

// ---------------------------------------------------------------------------
// Open Invoices
// ---------------------------------------------------------------------------

export interface OpenInvoiceRow {
  invoiceId: string;
  invoiceNumber: number;
  /** The number the user sees (typed ref number, else the legacy integer). */
  refNumber: string;
  customerId: string;
  customerName: string;
  date: string;
  dueDate: string | null;
  terms: string | null;
  /** Days past due (0 when not yet due). */
  daysOverdue: number;
  total: string;
  balanceDue: string;
}

export interface OpenInvoicesReport {
  asOf: string;
  rows: OpenInvoiceRow[];
  totalOpen: string;
}

/**
 * Open Invoices — every unpaid (non-void, non-draft) invoice with its live
 * balance due, sorted by customer then date. QB parity: "Open Invoices" report.
 */
export async function openInvoices(ctx: ServiceContext): Promise<OpenInvoicesReport> {
  const now = new Date();
  const rows = await ctx.db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      refNumber: invoices.refNumber,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      date: invoices.date,
      dueDate: invoices.dueDate,
      terms: invoices.terms,
      total: invoices.total,
      balanceDue: invoices.balanceDue,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
        sql`CAST(${invoices.balanceDue} AS NUMERIC) > 0`,
      ),
    )
    .orderBy(asc(customers.displayName), asc(invoices.date));

  let totalOpen = Money.zero();
  const out: OpenInvoiceRow[] = rows.map((r) => {
    totalOpen = totalOpen.plus(Money.of(r.balanceDue));
    const effectiveDue = r.dueDate ?? r.date;
    return {
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      refNumber: docRef(r.refNumber, r.invoiceNumber),
      customerId: r.customerId,
      customerName: r.customerName,
      date: r.date.toISOString(),
      dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      terms: r.terms,
      daysOverdue: Math.max(0, ms_to_days(now.getTime() - effectiveDue.getTime())),
      total: toAmountString(r.total),
      balanceDue: toAmountString(r.balanceDue),
    };
  });

  return { asOf: now.toISOString(), rows: out, totalOpen: toAmountString(totalOpen) };
}

// ---------------------------------------------------------------------------
// Collections report — overdue invoices grouped by customer with contact info
// ---------------------------------------------------------------------------

export interface CollectionsInvoice {
  invoiceId: string;
  invoiceNumber: number;
  /** The number the user sees (typed ref number, else the legacy integer). */
  refNumber: string;
  date: string;
  dueDate: string | null;
  daysOverdue: number;
  balanceDue: string;
}

export interface CollectionsCustomer {
  customerId: string;
  customerName: string;
  email: string | null;
  phone: string | null;
  totalDue: string;
  invoices: CollectionsInvoice[];
}

export interface CollectionsReport {
  asOf: string;
  customers: CollectionsCustomer[];
  totalDue: string;
}

/**
 * Collections Report — overdue open invoices grouped by customer, with the
 * customer's contact details so the user can chase payment (QB parity).
 * An invoice is overdue when its effective due date (dueDate, falling back to
 * the invoice date) is strictly before the as-of date and it still has a balance.
 */
export async function collectionsReport(ctx: ServiceContext, asOf?: Date): Promise<CollectionsReport> {
  const cutoff = asOf ?? new Date();
  const rows = await ctx.db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      refNumber: invoices.refNumber,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      email: customers.email,
      phone: customers.phone,
      date: invoices.date,
      dueDate: invoices.dueDate,
      balanceDue: invoices.balanceDue,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
        sql`CAST(${invoices.balanceDue} AS NUMERIC) > 0`,
      ),
    )
    .orderBy(asc(customers.displayName), asc(invoices.date));

  const byCustomer = new Map<string, CollectionsCustomer>();
  let totalDue = Money.zero();

  for (const r of rows) {
    const effectiveDue = r.dueDate ?? r.date;
    const daysOverdue = ms_to_days(cutoff.getTime() - effectiveDue.getTime());
    if (daysOverdue <= 0) continue; // not yet due — not a collections item

    if (!byCustomer.has(r.customerId)) {
      byCustomer.set(r.customerId, {
        customerId: r.customerId,
        customerName: r.customerName,
        email: r.email,
        phone: r.phone,
        totalDue: '0.00',
        invoices: [],
      });
    }
    const cust = byCustomer.get(r.customerId)!;
    cust.invoices.push({
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      refNumber: docRef(r.refNumber, r.invoiceNumber),
      date: r.date.toISOString(),
      dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      daysOverdue,
      balanceDue: toAmountString(r.balanceDue),
    });
    cust.totalDue = toAmountString(Money.of(cust.totalDue).plus(Money.of(r.balanceDue)));
    totalDue = totalDue.plus(Money.of(r.balanceDue));
  }

  return {
    asOf: cutoff.toISOString(),
    customers: [...byCustomer.values()],
    totalDue: toAmountString(totalDue),
  };
}

// ---------------------------------------------------------------------------
// Missing Checks — gaps in the check-number sequence per bank account
// ---------------------------------------------------------------------------

export interface MissingCheckRange {
  from: number;
  to: number;
  count: number;
}

export interface MissingChecksAccountRow {
  accountId: string;
  accountName: string;
  firstNumber: number;
  lastNumber: number;
  /** Distinct numeric check numbers found (incl. voided checks — they consume a number). */
  checkCount: number;
  missing: MissingCheckRange[];
  missingCount: number;
}

export interface MissingChecksReport {
  accounts: MissingChecksAccountRow[];
}

/**
 * Missing Checks — for each bank account, finds gaps in the numeric check-number
 * sequence across write-check expenses AND bill payments paid by check (QB parity).
 * Voided checks are included in the sequence (a voided check still uses its number);
 * non-numeric references are ignored.
 */
export async function missingChecks(ctx: ServiceContext, accountId?: string): Promise<MissingChecksReport> {
  const expConds = [
    eq(expenses.companyId, ctx.companyId),
    eq(expenses.method, 'check' as const),
    isNotNull(expenses.reference),
  ];
  if (accountId) expConds.push(eq(expenses.paymentAccountId, accountId));
  const expRows = await ctx.db
    .select({
      accountId: expenses.paymentAccountId,
      accountName: accounts.name,
      reference: expenses.reference,
    })
    .from(expenses)
    .innerJoin(accounts, eq(expenses.paymentAccountId, accounts.id))
    .where(and(...expConds));

  const bpConds = [
    eq(billPayments.companyId, ctx.companyId),
    eq(billPayments.method, 'check' as const),
    isNotNull(billPayments.reference),
    isNotNull(billPayments.paymentAccountId),
  ];
  if (accountId) bpConds.push(eq(billPayments.paymentAccountId, accountId));
  const bpRows = await ctx.db
    .select({
      accountId: billPayments.paymentAccountId,
      accountName: accounts.name,
      reference: billPayments.reference,
    })
    .from(billPayments)
    .innerJoin(accounts, eq(billPayments.paymentAccountId, accounts.id))
    .where(and(...bpConds));

  // Collect distinct numeric check numbers per account.
  const byAccount = new Map<string, { name: string; numbers: Set<number> }>();
  for (const r of [...expRows, ...bpRows]) {
    if (!r.accountId || !r.reference) continue;
    const trimmed = r.reference.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num)) continue;
    if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, { name: r.accountName, numbers: new Set() });
    byAccount.get(r.accountId)!.numbers.add(num);
  }

  const out: MissingChecksAccountRow[] = [];
  for (const [acctId, { name, numbers }] of byAccount) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const missing: MissingCheckRange[] = [];
    let missingCount = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > 1) {
        const from = sorted[i - 1] + 1;
        const to = sorted[i] - 1;
        missing.push({ from, to, count: to - from + 1 });
        missingCount += to - from + 1;
      }
    }
    out.push({
      accountId: acctId,
      accountName: name,
      firstNumber: sorted[0],
      lastNumber: sorted[sorted.length - 1],
      checkCount: sorted.length,
      missing,
      missingCount,
    });
  }
  out.sort((a, b) => a.accountName.localeCompare(b.accountName));
  return { accounts: out };
}

// ---------------------------------------------------------------------------
// Check Detail — every check written (expenses + bill payments) with split lines
// ---------------------------------------------------------------------------

export interface CheckDetailLine {
  description: string | null;
  /** Split account (expense lines) or applied bill (bill payments). */
  detail: string;
  amount: string;
}

export interface CheckDetailRow {
  source: 'expense' | 'bill_payment';
  id: string;
  date: string;
  checkNumber: string | null;
  payee: string | null;
  bankAccountId: string;
  bankAccountName: string;
  amount: string;
  voided: boolean;
  lines: CheckDetailLine[];
}

export interface CheckDetailReport {
  from?: string;
  to?: string;
  rows: CheckDetailRow[];
  /** Sum of non-voided checks. */
  total: string;
}

/**
 * Check Detail — all checks written in the period from BOTH sources of checks:
 * write-check expenses (with their expense-account split lines) and bill payments
 * by check (with the bills they paid). Voided checks are listed but excluded
 * from the total.
 */
export async function checkDetail(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<CheckDetailReport> {
  const expConds = [eq(expenses.companyId, ctx.companyId), eq(expenses.method, 'check' as const)];
  if (range?.from) expConds.push(gte(expenses.date, range.from));
  if (range?.to) expConds.push(lte(expenses.date, range.to));
  const expRows = await ctx.db
    .select({
      id: expenses.id,
      date: expenses.date,
      reference: expenses.reference,
      payeeName: expenses.payeeName,
      vendorName: vendors.displayName,
      accountId: expenses.paymentAccountId,
      accountName: accounts.name,
      total: expenses.total,
      voidedAt: expenses.voidedAt,
    })
    .from(expenses)
    .innerJoin(accounts, eq(expenses.paymentAccountId, accounts.id))
    .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
    .where(and(...expConds));

  // Split lines for the expense checks, in bulk.
  const expIds = expRows.map((r) => r.id);
  const expLineRows = expIds.length
    ? await ctx.db
        .select({
          expenseId: expenseLines.expenseId,
          description: expenseLines.description,
          accountName: accounts.name,
          amount: expenseLines.amount,
          lineOrder: expenseLines.lineOrder,
        })
        .from(expenseLines)
        .innerJoin(accounts, eq(expenseLines.accountId, accounts.id))
        .where(inArray(expenseLines.expenseId, expIds))
    : [];
  const expLinesById = new Map<string, CheckDetailLine[]>();
  for (const l of [...expLineRows].sort((a, b) => a.lineOrder - b.lineOrder)) {
    if (!expLinesById.has(l.expenseId)) expLinesById.set(l.expenseId, []);
    expLinesById.get(l.expenseId)!.push({
      description: l.description,
      detail: l.accountName,
      amount: toAmountString(l.amount),
    });
  }

  const bpConds = [
    eq(billPayments.companyId, ctx.companyId),
    eq(billPayments.method, 'check' as const),
    isNotNull(billPayments.paymentAccountId),
  ];
  if (range?.from) bpConds.push(gte(billPayments.date, range.from));
  if (range?.to) bpConds.push(lte(billPayments.date, range.to));
  const bpRows = await ctx.db
    .select({
      id: billPayments.id,
      date: billPayments.date,
      reference: billPayments.reference,
      vendorName: vendors.displayName,
      accountId: billPayments.paymentAccountId,
      accountName: accounts.name,
      amount: billPayments.amount,
      voidedAt: billPayments.voidedAt,
    })
    .from(billPayments)
    .innerJoin(accounts, eq(billPayments.paymentAccountId, accounts.id))
    .innerJoin(vendors, eq(billPayments.vendorId, vendors.id))
    .where(and(...bpConds));

  const bpIds = bpRows.map((r) => r.id);
  const bpAppRows = bpIds.length
    ? await ctx.db
        .select({
          billPaymentId: billPaymentApplications.billPaymentId,
          billNumber: bills.billNumber,
          amountApplied: billPaymentApplications.amountApplied,
        })
        .from(billPaymentApplications)
        .innerJoin(bills, eq(billPaymentApplications.billId, bills.id))
        .where(inArray(billPaymentApplications.billPaymentId, bpIds))
    : [];
  const bpLinesById = new Map<string, CheckDetailLine[]>();
  for (const a of bpAppRows) {
    if (!bpLinesById.has(a.billPaymentId)) bpLinesById.set(a.billPaymentId, []);
    bpLinesById.get(a.billPaymentId)!.push({
      description: null,
      detail: a.billNumber ? `Bill ${a.billNumber}` : 'Bill',
      amount: toAmountString(a.amountApplied),
    });
  }

  const rows: CheckDetailRow[] = [
    ...expRows.map((r): CheckDetailRow => ({
      source: 'expense',
      id: r.id,
      date: r.date.toISOString(),
      checkNumber: r.reference,
      payee: r.vendorName ?? r.payeeName,
      bankAccountId: r.accountId,
      bankAccountName: r.accountName,
      amount: toAmountString(r.total),
      voided: r.voidedAt !== null,
      lines: expLinesById.get(r.id) ?? [],
    })),
    ...bpRows.map((r): CheckDetailRow => ({
      source: 'bill_payment',
      id: r.id,
      date: r.date.toISOString(),
      checkNumber: r.reference,
      payee: r.vendorName,
      bankAccountId: r.accountId!,
      bankAccountName: r.accountName,
      amount: toAmountString(r.amount),
      voided: r.voidedAt !== null,
      lines: bpLinesById.get(r.id) ?? [],
    })),
  ];
  rows.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.checkNumber ?? '').localeCompare(b.checkNumber ?? ''),
  );

  let total = Money.zero();
  for (const r of rows) if (!r.voided) total = total.plus(Money.of(r.amount));

  return {
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
    rows,
    total: toAmountString(total),
  };
}

// ---------------------------------------------------------------------------
// Deposit Detail — deposits with their constituent lines
// ---------------------------------------------------------------------------

export interface DepositDetailLine {
  description: string | null;
  /** Customer behind the deposited payment, when the line came from a received payment. */
  customerName: string | null;
  amount: string;
}

export interface DepositDetailRow {
  id: string;
  date: string;
  accountId: string;
  accountName: string;
  memo: string | null;
  total: string;
  voided: boolean;
  lines: DepositDetailLine[];
}

export interface DepositDetailReport {
  from?: string;
  to?: string;
  rows: DepositDetailRow[];
  /** Sum of non-voided deposits. */
  total: string;
}

/**
 * Deposit Detail — every bank deposit in the period with its line items, each
 * line resolved to the customer whose payment was deposited (QB parity).
 * Voided deposits are listed but excluded from the total.
 */
export async function depositDetail(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<DepositDetailReport> {
  const conds = [eq(deposits.companyId, ctx.companyId)];
  if (range?.from) conds.push(gte(deposits.date, range.from));
  if (range?.to) conds.push(lte(deposits.date, range.to));
  const depRows = await ctx.db
    .select({
      id: deposits.id,
      date: deposits.date,
      accountId: deposits.depositAccountId,
      accountName: accounts.name,
      memo: deposits.memo,
      total: deposits.total,
      voidedAt: deposits.voidedAt,
    })
    .from(deposits)
    .innerJoin(accounts, eq(deposits.depositAccountId, accounts.id))
    .where(and(...conds))
    .orderBy(asc(deposits.date));

  const depIds = depRows.map((r) => r.id);
  const lineRows = depIds.length
    ? await ctx.db
        .select({
          depositId: depositLines.depositId,
          description: depositLines.description,
          amount: depositLines.amount,
          customerName: customers.displayName,
        })
        .from(depositLines)
        .leftJoin(paymentsReceived, eq(depositLines.paymentId, paymentsReceived.id))
        .leftJoin(customers, eq(paymentsReceived.customerId, customers.id))
        .where(inArray(depositLines.depositId, depIds))
    : [];
  const linesById = new Map<string, DepositDetailLine[]>();
  for (const l of lineRows) {
    if (!linesById.has(l.depositId)) linesById.set(l.depositId, []);
    linesById.get(l.depositId)!.push({
      description: l.description,
      customerName: l.customerName,
      amount: toAmountString(l.amount),
    });
  }

  let total = Money.zero();
  const rows: DepositDetailRow[] = depRows.map((r) => {
    const voided = r.voidedAt !== null;
    if (!voided) total = total.plus(Money.of(r.total));
    return {
      id: r.id,
      date: r.date.toISOString(),
      accountId: r.accountId,
      accountName: r.accountName,
      memo: r.memo,
      total: toAmountString(r.total),
      voided,
      lines: linesById.get(r.id) ?? [],
    };
  });

  return {
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
    rows,
    total: toAmountString(total),
  };
}

// ---------------------------------------------------------------------------
// Sales by Item / Purchases by Item
// ---------------------------------------------------------------------------

export interface SalesByItemRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  type: string;
  quantity: string;
  revenue: string;
  /** COGS estimated as quantity x current average cost for inventory items ('0.00' otherwise). */
  cogs: string;
  margin: string;
  /** Margin as a % of revenue (2dp), null when revenue is zero. */
  marginPct: string | null;
}

export interface SalesByItemReport {
  from?: string;
  to?: string;
  rows: SalesByItemRow[];
  totals: { quantity: string; revenue: string; cogs: string; margin: string; marginPct: string | null };
}

/**
 * Sales by Item (summary) — quantity / revenue / COGS / margin per item across
 * invoices AND sales receipts in the period (voided/draft documents excluded).
 *
 * COGS uses the item's current average cost (quantity x averageCost) for
 * inventory items — a close approximation of the perpetual-inventory postings,
 * which are not stored per line.
 */
export async function salesByItem(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<SalesByItemReport> {
  const invConds = [
    eq(invoices.companyId, ctx.companyId),
    ne(invoices.status, 'void'),
    ne(invoices.status, 'draft'),
    isNotNull(invoiceLines.itemId),
  ];
  if (range?.from) invConds.push(gte(invoices.date, range.from));
  if (range?.to) invConds.push(lte(invoices.date, range.to));
  const invRows = await ctx.db
    .select({
      itemId: invoiceLines.itemId,
      quantity: sql<string>`COALESCE(SUM(CAST(${invoiceLines.quantity} AS NUMERIC)), 0)`,
      revenue: sql<string>`COALESCE(SUM(CAST(${invoiceLines.amount} AS NUMERIC)), 0)`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .where(and(...invConds))
    .groupBy(invoiceLines.itemId);

  const srConds = [
    eq(salesReceipts.companyId, ctx.companyId),
    ne(salesReceipts.status, 'void'),
    isNotNull(salesReceiptLines.itemId),
  ];
  if (range?.from) srConds.push(gte(salesReceipts.date, range.from));
  if (range?.to) srConds.push(lte(salesReceipts.date, range.to));
  const srRows = await ctx.db
    .select({
      itemId: salesReceiptLines.itemId,
      quantity: sql<string>`COALESCE(SUM(CAST(${salesReceiptLines.quantity} AS NUMERIC)), 0)`,
      revenue: sql<string>`COALESCE(SUM(CAST(${salesReceiptLines.amount} AS NUMERIC)), 0)`,
    })
    .from(salesReceiptLines)
    .innerJoin(salesReceipts, eq(salesReceiptLines.salesReceiptId, salesReceipts.id))
    .where(and(...srConds))
    .groupBy(salesReceiptLines.itemId);

  // Merge invoice + sales-receipt activity per item.
  const acc = new Map<string, { qty: ReturnType<typeof Money.zero>; revenue: ReturnType<typeof Money.zero> }>();
  for (const r of [...invRows, ...srRows]) {
    if (!r.itemId) continue;
    if (!acc.has(r.itemId)) acc.set(r.itemId, { qty: Money.zero(), revenue: Money.zero() });
    const a = acc.get(r.itemId)!;
    a.qty = a.qty.plus(Money.of(r.quantity));
    a.revenue = a.revenue.plus(Money.of(r.revenue));
  }

  const itemIds = [...acc.keys()];
  const itemRows = itemIds.length
    ? await ctx.db
        .select({
          id: items.id,
          name: items.name,
          sku: items.sku,
          type: items.type,
          averageCost: items.averageCost,
        })
        .from(items)
        .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)))
    : [];
  const itemById = new Map(itemRows.map((i) => [i.id, i]));

  let totQty = Money.zero();
  let totRevenue = Money.zero();
  let totCogs = Money.zero();

  const rows: SalesByItemRow[] = [];
  for (const [itemId, a] of acc) {
    const item = itemById.get(itemId);
    if (!item) continue;
    const cogs =
      item.type === 'inventory' && item.averageCost
        ? Money.round2(a.qty.times(Money.of(item.averageCost)))
        : Money.zero();
    const margin = a.revenue.minus(cogs);
    totQty = totQty.plus(a.qty);
    totRevenue = totRevenue.plus(a.revenue);
    totCogs = totCogs.plus(cogs);
    rows.push({
      itemId,
      itemName: item.name,
      sku: item.sku,
      type: item.type,
      quantity: a.qty.toString(),
      revenue: toAmountString(a.revenue),
      cogs: toAmountString(cogs),
      margin: toAmountString(margin),
      marginPct: a.revenue.isZero() ? null : margin.dividedBy(a.revenue).times(100).toFixed(2),
    });
  }
  rows.sort((a, b) => Money.of(b.revenue).comparedTo(Money.of(a.revenue)));

  const totMargin = totRevenue.minus(totCogs);
  return {
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
    rows,
    totals: {
      quantity: totQty.toString(),
      revenue: toAmountString(totRevenue),
      cogs: toAmountString(totCogs),
      margin: toAmountString(totMargin),
      marginPct: totRevenue.isZero() ? null : totMargin.dividedBy(totRevenue).times(100).toFixed(2),
    },
  };
}

export interface PurchasesByItemRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  cost: string;
  /** cost / quantity (2dp), null when quantity is zero. */
  avgUnitCost: string | null;
}

export interface PurchasesByItemReport {
  from?: string;
  to?: string;
  rows: PurchasesByItemRow[];
  totals: { quantity: string; cost: string };
}

/**
 * Purchases by Item (summary) — quantity and cost per item across vendor bills
 * in the period (voided bills excluded). Only item-coded bill lines count.
 */
export async function purchasesByItem(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<PurchasesByItemReport> {
  const conds = [
    eq(bills.companyId, ctx.companyId),
    ne(bills.status, 'void'),
    isNotNull(billLines.itemId),
  ];
  if (range?.from) conds.push(gte(bills.date, range.from));
  if (range?.to) conds.push(lte(bills.date, range.to));

  const agg = await ctx.db
    .select({
      itemId: billLines.itemId,
      itemName: items.name,
      sku: items.sku,
      quantity: sql<string>`COALESCE(SUM(CAST(${billLines.quantity} AS NUMERIC)), 0)`,
      cost: sql<string>`COALESCE(SUM(CAST(${billLines.amount} AS NUMERIC)), 0)`,
    })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .innerJoin(items, eq(billLines.itemId, items.id))
    .where(and(...conds))
    .groupBy(billLines.itemId, items.name, items.sku)
    .orderBy(sql`SUM(CAST(${billLines.amount} AS NUMERIC)) DESC`);

  let totQty = Money.zero();
  let totCost = Money.zero();
  const rows: PurchasesByItemRow[] = agg
    .filter((r) => r.itemId !== null)
    .map((r) => {
      const qty = Money.of(r.quantity);
      const cost = Money.of(r.cost);
      totQty = totQty.plus(qty);
      totCost = totCost.plus(cost);
      return {
        itemId: r.itemId!,
        itemName: r.itemName,
        sku: r.sku,
        quantity: qty.toString(),
        cost: toAmountString(cost),
        avgUnitCost: qty.isZero() ? null : cost.dividedBy(qty).toFixed(2),
      };
    });

  return {
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
    rows,
    totals: { quantity: totQty.toString(), cost: toAmountString(totCost) },
  };
}

// ---------------------------------------------------------------------------
// Transaction Detail — filterable cross-account journal-line listing
// ---------------------------------------------------------------------------

export interface TransactionDetailFilters {
  from?: Date;
  to?: Date;
  accountId?: string;
  classId?: string;
  /** Case-insensitive match against entry description / line memo / source ref. */
  search?: string;
  /** Safety cap on returned rows (default 5000). */
  limit?: number;
}

export interface TransactionDetailRow {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  memo: string | null;
  reference: string | null;
  sourceRef: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  /** Signed amount (debit - credit). */
  amount: string;
  /** Running total of the signed amounts in report order. */
  runningTotal: string;
}

export interface TransactionDetailReport {
  from?: string;
  to?: string;
  rows: TransactionDetailRow[];
  totalDebit: string;
  totalCredit: string;
  count: number;
  truncated: boolean;
}

/**
 * Transaction Detail — every posted journal line, filterable by date range,
 * account, class, and free-text (entry description / line memo / sourceRef),
 * with a running total of the signed (debit - credit) amounts. The QB
 * "Transaction Detail by Account / Transaction List by Date" workhorse.
 */
export async function transactionDetail(
  ctx: ServiceContext,
  filters: TransactionDetailFilters = {},
): Promise<TransactionDetailReport> {
  const limit = Math.max(1, Math.min(filters.limit ?? 5000, 20000));
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
  ];
  if (filters.from) conds.push(gte(journalEntries.date, filters.from));
  if (filters.to) conds.push(lte(journalEntries.date, filters.to));
  if (filters.accountId) conds.push(eq(journalEntryLines.accountId, filters.accountId));
  if (filters.classId) conds.push(eq(journalEntryLines.classId, filters.classId));
  if (filters.search) {
    const like = `%${filters.search}%`;
    conds.push(
      sql`(${journalEntries.description} ILIKE ${like} OR ${journalEntryLines.memo} ILIKE ${like} OR ${journalEntries.sourceRef} ILIKE ${like})`,
    );
  }

  const lineRows = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      memo: journalEntryLines.memo,
      reference: journalEntries.reference,
      sourceRef: journalEntries.sourceRef,
      accountId: journalEntryLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(...conds))
    .orderBy(asc(journalEntries.date), asc(journalEntries.entryNumber), asc(journalEntryLines.createdAt))
    .limit(limit + 1);

  const truncated = lineRows.length > limit;
  const slice = truncated ? lineRows.slice(0, limit) : lineRows;

  let running = Money.zero();
  let totalDebit = Money.zero();
  let totalCredit = Money.zero();
  const rows: TransactionDetailRow[] = slice.map((r) => {
    const debit = Money.of(r.debit ?? '0');
    const credit = Money.of(r.credit ?? '0');
    const amount = debit.minus(credit);
    running = running.plus(amount);
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    return {
      lineId: r.lineId,
      entryId: r.entryId,
      entryNumber: r.entryNumber,
      date: r.date.toISOString(),
      description: r.description,
      memo: r.memo,
      reference: r.reference,
      sourceRef: r.sourceRef,
      accountId: r.accountId,
      accountCode: r.accountCode,
      accountName: r.accountName,
      debit: toAmountString(debit),
      credit: toAmountString(credit),
      amount: toAmountString(amount),
      runningTotal: toAmountString(running),
    };
  });

  return {
    from: filters.from?.toISOString(),
    to: filters.to?.toISOString(),
    rows,
    totalDebit: toAmountString(totalDebit),
    totalCredit: toAmountString(totalCredit),
    count: rows.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Comparative Balance Sheet — current vs prior as-of date, with $ change
// ---------------------------------------------------------------------------

export interface BalanceSheetComparativeRow {
  accountId: string;
  code: string;
  name: string;
  current: string;
  prior: string;
  change: string;
}

export interface BalanceSheetComparative {
  asOf: string;
  priorAsOf: string;
  assets: BalanceSheetComparativeRow[];
  liabilities: BalanceSheetComparativeRow[];
  equity: BalanceSheetComparativeRow[];
  retainedEarnings: { current: string; prior: string; change: string };
  totals: {
    assets: { current: string; prior: string; change: string };
    liabilities: { current: string; prior: string; change: string };
    equity: { current: string; prior: string; change: string };
  };
  balanced: boolean;
}

function mergeBsSection(
  current: BalanceSheet['assets'],
  prior: BalanceSheet['assets'],
): BalanceSheetComparativeRow[] {
  const byId = new Map<string, BalanceSheetComparativeRow>();
  for (const l of current) {
    byId.set(l.accountId, {
      accountId: l.accountId,
      code: l.code,
      name: l.name,
      current: l.amount,
      prior: '0.00',
      change: l.amount,
    });
  }
  for (const l of prior) {
    const row = byId.get(l.accountId);
    if (row) {
      row.prior = l.amount;
      row.change = toAmountString(Money.of(row.current).minus(Money.of(l.amount)));
    } else {
      byId.set(l.accountId, {
        accountId: l.accountId,
        code: l.code,
        name: l.name,
        current: '0.00',
        prior: l.amount,
        change: toAmountString(Money.of(l.amount).negated()),
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Comparative Balance Sheet — two balanceSheet runs merged side by side with a
 * dollar-change column (QB "Balance Sheet Prev Year Comparison" parity).
 */
export async function balanceSheetComparative(
  ctx: ServiceContext,
  asOf: Date,
  priorAsOf: Date,
): Promise<BalanceSheetComparative> {
  const [cur, pri] = await Promise.all([balanceSheet(ctx, asOf), balanceSheet(ctx, priorAsOf)]);
  const diff = (a: string, b: string) => toAmountString(Money.of(a).minus(Money.of(b)));
  return {
    asOf: asOf.toISOString(),
    priorAsOf: priorAsOf.toISOString(),
    assets: mergeBsSection(cur.assets, pri.assets),
    liabilities: mergeBsSection(cur.liabilities, pri.liabilities),
    equity: mergeBsSection(cur.equity, pri.equity),
    retainedEarnings: {
      current: cur.retainedEarnings,
      prior: pri.retainedEarnings,
      change: diff(cur.retainedEarnings, pri.retainedEarnings),
    },
    totals: {
      assets: { current: cur.totalAssets, prior: pri.totalAssets, change: diff(cur.totalAssets, pri.totalAssets) },
      liabilities: {
        current: cur.totalLiabilities,
        prior: pri.totalLiabilities,
        change: diff(cur.totalLiabilities, pri.totalLiabilities),
      },
      equity: { current: cur.totalEquity, prior: pri.totalEquity, change: diff(cur.totalEquity, pri.totalEquity) },
    },
    balanced: cur.balanced && pri.balanced,
  };
}
