/**
 * Estimates (Quotes) service.
 *
 * Estimates represent a price quote to a customer. They do NOT post to the GL —
 * they are pre-sales documents only. An estimate can be:
 *   - draft     → initial state
 *   - accepted  → customer agreed to the quote
 *   - rejected  → customer declined
 *   - closed    → converted into an invoice (convertedInvoiceId is set)
 *
 * `convertToInvoice` is the only mutation that touches the GL, and it does so
 * by delegating entirely to `createInvoice` from the invoices service.
 */
import { and, eq, sql } from 'drizzle-orm';
import { Money, allocate, toAmountString } from '@/lib/money';
import { estimates, estimateLines, customers, taxRates } from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { createInvoice } from './invoices';
import { type AppliedPricing, resolveLinePricing } from './pricing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EstimateLineInput {
  itemId?: string | null;
  description?: string | null;
  quantity: string | number;
  /** Unit price; omit on item lines to price server-side (lib/services/pricing.ts). */
  rate?: string | number | null;
  /** Defaults to true. */
  taxable?: boolean;
}

export interface CreateEstimateInput {
  customerId: string;
  date: Date;
  expirationDate?: Date | null;
  lines: EstimateLineInput[];
  /**
   * UUID of a taxRates row. When set, sales tax is computed on taxable lines
   * using the SAME math as invoices (taxableSubtotal * rate) so the quoted
   * total matches the eventual taxed invoice. The estimates table has no
   * taxRateId column, so the rate is resolved at creation time and the
   * resulting dollar amount is persisted in estimates.taxAmount.
   */
  taxRateId?: string | null;
  memo?: string | null;
  /** wave2 sales (C7): queue for batch printing / emailing. */
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
}

export type EstimateStatus = 'draft' | 'accepted' | 'rejected' | 'closed';

