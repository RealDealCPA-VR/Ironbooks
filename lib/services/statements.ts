/**
 * Customer statements and 1099 vendor reports.
 *
 * customerStatement — chronological "balance forward" ledger for a customer
 *   combining invoices (charges) and payments received (credits) with a
 *   running balance.
 *
 * openItemStatement — QB "Open Item" statement format: each unpaid/partially
 *   paid invoice as of a date, with days past due, per-invoice aging bucket,
 *   and an aging summary footer (Current / 1-30 / 31-60 / 61-90 / 90+).
 *
 * batchStatements — month-end batch run: generates a statement (either format)
 *   for every active customer that has something to report.
 *
 * vendor1099Report — sums payments to 1099-flagged vendors for a calendar year.
 *   Combines bill payments (via bill_payment_applications) and direct expenses.
 *   Only vendors at or above the year's 1099 threshold ($600; $2,000 from 2026) are included.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, not, or, sql } from 'drizzle-orm';
import {
  accounts,
  billLines,
  bills,
  billPaymentApplications,
  bouncedChecks,
  paymentApplications,
  billPayments,
  companies,
  creditMemos,
  customers,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  paymentsReceived,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { inTransaction, notFound, validation, writeAudit, type ServiceContext } from './_base';
import { taxIdFor } from './access';
import { journalOpenItems } from './journal';
import { generalJournalSourceSql } from './posting';
import { docRef } from './docNumbers';
import { companyToday } from './salesDates';

// ---------------------------------------------------------------------------
// Customer Statement
// ---------------------------------------------------------------------------

export interface StatementLine {
  date: string;
  /**
   * Charges: invoice, statement_charge (C5), bounced_check (F2 — a returned payment owed again),
   * refund (money paid back to the customer: a credit-memo refund or an overpayment refund).
   * Credits: payment, credit_memo, discount (C3 — early-payment discount taken).
   * general_journal: a named General Journal line on A/R (amount signed: + charge, − credit).
   */
  type:
    | 'invoice'
    | 'payment'
    | 'credit_memo'
    | 'statement_charge'
    | 'bounced_check'
    | 'discount'
    | 'general_journal'
    | 'refund'
    /** Foreign-currency customers (home-currency statement): an exchange-rate adjustment posted
     *  to A/R when an unapplied payment was applied at a different rate (signed like GJ). */
    | 'exchange_adjustment';
  /**
   * Invoice number (invoices), payment reference (payments), memo number (credit memos), or
   * "GJ #<entry>" for a named General Journal line on A/R.
   */
  ref: string | null;
  /** Positive for invoices (charges); positive for payments/credit memos (credits). */
  amount: string;
  /** Running balance after this line (positive = customer owes). */
  runningBalance: string;
}

export interface CustomerStatement {
  customer: {
    id: string;
    displayName: string;
    companyName: string | null;
    email: string | null;
  };
  from: string | null;
  to: string | null;
  /** Balance before the first line in the period (sum of prior open items). */
  openingBalance: string;
  lines: StatementLine[];
  closingBalance: string;
  /** true = a foreign-currency customer's statement, shown in home currency (ties to home A/R). */
  homeCurrency?: boolean;
}

/**
 * Bounced checks of a customer (wave2 sales F2): the amount owed again = the returned payment
 * plus any early-payment discounts it had taken (both reversed by recordBouncedCheck).
 */
async function bouncedAmounts(
  ctx: ServiceContext,
  customerId: string,
  range: { before?: Date; from?: Date; to?: Date },
): Promise<Array<{ date: Date; reference: string | null; amount: ReturnType<typeof Money.zero> }>> {
  const conds = [eq(bouncedChecks.companyId, ctx.companyId), eq(bouncedChecks.customerId, customerId)];
  if (range.before) conds.push(lt(bouncedChecks.date, range.before));
  if (range.from) conds.push(gte(bouncedChecks.date, range.from));
  if (range.to) conds.push(lt(bouncedChecks.date, new Date(range.to.getTime() + 86_400_000)));
  const rows = await ctx.db
    .select({
      date: bouncedChecks.date,
      amount: bouncedChecks.amount,
      applications: bouncedChecks.applications,
      reference: paymentsReceived.reference,
    })
    .from(bouncedChecks)
    .innerJoin(paymentsReceived, eq(paymentsReceived.id, bouncedChecks.paymentId))
    .where(and(...conds));
  return rows.map((r) => ({
    date: r.date,
    reference: r.reference ?? null,
    amount: Money.of(r.amount).plus(
      (r.applications ?? []).reduce((s, a) => s.plus(Money.of(a.discountAmount ?? '0')), Money.zero()),
    ),
  }));
}

/**
 * Early-payment discounts of bounced payments, per payment. recordBouncedCheck deletes the
 * payment's applications (their discounts with them) and keeps a snapshot on the bounced-check
 * row; the bounce line charges the payment PLUS those discounts back, so the statement must keep
 * showing the discount credit the payment took, or it overstates the balance by the discount.
 */
async function bouncedPaymentDiscounts(
  ctx: ServiceContext,
  paymentIds: string[],
): Promise<Map<string, ReturnType<typeof Money.zero>>> {
  const out = new Map<string, ReturnType<typeof Money.zero>>();
  if (paymentIds.length === 0) return out;
  const rows = await ctx.db
    .select({ paymentId: bouncedChecks.paymentId, applications: bouncedChecks.applications })
    .from(bouncedChecks)
    .where(and(eq(bouncedChecks.companyId, ctx.companyId), inArray(bouncedChecks.paymentId, paymentIds)));
  for (const r of rows) {
    const disc = (r.applications ?? []).reduce((s, a) => s.plus(Money.of(a.discountAmount ?? '0')), Money.zero());
    if (disc.greaterThan(0)) out.set(r.paymentId, (out.get(r.paymentId) ?? Money.zero()).plus(disc));
  }
  return out;
}

/**
 * Refunds paid to a customer: refund checks for a credit memo and refunds of an unapplied payment
 * (overpayment). They have no table of their own — the record is the posted journal entry
 * `refund:<creditMemoId | paymentId>`, whose A/R line is a debit (it takes back the credit the
 * memo / payment left in A/R). Amounts are returned in the document's currency (a payment refund
 * posts amount × the payment's rate in home currency).
 */
async function refundAmounts(
  ctx: ServiceContext,
  customerId: string,
  range: { before?: Date; from?: Date; to?: Date },
): Promise<Array<{ date: Date; reference: string | null; amount: ReturnType<typeof Money.zero> }>> {
  const [payments, memos] = await Promise.all([
    ctx.db
      .select({ id: paymentsReceived.id, reference: paymentsReceived.reference, exchangeRate: paymentsReceived.exchangeRate })
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), eq(paymentsReceived.customerId, customerId))),
    ctx.db
      .select({ id: creditMemos.id, refNumber: creditMemos.refNumber, memoNumber: creditMemos.memoNumber })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.customerId, customerId))),
  ]);
  const sources = new Map<string, { reference: string | null; rate: ReturnType<typeof Money.zero> }>();
  for (const p of payments) {
    sources.set(`refund:${p.id}`, { reference: p.reference ?? null, rate: Money.of(p.exchangeRate ?? 1) });
  }
  for (const m of memos) {
    sources.set(`refund:${m.id}`, { reference: docRef(m.refNumber, m.memoNumber), rate: Money.of(1) });
  }
  if (sources.size === 0) return [];

  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    inArray(journalEntries.sourceRef, [...sources.keys()]),
    eq(accounts.type, 'asset'),
    eq(accounts.subtype, 'accounts_receivable'),
  ];
  if (range.before) conds.push(lt(journalEntries.date, range.before));
  if (range.from) conds.push(gte(journalEntries.date, range.from));
  if (range.to) conds.push(lt(journalEntries.date, new Date(range.to.getTime() + 86_400_000)));
  const rows = await ctx.db
    .select({
      entryId: journalEntries.id,
      date: journalEntries.date,
      sourceRef: journalEntries.sourceRef,
      net: sql<string>`COALESCE(SUM(CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC) - CAST(COALESCE(${journalEntryLines.credit}, '0') AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .where(and(...conds))
    .groupBy(journalEntries.id, journalEntries.date, journalEntries.sourceRef);
  return rows
    .map((r) => {
      const src = sources.get(r.sourceRef ?? '')!;
      const home = Money.of(r.net);
      const amount = src.rate.greaterThan(0) && !src.rate.equals(1) ? Money.round2(home.dividedBy(src.rate)) : home;
      return { date: r.date, reference: src.reference, amount };
    })
    .filter((r) => !r.amount.isZero());
}

/**
 * A customer's balance straight from the general ledger: every posted line on an A/R account
 * that belongs to this customer — the customer's own documents (invoice:, credit_memo:,
 * customer: (payments), payment: (applying / unapplying an unapplied payment), bounced:,
 * refund:) plus General Journal lines named for the customer. The customer statement's closing
 * balance and the A/R aging total must both equal this number.
 */
export async function customerArLedgerBalance(
  ctx: ServiceContext,
  customerId: string,
  asOf?: Date,
): Promise<string> {
  const [invRows, memoRows, payRows] = await Promise.all([
    ctx.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, customerId))),
    ctx.db
      .select({ id: creditMemos.id })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.customerId, customerId))),
    ctx.db
      .select({ id: paymentsReceived.id })
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), eq(paymentsReceived.customerId, customerId))),
  ]);
  const refs = [
    `customer:${customerId}`,
    ...invRows.map((r) => `invoice:${r.id}`),
    ...memoRows.flatMap((r) => [`credit_memo:${r.id}`, `refund:${r.id}`]),
    ...payRows.flatMap((r) => [`payment:${r.id}`, `bounced:${r.id}`, `refund:${r.id}`]),
  ];
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    eq(accounts.type, 'asset'),
    eq(accounts.subtype, 'accounts_receivable'),
    or(
      inArray(journalEntries.sourceRef, refs),
      and(
        eq(journalEntryLines.entityType, 'customer'),
        eq(journalEntryLines.entityId, customerId),
        generalJournalSourceSql(),
      ),
    )!,
  ];
  if (asOf) conds.push(lt(journalEntries.date, new Date(asOf.getTime() + 86_400_000)));
  const [row] = await ctx.db
    .select({
      net: sql<string>`COALESCE(SUM(CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC) - CAST(COALESCE(${journalEntryLines.credit}, '0') AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .where(and(...conds));
  return toAmountString(Money.of(row?.net ?? '0'));
}

// ---------------------------------------------------------------------------
// Foreign-currency customers: the statement in home currency, tied to home A/R
// ---------------------------------------------------------------------------

/** Does this customer have any invoice or payment in a foreign currency? */
async function hasForeignCurrencyActivity(ctx: ServiceContext, customerId: string): Promise<boolean> {
  const [inv] = await ctx.db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, customerId), isNotNull(invoices.currency)))
    .limit(1);
  if (inv) return true;
  const [pay] = await ctx.db
    .select({ id: paymentsReceived.id })
    .from(paymentsReceived)
    .where(
      and(
        eq(paymentsReceived.companyId, ctx.companyId),
        eq(paymentsReceived.customerId, customerId),
        isNotNull(paymentsReceived.currency),
      ),
    )
    .limit(1);
  return !!pay;
}

