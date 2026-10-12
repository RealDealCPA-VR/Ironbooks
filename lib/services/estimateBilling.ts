/**
 * Estimate billing progress (QB Desktop Progress Invoicing) — what has been invoiced so far,
 * per estimate line and for the whole estimate.
 *
 * Invoiced-to-date is never a running counter that can drift: it is computed from the invoice
 * lines that point at an estimate line (invoice_lines.estimate_line_id) on posted invoices that
 * are not void or pending, plus the "prior" amounts kept for estimates billed before per-line
 * links existed (migration 0036 backfill). Voiding or editing a progress invoice therefore puts
 * the amount back on the estimate automatically; `refreshEstimateBilling` re-stamps the
 * estimate header (amount invoiced, status, closing invoice).
 *
 * Kept separate from estimates.ts so invoices.ts can call it without a circular import.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { estimateLines, estimates, invoiceLines, invoices } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';

type Dec = ReturnType<typeof Money.zero>;

export interface EstimateLineProgress {
  lineId: string;
  /** Units invoiced so far (prior + linked invoice lines). */
  qtyInvoiced: Dec;
  /** Dollars invoiced so far, before sales tax. */
  amountInvoiced: Dec;
}

/** Invoice statuses that do not bill anything (a pending invoice posts nothing; a void one is undone). */
const NOT_BILLED = ['void', 'draft'] as const;

/** Per-line invoiced-to-date for one estimate. */
export async function estimateLineProgress(
  ctx: ServiceContext,
  estimateId: string,
): Promise<Map<string, EstimateLineProgress>> {
  const lines = await ctx.db
    .select({
      id: estimateLines.id,
      priorQty: estimateLines.priorQtyInvoiced,
      priorAmount: estimateLines.priorAmountInvoiced,
    })
    .from(estimateLines)
    .where(eq(estimateLines.estimateId, estimateId));
  const out = new Map<string, EstimateLineProgress>();
  for (const l of lines) {
    out.set(l.id, {
      lineId: l.id,
      qtyInvoiced: Money.of(l.priorQty ?? '0'),
      amountInvoiced: Money.of(l.priorAmount ?? '0'),
    });
  }
  if (lines.length === 0) return out;

  const linked = await ctx.db
    .select({
      estimateLineId: invoiceLines.estimateLineId,
      qty: sql<string>`COALESCE(SUM(CAST(${invoiceLines.quantity} AS NUMERIC)), 0)`,
      amount: sql<string>`COALESCE(SUM(ABS(CAST(${invoiceLines.amount} AS NUMERIC))), 0)`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        inArray(invoiceLines.estimateLineId, [...out.keys()]),
        notInArray(invoices.status, [...NOT_BILLED]),
      ),
    )
    .groupBy(invoiceLines.estimateLineId);
  for (const r of linked) {
    const p = out.get(r.estimateLineId!);
    if (!p) continue;
    p.qtyInvoiced = p.qtyInvoiced.plus(Money.of(r.qty));
    p.amountInvoiced = p.amountInvoiced.plus(Money.of(r.amount));
  }
  return out;
}

/** Estimates billed by the given invoice (through its linked lines). */
export async function estimatesBilledByInvoice(ctx: ServiceContext, invoiceId: string): Promise<string[]> {
  const rows = await ctx.db
    .selectDistinct({ estimateId: estimateLines.estimateId })
    .from(invoiceLines)
    .innerJoin(estimateLines, eq(estimateLines.id, invoiceLines.estimateLineId))
    .where(eq(invoiceLines.invoiceId, invoiceId));
  return rows.map((r) => r.estimateId);
}

/**
 * Recompute an estimate's billing header from its lines: amount invoiced (the totals, tax
 * included, of the posted invoices that bill it, plus any prior amount), status ('partial'
 * while some but not all lines are billed, 'closed' once every line is fully billed — QB marks
 * the estimate inactive then) and convertedInvoiceId (the invoice that finished it).
 * Called after a progress invoice / conversion is saved and after one is voided or edited.
 */
