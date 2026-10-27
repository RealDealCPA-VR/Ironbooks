/**
 * Unapplied customer payments ("credits" in QuickBooks Receive Payments).
 *
 * receivePayment credits A/R for the FULL amount received, including any part not applied to an
 * invoice (an overpayment, or a payment against a General Journal charge, which has no invoice to
 * apply to). That unapplied part therefore belongs in the customer subledger as a credit, or A/R
 * aging / customer balances would stop matching the A/R account in the GL.
 *
 * As-of reconstruction (p1 fx): the credit is rebuilt in the PAYMENT'S currency, then converted:
 *   unapplied(as of cutoff) = current `unapplied`
 *                           + refunds of that payment dated after the cutoff (foreign amount)
 *                           + foreign-invoice applies / unapplies recorded after the cutoff
 *                             (payment_fx_reliefs dated after it; an unapply is negative)
 *   credit (home)           = round2(unapplied(as of cutoff) x payment rate)
 * Every A/R posting that changes the credit (refund, apply / unapply FX plug, refund-void plug) is
 * dated on the day the credit changed, so the A/R balance as of any date equals this figure.
 * Home-currency payments (rate 1) reduce to current unapplied + later refunds, as before.
 * Voided payments are excluded entirely — their journal entry is voided, so they leave the GL at
 * every date.
 */
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  accounts,
  auditLogs,
  bouncedChecks,
  invoices,
  journalEntries,
  journalEntryLines,
  paymentApplications,
  paymentFxReliefs,
  paymentsReceived,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';

export interface UnappliedCustomerPayment {
  paymentId: string;
  customerId: string;
  date: Date;
  reference: string | null;
  /** Positive amount of credit the customer holds, in base currency (reduces what they owe). */
  amount: string;
}

/** Home value of a payment-currency amount at the payment rate (round2); exactly 0 when nothing is left. */
export function paymentCreditHome(foreign: Decimal, rate: Decimal): Decimal {
  return foreign.isZero() ? Money.zero() : Money.round2(foreign.times(rate));
}

/** A change to a payment's unapplied credit after the payment itself. */
export interface PaymentCreditEvent {
  date: Date;
  /** Reduction of the unapplied credit, payment currency (a refund or apply: +, an unapply: -). */
  foreign: Decimal;
  kind: 'refund' | 'apply';
  /** refund: the refund's journal entry. */
  entryId?: string;
}

/**
 * Posted refunds and later foreign-invoice applies / unapplies of these payments, optionally only
 * those dated after `after`. A refund's foreign amount is the one recorded on its audit row
 * (exact); a refund without one falls back to round2(posted home / rate).
 */