/** Net A/R movement (debit − credit, home currency) of posted entries, per entry. */
async function arNetByEntry(
  ctx: ServiceContext,
  where: { sourceRefs?: string[]; entryIds?: string[] },
  range: { from?: Date; toExclusive?: Date | null },
): Promise<Array<{ entryId: string; sourceRef: string | null; date: Date; net: ReturnType<typeof Money.zero> }>> {
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    eq(accounts.type, 'asset'),
    eq(accounts.subtype, 'accounts_receivable'),
  ];
  if (where.sourceRefs) {
    if (where.sourceRefs.length === 0) return [];
    conds.push(inArray(journalEntries.sourceRef, where.sourceRefs));
  }
  if (where.entryIds) {
    if (where.entryIds.length === 0) return [];
    conds.push(inArray(journalEntries.id, where.entryIds));
  }
  if (range.from) conds.push(gte(journalEntries.date, range.from));
  if (range.toExclusive) conds.push(lt(journalEntries.date, range.toExclusive));
  const rows = await ctx.db
    .select({
      entryId: journalEntries.id,
      sourceRef: journalEntries.sourceRef,
      date: journalEntries.date,
      net: sql<string>`COALESCE(SUM(CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC) - CAST(COALESCE(${journalEntryLines.credit}, '0') AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .where(and(...conds))
    .groupBy(journalEntries.id, journalEntries.sourceRef, journalEntries.date);
  return rows.map((r) => ({ entryId: r.entryId, sourceRef: r.sourceRef, date: r.date, net: Money.of(r.net) }));
}

/**
 * Balance-forward statement for a customer billed in a foreign currency, in HOME currency so
 * it ties to the home-currency A/R account: every line is the A/R amount its document posted
 * (invoices at their booked rate, payments at the amount they relieved), and the exchange-rate
 * adjustments posted when an unapplied foreign payment is later applied (sourceRef
 * payment:<id>) are listed as "Exchange Rate Adjustment" lines. Closing balance ==
 * customerArLedgerBalance.
 */
async function homeCurrencyStatement(
  ctx: ServiceContext,
  cust: { id: string; displayName: string; companyName: string | null; email: string | null },
  range?: { from?: Date; to?: Date },
): Promise<CustomerStatement> {
  const customerId = cust.id;
  const from = range?.from;
  const toExclusive = range?.to ? new Date(range.to.getTime() + 86_400_000) : null;
  const inRange = { from, toExclusive };

  // Opening balance straight from the GL (everything dated before `from`).
  const openingBalance = from
    ? Money.of(await customerArLedgerBalance(ctx, customerId, new Date(from.getTime() - 86_400_000)))
    : Money.zero();

  const [invRows, payRows, memoRows] = await Promise.all([
    ctx.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        refNumber: invoices.refNumber,
        isStatementCharge: invoices.isStatementCharge,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, ctx.companyId),
          eq(invoices.customerId, customerId),
          ne(invoices.status, 'void'),
          ne(invoices.status, 'draft'),
        ),
      ),
    ctx.db
      .select({
        id: paymentsReceived.id,
        date: paymentsReceived.date,
        reference: paymentsReceived.reference,
        postedEntryId: paymentsReceived.postedEntryId,
      })
      .from(paymentsReceived)
      .where(
        and(
          eq(paymentsReceived.companyId, ctx.companyId),
          eq(paymentsReceived.customerId, customerId),
          isNull(paymentsReceived.voidedAt),
        ),
      ),
    ctx.db
      .select({
        id: creditMemos.id,
        date: creditMemos.date,
        memoNumber: creditMemos.memoNumber,
        refNumber: creditMemos.refNumber,
        total: creditMemos.total,
      })
      .from(creditMemos)
      .where(
        and(
          eq(creditMemos.companyId, ctx.companyId),
          eq(creditMemos.customerId, customerId),
          ne(creditMemos.status, 'void'),
        ),
      ),
  ]);

  type RawLine = { kind: StatementLine['type']; date: Date; ref: string | null; amount: ReturnType<typeof Money.zero> };
  const raw: RawLine[] = [];

  // Invoices / statement charges: the A/R their entries posted.
  const invById = new Map(invRows.map((r) => [`invoice:${r.id}`, r]));
  for (const e of await arNetByEntry(ctx, { sourceRefs: [...invById.keys()] }, inRange)) {
    const inv = invById.get(e.sourceRef ?? '')!;
    if (e.net.isZero()) continue;
    raw.push({
      kind: inv.isStatementCharge ? 'statement_charge' : 'invoice',
      date: e.date,
      ref: docRef(inv.refNumber, inv.invoiceNumber),
      amount: e.net,
    });
  }

  // Payments: the A/R each payment relieved (its discounts shown as their own line).
  const payByEntry = new Map(payRows.filter((p) => p.postedEntryId).map((p) => [p.postedEntryId!, p]));
  const payEntries = await arNetByEntry(ctx, { entryIds: [...payByEntry.keys()] }, inRange);
  const discountRows = payEntries.length
    ? await ctx.db
        .select({
          paymentId: paymentApplications.paymentId,
          home: sql<string>`COALESCE(SUM(ROUND(CAST(${paymentApplications.discountAmount} AS NUMERIC) * CAST(COALESCE(${invoices.exchangeRate}, '1') AS NUMERIC), 2)), 0)`,
        })
        .from(paymentApplications)
        .innerJoin(invoices, eq(invoices.id, paymentApplications.invoiceId))
        .where(inArray(paymentApplications.paymentId, payEntries.map((e) => payByEntry.get(e.entryId)!.id)))
        .groupBy(paymentApplications.paymentId)
    : [];
  const discountByPayment = new Map(discountRows.map((r) => [r.paymentId, Money.of(r.home)]));
  for (const e of payEntries) {
    const p = payByEntry.get(e.entryId)!;
    const discount = discountByPayment.get(p.id) ?? Money.zero();
    const paid = e.net.negated().minus(discount);
    if (!paid.isZero()) raw.push({ kind: 'payment', date: e.date, ref: p.reference ?? null, amount: paid });
    if (discount.greaterThan(0)) raw.push({ kind: 'discount', date: e.date, ref: p.reference ?? null, amount: discount });
  }

  // Exchange-rate adjustments, returned checks and refunds — straight from their entries.
  const payRef = new Map(payRows.map((p) => [p.id, p.reference ?? null]));
  const memoRef = new Map(memoRows.map((m) => [m.id, docRef(m.refNumber, m.memoNumber)]));
  const extraRefs = [
    ...payRows.flatMap((p) => [`payment:${p.id}`, `bounced:${p.id}`, `refund:${p.id}`]),
    ...memoRows.map((m) => `refund:${m.id}`),
  ];
  for (const e of await arNetByEntry(ctx, { sourceRefs: extraRefs }, inRange)) {
    if (e.net.isZero()) continue;
    const [prefix, id] = (e.sourceRef ?? '').split(':');
    const ref = payRef.get(id) ?? memoRef.get(id) ?? null;
    if (prefix === 'payment') raw.push({ kind: 'exchange_adjustment', date: e.date, ref, amount: e.net });
    else if (prefix === 'bounced') raw.push({ kind: 'bounced_check', date: e.date, ref, amount: e.net });
    else raw.push({ kind: 'refund', date: e.date, ref, amount: e.net });
  }

  // Credit memos (home currency documents).
  for (const m of memoRows) {
    if ((from && m.date < from) || (toExclusive && m.date >= toExclusive)) continue;
    raw.push({ kind: 'credit_memo', date: m.date, ref: docRef(m.refNumber, m.memoNumber), amount: Money.of(m.total) });
  }

  // Named General Journal lines on A/R.
  const journalItems = await journalOpenItems(ctx, 'ar', { entityId: customerId, gross: true });
  for (const j of journalItems) {
    if ((from && j.date < from) || (toExclusive && j.date >= toExclusive)) continue;
    raw.push({ kind: 'general_journal', date: j.date, ref: `GJ #${j.entryNumber}`, amount: Money.of(j.amount) });
  }

  raw.sort((a, b) => a.date.getTime() - b.date.getTime());
  const SIGNED = new Set<StatementLine['type']>(['general_journal', 'exchange_adjustment']);
  const CHARGE = new Set<StatementLine['type']>(['invoice', 'statement_charge', 'bounced_check', 'refund']);
  let running = openingBalance;
  const lines: StatementLine[] = raw.map((r) => {
    running = SIGNED.has(r.kind) || CHARGE.has(r.kind) ? running.plus(r.amount) : running.minus(r.amount);
    return {
      date: r.date.toISOString().slice(0, 10),
      type: r.kind,
      ref: r.ref,
      amount: toAmountString(r.amount),
      runningBalance: toAmountString(running),
    };
  });

  return {
    customer: {
      id: cust.id,
      displayName: cust.displayName,
      companyName: cust.companyName ?? null,
      email: cust.email ?? null,
    },
    from: from?.toISOString().slice(0, 10) ?? null,
    to: range?.to?.toISOString().slice(0, 10) ?? null,
    openingBalance: toAmountString(openingBalance),
    lines,
    closingBalance: toAmountString(running),
    homeCurrency: true,
  };
}

