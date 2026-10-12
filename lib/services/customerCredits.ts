/**
 * Unapplied customer payments ("credits" in QuickBooks Receive Payments).
 *
 * receivePayment credits A/R for the FULL amount received, including any part not applied to an
 * invoice (an overpayment, or a payment against a General Journal charge, which has no invoice to
 * apply to). That unapplied part therefore belongs in the customer subledger as a credit, or A/R
 * aging / customer balances would stop matching the A/R account in the GL.
 *
 * As-of reconstruction mirrors arAging's invoice side (applications count as of their payment's
 * date): credit(as of cutoff) = current `unapplied` + refunds of that payment dated after the
 * cutoff (a refund debits A/R on its own date). Voided payments are excluded entirely — their
 * journal entry is voided, so they leave the GL at every date.
 */
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { journalEntries, journalEntryLines, paymentsReceived } from '@/lib/db/schema';
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

  // Refunds dated after the cutoff: the credit still existed on the cutoff date.
  const laterRefunds = new Map<string, string>();
  if (opts.asOf) {
    const refundRows = await ctx.db
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
          gt(journalEntries.date, opts.asOf),
        ),
      )
      .groupBy(journalEntries.sourceRef);
    for (const r of refundRows) {
      if (r.sourceRef) laterRefunds.set(r.sourceRef.slice('refund:'.length), r.amount);
    }
  }

  const out: UnappliedCustomerPayment[] = [];
  for (const r of rows) {
    // `unapplied` is in the payment's currency; A/R was credited at the payment's settlement
    // rate (payments.ts receivePayment), and refunds debit A/R at that same rate (base amounts).
    const unappliedBase = Money.round2(Money.mul(Money.of(r.unapplied), Money.of(r.exchangeRate ?? 1)));
    const amount = unappliedBase.plus(Money.of(laterRefunds.get(r.id) ?? '0'));
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