export async function refreshEstimateBilling(
  ctx: ServiceContext,
  estimateId: string,
  opts: { closingInvoiceId?: string | null } = {},
) {
  const [est] = await ctx.db
    .select()
    .from(estimates)
    .where(and(eq(estimates.companyId, ctx.companyId), eq(estimates.id, estimateId)));
  if (!est) return null;
  const lines = await ctx.db
    .select({ id: estimateLines.id, quantity: estimateLines.quantity, amount: estimateLines.amount })
    .from(estimateLines)
    .where(eq(estimateLines.estimateId, estimateId));
  const progress = await estimateLineProgress(ctx, estimateId);

  // Totals of the posted invoices that bill this estimate (tax included, as the customer sees it).
  const [billed] = await ctx.db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(${invoices.total} AS NUMERIC)), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        notInArray(invoices.status, [...NOT_BILLED]),
        sql`${invoices.id} IN (
          SELECT ${invoiceLines.invoiceId} FROM ${invoiceLines}
          JOIN ${estimateLines} ON ${estimateLines.id} = ${invoiceLines.estimateLineId}
          WHERE ${estimateLines.estimateId} = ${estimateId}
        )`,
      ),
    );
  const amountInvoiced = Money.round2(Money.of(est.priorAmountInvoiced ?? '0').plus(Money.of(billed?.total ?? '0')));

  let anyBilled = Money.gt(est.priorAmountInvoiced ?? '0', 0);
  let allBilled = lines.length > 0;
  for (const l of lines) {
    const p = progress.get(l.id);
    const amt = p?.amountInvoiced ?? Money.zero();
    const qty = p?.qtyInvoiced ?? Money.zero();
    if (amt.greaterThan(0) || qty.greaterThan(0)) anyBilled = true;
    const lineAmount = Money.of(l.amount);
    const done = lineAmount.greaterThan(0)
      ? !amt.lessThan(lineAmount)
      : !qty.lessThan(Money.of(l.quantity));
    if (!done) allBilled = false;
  }

  let status = est.status;
  let convertedInvoiceId = est.convertedInvoiceId;
  if (allBilled && anyBilled) {
    status = 'closed';
    convertedInvoiceId = opts.closingInvoiceId ?? est.convertedInvoiceId;
    if (!convertedInvoiceId) {
      // Find the latest posted invoice that bills it (e.g. after re-posting an edit).
      const [last] = await ctx.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.companyId, ctx.companyId),
            notInArray(invoices.status, [...NOT_BILLED]),
            sql`${invoices.id} IN (
              SELECT ${invoiceLines.invoiceId} FROM ${invoiceLines}
              JOIN ${estimateLines} ON ${estimateLines.id} = ${invoiceLines.estimateLineId}
              WHERE ${estimateLines.estimateId} = ${estimateId}
            )`,
          ),
        )
        .orderBy(sql`${invoices.createdAt} DESC`)
        .limit(1);
      convertedInvoiceId = last?.id ?? null;
    }
  } else if (anyBilled) {
    status = 'partial';
    convertedInvoiceId = null;
  } else if (est.status === 'partial' || est.status === 'closed') {
    // Every invoice that billed it was voided: the estimate is open again (accepted).
    status = 'accepted';
    convertedInvoiceId = null;
  }

  const [updated] = await ctx.db
    .update(estimates)
    .set({ amountInvoiced: toAmountString(amountInvoiced), status, convertedInvoiceId, updatedAt: new Date() })
    .where(eq(estimates.id, estimateId))
    .returning();
  return updated;
}

/** Re-stamp every estimate the given invoice bills (after a void or edit of that invoice). */
export async function refreshEstimatesForInvoice(ctx: ServiceContext, invoiceId: string) {
  for (const estimateId of await estimatesBilledByInvoice(ctx, invoiceId)) {
    await refreshEstimateBilling(ctx, estimateId);
  }
}