/**
 * Payment-item lines on an invoice (correlated on invoices.id). They are received with the
 * invoice — the invoice's entry debits Undeposited Funds for them instead of A/R — so the amount
 * an invoice charges to A/R is total − retainage − these lines.
 */
const invoicePaymentLinesSql = sql`(SELECT COALESCE(SUM(CAST(${invoiceLines.amount} AS NUMERIC)), 0) FROM ${invoiceLines} INNER JOIN ${items} ON ${items.id} = ${invoiceLines.itemId} WHERE ${invoiceLines.invoiceId} = ${invoices.id} AND ${items.type} = 'payment')`;

export async function customerStatement(
  ctx: ServiceContext,
  customerId: string,
  range?: { from?: Date; to?: Date },
): Promise<CustomerStatement> {
  // Verify the customer belongs to this company.
  const [cust] = await ctx.db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      companyName: customers.companyName,
      email: customers.email,
      companyId: customers.companyId,
    })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.companyId, ctx.companyId)));

  if (!cust) throw notFound('Customer');

  // Customers billed in another currency: list everything in home currency so the statement
  // ties to home A/R (incl. exchange-rate adjustment lines).
  if (await hasForeignCurrencyActivity(ctx, customerId)) {
    return homeCurrencyStatement(ctx, cust, range);
  }

  // --- Opening balance: sum of all charges and credits BEFORE the range start ---
  // We compute it by fetching all pre-range activity (if a from date is given).
  let openingBalance = Money.zero();

  if (range?.from) {
    // Invoices before range start (posted, non-void). Only the billed base hits A/R —
    // retainage held back sits in Retainage Receivable (an Other Current Asset), and payment-item
    // lines went to Undeposited Funds.
    const [priorInvoiceRow] = await ctx.db
      .select({
        total: sql<string>`COALESCE(SUM(CAST(${invoices.total} AS NUMERIC) - CAST(COALESCE(${invoices.retainageAmount}, '0') AS NUMERIC) - ${invoicePaymentLinesSql}), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, ctx.companyId),
          eq(invoices.customerId, customerId),
          ne(invoices.status, 'void'),
          ne(invoices.status, 'draft'),
          lt(invoices.date, range.from),
        ),
      );

    // Payments before range start
    const [priorPaymentRow] = await ctx.db
      .select({
        total: sql<string>`COALESCE(SUM(CAST(${paymentsReceived.amount} AS NUMERIC)), 0)`,
      })
      .from(paymentsReceived)
      .where(
        and(
          eq(paymentsReceived.companyId, ctx.companyId),
          eq(paymentsReceived.customerId, customerId),
          isNull(paymentsReceived.voidedAt),
          lt(paymentsReceived.date, range.from),
        ),
      );

    // wave2 sales: early-payment discounts (credits) and bounced checks (charges) before range.
    const [priorDiscountRow] = await ctx.db
      .select({
        total: sql<string>`COALESCE(SUM(CAST(${paymentApplications.discountAmount} AS NUMERIC)), 0)`,
      })
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentsReceived.id, paymentApplications.paymentId))
      .where(
        and(
          eq(paymentsReceived.companyId, ctx.companyId),
          eq(paymentsReceived.customerId, customerId),
          isNull(paymentsReceived.voidedAt),
          lt(paymentsReceived.date, range.from),
        ),
      );
    const priorBounced = await bouncedAmounts(ctx, customerId, { before: range.from });
    const priorRefunds = await refundAmounts(ctx, customerId, { before: range.from });
    // Discounts of earlier payments that bounced since (their applications are gone).
    const priorPaymentIds = (
      await ctx.db
        .select({ id: paymentsReceived.id })
        .from(paymentsReceived)
        .where(
          and(
            eq(paymentsReceived.companyId, ctx.companyId),
            eq(paymentsReceived.customerId, customerId),
            isNull(paymentsReceived.voidedAt),
            isNotNull(paymentsReceived.bouncedAt),
            lt(paymentsReceived.date, range.from),
          ),
        )
    ).map((p) => p.id);
    const priorBouncedDiscounts = [...(await bouncedPaymentDiscounts(ctx, priorPaymentIds)).values()].reduce(
      (s, v) => s.plus(v),
      Money.zero(),
    );

    // Credit memos before range start (non-void) — they credit A/R at creation,
    // so they reduce what the customer owes just like payments.
    const [priorCreditMemoRow] = await ctx.db
      .select({
        total: sql<string>`COALESCE(SUM(CAST(${creditMemos.total} AS NUMERIC)), 0)`,
      })
      .from(creditMemos)
      .where(
        and(
          eq(creditMemos.companyId, ctx.companyId),
          eq(creditMemos.customerId, customerId),
          ne(creditMemos.status, 'void'),
          lt(creditMemos.date, range.from),
        ),
      );

    const priorInvoices = Money.of(priorInvoiceRow?.total ?? '0');
    const priorPayments = Money.of(priorPaymentRow?.total ?? '0');
    const priorCreditMemos = Money.of(priorCreditMemoRow?.total ?? '0');
    const priorDiscounts = Money.of(priorDiscountRow?.total ?? '0').plus(priorBouncedDiscounts);
    openingBalance = priorInvoices
      .minus(priorPayments)
      .minus(priorCreditMemos)
      .minus(priorDiscounts)
      .plus(priorBounced.reduce((sum, b) => sum.plus(b.amount), Money.zero()))
      .plus(priorRefunds.reduce((sum, r) => sum.plus(r.amount), Money.zero()));
  }

  // Named General Journal lines on A/R for this customer (QB shows them as "General Journal").
  const journalItems = await journalOpenItems(ctx, 'ar', { entityId: customerId, gross: true });
  const toExclusive = range?.to ? new Date(range.to.getTime() + 86_400_000) : null;
  const journalInRange = journalItems.filter(
    (j) => (!range?.from || j.date >= range.from) && (!toExclusive || j.date < toExclusive),
  );
  if (range?.from) {
    for (const j of journalItems) {
      if (j.date < range.from) openingBalance = openingBalance.plus(Money.of(j.amount));
    }
  }

  // --- In-range invoices ---
  const invoiceConds = [
    eq(invoices.companyId, ctx.companyId),
    eq(invoices.customerId, customerId),
    ne(invoices.status, 'void'),
    // Drafts (pending invoices) post nothing to A/R — QB leaves them off statements.
    ne(invoices.status, 'draft'),
  ];
  if (range?.from) invoiceConds.push(gte(invoices.date, range.from));
  if (range?.to) invoiceConds.push(lt(invoices.date, new Date(range.to.getTime() + 86_400_000)));

  const invoiceRows = await ctx.db
    .select({
      date: invoices.date,
      invoiceNumber: invoices.invoiceNumber,
      refNumber: invoices.refNumber,
      // Billed base (total minus retainage, minus payment-item lines received with the
      // invoice) — the amount actually charged to A/R.
      total: sql<string>`CAST(${invoices.total} AS NUMERIC) - CAST(COALESCE(${invoices.retainageAmount}, '0') AS NUMERIC) - ${invoicePaymentLinesSql}`,
      isStatementCharge: invoices.isStatementCharge,
    })
    .from(invoices)
    .where(and(...invoiceConds));

  // --- In-range payments received ---
  const paymentConds = [
    eq(paymentsReceived.companyId, ctx.companyId),
    eq(paymentsReceived.customerId, customerId),
    // A voided payment never happened — it must not reduce the statement balance.
    isNull(paymentsReceived.voidedAt),
  ];
  if (range?.from) paymentConds.push(gte(paymentsReceived.date, range.from));
  if (range?.to)
    paymentConds.push(lt(paymentsReceived.date, new Date(range.to.getTime() + 86_400_000)));

  const paymentRows = await ctx.db
    .select({
      id: paymentsReceived.id,
      date: paymentsReceived.date,
      reference: paymentsReceived.reference,
      amount: paymentsReceived.amount,
    })
    .from(paymentsReceived)
    .where(and(...paymentConds));

  // wave2 sales: discounts taken with in-range payments, and in-range bounced checks.
  const discountRows =
    paymentRows.length > 0
      ? await ctx.db
          .select({
            paymentId: paymentApplications.paymentId,
            total: sql<string>`COALESCE(SUM(CAST(${paymentApplications.discountAmount} AS NUMERIC)), 0)`,
          })
          .from(paymentApplications)
          .where(inArray(paymentApplications.paymentId, paymentRows.map((p) => p.id)))
          .groupBy(paymentApplications.paymentId)
      : [];
  const discountByPayment = new Map(discountRows.map((r) => [r.paymentId, Money.of(r.total)]));
  for (const [paymentId, disc] of await bouncedPaymentDiscounts(ctx, paymentRows.map((p) => p.id))) {
    discountByPayment.set(paymentId, (discountByPayment.get(paymentId) ?? Money.zero()).plus(disc));
  }
  const bouncedRows = await bouncedAmounts(ctx, customerId, { from: range?.from, to: range?.to });
  const refundRows = await refundAmounts(ctx, customerId, { from: range?.from, to: range?.to });

  // --- In-range credit memos ---
  // A credit memo credits A/R in the GL at creation (not at application), so the
  // statement shows its FULL total dated at creation — this keeps it double-count-free
  // because applying a memo to an invoice posts nothing.
  const creditMemoConds = [
    eq(creditMemos.companyId, ctx.companyId),
    eq(creditMemos.customerId, customerId),
    ne(creditMemos.status, 'void'),
  ];
  if (range?.from) creditMemoConds.push(gte(creditMemos.date, range.from));
  if (range?.to)
    creditMemoConds.push(lt(creditMemos.date, new Date(range.to.getTime() + 86_400_000)));

  const creditMemoRows = await ctx.db
    .select({
      date: creditMemos.date,
      memoNumber: creditMemos.memoNumber,
      refNumber: creditMemos.refNumber,
      total: creditMemos.total,
    })
    .from(creditMemos)
    .where(and(...creditMemoConds));

  // --- Merge and sort chronologically ---
  type RawLine = { kind: StatementLine['type']; date: Date; ref: string | null; amount: string };

  const raw: RawLine[] = [
    ...invoiceRows.map((r) => ({
      kind: r.isStatementCharge ? ('statement_charge' as const) : ('invoice' as const),
      date: r.date,
      ref: docRef(r.refNumber, r.invoiceNumber),
      amount: r.total,
    })),
    ...paymentRows
      .filter((r) => Money.of(r.amount).greaterThan(0))
      .map((r) => ({
        kind: 'payment' as const,
        date: r.date,
        ref: r.reference ?? null,
        amount: r.amount,
      })),
    ...paymentRows
      .filter((r) => (discountByPayment.get(r.id) ?? Money.zero()).greaterThan(0))
      .map((r) => ({
        kind: 'discount' as const,
        date: r.date,
        ref: r.reference ?? null,
        amount: toAmountString(discountByPayment.get(r.id)!),
      })),
    ...bouncedRows.map((b) => ({
      kind: 'bounced_check' as const,
      date: b.date,
      ref: b.reference,
      amount: toAmountString(b.amount),
    })),
    ...refundRows.map((r) => ({
      kind: 'refund' as const,
      date: r.date,
      ref: r.reference,
      amount: toAmountString(r.amount),
    })),
    ...creditMemoRows.map((r) => ({
      kind: 'credit_memo' as const,
      date: r.date,
      ref: docRef(r.refNumber, r.memoNumber),
      amount: r.total,
    })),
    ...journalInRange.map((j) => ({
      kind: 'general_journal' as const,
      date: j.date,
      ref: `GJ #${j.entryNumber}`,
      amount: j.amount,
    })),
  ];

  raw.sort((a, b) => a.date.getTime() - b.date.getTime());

  // --- Compute running balance ---
  let running = openingBalance;
  const lines: StatementLine[] = raw.map((r) => {
    if (
      r.kind === 'invoice' ||
      r.kind === 'statement_charge' ||
      r.kind === 'bounced_check' ||
      // A refund pays the customer back, so the credit it consumed is owed again.
      r.kind === 'refund' ||
      // General Journal amounts are already signed (+ charge, − credit).
      r.kind === 'general_journal'
    ) {
      running = running.plus(Money.of(r.amount));
    } else {
      // Payments, discounts and credit memos all reduce what the customer owes.
      running = running.minus(Money.of(r.amount));
    }
    return {
      date: r.date.toISOString().slice(0, 10),
      type: r.kind,
      ref: r.ref,
      amount: toAmountString(r.amount),
      runningBalance: toAmountString(running),
    };
  });

  return {
    customer: {
      id: cust.id,
      displayName: cust.displayName,
      companyName: cust.companyName ?? null,
      email: cust.email ?? null,
    },
    from: range?.from?.toISOString().slice(0, 10) ?? null,
    to: range?.to?.toISOString().slice(0, 10) ?? null,
    openingBalance: toAmountString(openingBalance),
    lines,
    closingBalance: toAmountString(running),
  };
}