/** Progress-invoicing request: bill a % of the remaining balance OR explicit per-line amounts. */
export interface ProgressInvoiceInput {
  /** Percentage (0–100] of the REMAINING (un-invoiced) estimate balance to bill. */
  percent?: string | number | null;
  /** Explicit dollar amounts per estimate line (estimateLines.id). */
  lineAmounts?: Array<{ lineId: string; amount: string | number }> | null;
  /** Invoice date; defaults to now. */
  date?: Date | null;
  /** wave2 sales (C2): save even if the invoice puts the customer over their credit limit. */
  overrideCreditLimit?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function nextEstimateNumber(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${estimates.estimateNumber}), 0)` })
    .from(estimates)
    .where(eq(estimates.companyId, ctx.companyId));
  return (row?.max ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// createEstimate
// ---------------------------------------------------------------------------

/** Validate an estimate input and compute its lines/totals (read-only; shared by create + edit). */
async function prepareEstimate(ctx: ServiceContext, input: CreateEstimateInput) {
  if (!input.lines || input.lines.length === 0) {
    throw validation('An estimate must have at least one line.');
  }

  // Verify customer belongs to this company.
  const [customer] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!customer) throw notFound('Customer');

  // Resolve the tax rate (if any) — the same math invoices use, so the quoted
  // total matches the eventual taxed invoice.
  let taxRateDecimal = Money.zero();
  if (input.taxRateId) {
    const [taxRow] = await ctx.db
      .select({ rate: taxRates.rate })
      .from(taxRates)
      .where(and(eq(taxRates.companyId, ctx.companyId), eq(taxRates.id, input.taxRateId)));
    if (!taxRow) throw notFound('Tax rate');
    taxRateDecimal = Money.of(taxRow.rate);
  }

  // Compute per-line amounts.
  type ComputedLine = {
    itemId: string | null;
    description: string | null;
    quantity: string;
    rate: string;
    amount: string;
    taxable: boolean;
    lineOrder: number;
    pricing: AppliedPricing | null;
  };

  // Advanced pricing: fill omitted item rates and record rule/level provenance.
  const pricedLines = await resolveLinePricing(
    ctx,
    { customerId: input.customerId, date: input.date },
    input.lines,
  );

  let subtotal = Money.zero();
  let taxableSubtotal = Money.zero();
  const computedLines: ComputedLine[] = [];

  for (let i = 0; i < pricedLines.length; i++) {
    const l = pricedLines[i];
    // Quantity and rate are stored at 4 decimals (the column scale); compute the
    // amount from the stored values so a later rebuild (convert, copy) re-prices exactly.
    const qty = Money.of(l.quantity).toDecimalPlaces(4);
    const rate = Money.of(l.rate).toDecimalPlaces(4);
    if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
    if (rate.lessThan(0)) throw validation(`Line ${i + 1}: rate cannot be negative.`);

    const amount = Money.round2(Money.mul(qty, rate));
    subtotal = subtotal.plus(amount);
    if (l.taxable !== false) taxableSubtotal = taxableSubtotal.plus(amount);

    computedLines.push({
      itemId: l.itemId ?? null,
      description: l.description ?? null,
      quantity: qty.toFixed(4),
      rate: rate.toFixed(4),
      amount: toAmountString(amount),
      taxable: l.taxable !== false,
      lineOrder: i,
      pricing: l.pricing,
    });
  }

  // Sales tax — identical to the invoice computation: taxableSubtotal * rate, 2dp.
  const taxAmount = Money.round2(Money.mul(taxableSubtotal, taxRateDecimal));
  const total = Money.round2(subtotal.plus(taxAmount));

  return { computedLines, subtotal, taxAmount, total };
}

export async function createEstimate(ctx: ServiceContext, input: CreateEstimateInput) {
  const { computedLines, subtotal, taxAmount, total } = await prepareEstimate(ctx, input);

  return inTransaction(ctx, async (tx) => {
    const estimateNumber = await nextEstimateNumber(tx);

    const [estimate] = await tx.db
      .insert(estimates)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        estimateNumber,
        date: input.date,
        expirationDate: input.expirationDate ?? null,
        status: 'draft',
        subtotal: toAmountString(subtotal),
        taxAmount: toAmountString(taxAmount),
        total: toAmountString(total),
        memo: input.memo ?? null,
        taxRateId: input.taxRateId ?? null,
        toBePrinted: input.toBePrinted ?? false,
        toBeEmailed: input.toBeEmailed ?? false,
      })
      .returning();

    await tx.db.insert(estimateLines).values(
      computedLines.map((cl) => ({
        estimateId: estimate.id,
        itemId: cl.itemId,
        description: cl.description,
        quantity: cl.quantity,
        rate: cl.rate,
        amount: cl.amount,
        taxable: cl.taxable,
        lineOrder: cl.lineOrder,
        pricing: cl.pricing as Record<string, unknown> | null,
      })),
    );

    await writeAudit(tx, {
      action: 'create',
      entityType: 'estimate',
      entityId: estimate.id,
      newValues: { estimateNumber, customerId: input.customerId, total: toAmountString(total) },
    });

    return { ...estimate, lines: computedLines };
  });
}

// ---------------------------------------------------------------------------
// listEstimates
// ---------------------------------------------------------------------------

export async function listEstimates(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(estimates)
    .where(eq(estimates.companyId, ctx.companyId))
    .orderBy(estimates.estimateNumber);
}

// ---------------------------------------------------------------------------
// getEstimate (with lines)
// ---------------------------------------------------------------------------

export async function getEstimate(ctx: ServiceContext, id: string) {
  const [estimate] = await ctx.db
    .select()
    .from(estimates)
    .where(and(eq(estimates.companyId, ctx.companyId), eq(estimates.id, id)));
  if (!estimate) throw notFound('Estimate');

  const lines = await ctx.db
    .select()
    .from(estimateLines)
    .where(eq(estimateLines.estimateId, id))
    .orderBy(estimateLines.lineOrder);

  return { ...estimate, lines };
}

// ---------------------------------------------------------------------------
// updateEstimateStatus
// ---------------------------------------------------------------------------

export async function updateEstimateStatus(
  ctx: ServiceContext,
  id: string,
  status: EstimateStatus,
) {
  const [estimate] = await ctx.db
    .select()
    .from(estimates)
    .where(and(eq(estimates.companyId, ctx.companyId), eq(estimates.id, id)));
  if (!estimate) throw notFound('Estimate');

  if (estimate.status === 'closed') {
    throw new ServiceError('CONFLICT', 'Cannot change the status of a closed (converted) estimate.');
  }
  if (estimate.status === 'partial') {
    throw new ServiceError(
      'CONFLICT',
      'This estimate has progress invoices against it. Finish progress invoicing instead of changing its status.',
    );
  }

  const allowed: EstimateStatus[] = ['draft', 'accepted', 'rejected'];
  if (!allowed.includes(status)) {
    throw validation(`Invalid status "${status}". Allowed: ${allowed.join(', ')}.`);
  }

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(estimates)
      .set({ status, updatedAt: new Date() })
      .where(eq(estimates.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'estimate',
      entityId: id,
      oldValues: { status: estimate.status },
      newValues: { status },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// convertToInvoice
// ---------------------------------------------------------------------------

/**
 * Convert an estimate into an invoice.
 *
 * - Loads the estimate + its lines.
 * - Calls createInvoice (which posts the A/R journal entry).
 * - Stamps estimates.convertedInvoiceId and sets status to 'closed'.
 * - Returns the new invoice.
 */
export async function convertToInvoice(
  ctx: ServiceContext,
  estimateId: string,
  opts?: { overrideCreditLimit?: boolean },
) {
  // Invoice creation and estimate stamping must commit or roll back TOGETHER —
  // otherwise a failure after createInvoice leaves a posted GL invoice with the
  // estimate still open and convertible again (duplicate invoice + revenue).
  // Re-loading the estimate inside the transaction also closes the
  // read-then-write race between concurrent converts.
  return inTransaction(ctx, async (tx) => {
    const estimate = await getEstimate(tx, estimateId);

    if (estimate.status === 'closed' || estimate.convertedInvoiceId) {
      throw new ServiceError('CONFLICT', 'Estimate has already been converted to an invoice.');
    }
    if (estimate.status === 'rejected') {
      throw new ServiceError('CONFLICT', 'Cannot convert a rejected estimate to an invoice.');
    }
    if (Money.gt(estimate.amountInvoiced ?? '0', 0)) {
      throw new ServiceError(
        'CONFLICT',
        'This estimate has progress invoices against it. Use progress invoicing to bill the remainder.',
      );
    }

    // Map estimate lines to invoice line inputs.
    const invoiceLines = estimate.lines.map((l) => ({
      itemId: l.itemId ?? null,
      description: l.description ?? null,
      quantity: l.quantity,
      rate: l.rate,
      taxable: l.taxable,
      pricing: { origin: 'estimate' },
    }));

    // createInvoice posts the GL entry; its internal inTransaction nests as a
    // savepoint on this transaction (same pattern as timeTracking.billTimeToInvoice).
    const invoice = await createInvoice(tx, {
      customerId: estimate.customerId,
      date: new Date(),
      lines: invoiceLines,
      memo: estimate.memo ?? undefined,
      // wave2 sales: carry the quoted tax rate (stored since 0027) so the invoice total matches.
      taxRateId: estimate.taxRateId ?? null,
      overrideCreditLimit: opts?.overrideCreditLimit,
    });

    // Stamp the estimate as closed with the invoice reference. A full
    // conversion bills 100%, so amountInvoiced is brought up to the total.
    await tx.db
      .update(estimates)
      .set({
        status: 'closed',
        convertedInvoiceId: invoice.id,
        amountInvoiced: estimate.total,
        updatedAt: new Date(),
      })
      .where(eq(estimates.id, estimateId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'estimate',
      entityId: estimateId,
      oldValues: { status: estimate.status },
      newValues: { status: 'closed', convertedInvoiceId: invoice.id },
    });

    return invoice;
  });
}

// ---------------------------------------------------------------------------
// createProgressInvoice (QB Progress Invoicing)
// ---------------------------------------------------------------------------

/**
 * Bill PART of an estimate (QB Desktop Progress Invoicing).
 *
 * Two modes:
 *   { percent }      — bill a percentage (0–100] of the REMAINING balance,
 *                      allocated across estimate lines proportionally to their
 *                      amounts (penny-exact via allocate()).
 *   { lineAmounts }  — bill explicit dollar amounts against specific estimate
 *                      lines (per-line progress billing).
 *
 * Creates a partial invoice linked to the estimate (memo carries the estimate
 * number), accumulates estimates.amount_invoiced (guarded ≤ total), and keeps
 * the estimate open: status becomes 'partial' until the full total has been
 * invoiced, at which point it closes and convertedInvoiceId points at the
 * final progress invoice.
 */
export async function createProgressInvoice(
  ctx: ServiceContext,
  estimateId: string,
  input: ProgressInvoiceInput,
) {
  // Everything (estimate re-read, invoice creation, amount accumulation) runs
  // in ONE transaction so concurrent progress bills cannot overshoot the total.
  return inTransaction(ctx, async (tx) => {
    const estimate = await getEstimate(tx, estimateId);

    if (estimate.status === 'rejected') {
      throw new ServiceError('CONFLICT', 'Cannot invoice a rejected estimate.');
    }
    if (estimate.status === 'closed') {
      throw new ServiceError('CONFLICT', 'Estimate is closed (fully invoiced or converted).');
    }

    const total = Money.of(estimate.total);
    const alreadyInvoiced = Money.of(estimate.amountInvoiced ?? '0');
    const remaining = Money.round2(total.minus(alreadyInvoiced));
    if (remaining.lessThanOrEqualTo(0)) {
      throw new ServiceError('CONFLICT', 'Estimate has already been fully invoiced.');
    }

    // Resolve per-line billing amounts (transaction-currency dollars).
    type BillLine = { itemId: string | null; description: string; amount: ReturnType<typeof Money.zero> };
    const billLines: BillLine[] = [];
    let progressLabel: string;

    if (input.percent != null) {
      const pct = Money.of(input.percent);
      if (pct.lessThanOrEqualTo(0) || pct.greaterThan(100)) {
        throw validation('percent must be greater than 0 and at most 100.');
      }
      const requested = Money.round2(Money.mul(remaining, Money.div(pct, 100)));
      if (requested.lessThanOrEqualTo(0)) {
        throw validation('Requested progress amount is zero — nothing to invoice.');
      }
      // Allocate the requested amount across estimate lines proportionally to
      // their amounts (largest-remainder, so the pennies sum exactly).
      const weights = estimate.lines.map((l) => Money.of(l.amount));
      const allocs = allocate(requested, weights);
      estimate.lines.forEach((l, i) => {
        if (allocs[i].greaterThan(0)) {
          billLines.push({
            itemId: l.itemId ?? null,
            description: `${l.description ?? 'Estimate line'} — progress billing (${toAmountString(pct)}% of remaining)`,
            amount: allocs[i],
          });
        }
      });
      progressLabel = `${toAmountString(pct)}% of remaining`;
    } else if (input.lineAmounts && input.lineAmounts.length > 0) {
      const lineById = new Map(estimate.lines.map((l) => [l.id, l]));
      for (const la of input.lineAmounts) {
        const line = lineById.get(la.lineId);
        if (!line) throw notFound(`Estimate line ${la.lineId}`);
        const amount = Money.round2(la.amount);
        if (amount.lessThan(0)) throw validation('Line amounts cannot be negative.');
        if (amount.isZero()) continue;
        billLines.push({
          itemId: line.itemId ?? null,
          description: `${line.description ?? 'Estimate line'} — progress billing`,
          amount,
        });
      }
      progressLabel = 'selected line amounts';
    } else {
      throw validation('Provide either { percent } or { lineAmounts } to create a progress invoice.');
    }

    const billedTotal = billLines.reduce((sum, l) => sum.plus(l.amount), Money.zero());
    if (billedTotal.lessThanOrEqualTo(0)) {
      throw validation('Progress invoice amount must be greater than zero.');
    }

    // Guard: cumulative billing can never exceed the estimate total.
    const newInvoiced = Money.round2(alreadyInvoiced.plus(billedTotal));
    if (newInvoiced.greaterThan(total)) {
      throw validation(
        `Progress amount ${toAmountString(billedTotal)} exceeds the remaining balance ${toAmountString(remaining)} on this estimate.`,
      );
    }

    // Create the partial invoice. Lines are dollar amounts (quantity 1) carved
    // out of the estimate's quoted total, so they are not re-taxed (the quoted
    // total already includes any estimate tax).
    const invoice = await createInvoice(tx, {
      customerId: estimate.customerId,
      date: input.date ?? new Date(),
      memo: `Progress billing (${progressLabel}) for Estimate #${estimate.estimateNumber}`,
      overrideCreditLimit: input.overrideCreditLimit,
      lines: billLines.map((l) => ({
        itemId: l.itemId,
        description: l.description,
        quantity: 1,
        rate: toAmountString(l.amount),
        taxable: false,
      })),
    });

    // Accumulate amount_invoiced; close the estimate once fully billed.
    const fullyInvoiced = !newInvoiced.lessThan(total);
    const [updatedEstimate] = await tx.db
      .update(estimates)
      .set({
        amountInvoiced: toAmountString(newInvoiced),
        status: fullyInvoiced ? 'closed' : 'partial',
        convertedInvoiceId: fullyInvoiced ? invoice.id : estimate.convertedInvoiceId,
        updatedAt: new Date(),
      })
      .where(eq(estimates.id, estimateId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'estimate',
      entityId: estimateId,
      oldValues: { status: estimate.status, amountInvoiced: toAmountString(alreadyInvoiced) },
      newValues: {
        status: updatedEstimate.status,
        amountInvoiced: toAmountString(newInvoiced),
        progressInvoiceId: invoice.id,
        progressAmount: toAmountString(billedTotal),
      },
    });

    return { invoice, estimate: updatedEstimate };
  });
}

