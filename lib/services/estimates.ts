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
import { and, eq, inArray } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import { estimates, estimateLines, customers, taxRates, classes, items } from '@/lib/db/schema';
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
import { allocateDocNumber, docRef } from './docNumbers';
import { estimateLineProgress, refreshEstimateBilling } from './estimateBilling';

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
  /** Class for this line; carried onto the invoice lines that bill it. */
  classId?: string | null;
}

export interface CreateEstimateInput {
  /**
   * Document number typed by the user (alphanumeric, e.g. "INV-1001"). Blank = the next number
   * (QB: last number used with its trailing digits + 1). See lib/services/docNumbers.ts.
   */
  refNumber?: string | null;
  /** The user confirmed the "this number is already used" warning. */
  allowDuplicateNumber?: boolean | null;
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

/** One estimate line in a "selected items / different percentage of each item" progress bill. */
export interface ProgressLineInput {
  lineId: string;
  /** Percentage of this line's estimate quantity and amount to bill now. */
  percent?: string | number | null;
  /** Units to bill now (amount = units × the estimate rate). */
  quantity?: string | number | null;
  /** Dollars to bill now, before sales tax (units = amount ÷ the estimate rate). */
  amount?: string | number | null;
}

/**
 * Progress-invoicing request — the three QB Desktop choices:
 *   { percent }  "a percentage of the entire estimate" — every line billed at that % of its
 *                estimate quantity and amount (100 = the entire estimate);
 *   { remaining: true }  everything not billed yet on every line;
 *   { lines }    "selected items or different percentages of each item" — per line, a percent,
 *                a quantity or an amount.
 * Lines keep the estimate's item, rate, taxability and class; sales tax is computed on the
 * invoice the normal way (never billed as income).
 */
export interface ProgressInvoiceInput {
  /** Percentage (0–100] of the ENTIRE estimate to bill on every line. */
  percent?: string | number | null;
  /** Bill whatever has not been billed yet on every line. */
  remaining?: boolean | null;
  /** Per-line billing (percent, quantity or amount per estimate line). */
  lines?: ProgressLineInput[] | null;
  /** Older per-line dollar form; same as `lines` with `amount`. */
  lineAmounts?: Array<{ lineId: string; amount: string | number }> | null;
  /** Invoice date; defaults to now. */
  date?: Date | null;
  /** wave2 sales (C2): save even if the invoice puts the customer over their credit limit. */
  overrideCreditLimit?: boolean;
  /**
   * QB warns before billing more than 100% of an estimate line and lets you go ahead. Without
   * this flag such a request is refused with a VALIDATION error whose details carry
   * `{ warning: 'PROGRESS_OVERBILL', lines }`; resend with `allowOverBilling: true` to save.
   */
  allowOverBilling?: boolean;
}

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  // Classes on lines must belong to this company.
  const classIds = [...new Set(input.lines.map((l) => l.classId).filter((x): x is string => !!x))];
  if (classIds.length > 0) {
    const rows = await ctx.db
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.companyId, ctx.companyId), inArray(classes.id, classIds)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of classIds) if (!found.has(id)) throw notFound(`Class ${id}`);
  }

  // Compute per-line amounts.
  type ComputedLine = {
    itemId: string | null;
    description: string | null;
    quantity: string;
    rate: string;
    amount: string;
    taxable: boolean;
    classId: string | null;
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
      classId: l.classId ?? null,
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
    const { refNumber, number: estimateNumber } = await allocateDocNumber(tx, 'estimate', input.refNumber, {
      allowDuplicate: input.allowDuplicateNumber === true,
    });

    const [estimate] = await tx.db
      .insert(estimates)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        estimateNumber,
        refNumber,
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
        classId: cl.classId,
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

  const rows = await ctx.db
    .select()
    .from(estimateLines)
    .where(eq(estimateLines.estimateId, id))
    .orderBy(estimateLines.lineOrder);

  // Invoiced-to-date per line (progress invoicing): units, dollars before tax, and percent.
  const progress = await estimateLineProgress(ctx, id);
  const lines = rows.map((l) => {
    const p = progress.get(l.id);
    const qtyInvoiced = p?.qtyInvoiced ?? Money.zero();
    const amountInvoiced = p?.amountInvoiced ?? Money.zero();
    const amount = Money.of(l.amount);
    const qty = Money.of(l.quantity);
    const pct = amount.greaterThan(0)
      ? Money.mul(Money.div(amountInvoiced, amount), 100)
      : qty.greaterThan(0)
        ? Money.mul(Money.div(qtyInvoiced, qty), 100)
        : Money.zero();
    return {
      ...l,
      qtyInvoiced: qtyInvoiced.toFixed(4),
      amountInvoiced: toAmountString(amountInvoiced),
      percentInvoiced: pct.toDecimalPlaces(2).toFixed(2),
    };
  });

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
 * - Calls createInvoice (which posts the A/R journal entry); every invoice line is linked to
 *   the estimate line it bills.
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
    if (
      Money.gt(estimate.amountInvoiced ?? '0', 0) ||
      estimate.lines.some((l) => Money.gt(l.amountInvoiced, 0) || Money.gt(l.qtyInvoiced, 0))
    ) {
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
      classId: l.classId ?? null,
      pricing: { origin: 'estimate' },
      estimateLineId: l.id,
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

    // Stamp the estimate as closed with the invoice reference (a full conversion bills every
    // line in full, so amountInvoiced becomes the invoice total).
    await refreshEstimateBilling(tx, estimateId, { closingInvoiceId: invoice.id });
    await tx.db
      .update(estimates)
      .set({ status: 'closed', convertedInvoiceId: invoice.id, updatedAt: new Date() })
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

type Dec = ReturnType<typeof Money.zero>;
type EstimateLineRow = Awaited<ReturnType<typeof getEstimate>>['lines'][number];

/** Quantity and amount for billing `pct` % of one estimate line (QB: quantity = estimate qty × %). */
function billByPercent(line: EstimateLineRow, pct: Dec): { qty: Dec; amount: Dec } {
  const Q = Money.of(line.quantity);
  const A = Money.of(line.amount);
  const qty = Money.mul(Q, Money.div(pct, 100)).toDecimalPlaces(4);
  let amount = Money.round2(Money.mul(A, Money.div(pct, 100)));
  // Finishing the line: bill exactly what is left, so the pennies add up to the estimate.
  if (Money.of(line.qtyInvoiced).plus(qty).equals(Q)) {
    const left = Money.round2(A.minus(Money.of(line.amountInvoiced)));
    if (left.greaterThanOrEqualTo(0) && Money.abs(left.minus(amount)).lessThanOrEqualTo('0.05')) amount = left;
  }
  return { qty, amount };
}

/**
 * Bill PART of an estimate (QB Desktop Progress Invoicing).
 *
 * The invoice gets the estimate's own lines — item, description, rate, taxability, class — with
 * pro-rated quantities, so inventory relief and COGS follow the units actually billed. Sales tax
 * is computed on the invoice from the estimate's tax rate exactly like any invoice (it is never
 * billed as an income line). Each invoice line points back at its estimate line, which is how
 * invoiced-to-date per line is known (lib/services/estimateBilling.ts). Billing more than 100%
 * of a line needs `allowOverBilling` (QB warns, then lets you). The estimate is 'partial' until
 * every line is fully billed, then 'closed' with convertedInvoiceId = the finishing invoice.
 */
export async function createProgressInvoice(
  ctx: ServiceContext,
  estimateId: string,
  input: ProgressInvoiceInput,
) {
  // Everything (estimate re-read, invoice creation, billing refresh) runs in ONE transaction so
  // concurrent progress bills see each other.
  return inTransaction(ctx, async (tx) => {
    const estimate = await getEstimate(tx, estimateId);

    if (estimate.status === 'rejected') {
      throw new ServiceError('CONFLICT', 'Cannot invoice a rejected estimate.');
    }

    // Subtotal items only add up the lines above them — nothing to bill on their own.
    const itemIds = [...new Set(estimate.lines.map((l) => l.itemId).filter((x): x is string => !!x))];
    const itemTypes = new Map<string, string>();
    if (itemIds.length > 0) {
      const rows = await tx.db
        .select({ id: items.id, type: items.type })
        .from(items)
        .where(and(eq(items.companyId, tx.companyId), inArray(items.id, itemIds)));
      for (const r of rows) itemTypes.set(r.id, r.type);
    }
    const billable = estimate.lines.filter((l) => !(l.itemId && itemTypes.get(l.itemId) === 'subtotal'));

    const lineDone = (l: EstimateLineRow) =>
      Money.gt(l.amount, 0)
        ? !Money.of(l.amountInvoiced).lessThan(Money.of(l.amount))
        : !Money.of(l.qtyInvoiced).lessThan(Money.of(l.quantity));
    const fullyBilled = estimate.status === 'closed' || billable.every(lineDone);
    if (fullyBilled && !input.allowOverBilling) {
      throw new ServiceError('CONFLICT', 'This estimate has already been fully invoiced.');
    }

    const perLine: ProgressLineInput[] = [
      ...(input.lines ?? []),
      ...(input.lineAmounts ?? []).map((la) => ({ lineId: la.lineId, amount: la.amount })),
    ];
    const modes = [input.percent != null, input.remaining === true, perLine.length > 0].filter(Boolean).length;
    if (modes === 0) {
      throw validation(
        'Choose how much to bill: a percentage of the whole estimate, the remaining amounts, or amounts for selected lines.',
      );
    }
    if (modes > 1) {
      throw validation('Choose only one way to bill: a percentage, the remaining amounts, or selected lines.');
    }

    type Bill = { line: EstimateLineRow; qty: Dec; amount: Dec };
    const bills: Bill[] = [];
    let progressLabel: string;
    const isSet = (v: string | number | null | undefined) => v != null && v !== '';

    if (input.percent != null) {
      const pct = Money.of(input.percent);
      if (pct.lessThanOrEqualTo(0) || pct.greaterThan(100)) {
        throw validation('The percentage must be more than 0 and no more than 100.');
      }
      for (const l of billable) {
        const b = billByPercent(l, pct);
        if (b.qty.greaterThan(0)) bills.push({ line: l, ...b });
      }
      progressLabel = `${toAmountString(pct)}% of estimate`;
    } else if (input.remaining === true) {
      for (const l of billable) {
        let qty = Money.of(l.quantity).minus(Money.of(l.qtyInvoiced)).toDecimalPlaces(4);
        const amount = Money.round2(Money.of(l.amount).minus(Money.of(l.amountInvoiced)));
        if (amount.lessThanOrEqualTo(0) && qty.lessThanOrEqualTo(0)) continue;
        if (qty.lessThanOrEqualTo(0)) {
          // Only pennies left (rounding of an older bill): bill them on the smallest quantity.
          const rate = Money.of(l.rate);
          qty = rate.greaterThan(0) ? Money.div(amount, rate).toDecimalPlaces(4) : Money.zero();
          if (qty.lessThanOrEqualTo(0)) qty = Money.of('0.0001');
        }
        bills.push({ line: l, qty, amount: amount.greaterThan(0) ? amount : Money.zero() });
      }
      progressLabel = 'remaining amounts';
    } else {
      const lineById = new Map(estimate.lines.map((l) => [l.id, l]));
      const seen = new Set<string>();
      for (const pl of perLine) {
        const line = lineById.get(pl.lineId);
        if (!line) throw notFound(`Estimate line ${pl.lineId}`);
        if (seen.has(pl.lineId)) throw validation('Each estimate line can be listed only once.');
        seen.add(pl.lineId);
        const label = line.description ?? 'Estimate line';
        const given = [isSet(pl.percent), isSet(pl.quantity), isSet(pl.amount)];
        if (given.filter(Boolean).length !== 1) {
          throw validation(`"${label}": enter a percentage, a quantity or an amount (just one).`);
        }
        const Q = Money.of(line.quantity);
        const A = Money.of(line.amount);
        const R = Money.of(line.rate);
        let qty: Dec;
        let amount: Dec;
        if (given[0]) {
          const pct = Money.of(pl.percent!);
          if (pct.lessThan(0)) throw validation(`"${label}": the percentage cannot be negative.`);
          if (pct.isZero()) continue;
          ({ qty, amount } = billByPercent(line, pct));
        } else if (given[1]) {
          qty = Money.of(pl.quantity!).toDecimalPlaces(4);
          if (qty.lessThan(0)) throw validation(`"${label}": the quantity cannot be negative.`);
          if (qty.isZero()) continue;
          amount = Money.round2(Money.mul(qty, R));
          if (Money.of(line.qtyInvoiced).plus(qty).equals(Q)) {
            const left = Money.round2(A.minus(Money.of(line.amountInvoiced)));
            if (left.greaterThanOrEqualTo(0) && Money.abs(left.minus(amount)).lessThanOrEqualTo('0.05')) amount = left;
          }
        } else {
          amount = Money.round2(pl.amount!);
          if (amount.lessThan(0)) throw validation(`"${label}": the amount cannot be negative.`);
          if (amount.isZero()) continue;
          if (!R.greaterThan(0)) {
            throw validation(`"${label}" has no rate on the estimate. Bill it by quantity or percentage instead.`);
          }
          qty = Money.div(amount, R).toDecimalPlaces(4);
          if (Money.round2(Money.of(line.amountInvoiced).plus(amount)).equals(A)) {
            const left = Q.minus(Money.of(line.qtyInvoiced));
            if (left.greaterThan(0)) qty = left;
          }
          if (qty.lessThanOrEqualTo(0)) qty = Money.of('0.0001');
        }
        bills.push({ line, qty, amount });
      }
      progressLabel = 'selected lines';
    }

    if (bills.length === 0) {
      throw validation('Nothing to invoice — every amount is zero.');
    }

    // Over-billing check (QB: "you are billing more than 100% of this item" — warn, then allow).
    const over: OverBilledLine[] = [];
    for (const b of bills) {
      const A = Money.of(b.line.amount);
      const Q = Money.of(b.line.quantity);
      const newAmt = Money.of(b.line.amountInvoiced).plus(b.amount);
      const newQty = Money.of(b.line.qtyInvoiced).plus(b.qty);
      const overAmt = A.greaterThan(0) ? newAmt.greaterThan(A.plus('0.005')) : false;
      const overQty = newQty.greaterThan(Q.plus('0.00005'));
      if (overAmt || overQty) {
        const pct = A.greaterThan(0)
          ? Money.mul(Money.div(newAmt, A), 100)
          : Q.greaterThan(0)
            ? Money.mul(Money.div(newQty, Q), 100)
            : Money.zero();
        over.push({
          lineId: b.line.id,
          description: b.line.description ?? 'Estimate line',
          estimateAmount: toAmountString(A),
          invoicedToDate: toAmountString(Money.of(b.line.amountInvoiced)),
          thisInvoice: toAmountString(b.amount),
          percentBilled: pct.toDecimalPlaces(2).toFixed(2),
        });
      }
    }
    if (over.length > 0 && !input.allowOverBilling) {
      const names = over.map((o) => `"${o.description}" (${o.percentBilled}%)`).join(', ');
      throw new ServiceError(
        'VALIDATION',
        `This invoice would bill more than 100% of the estimate for ${names}. Save anyway?`,
        { warning: PROGRESS_OVERBILL_WARNING, lines: over },
      );
    }

    const estRef = docRef(estimate.refNumber, estimate.estimateNumber);
    const invoice = await createInvoice(tx, {
      customerId: estimate.customerId,
      date: input.date ?? new Date(),
      memo: `Progress billing (${progressLabel}) for Estimate #${estRef}`,
      // Sales tax is charged on the invoice itself, at the estimate's rate, on taxable lines.
      taxRateId: estimate.taxRateId ?? null,
      overrideCreditLimit: input.overrideCreditLimit,
      lines: bills.map((b) => ({
        itemId: b.line.itemId ?? null,
        description: b.line.description ?? null,
        quantity: b.qty.toFixed(4),
        rate: b.line.rate,
        amount: toAmountString(b.amount),
        taxable: b.line.taxable,
        classId: b.line.classId ?? null,
        pricing: { origin: 'estimate' },
        estimateLineId: b.line.id,
      })),
    });

    const billedTotal = bills.reduce((sum, b) => sum.plus(b.amount), Money.zero());
    const updatedEstimate = await refreshEstimateBilling(tx, estimateId, { closingInvoiceId: invoice.id });

    await writeAudit(tx, {
      action: 'update',
      entityType: 'estimate',
      entityId: estimateId,
      oldValues: { status: estimate.status, amountInvoiced: estimate.amountInvoiced },
      newValues: {
        status: updatedEstimate?.status,
        amountInvoiced: updatedEstimate?.amountInvoiced,
        progressInvoiceId: invoice.id,
        progressAmount: toAmountString(billedTotal),
        overBilled: over.length > 0 ? over : undefined,
      },
    });

    return { invoice, estimate: updatedEstimate!, overBilled: over };
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
        classId: cl.classId,
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