// ---------------------------------------------------------------------------
// Open-Item Statement (QB "Open Item" format)
// ---------------------------------------------------------------------------

export type AgingBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

export interface OpenItemLine {
  /** invoice = an open charge; credit_memo / payment = an open (unapplied) credit (negative
   *  balance); general_journal = a named General Journal line on A/R (signed). */
  type: 'invoice' | 'credit_memo' | 'payment' | 'general_journal';
  /** The document's id (invoice, credit memo, payment, or journal entry). */
  docId: string;
  /** Same as docId (kept for older callers that only listed invoices). */
  invoiceId: string;
  /** ISO document date (YYYY-MM-DD). */
  date: string;
  /** Legacy integer number (invoice / memo number, GJ entry number; 0 for payments). */
  invoiceNumber: number;
  /** The number the user sees (typed ref number, else the legacy integer; payment reference). */
  refNumber: string;
  /** Plain-language label, e.g. "Invoice INV-1001", "Credit Memo CM-5", "Payment 1234". */
  label: string;
  /** ISO due date; falls back to the document date when no due date was set. */
  dueDate: string;
  /** Amount billed (negative for credits). */
  total: string;
  /** Paid / applied against it as of the statement date. */
  amountPaid: string;
  /** Open as of the statement date (negative for credits). */
  balanceDue: string;
  /** Whole days past due as of the statement date (0 when not yet due, and for credits). */
  daysPastDue: number;
  agingBucket: AgingBucket;
}

export interface AgingSummary {
  current: string;
  days1_30: string;
  days31_60: string;
  days61_90: string;
  days90Plus: string;
}

export interface OpenItemStatement {
  customer: {
    id: string;
    displayName: string;
    companyName: string | null;
    email: string | null;
  };
  /** Statement date (ISO). */
  asOf: string;
  lines: OpenItemLine[];
  aging: AgingSummary;
  totalDue: string;
}