// ---------------------------------------------------------------------------
// updateEstimate (wave2 sales, C1 — edit a saved estimate)
// ---------------------------------------------------------------------------

/**
 * Edit a saved estimate: customer, dates, lines, tax and memo. Estimates never post to the GL,
 * so this is a plain replace of the lines + header (estimateNumber/createdAt preserved), with
 * old/new values in the audit trail. Refused once the estimate has been invoiced (closed or
 * progress-billed) — the invoices carry its amounts; edit those instead.
 */
export async function updateEstimate(ctx: ServiceContext, id: string, input: CreateEstimateInput) {
  const existing = await getEstimate(ctx, id);
  if (existing.status === 'closed' || existing.convertedInvoiceId) {
    throw new ServiceError(
      'CONFLICT',
      'This estimate has already been turned into an invoice, so it can no longer be changed. Edit the invoice instead.',
    );
  }
  if (Money.gt(existing.amountInvoiced ?? '0', 0) || existing.status === 'partial') {
    throw new ServiceError(
      'CONFLICT',
      'This estimate has progress invoices against it, so its lines can no longer be changed.',
    );
  }
  const { computedLines, subtotal, taxAmount, total } = await prepareEstimate(ctx, input);

  return inTransaction(ctx, async (tx) => {
    const [current] = await tx.db
      .select()
      .from(estimates)
      .where(and(eq(estimates.companyId, tx.companyId), eq(estimates.id, id)));
    if (!current || current.status === 'closed' || current.status === 'partial') {
      throw new ServiceError('CONFLICT', 'This estimate changed while you were editing it — reload and try again.');
    }
    await tx.db.delete(estimateLines).where(eq(estimateLines.estimateId, id));
    await tx.db.insert(estimateLines).values(
      computedLines.map((cl) => ({
        estimateId: id,
        itemId: cl.itemId,
        description: cl.description,
        quantity: cl.quantity,
        rate: cl.rate,
        amount: cl.amount,
        taxable: cl.taxable,
        lineOrder: cl.lineOrder,
        pricing: cl.pricing as Record<string, unknown> | null,
      })),
    );
    const [updated] = await tx.db
      .update(estimates)
      .set({
        customerId: input.customerId,
        date: input.date,
        expirationDate: input.expirationDate ?? null,
        subtotal: toAmountString(subtotal),
        taxAmount: toAmountString(taxAmount),
        total: toAmountString(total),
        memo: input.memo ?? null,
        taxRateId: input.taxRateId ?? null,
        toBePrinted: input.toBePrinted ?? current.toBePrinted,
        toBeEmailed: input.toBeEmailed ?? current.toBeEmailed,
        updatedAt: new Date(),
      })
      .where(eq(estimates.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'estimate',
      entityId: id,
      oldValues: {
        customerId: existing.customerId,
        date: existing.date,
        expirationDate: existing.expirationDate,
        total: existing.total,
        memo: existing.memo,
        lines: existing.lines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount })),
      },
      newValues: {
        customerId: input.customerId,
        date: input.date,
        expirationDate: input.expirationDate ?? null,
        total: toAmountString(total),
        memo: input.memo ?? null,
        lines: computedLines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount })),
      },
    });
    return { ...updated, lines: computedLines };
  });
}