export async function paymentCreditEvents(
  ctx: ServiceContext,
  payments: Array<{ id: string; exchangeRate: string | null }>,
  opts: { after?: Date } = {},
): Promise<Map<string, PaymentCreditEvent[]>> {
  const out = new Map<string, PaymentCreditEvent[]>();
  if (payments.length === 0) return out;
  const ids = payments.map((p) => p.id);
  const rateOf = new Map(payments.map((p) => [p.id, Money.of(p.exchangeRate ?? 1)]));
  const push = (id: string, e: PaymentCreditEvent) => out.set(id, [...(out.get(id) ?? []), e]);

  const refundConds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    inArray(
      journalEntries.sourceRef,
      ids.map((id) => `refund:${id}`),
    ),
  ];
  if (opts.after) refundConds.push(gt(journalEntries.date, opts.after));
  const refundRows = await ctx.db
    .select({
      entryId: journalEntries.id,
      sourceRef: journalEntries.sourceRef,
      date: journalEntries.date,
      amount: sql<string>`COALESCE(SUM(CAST(${journalEntryLines.debit} AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...refundConds))
    .groupBy(journalEntries.id, journalEntries.sourceRef, journalEntries.date);
  if (refundRows.length > 0) {
    const refunded = [...new Set(refundRows.map((r) => r.sourceRef!.slice('refund:'.length)))];
    const audits = await ctx.db
      .select({ newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.entityType, 'payment_received'),
          inArray(auditLogs.entityId, refunded),
          sql`${auditLogs.newValues}->>'action' = 'refund'`,
        ),
      );
    const foreignByEntry = new Map<string, string>();
    for (const a of audits) {
      const v = a.newValues as { postedEntryId?: string; amount?: string } | null;
      if (v?.postedEntryId && v.amount) foreignByEntry.set(v.postedEntryId, v.amount);
    }
    for (const r of refundRows) {
      const id = r.sourceRef!.slice('refund:'.length);
      const rate = rateOf.get(id) ?? Money.of(1);
      const recorded = foreignByEntry.get(r.entryId);
      const foreign = recorded
        ? Money.round2(Money.of(recorded))
        : rate.greaterThan(0) && !rate.equals(1)
          ? Money.round2(Money.of(r.amount).div(rate))
          : Money.round2(Money.of(r.amount));
      push(id, { date: r.date, foreign, kind: 'refund', entryId: r.entryId });
    }
  }

  const reliefConds = [
    eq(paymentFxReliefs.companyId, ctx.companyId),
    inArray(paymentFxReliefs.paymentId, ids),
    // Reliefs recorded with the payment itself (dated the payment date) are part of the payment.
    gt(paymentFxReliefs.date, paymentsReceived.date),
  ];
  if (opts.after) reliefConds.push(gt(paymentFxReliefs.date, opts.after));
  const reliefs = await ctx.db
    .select({ paymentId: paymentFxReliefs.paymentId, date: paymentFxReliefs.date, amount: paymentFxReliefs.amount })
    .from(paymentFxReliefs)
    .innerJoin(paymentsReceived, eq(paymentFxReliefs.paymentId, paymentsReceived.id))
    .where(and(...reliefConds));
  for (const r of reliefs) push(r.paymentId, { date: r.date, foreign: Money.of(r.amount), kind: 'apply' });
  return out;
}

/** The payment's unapplied credit (payment currency) as of a date: today's + events after it. */
export function unappliedAsOf(current: Decimal | string, events: PaymentCreditEvent[] | undefined, asOf: Date): Decimal {
  let u = Money.of(current);
  for (const e of events ?? []) if (e.date.getTime() > asOf.getTime()) u = u.plus(e.foreign);
  return Money.round2(u);
}

/**
 * Unapplied credit (payment currency) of these payments as of a date (or today), per payment id.
 * Shared by the A/R aging (unappliedCustomerPayments) and the foreign subledger (fxSubledger.ts).
 */
export async function paymentsUnappliedAsOf(
  ctx: ServiceContext,
  payments: Array<{ id: string; unapplied: string; exchangeRate: string | null }>,
  asOf?: Date,
): Promise<Map<string, Decimal>> {
  if (!asOf) return new Map(payments.map((p) => [p.id, Money.round2(Money.of(p.unapplied))]));
  if (payments.length > 2000) {
    // review5 fx: the A/R aging reads every payment ever received; one IN (...) list over all of
    // them exceeds Postgres' 65,535 bind parameters on a large file. Each payment's credit depends
    // only on its own rows, so it is computed 2000 payments at a time.
    const out = new Map<string, Decimal>();
    for (let i = 0; i < payments.length; i += 2000) {
      for (const [k, v] of await paymentsUnappliedAsOf(ctx, payments.slice(i, i + 2000), asOf)) out.set(k, v);
    }
    return out;
  }
  const events = await paymentCreditEvents(ctx, payments, { after: asOf });
  const ids = payments.map((p) => p.id);
  const later = await homeAppliedToLaterInvoices(ctx, ids, asOf);
  const bounced = await bouncedCreditAfter(ctx, ids, asOf);
  return new Map(
    payments.map((p) => [
      p.id,
      unappliedAsOf(p.unapplied, events.get(p.id), asOf)
        .plus(later.get(p.id) ?? Money.zero())
        .plus(bounced.get(p.id) ?? Money.zero()),
    ]),
  );
}

/**
 * Credit a payment still held on `asOf` when it bounced AFTER that date (payments.ts
 * recordBouncedCheck zeroes `unapplied` and deletes the payment's applications, undated): what was
 * unapplied when it bounced (audit oldValues.unapplied), the General Journal charges it paid (reopened
 * by the bounce, so open again in every as-of aging), and its invoice applications to invoices dated
 * after `asOf` (not yet applied then — see homeAppliedToLaterInvoices). The bounce entry re-charges
 * A/R on its own date, so before it the GL still carries the whole payment as a credit.
 */
async function bouncedCreditAfter(ctx: ServiceContext, paymentIds: string[], asOf: Date): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  for (let i = 0; i < paymentIds.length; i += 2000) {
    const chunk = paymentIds.slice(i, i + 2000);
    const rows = await ctx.db
      .select({ paymentId: bouncedChecks.paymentId, applications: bouncedChecks.applications })
      .from(bouncedChecks)
      .where(and(eq(bouncedChecks.companyId, ctx.companyId), inArray(bouncedChecks.paymentId, chunk), gt(bouncedChecks.date, asOf)));
    if (rows.length === 0) continue;
    const bouncedIds = [...new Set(rows.map((r) => r.paymentId))];
    const audits = await ctx.db
      .select({ entityId: auditLogs.entityId, oldValues: auditLogs.oldValues, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.entityType, 'payment_received'),
          inArray(auditLogs.entityId, bouncedIds),
          sql`${auditLogs.newValues}->>'action' = 'bounced'`,
        ),
      );
    const heldAtBounce = new Map<string, Decimal>();
    for (const a of audits) {
      if (!a.entityId) continue;
      const unapplied = Money.of((a.oldValues as { unapplied?: string } | null)?.unapplied ?? 0);
      const journal = ((a.newValues as { journalChargesReopened?: Array<{ amount?: string }> } | null)?.journalChargesReopened ?? [])
        .reduce((s, j) => s.plus(Money.of(j.amount ?? 0)), Money.zero());
      heldAtBounce.set(a.entityId, unapplied.plus(journal));
    }
    const invIds = [...new Set(rows.flatMap((r) => (r.applications ?? []).map((x) => x.invoiceId)).filter((x): x is string => !!x))];
    // Invoices the reopened applications cannot be shown against on `asOf`: dated after it, or voided
    // since the bounce (a void takes the invoice off A/R at every date — the payment's money was then
    // a credit on the customer's account).
    const notAgedThen = new Set<string>();
    for (let j = 0; j < invIds.length; j += 2000) {
      for (const inv of await ctx.db
        .select({ id: invoices.id, date: invoices.date, status: invoices.status })
        .from(invoices)
        .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, invIds.slice(j, j + 2000))))) {
        if (inv.status === 'void' || inv.date.getTime() > asOf.getTime()) notAgedThen.add(inv.id);
      }
    }
    for (const r of rows) {
      let credit = heldAtBounce.get(r.paymentId) ?? Money.zero();
      for (const app of r.applications ?? []) {
        // Cash and early-payment discount both came off A/R on the payment date.
        if (app.invoiceId && notAgedThen.has(app.invoiceId)) {
          credit = credit.plus(Money.of(app.amountApplied ?? 0)).plus(Money.of(app.discountAmount ?? 0));
        }
      }
      out.set(r.paymentId, (out.get(r.paymentId) ?? Money.zero()).plus(credit));
    }
  }
  return out;
}

/**
 * Home-currency payment credit applied to invoices dated AFTER `asOf`, per payment. On that date the
 * invoice did not exist yet, so the credit was still unapplied: an application takes effect on the
 * later of the payment's and the invoice's dates (the A/R aging leaves invoices dated after its
 * cutoff out, and the GL credited the whole payment to A/R on the payment date). A prepayment later
 * applied to a new invoice therefore stays a credit in every as-of aging before that invoice.
 * Foreign payments record their applications as dated FX reliefs (paymentCreditEvents) instead.
 */
async function homeAppliedToLaterInvoices(ctx: ServiceContext, paymentIds: string[], asOf: Date): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  for (let i = 0; i < paymentIds.length; i += 2000) {
    const chunk = paymentIds.slice(i, i + 2000);
    const rows = await ctx.db
      .select({
        paymentId: paymentApplications.paymentId,
        // Cash and early-payment discount both came off A/R on the payment date.
        amount: sql<string>`COALESCE(SUM(CAST(${paymentApplications.amountApplied} AS NUMERIC) + CAST(${paymentApplications.discountAmount} AS NUMERIC)), 0)`,
      })
      .from(paymentApplications)
      .innerJoin(invoices, eq(paymentApplications.invoiceId, invoices.id))
      .innerJoin(paymentsReceived, eq(paymentApplications.paymentId, paymentsReceived.id))
      .where(
        and(
          eq(paymentsReceived.companyId, ctx.companyId),
          // The id list filters the payments (the join then finds each one's applications by
          // payment_applications_payment_idx). On payment_applications.payment_id it became an
          // index condition re-evaluated for every payment of the company, chunk after chunk:
          // quadratic, and the as-of A/R aging of a file with 66,000 payments never finished.
          inArray(paymentsReceived.id, chunk),
          isNull(paymentsReceived.currency),
          gt(invoices.date, asOf),
        ),
      )
      .groupBy(paymentApplications.paymentId);
    for (const r of rows) out.set(r.paymentId, Money.of(r.amount));
  }
  return out;
}

/**
 * What the ledger carries for a payment's unapplied credit, as dated A/R movements: the A/R of the
 * payment's own entry, its FX plugs (`payment:<id>`) and its refunds (`refund:<id>`), plus the home
 * A/R it moved onto foreign invoices (payment_fx_reliefs: A/R taken off the credit and put on the
 * invoice). ledgerCreditAsOf turns it into the credit's home amount as of a date. Used when a
 * refund is voided to keep A/R equal to the credit at every date.
 */
export async function paymentCreditLedger(
  ctx: ServiceContext,
  payment: { id: string; postedEntryId: string | null },
): Promise<Array<{ date: Date; arNet: Decimal }>> {
  const refs = [`payment:${payment.id}`, `refund:${payment.id}`];
  const rows = await ctx.db
    .select({
      date: journalEntries.date,
      net: sql<string>`COALESCE(SUM(COALESCE(CAST(${journalEntryLines.debit} AS NUMERIC), 0) - COALESCE(CAST(${journalEntryLines.credit} AS NUMERIC), 0)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(accounts.subtype, 'accounts_receivable'),
        payment.postedEntryId
          ? sql`(${inArray(journalEntries.sourceRef, refs)} OR ${eq(journalEntries.id, payment.postedEntryId)})`
          : inArray(journalEntries.sourceRef, refs),
      ),
    )
    .groupBy(journalEntries.id, journalEntries.date);
  const reliefs = await ctx.db
    .select({ date: paymentFxReliefs.date, home: paymentFxReliefs.homeAmount })
    .from(paymentFxReliefs)
    .where(and(eq(paymentFxReliefs.companyId, ctx.companyId), eq(paymentFxReliefs.paymentId, payment.id)));
  return [
    ...rows.map((r) => ({ date: r.date, arNet: Money.of(r.net) })),
    ...reliefs.map((r) => ({ date: r.date, arNet: Money.of(r.home) })),
  ];
}

/** Credit (positive home amount) the ledger carries for the payment as of a date. */
export function ledgerCreditAsOf(ledger: Array<{ date: Date; arNet: Decimal }>, asOf: Date): Decimal {
  let net = Money.zero();
  for (const l of ledger) if (l.date.getTime() <= asOf.getTime()) net = net.plus(l.arNet);
  return Money.round2(net.negated());
}

export async function unappliedCustomerPayments(
  ctx: ServiceContext,
  opts: { asOf?: Date; customerId?: string } = {},
): Promise<UnappliedCustomerPayment[]> {
  const conds = [eq(paymentsReceived.companyId, ctx.companyId), isNull(paymentsReceived.voidedAt)];
  if (opts.asOf) conds.push(lte(paymentsReceived.date, opts.asOf));
  if (opts.customerId) conds.push(eq(paymentsReceived.customerId, opts.customerId));
  const rows = await ctx.db
    .select({
      id: paymentsReceived.id,
      customerId: paymentsReceived.customerId,
      date: paymentsReceived.date,
      reference: paymentsReceived.reference,
      unapplied: paymentsReceived.unapplied,
      exchangeRate: paymentsReceived.exchangeRate,
    })
    .from(paymentsReceived)
    .where(and(...conds));

  // Refunds / foreign applies dated after the cutoff: the credit still existed on the cutoff date.
  const unappliedThen = await paymentsUnappliedAsOf(ctx, rows, opts.asOf);

  const out: UnappliedCustomerPayment[] = [];
  for (const r of rows) {
    // `unapplied` is in the payment's currency; A/R was credited at the payment's settlement
    // rate (payments.ts receivePayment), and every later change to the credit moved A/R by the
    // change in its home value at that rate.
    const amount = paymentCreditHome(unappliedThen.get(r.id) ?? Money.zero(), Money.of(r.exchangeRate ?? 1));
    if (!amount.greaterThan(0)) continue;
    out.push({
      paymentId: r.id,
      customerId: r.customerId,
      date: r.date,
      reference: r.reference ?? null,
      amount: toAmountString(amount),
    });
  }
  return out;
}

/** Unapplied payment credit per customer: customerId → positive amount. */
export async function unappliedPaymentsByCustomer(
  ctx: ServiceContext,
  opts: { asOf?: Date } = {},
): Promise<Map<string, string>> {
  const sums = new Map<string, ReturnType<typeof Money.zero>>();
  for (const p of await unappliedCustomerPayments(ctx, opts)) {
    sums.set(p.customerId, (sums.get(p.customerId) ?? Money.zero()).plus(Money.of(p.amount)));
  }
  return new Map([...sums].map(([k, v]) => [k, toAmountString(v)]));
}