const DAY_MS = 86_400_000;

function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return '1-30';
  if (daysPastDue <= 60) return '31-60';
  if (daysPastDue <= 90) return '61-90';
  return '90+';
}

/**
 * Open-item statement (QB "Open Item" format) as of `asOf`: every charge that was still open on
 * that date and every open credit (unapplied credit memos and payments, General Journal A/R
 * items). Open amounts are rebuilt AS OF the date — a payment or credit dated after the
 * statement date does not reduce it — using the same reconstruction as the A/R Aging Detail
 * report, so the total due always equals the customer's A/R aging total at `asOf`.
 */
export async function openItemStatement(
  ctx: ServiceContext,
  customerId: string,
  asOfInput?: Date,
): Promise<OpenItemStatement> {
  // Default: today's calendar day in the company's time zone (the UTC day is tomorrow in a US
  // evening — the statement was dated tomorrow and an invoice due today aged a day past due).
  const asOf = asOfInput ?? (await companyToday(ctx));
  const [cust] = await ctx.db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      companyName: customers.companyName,
      email: customers.email,
    })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.companyId, ctx.companyId)));
  if (!cust) throw notFound('Customer');

  // Lazy import: reportsExtra pulls in the report stack, which statements does not need otherwise.
  const { arAgingDetail } = await import('./reportsExtra');
  const detail = (await arAgingDetail(ctx, asOf)).rows.filter((r) => r.entityId === customerId);

  // Document details the aging rows don't carry (totals, numbers).
  const idsOf = (t: string) => detail.filter((d) => d.docType === t).map((d) => d.docId);
  const invIds = idsOf('invoice');
  const memoIds = idsOf('credit_memo');
  const payIds = idsOf('payment');
  const jeIds = idsOf('journal_entry');
  const [invRows, memoRows, payRows, jeRows] = await Promise.all([
    invIds.length
      ? ctx.db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            refNumber: invoices.refNumber,
            billed: sql<string>`CAST(${invoices.total} AS NUMERIC) - CAST(COALESCE(${invoices.retainageAmount}, '0') AS NUMERIC)`,
            isStatementCharge: invoices.isStatementCharge,
          })
          .from(invoices)
          .where(inArray(invoices.id, invIds))
      : [],
    memoIds.length
      ? ctx.db
          .select({ id: creditMemos.id, memoNumber: creditMemos.memoNumber, refNumber: creditMemos.refNumber, total: creditMemos.total })
          .from(creditMemos)
          .where(inArray(creditMemos.id, memoIds))
      : [],
    payIds.length
      ? ctx.db
          .select({ id: paymentsReceived.id, reference: paymentsReceived.reference, amount: paymentsReceived.amount })
          .from(paymentsReceived)
          .where(inArray(paymentsReceived.id, payIds))
      : [],
    jeIds.length
      ? ctx.db
          .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
          .from(journalEntries)
          .where(inArray(journalEntries.id, jeIds))
      : [],
  ]);
  const invById = new Map(invRows.map((r) => [r.id, r]));
  const memoById = new Map(memoRows.map((r) => [r.id, r]));
  const payById = new Map(payRows.map((r) => [r.id, r]));
  const jeById = new Map(jeRows.map((r) => [r.id, r]));

  const bucketTotals: Record<AgingBucket, ReturnType<typeof Money.zero>> = {
    current: Money.zero(),
    '1-30': Money.zero(),
    '31-60': Money.zero(),
    '61-90': Money.zero(),
    '90+': Money.zero(),
  };
  const BUCKET: Record<string, AgingBucket> = {
    current: 'current',
    days1_30: '1-30',
    days31_60: '31-60',
    days61_90: '61-90',
    days91plus: '90+',
  };
  let totalDue = Money.zero();

  const lines: OpenItemLine[] = detail.map((d) => {
    const open = Money.of(d.openBalance);
    const bucket = BUCKET[d.bucket] ?? 'current';
    bucketTotals[bucket] = bucketTotals[bucket].plus(open);
    totalDue = totalDue.plus(open);
    const base = {
      docId: d.docId,
      invoiceId: d.docId,
      date: d.date.slice(0, 10),
      dueDate: (d.dueDate ?? d.date).slice(0, 10),
      daysPastDue: d.daysPastDue,
      agingBucket: bucket,
      balanceDue: toAmountString(open),
    };
    if (d.docType === 'invoice') {
      const inv = invById.get(d.docId);
      const total = Money.of(inv?.billed ?? d.openBalance);
      const ref = inv ? docRef(inv.refNumber, inv.invoiceNumber) : '';
      return {
        ...base,
        type: 'invoice' as const,
        invoiceNumber: inv?.invoiceNumber ?? 0,
        refNumber: ref,
        label: `${inv?.isStatementCharge ? 'Statement Charge' : 'Invoice'} ${ref}`.trim(),
        total: toAmountString(total),
        amountPaid: toAmountString(total.minus(open)),
      };
    }
    if (d.docType === 'credit_memo') {
      const m = memoById.get(d.docId);
      const total = m ? Money.of(m.total).negated() : open;
      const ref = m ? docRef(m.refNumber, m.memoNumber) : '';
      return {
        ...base,
        type: 'credit_memo' as const,
        invoiceNumber: m?.memoNumber ?? 0,
        refNumber: ref,
        label: `Credit Memo ${ref}`.trim(),
        total: toAmountString(total),
        amountPaid: toAmountString(total.minus(open)),
      };
    }
    if (d.docType === 'payment') {
      const p = payById.get(d.docId);
      const total = p ? Money.of(p.amount).negated() : open;
      return {
        ...base,
        type: 'payment' as const,
        invoiceNumber: 0,
        refNumber: p?.reference ?? '',
        label: p?.reference ? `Payment ${p.reference}` : 'Payment',
        total: toAmountString(total),
        amountPaid: toAmountString(total.minus(open)),
      };
    }
    const je = jeById.get(d.docId);
    return {
      ...base,
      type: 'general_journal' as const,
      invoiceNumber: je?.entryNumber ?? 0,
      refNumber: je ? `GJ #${je.entryNumber}` : 'GJ',
      label: je ? `General Journal #${je.entryNumber}` : 'General Journal',
      total: toAmountString(open),
      amountPaid: '0.00',
    };
  });
  lines.sort((a, b) => a.date.localeCompare(b.date) || a.refNumber.localeCompare(b.refNumber));

  return {
    customer: {
      id: cust.id,
      displayName: cust.displayName,
      companyName: cust.companyName ?? null,
      email: cust.email ?? null,
    },
    asOf: asOf.toISOString().slice(0, 10),
    lines,
    aging: {
      current: toAmountString(bucketTotals.current),
      days1_30: toAmountString(bucketTotals['1-30']),
      days31_60: toAmountString(bucketTotals['31-60']),
      days61_90: toAmountString(bucketTotals['61-90']),
      days90Plus: toAmountString(bucketTotals['90+']),
    },
    totalDue: toAmountString(totalDue),
  };
}

// ---------------------------------------------------------------------------
// Batch statement generation (all customers with balances)
// ---------------------------------------------------------------------------

export type StatementFormat = 'balance_forward' | 'open_item';

export type BatchStatementEntry =
  | { customerId: string; displayName: string; format: 'balance_forward'; statement: CustomerStatement }
  | { customerId: string; displayName: string; format: 'open_item'; statement: OpenItemStatement };

/**
 * Generate statements for EVERY active customer that has something to report:
 *   - open_item:        customers with at least one open invoice as of `asOf`.
 *   - balance_forward:  customers whose closing balance for the range ≠ 0
 *                       OR with any activity lines in the range.
 */
