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
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { estimateLines, estimates, invoiceLines, invoices } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError } from './_base';

/** Soft-warning code for billing more than 100% of an estimate line. */
export const PROGRESS_OVERBILL_WARNING = 'PROGRESS_OVERBILL';

export interface OverBilledLine {
  lineId: string;
  description: string;
  estimateAmount: string;
  invoicedToDate: string;
  thisInvoice: string;
  /** Percent of the line billed once this invoice is saved. */
  percentBilled: string;
}

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
  opts: { excludeInvoiceId?: string } = {},
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
        opts.excludeInvoiceId ? ne(invoices.id, opts.excludeInvoiceId) : undefined,
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

/**
 * One estimate line's over-billing (QB: "you are billing more than 100% of this item"), or null
 * when the new total stays within the estimate. `invoicedToDate`/`qtyInvoicedToDate` exclude
 * this invoice; `thisAmount`/`thisQty` are what this invoice bills.
 */
export function overBilledLine(l: {
  lineId: string;
  description: string | null;
  quantity: string;
  amount: string;
  qtyInvoicedToDate: Dec;
  invoicedToDate: Dec;
  thisQty: Dec;
  thisAmount: Dec;
}): OverBilledLine | null {
  const A = Money.of(l.amount);
  const Q = Money.of(l.quantity);
  const newAmt = l.invoicedToDate.plus(l.thisAmount);
  const newQty = l.qtyInvoicedToDate.plus(l.thisQty);
  const overAmt = A.greaterThan(0) ? newAmt.greaterThan(A.plus('0.005')) : false;
  const overQty = newQty.greaterThan(Q.plus('0.00005'));
  if (!overAmt && !overQty) return null;
  const pct = A.greaterThan(0)
    ? Money.mul(Money.div(newAmt, A), 100)
    : Q.greaterThan(0)
      ? Money.mul(Money.div(newQty, Q), 100)
      : Money.zero();
  return {
    lineId: l.lineId,
    description: l.description ?? 'Estimate line',
    estimateAmount: toAmountString(A),
    invoicedToDate: toAmountString(l.invoicedToDate),
    thisInvoice: toAmountString(l.thisAmount),
    percentBilled: pct.toDecimalPlaces(2).toFixed(2),
  };
}

/** The soft over-billing error (HTTP 409 PROGRESS_OVERBILL); resend with allowOverBilling. */
export function overBillingError(over: OverBilledLine[]) {
  const names = over.map((o) => `"${o.description}" (${o.percentBilled}%)`).join(', ');
  return new ServiceError(
    'VALIDATION',
    `This invoice would bill more than 100% of the estimate for ${names}. Save anyway?`,
    { warning: PROGRESS_OVERBILL_WARNING, lines: over },
  );
}

/**
 * Over-billing check for ANY invoice that bills estimate lines (a plain invoice that links
 * them, an edit of a progress invoice, a pending invoice being posted) - the same rule
 * createProgressInvoice applies. Invoiced-to-date leaves out `excludeInvoiceId` (the invoice
 * being edited/posted), so its old lines are not counted twice. Throws the soft
 * PROGRESS_OVERBILL error unless `allowOverBilling`; returns the over-billed lines otherwise.
 */
export async function checkEstimateOverBilling(
  ctx: ServiceContext,
  lines: Array<{ estimateLineId?: string | null; quantity: string | number; amount: string | number }>,
  opts: { excludeInvoiceId?: string; allowOverBilling?: boolean } = {},
): Promise<OverBilledLine[]> {
  const thisBill = new Map<string, { qty: Dec; amount: Dec }>();
  for (const l of lines) {
    if (!l.estimateLineId) continue;
    const cur = thisBill.get(l.estimateLineId) ?? { qty: Money.zero(), amount: Money.zero() };
    cur.qty = cur.qty.plus(Money.of(l.quantity));
    cur.amount = cur.amount.plus(Money.abs(Money.of(l.amount)));
    thisBill.set(l.estimateLineId, cur);
  }
  if (thisBill.size === 0) return [];

  const estLines = await ctx.db
    .select({
      id: estimateLines.id,
      estimateId: estimateLines.estimateId,
      description: estimateLines.description,
      quantity: estimateLines.quantity,
      amount: estimateLines.amount,
    })
    .from(estimateLines)
    .innerJoin(estimates, eq(estimates.id, estimateLines.estimateId))
    .where(and(eq(estimates.companyId, ctx.companyId), inArray(estimateLines.id, [...thisBill.keys()])));

  const over: OverBilledLine[] = [];
  const progressByEstimate = new Map<string, Map<string, EstimateLineProgress>>();
  for (const el of estLines) {
    let progress = progressByEstimate.get(el.estimateId);
    if (!progress) {
      progress = await estimateLineProgress(ctx, el.estimateId, { excludeInvoiceId: opts.excludeInvoiceId });
      progressByEstimate.set(el.estimateId, progress);
    }
    const p = progress.get(el.id);
    const b = thisBill.get(el.id)!;
    const o = overBilledLine({
      lineId: el.id,
      description: el.description,
      quantity: el.quantity,
      amount: el.amount,
      qtyInvoicedToDate: p?.qtyInvoiced ?? Money.zero(),
      invoicedToDate: p?.amountInvoiced ?? Money.zero(),
      thisQty: b.qty,
      thisAmount: Money.round2(b.amount),
    });
    if (o) over.push(o);
  }
  if (over.length > 0 && !opts.allowOverBilling) throw overBillingError(over);
  return over;
}

/**
 * Refuse billing a rejected estimate (QB: a declined estimate is not invoiced). Used where the
 * stored links of a pending invoice start counting (posting it); createInvoice / updateInvoice
 * check the same rule while validating their links.
 */
export async function assertEstimatesNotRejected(
  ctx: ServiceContext,
  lines: Array<{ estimateLineId?: string | null }>,
) {
  const ids = [...new Set(lines.map((l) => l.estimateLineId).filter(Boolean) as string[])];
  if (ids.length === 0) return;
  const rows = await ctx.db
    .selectDistinct({ estimateNumber: estimates.estimateNumber })
    .from(estimateLines)
    .innerJoin(estimates, eq(estimates.id, estimateLines.estimateId))
    .where(
      and(eq(estimates.companyId, ctx.companyId), inArray(estimateLines.id, ids), eq(estimates.status, 'rejected')),
    );
  if (rows.length > 0) {
    throw new ServiceError(
      'CONFLICT',
      `This invoice bills estimate ${rows.map((r) => r.estimateNumber).join(', ')}, which the customer rejected. Mark the estimate accepted before invoicing it.`,
    );
  }
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
  if (est.status === 'rejected') {
    // A rejected estimate keeps its status (invoices cannot bill it; this only guards legacy links).
  } else if (allBilled && anyBilled) {
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