export async function batchStatements(
  ctx: ServiceContext,
  opts: {
    format: StatementFormat;
    /** balance_forward range (both optional, like customerStatement). */
    from?: Date;
    to?: Date;
    /** open_item statement date; defaults to today. */
    asOf?: Date;
  },
): Promise<BatchStatementEntry[]> {
  const custRows = await ctx.db
    .select({ id: customers.id, displayName: customers.displayName })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.isActive, true)))
    .orderBy(asc(customers.displayName));

  const out: BatchStatementEntry[] = [];
  for (const c of custRows) {
    if (opts.format === 'open_item') {
      const stmt = await openItemStatement(ctx, c.id, opts.asOf);
      if (stmt.lines.length === 0) continue;
      out.push({ customerId: c.id, displayName: c.displayName, format: 'open_item', statement: stmt });
    } else {
      const stmt = await customerStatement(ctx, c.id, { from: opts.from, to: opts.to });
      const hasBalance = !Money.isZero(stmt.closingBalance);
      if (!hasBalance && stmt.lines.length === 0) continue;
      out.push({
        customerId: c.id,
        displayName: c.displayName,
        format: 'balance_forward',
        statement: stmt,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1099 Vendor Report
// ---------------------------------------------------------------------------

export interface Vendor1099Row {
  vendorId: string;
  vendorName: string;
  taxId: string | null;
  /** Total payments in the calendar year, formatted as decimal string. */
  total: string;
}

/**
 * The amount at which a 1099-NEC / 1099-MISC (rents, other income) is required for payments made
 * in `year`: $600 through 2025; $2,000 for payments made after December 31, 2025 (Public Law
 * 119-21, sec. 70433 — inflation-adjusted after 2026, so $2,000 is the floor the IRS publishes
 * from). The worksheet, the e-file and the NEC PDFs used $600 for every year, so for 2026 every
 * contractor paid $600–$1,999.99 was flagged "Form required" and put in the e-file.
 */
export function threshold1099(year: number): ReturnType<typeof Money.zero> {
  return Money.of(year >= 2026 ? '2000' : '600');
}

/**
 * Aggregate vendor payments for a calendar year (Jan 1 – Dec 31).
 * Sources:
 *   1. Bill payments applied to bills that belong to an is_1099 vendor.
 *   2. Direct expenses linked to an is_1099 vendor.
 *
 * Card-settled payments are EXCLUDED (both by payment method 'credit_card' and
 * by funding account being a credit-card liability): those amounts are reportable
 * on the card processor's 1099-K, not the payer's 1099-NEC — matching QB Desktop.
 *
 * Only vendors at or above the year's threshold (threshold1099) are returned.
 */
/**
 * 1099s report cash paid. A bill payment application stores the FULL settlement of the bill
 * (cash + early-payment discount taken); the discount lives only on the payment's journal entry
 * (the "Early-payment discounts" credit line, see billPayments.buildPaymentLines). Returns, per
 * payment, the share of each application that was cash: (applied - discount) / applied, with the
 * discount prorated across the payment's applications. Payments without a discount map to 1.
 */
async function billPaymentCashFactors(
  ctx: ServiceContext,
  paymentIds: string[],
): Promise<Map<string, ReturnType<typeof Money.zero>>> {
  const out = new Map<string, ReturnType<typeof Money.zero>>();
  if (paymentIds.length === 0) return out;
  const pays = await ctx.db
    .select({
      id: billPayments.id,
      postedEntryId: billPayments.postedEntryId,
      paymentAccountId: billPayments.paymentAccountId,
      currency: billPayments.currency,
      exchangeRate: billPayments.exchangeRate,
    })
    .from(billPayments)
    .where(and(eq(billPayments.companyId, ctx.companyId), inArray(billPayments.id, paymentIds)));
  const entryIds = pays.map((p) => p.postedEntryId).filter((v): v is string => !!v);
  if (entryIds.length === 0) return out;
  const discLines = await ctx.db
    .select({
      entryId: journalEntryLines.journalEntryId,
      accountId: journalEntryLines.accountId,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .where(
      and(
        inArray(journalEntryLines.journalEntryId, entryIds),
        sql`${journalEntryLines.memo} LIKE 'Early-payment discounts%'`,
      ),
    );
  if (discLines.length === 0) return out;
  const appSums = await ctx.db
    .select({
      billPaymentId: billPaymentApplications.billPaymentId,
      total: sql<string>`COALESCE(SUM(${billPaymentApplications.amountApplied}), 0)`,
    })
    .from(billPaymentApplications)
    .where(inArray(billPaymentApplications.billPaymentId, paymentIds))
    .groupBy(billPaymentApplications.billPaymentId);
  const appSumById = new Map(appSums.map((r) => [r.billPaymentId, Money.of(r.total)]));
  for (const p of pays) {
    if (!p.postedEntryId) continue;
    let discHome = Money.zero();
    for (const l of discLines) {
      if (l.entryId !== p.postedEntryId || l.accountId === p.paymentAccountId) continue;
      discHome = discHome.plus(Money.of(l.credit ?? 0));
    }
    if (!discHome.greaterThan(0)) continue;
    // The discount line is in home currency; applications are in the bills' currency.
    const disc = p.currency && p.exchangeRate && Money.of(p.exchangeRate).greaterThan(0)
      ? Money.round2(discHome.dividedBy(Money.of(p.exchangeRate)))
      : discHome;
    const applied = appSumById.get(p.id) ?? Money.zero();
    if (!applied.greaterThan(0)) continue;
    const cash = applied.minus(disc);
    out.set(p.id, cash.lessThanOrEqualTo(0) ? Money.zero() : cash.dividedBy(applied));
  }
  return out;
}

/** Cash part of one application (see billPaymentCashFactors). */
function cashOfApplication(
  factors: Map<string, ReturnType<typeof Money.zero>>,
  billPaymentId: string,
  amountApplied: string,
): ReturnType<typeof Money.zero> {
  const f = factors.get(billPaymentId);
  return f ? Money.round2(Money.of(amountApplied).times(f)) : Money.of(amountApplied);
}

/**
 * Home-currency value of a 1099 amount: foreign bill payments / checks store their amounts in the
 * transaction currency, and 1099s are filed in home currency (null rate = home document).
 */
function home1099(amount: ReturnType<typeof Money.zero>, rate: string | null): ReturnType<typeof Money.zero> {
  if (!rate) return amount;
  const r = Money.of(rate);
  return r.greaterThan(0) && !r.equals(1) ? Money.round2(amount.times(r)) : amount;
}

/**
 * General Journal amounts owed to 1099 vendors (named A/P credits, e.g. a contractor's opening
 * balance from a QB conversion) that a Pay Bills check paid in the year (QB I11: they are listed
 * in Pay Bills next to the bills). Only the bill payments' applications to BILLS were counted, so
 * that cash never reached the 1099. Home currency (journal items are paid in home currency only);
 * card-settled payments are excluded as for bills. `accounts` = the journal entry's other (debit)
 * lines, for the account → box mapping.
 */
async function journalItemsPaid1099(
  ctx: ServiceContext,
  yearStart: Date,
  yearEnd: Date,
): Promise<
  Array<{
    vendorId: string;
    vendorName: string;
    taxId: string | null;
    amount: ReturnType<typeof Money.zero>;
    accounts: Array<{ accountId: string; amount: string }>;
  }>
> {
  const fundingAccountNotCreditCard = or(
    isNull(accounts.id),
    not(and(eq(accounts.type, 'liability'), eq(accounts.subtype, 'credit_card'))!),
  );
  const rows = await ctx.db
    .select({
      vendorId: vendors.id,
      vendorName: vendors.displayName,
      taxId: vendors.taxId,
      journalEntryId: journalItemApplications.journalEntryId,
      journalLineId: journalItemApplications.journalLineId,
      amount: journalItemApplications.amount,
    })
    .from(journalItemApplications)
    .innerJoin(billPayments, eq(journalItemApplications.billPaymentId, billPayments.id))
    .innerJoin(vendors, eq(billPayments.vendorId, vendors.id))
    .leftJoin(accounts, eq(billPayments.paymentAccountId, accounts.id))
    .where(
      and(
        eq(journalItemApplications.companyId, ctx.companyId),
        eq(journalItemApplications.kind, 'bill_payment'),
        eq(vendors.is1099, true),
        gte(billPayments.date, yearStart),
        lt(billPayments.date, yearEnd),
        isNull(billPayments.voidedAt),
        ne(billPayments.method, 'credit_card'),
        fundingAccountNotCreditCard,
      ),
    );
  if (rows.length === 0) return [];
  const entryIds = [...new Set(rows.map((r) => r.journalEntryId))];
  const debitLines = await ctx.db
    .select({ entryId: journalEntryLines.journalEntryId, id: journalEntryLines.id, accountId: journalEntryLines.accountId, debit: journalEntryLines.debit })
    .from(journalEntryLines)
    .where(and(inArray(journalEntryLines.journalEntryId, entryIds), sql`COALESCE(${journalEntryLines.debit}, 0) > 0`));
  return rows.map((r) => ({
    vendorId: r.vendorId,
    vendorName: r.vendorName,
    taxId: r.taxId ?? null,
    amount: Money.of(r.amount),
    accounts: debitLines
      .filter((l) => l.entryId === r.journalEntryId && l.id !== r.journalLineId)
      .map((l) => ({ accountId: l.accountId, amount: l.debit ?? '0' })),
  }));
}

export async function vendor1099Report(
  ctx: ServiceContext,
  { year }: { year: number },
): Promise<Vendor1099Row[]> {
  const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00.000Z`);

  // Funding account is NOT a credit-card liability (null-safe for left joins —
  // a payment with no/unknown funding account is treated as non-card).
  const fundingAccountNotCreditCard = or(
    isNull(accounts.id),
    not(and(eq(accounts.type, 'liability'), eq(accounts.subtype, 'credit_card'))!),
  );

  // --- Bill payments applied to vendors that are is_1099 ---
  // Join: bill_payment_applications -> bill_payments (date filter) -> bills (vendorId) -> vendors (is1099)
  const billPaymentRows = await ctx.db
    .select({
      vendorId: vendors.id,
      vendorName: vendors.displayName,
      taxId: vendors.taxId,
      billPaymentId: billPaymentApplications.billPaymentId,
      amountApplied: billPaymentApplications.amountApplied,
      rate: billPayments.exchangeRate,
    })
    .from(billPaymentApplications)
    .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
    .innerJoin(bills, eq(billPaymentApplications.billId, bills.id))
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .leftJoin(accounts, eq(billPayments.paymentAccountId, accounts.id))
    .where(
      and(
        eq(billPayments.companyId, ctx.companyId),
        eq(vendors.is1099, true),
        gte(billPayments.date, yearStart),
        lt(billPayments.date, yearEnd),
        // Exclude card-settled payments (1099-K territory, not 1099-NEC box 1).
        ne(billPayments.method, 'credit_card'),
        fundingAccountNotCreditCard,
      ),
    );

  // --- Direct expenses linked to a 1099 vendor ---
  const expenseRows = await ctx.db
    .select({
      vendorId: vendors.id,
      vendorName: vendors.displayName,
      taxId: vendors.taxId,
      total: expenses.total,
      rate: expenses.exchangeRate,
    })
    .from(expenses)
    .innerJoin(vendors, eq(expenses.vendorId, vendors.id))
    .leftJoin(accounts, eq(expenses.paymentAccountId, accounts.id))
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        eq(vendors.is1099, true),
        gte(expenses.date, yearStart),
        lt(expenses.date, yearEnd),
        isNull(expenses.voidedAt),
        // Same card-settled exclusion as bill payments.
        ne(expenses.method, 'credit_card'),
        fundingAccountNotCreditCard,
      ),
    );

  // --- Aggregate per vendor ---
  const totals = new Map<
    string,
    { vendorName: string; taxId: string | null; total: ReturnType<typeof Money.zero> }
  >();

  function accumulate(vendorId: string, vendorName: string, taxId: string | null, amount: string) {
    if (!totals.has(vendorId)) {
      totals.set(vendorId, { vendorName, taxId, total: Money.zero() });
    }
    totals.get(vendorId)!.total = totals.get(vendorId)!.total.plus(Money.of(amount));
  }

  const cashFactors = await billPaymentCashFactors(ctx, [...new Set(billPaymentRows.map((r) => r.billPaymentId))]);
  for (const r of billPaymentRows) {
    accumulate(
      r.vendorId,
      r.vendorName,
      r.taxId ?? null,
      toAmountString(home1099(cashOfApplication(cashFactors, r.billPaymentId, r.amountApplied), r.rate)),
    );
  }
  for (const r of expenseRows) {
    accumulate(r.vendorId, r.vendorName, r.taxId ?? null, toAmountString(home1099(Money.of(r.total), r.rate)));
  }
  // General Journal amounts owed paid in Pay Bills (home currency).
  for (const j of await journalItemsPaid1099(ctx, yearStart, yearEnd)) {
    accumulate(j.vendorId, j.vendorName, j.taxId, toAmountString(j.amount));
  }

  // --- Filter to the year's 1099 threshold ($600; $2,000 from 2026) ---
  const result: Vendor1099Row[] = [];
  for (const [vendorId, { vendorName, taxId, total }] of totals) {
    if (total.greaterThanOrEqualTo(threshold1099(year))) {
      result.push({
        vendorId,
        vendorName,
        // Masked unless the caller may view sensitive data (also covers the 1099 PDF/e-file).
        taxId: taxIdFor(ctx, taxId),
        total: toAmountString(total),
      });
    }
  }

  // Sort descending by total
  result.sort((a, b) => Money.of(b.total).comparedTo(Money.of(a.total)));

  return result;
}

// ---------------------------------------------------------------------------
// 1099 account → box mapping (companies.settings.tax1099)
// ---------------------------------------------------------------------------

/**
 * Supported 1099 boxes:
 *   nec_1  — 1099-NEC Box 1 (Nonemployee compensation)
 *   misc_1 — 1099-MISC Box 1 (Rents)
 *   misc_3 — 1099-MISC Box 3 (Other income)
 */
export type Tax1099Box = 'nec_1' | 'misc_1' | 'misc_3';

export const TAX_1099_BOXES: Array<{ box: Tax1099Box; label: string }> = [
  { box: 'nec_1', label: '1099-NEC Box 1 — Nonemployee Compensation' },
  { box: 'misc_1', label: '1099-MISC Box 1 — Rents' },
  { box: 'misc_3', label: '1099-MISC Box 3 — Other Income' },
];

export interface Tax1099Mapping {
  boxes: Array<{ box: Tax1099Box; accountIds: string[] }>;
}

/** Read the saved 1099 account mapping from companies.settings.tax1099 (null when unset). */
export async function get1099Mapping(ctx: ServiceContext): Promise<Tax1099Mapping | null> {
  const [company] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  if (!company) throw notFound('Company');
  const raw = (company.settings ?? {}) as Record<string, unknown>;
  const mapping = raw.tax1099 as Tax1099Mapping | undefined;
  if (!mapping || !Array.isArray(mapping.boxes)) return null;
  return mapping;
}

/**
 * Save the 1099 account mapping into companies.settings.tax1099. Validates box
 * keys and that every account id belongs to this company. Passing an empty
 * boxes array clears the mapping (back to "everything counts as NEC box 1").
 */
export async function set1099Mapping(ctx: ServiceContext, mapping: Tax1099Mapping) {
  if (!mapping || !Array.isArray(mapping.boxes)) {
    throw validation('mapping.boxes must be an array.');
  }
  const validBoxes = new Set<string>(TAX_1099_BOXES.map((b) => b.box));
  const seen = new Set<string>();
  const allAccountIds: string[] = [];
  for (const entry of mapping.boxes) {
    // A request body's entry may be anything (null, a string): a 400, not a TypeError (HTTP 500).
    if (!entry || typeof entry !== 'object') {
      throw validation('Each 1099 box mapping needs a box and a list of accountIds.');
    }
    if (!validBoxes.has(entry.box)) {
      throw validation(`Unknown 1099 box "${entry.box}". Valid: ${[...validBoxes].join(', ')}.`);
    }
    if (seen.has(entry.box)) {
      throw validation(`Duplicate 1099 box "${entry.box}" in mapping.`);
    }
    seen.add(entry.box);
    if (!Array.isArray(entry.accountIds) || entry.accountIds.some((id) => typeof id !== 'string')) {
      throw validation(`accountIds for box "${entry.box}" must be a list of account ids.`);
    }
    allAccountIds.push(...entry.accountIds);
  }

  // One account cannot feed two boxes (a payment dollar lands in exactly one box).
  if (new Set(allAccountIds).size !== allAccountIds.length) {
    throw validation('An account can be mapped to only one 1099 box.');
  }

  // Verify account ownership.
  if (allAccountIds.length > 0) {
    const rows = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, allAccountIds)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of allAccountIds) {
      if (!found.has(id)) throw notFound(`Account ${id}`);
    }
  }

  // Read and write the settings JSON in ONE transaction: another settings save (preferences,
  // receiving, ...) committed between the read and the write here was overwritten with the old
  // copy of its keys.
  return inTransaction(ctx, async (tx) => {
    const [company] = await tx.db
      .select()
      .from(companies)
      .where(eq(companies.id, tx.companyId));
    if (!company) throw notFound('Company');

    const oldSettings = (company.settings ?? {}) as Record<string, unknown>;
    const cleaned: Tax1099Mapping = {
      boxes: mapping.boxes
        .map((b) => ({ box: b.box, accountIds: [...new Set(b.accountIds)] }))
        .filter((b) => b.accountIds.length > 0),
    };
    const newSettings = { ...oldSettings, tax1099: cleaned };

    const [updated] = await tx.db
      .update(companies)
      .set({ settings: newSettings, updatedAt: new Date() })
      .where(eq(companies.id, tx.companyId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'company',
      entityId: tx.companyId,
      oldValues: { tax1099: oldSettings.tax1099 ?? null },
      newValues: { tax1099: cleaned },
    });

    return (updated.settings as Record<string, unknown>).tax1099 as Tax1099Mapping;
  });
}

// ---------------------------------------------------------------------------
// 1099 Worksheet (NEC + MISC, account-mapped)
// ---------------------------------------------------------------------------

export interface Vendor1099WorksheetRow {
  vendorId: string;
  vendorName: string;
  taxId: string | null;
  /** 1099-NEC Box 1 — Nonemployee compensation. */
  nec1: string;
  /** 1099-MISC Box 1 — Rents. */
  misc1: string;
  /** 1099-MISC Box 3 — Other income. */
  misc3: string;
  /** Sum of all boxes. */
  total: string;
  /** NEC form required (nec1 >= the year's threshold: $600; $2,000 from 2026). */
  necEligible: boolean;
  /** MISC form required (misc1 or misc3 >= the year's threshold). */
  miscEligible: boolean;
}

export interface Vendor1099Worksheet {
  year: number;
  /** True when an account mapping is configured (otherwise everything counts as NEC box 1). */
  mapped: boolean;
  /** The amount at which a form is required for this year (threshold1099). */
  threshold: string;
  rows: Vendor1099WorksheetRow[];
}

/**
 * 1099 worksheet for a calendar year, split by form/box using the saved
 * account mapping (companies.settings.tax1099):
 *
 *  - When NO mapping is configured, every eligible payment dollar counts toward
 *    1099-NEC Box 1 (the legacy behavior).
 *  - When a mapping IS configured, payments count toward a box only when the
 *    underlying expense/bill LINE hits a mapped account; lines on unmapped
 *    accounts are excluded (QB Desktop "map accounts to boxes" semantics).
 *
 * Sources and exclusions mirror vendor1099Report:
 *  - Bill payments applied to is_1099 vendors' bills. The applied amount is
 *    prorated across the bill's lines by line amount, so each line's account
 *    routes its share to the right box.
 *  - Direct expenses to is_1099 vendors, per expense line account.
 *  - Card-settled payments are EXCLUDED (method 'credit_card' or a credit-card
 *    funding account): reportable on the processor's 1099-K instead.
 *  - Voided expenses / bill payments are excluded.
 */
export async function vendor1099Worksheet(
  ctx: ServiceContext,
  { year }: { year: number },
): Promise<Vendor1099Worksheet> {
  const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00.000Z`);

  const mapping = await get1099Mapping(ctx);
  const accountBox = new Map<string, Tax1099Box>();
  for (const entry of mapping?.boxes ?? []) {
    for (const id of entry.accountIds) accountBox.set(id, entry.box);
  }
  const mapped = accountBox.size > 0;

  /** Box for a GL account: NEC box 1 when unmapped company-wide, else mapping or excluded. */
  const boxFor = (accountId: string): Tax1099Box | null =>
    mapped ? (accountBox.get(accountId) ?? null) : 'nec_1';

  const fundingAccountNotCreditCard = or(
    isNull(accounts.id),
    not(and(eq(accounts.type, 'liability'), eq(accounts.subtype, 'credit_card'))!),
  );

  // --- Bill payments applied to is_1099 vendors (per application) ---
  const applicationRows = await ctx.db
    .select({
      billId: bills.id,
      vendorId: vendors.id,
      vendorName: vendors.displayName,
      taxId: vendors.taxId,
      billPaymentId: billPaymentApplications.billPaymentId,
      amountApplied: billPaymentApplications.amountApplied,
      rate: billPayments.exchangeRate,
    })
    .from(billPaymentApplications)
    .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
    .innerJoin(bills, eq(billPaymentApplications.billId, bills.id))
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .leftJoin(accounts, eq(billPayments.paymentAccountId, accounts.id))
    .where(
      and(
        eq(billPayments.companyId, ctx.companyId),
        eq(vendors.is1099, true),
        gte(billPayments.date, yearStart),
        lt(billPayments.date, yearEnd),
        isNull(billPayments.voidedAt),
        ne(billPayments.method, 'credit_card'),
        fundingAccountNotCreditCard,
      ),
    );

  // Load the lines of every involved bill for the account split.
  const billIds = [...new Set(applicationRows.map((r) => r.billId))];
  const linesByBill = new Map<string, Array<{ accountId: string; amount: string }>>();
  if (billIds.length > 0) {
    const lineRows = await ctx.db
      .select({ billId: billLines.billId, accountId: billLines.accountId, amount: billLines.amount })
      .from(billLines)
      .where(inArray(billLines.billId, billIds));
    for (const l of lineRows) {
      const list = linesByBill.get(l.billId) ?? [];
      list.push({ accountId: l.accountId, amount: l.amount });
      linesByBill.set(l.billId, list);
    }
  }

  // --- Direct expense lines to is_1099 vendors ---
  const expenseLineRows = await ctx.db
    .select({
      vendorId: vendors.id,
      vendorName: vendors.displayName,
      taxId: vendors.taxId,
      accountId: expenseLines.accountId,
      amount: expenseLines.amount,
      rate: expenses.exchangeRate,
    })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .innerJoin(vendors, eq(expenses.vendorId, vendors.id))
    .leftJoin(accounts, eq(expenses.paymentAccountId, accounts.id))
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        eq(vendors.is1099, true),
        gte(expenses.date, yearStart),
        lt(expenses.date, yearEnd),
        isNull(expenses.voidedAt),
        ne(expenses.method, 'credit_card'),
        fundingAccountNotCreditCard,
      ),
    );

  // --- Accumulate per vendor / box ---
  type Acc = {
    vendorName: string;
    taxId: string | null;
    boxes: Record<Tax1099Box, ReturnType<typeof Money.zero>>;
  };
  const totals = new Map<string, Acc>();

  function add(
    vendorId: string,
    vendorName: string,
    taxId: string | null,
    box: Tax1099Box | null,
    amount: ReturnType<typeof Money.zero>,
  ) {
    if (!box || amount.lessThanOrEqualTo(0)) return;
    if (!totals.has(vendorId)) {
      totals.set(vendorId, {
        vendorName,
        taxId,
        boxes: { nec_1: Money.zero(), misc_1: Money.zero(), misc_3: Money.zero() },
      });
    }
    const acc = totals.get(vendorId)!;
    acc.boxes[box] = acc.boxes[box].plus(amount);
  }

  // Bill payments: prorate each application across the bill's lines by amount.
  const cashFactors = await billPaymentCashFactors(ctx, [...new Set(applicationRows.map((r) => r.billPaymentId))]);
  for (const app of applicationRows) {
    const lines = linesByBill.get(app.billId) ?? [];
    // Cash share (in the payment's currency) at the payment's rate = home cash paid.
    const applied = home1099(cashOfApplication(cashFactors, app.billPaymentId, app.amountApplied), app.rate);
    if (applied.lessThanOrEqualTo(0)) continue;
    const lineSum = lines.reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero());
    if (lines.length === 0 || lineSum.lessThanOrEqualTo(0)) {
      // No line detail — treat the whole application like a single unmapped line.
      add(app.vendorId, app.vendorName, app.taxId ?? null, mapped ? null : 'nec_1', applied);
      continue;
    }
    for (const line of lines) {
      const share = applied.times(Money.of(line.amount)).dividedBy(lineSum);
      add(app.vendorId, app.vendorName, app.taxId ?? null, boxFor(line.accountId), share);
    }
  }

  // Expense lines: direct account → box.
  for (const l of expenseLineRows) {
    add(l.vendorId, l.vendorName, l.taxId ?? null, boxFor(l.accountId), home1099(Money.of(l.amount), l.rate));
  }

  // General Journal amounts owed paid in Pay Bills: prorated over the journal entry's other
  // (debit) lines, so each account routes its share to its box (as bill lines do).
  for (const j of await journalItemsPaid1099(ctx, yearStart, yearEnd)) {
    const lineSum = j.accounts.reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero());
    if (j.accounts.length === 0 || lineSum.lessThanOrEqualTo(0)) {
      add(j.vendorId, j.vendorName, j.taxId, mapped ? null : 'nec_1', j.amount);
      continue;
    }
    for (const line of j.accounts) {
      add(j.vendorId, j.vendorName, j.taxId, boxFor(line.accountId), j.amount.times(Money.of(line.amount)).dividedBy(lineSum));
    }
  }

  // --- Build rows + thresholds ---
  const THRESHOLD = threshold1099(year);
  const rows: Vendor1099WorksheetRow[] = [];
  for (const [vendorId, acc] of totals) {
    const nec1 = acc.boxes.nec_1;
    const misc1 = acc.boxes.misc_1;
    const misc3 = acc.boxes.misc_3;
    const total = nec1.plus(misc1).plus(misc3);
    if (total.lessThanOrEqualTo(0)) continue;
    rows.push({
      vendorId,
      vendorName: acc.vendorName,
      taxId: taxIdFor(ctx, acc.taxId),
      nec1: toAmountString(nec1),
      misc1: toAmountString(misc1),
      misc3: toAmountString(misc3),
      total: toAmountString(total),
      necEligible: nec1.greaterThanOrEqualTo(THRESHOLD),
      miscEligible:
        misc1.greaterThanOrEqualTo(THRESHOLD) || misc3.greaterThanOrEqualTo(THRESHOLD),
    });
  }

  rows.sort((a, b) => Money.of(b.total).comparedTo(Money.of(a.total)));

  return { year, mapped, threshold: toAmountString(THRESHOLD), rows };
}
