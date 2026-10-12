/**
 * Sales Orders service.
 *
 * Sales orders are pre-sale commitments that do NOT post to the GL.
 * They become invoices via `convertToInvoice`, which calls `createInvoice`
 * (fully or partially) and tracks per-line invoiced quantity.
 *
 * Status flow:
 *   open  →  partial  (via convertToInvoice with per-line quantities — some qty backordered)
 *   open / partial  →  closed  (via convertToInvoice once every line is fully invoiced,
 *                               or manually via updateStatus to cancel the backorder)
 *   open  →  void    (via updateStatus; blocked once anything has been invoiced)
 *
 * Partial invoicing / backorders (mirrors purchaseOrders partial billing):
 *   convertToInvoice(ctx, soId, opts?) invoices the order (default: every line's
 *   full remaining quantity; or per-line quantities via opts.lines).
 *   salesOrderLines.quantityInvoiced accumulates how much of each line has been
 *   pulled onto invoices; multiple invoices per order are supported.
 *   Over-invoicing is enforced by a guarded conditional UPDATE on
 *   quantityInvoiced inside the transaction. convertedInvoiceId is stamped with
 *   the invoice that completes (closes) the order. `backorderReport` exposes
 *   the remaining (backordered) quantity per open sales-order line.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import { customers, items, salesOrders, salesOrderLines, taxRates } from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { createInvoice, shippingColumns } from './invoices';
import { type AppliedPricing, resolveLinePricing } from './pricing';
import { applyCustomerTaxDefaults } from './customerDefaults';
import { allocateDocNumber, renumberDoc } from './docNumbers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SalesOrderLineInput {
  /** Edit only (C1): the existing sales-order line this row updates (keeps its invoiced qty). */
  id?: string | null;
  itemId?: string | null;
  description?: string | null;
  quantity: string | number;
  /** Unit price; omit on item lines to price server-side (lib/services/pricing.ts). */
  rate?: string | number | null;
  /** QB "Tax" column; defaults to true. */
  taxable?: boolean;
}

export interface CreateSalesOrderInput {
  /**
   * Document number typed by the user (alphanumeric, e.g. "INV-1001"). Blank = the next number
   * (QB: last number used with its trailing digits + 1). See lib/services/docNumbers.ts.
   */
  refNumber?: string | null;
  /** The user confirmed the "this number is already used" warning. */
  allowDuplicateNumber?: boolean | null;
  customerId: string;
  date: Date;
  lines: SalesOrderLineInput[];
  memo?: string | null;
  /**
   * Sales tax item (taxRates row). Omitted → the customer's tax item; null → no tax. Tax is
   * taxable lines × rate, the same math as invoices, and carries to the invoice on conversion.
   */
  taxRateId?: string | null;
  // wave2 sales: shipping (B6) + send queues (C7)
  shipDate?: Date | null;
  shipVia?: string | null;
  fob?: string | null;
  trackingNumber?: string | null;
  shipTo?: Record<string, string> | null;
  poNumber?: string | null;
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createSalesOrder
// ---------------------------------------------------------------------------

/** Validate a sales-order input and compute its lines/totals (read-only; create + edit). */
async function prepareSalesOrder(ctx: ServiceContext, input: CreateSalesOrderInput) {
  if (!input.lines || input.lines.length === 0) {
    throw validation('A sales order must have at least one line.');
  }

  // Verify customer belongs to company.
  const [customer] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!customer) throw notFound('Customer');

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
    const taxable = input.lines[i].taxable !== false;
    if (taxable) taxableSubtotal = taxableSubtotal.plus(amount);

    computedLines.push({
      itemId: l.itemId ?? null,
      description: l.description ?? null,
      quantity: qty.toFixed(4),
      rate: rate.toFixed(4),
      amount: toAmountString(amount),
      taxable,
      lineOrder: i,
      pricing: l.pricing,
    });
  }

  // Sales tax — identical to the invoice computation: taxableSubtotal * rate, 2dp.
  const taxAmount = Money.round2(Money.mul(taxableSubtotal, taxRateDecimal));
  const total = Money.round2(subtotal.plus(taxAmount));

  return { computedLines, subtotal, taxAmount, total };
}

export async function createSalesOrder(ctx: ServiceContext, input: CreateSalesOrderInput) {
  input = await applyCustomerTaxDefaults(ctx, input, { defaultRate: true });
  const { computedLines, subtotal, taxAmount, total } = await prepareSalesOrder(ctx, input);

  return inTransaction(ctx, async (tx) => {
    const { refNumber, number: orderNumber } = await allocateDocNumber(tx, 'sales_order', input.refNumber, {
      allowDuplicate: input.allowDuplicateNumber === true,
    });

    const [order] = await tx.db
      .insert(salesOrders)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        orderNumber,
        refNumber,
        date: input.date,
        status: 'open',
        subtotal: toAmountString(subtotal),
        taxRateId: input.taxRateId ?? null,
        taxAmount: toAmountString(taxAmount),
        total: toAmountString(total),
        memo: input.memo ?? null,
        ...shippingColumns(input),
      })
      .returning();

    await tx.db.insert(salesOrderLines).values(
      computedLines.map((cl) => ({
        salesOrderId: order.id,
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
      entityType: 'sales_order',
      entityId: order.id,
      newValues: {
        orderNumber,
        customerId: input.customerId,
        total: toAmountString(total),
      },
    });

    return { ...order, lines: computedLines };
  });
}

// ---------------------------------------------------------------------------
// listSalesOrders
// ---------------------------------------------------------------------------

export async function listSalesOrders(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.companyId, ctx.companyId))
    .orderBy(salesOrders.orderNumber);
}

// ---------------------------------------------------------------------------
// getSalesOrder (with lines)
// ---------------------------------------------------------------------------

export async function getSalesOrder(ctx: ServiceContext, id: string) {
  const [order] = await ctx.db
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.companyId, ctx.companyId), eq(salesOrders.id, id)));
  if (!order) throw notFound('Sales order');

  const lines = await ctx.db
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, id))
    .orderBy(salesOrderLines.lineOrder);

  return { ...order, lines };
}

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

export async function updateStatus(
  ctx: ServiceContext,
  id: string,
  status: 'open' | 'closed' | 'void',
) {
  const [order] = await ctx.db
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.companyId, ctx.companyId), eq(salesOrders.id, id)));
  if (!order) throw notFound('Sales order');

  if (order.status === 'closed' && status !== 'closed') {
    throw new ServiceError('CONFLICT', 'Cannot reopen a closed (converted) sales order.');
  }

  if (order.status === 'partial' && status === 'open') {
    throw new ServiceError(
      'CONFLICT',
      'Cannot mark a partially invoiced sales order as open — its invoiced quantities already track the open balance.',
    );
  }

  if (order.status === 'partial' && status === 'void') {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void a partially invoiced sales order. Close it instead to cancel the backorder.',
    );
  }

  const [updated] = await ctx.db
    .update(salesOrders)
    .set({ status })
    .where(eq(salesOrders.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'sales_order',
    entityId: id,
    oldValues: { status: order.status },
    newValues: { status },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// convertToInvoice
// ---------------------------------------------------------------------------

/** A per-line invoicing request for partial sales-order invoicing. */
export interface ConvertToInvoiceLineInput {
  /** salesOrderLines.id to invoice from. */
  lineId: string;
  /** Quantity to invoice now (> 0 and ≤ the line's remaining uninvoiced quantity). */
  quantity: string | number;
}

export interface ConvertToInvoiceOptions {
  /** wave2 sales (C2): save even if the invoice puts the customer over their credit limit. */
  overrideCreditLimit?: boolean;
  /**
   * Per-line quantities to invoice. Lines omitted from the array are not
   * invoiced (they stay on backorder). When undefined, every line is invoiced
   * at its full remaining quantity (legacy full-convert behaviour).
   */
  lines?: ConvertToInvoiceLineInput[];
  /** Invoice date — defaults to the sales-order date. */
  date?: Date;
}

/**
 * Invoice a sales order (fully or partially) — atomically:
 * 1. Validate the order is invoiceable (not void, not closed) and resolve the
 *    invoicing plan: requested per-line quantities, or every line's remaining
 *    quantity.
 * 2. Inside ONE transaction:
 *    a. Claim each line via a guarded conditional UPDATE that increments
 *       quantityInvoiced only while quantityInvoiced + qty ≤ quantity. Zero
 *       rows back means a concurrent convert consumed the quantity — throw
 *       CONFLICT. This per-line quantity guard is the over-invoicing /
 *       idempotency guard (multiple invoices per order are allowed).
 *    b. Call `createInvoice` with the tx context (posts A/R + revenue in the
 *       same transaction via a savepoint). Item lines pass itemId + quantity
 *       through so inventory items relieve stock / post COGS perpetually.
 *    c. Recompute the order status: 'closed' when every line is fully invoiced
 *       (stamping convertedInvoiceId with the closing invoice), else 'partial'.
 * Any failure rolls back the line claims, the invoice, and the GL entry
 * together, so a crash mid-conversion can never leave a posted invoice with
 * stale order quantities (and re-running convert can never double-post A/R).
 */
export async function convertToInvoice(
  ctx: ServiceContext,
  salesOrderId: string,
  opts?: ConvertToInvoiceOptions,
) {
  // Invoice creation and order stamping must commit or roll back TOGETHER —
  // otherwise a failure after createInvoice leaves a posted GL invoice with the
  // order still open and convertible again (duplicate invoice + revenue).
  // Re-loading the order inside the transaction also closes the
  // read-then-write race between concurrent converts.
  return inTransaction(ctx, async (tx) => {
    const [order] = await tx.db
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.companyId, tx.companyId), eq(salesOrders.id, salesOrderId)));
    if (!order) throw notFound('Sales order');

    if (order.status === 'closed') {
      throw new ServiceError('CONFLICT', 'Sales order has already been fully invoiced.');
    }
    if (order.status === 'void') {
      throw new ServiceError('CONFLICT', 'Cannot convert a voided sales order.');
    }

    const lines = await tx.db
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, salesOrderId))
      .orderBy(asc(salesOrderLines.lineOrder));

    if (lines.length === 0) {
      throw validation('Sales order has no lines to convert.');
    }

    const remainingOf = (l: (typeof lines)[number]) =>
      Money.of(l.quantity).minus(Money.of(l.quantityInvoiced ?? '0'));

    // --- Resolve the invoicing plan ---------------------------------------
    type PlanEntry = { line: (typeof lines)[number]; qty: ReturnType<typeof Money.of> };
    const plan: PlanEntry[] = [];

    if (opts?.lines && opts.lines.length > 0) {
      const lineById = new Map(lines.map((l) => [l.id, l]));
      const seen = new Set<string>();
      for (const [i, req] of opts.lines.entries()) {
        const line = lineById.get(req.lineId);
        if (!line) {
          throw validation(`Invoicing line ${i + 1}: sales order line not found.`);
        }
        if (seen.has(req.lineId)) {
          throw validation(`Invoicing line ${i + 1}: duplicate sales order line.`);
        }
        seen.add(req.lineId);

        const qty = Money.of(req.quantity);
        if (qty.lessThanOrEqualTo(0)) {
          throw validation(`Invoicing line ${i + 1}: quantity must be positive.`);
        }
        const remaining = remainingOf(line);
        if (qty.greaterThan(remaining)) {
          throw validation(
            `Invoicing line ${i + 1}: only ${remaining.toFixed(4)} remaining uninvoiced ` +
              `(ordered ${Money.of(line.quantity).toFixed(4)}, ` +
              `invoiced ${Money.of(line.quantityInvoiced ?? '0').toFixed(4)}).`,
          );
        }
        plan.push({ line, qty });
      }
    } else {
      // Default: invoice the full remaining quantity of every line.
      for (const line of lines) {
        const remaining = remainingOf(line);
        if (remaining.greaterThan(0)) plan.push({ line, qty: remaining });
      }
    }

    if (plan.length === 0) {
      throw new ServiceError('CONFLICT', 'Sales order has no uninvoiced quantity remaining.');
    }

    // Claim each line's quantity with a guarded conditional UPDATE. If a
    // concurrent conversion already consumed the quantity, zero rows come back
    // and we bail without posting anything.
    for (const { line, qty } of plan) {
      const qtyStr = qty.toFixed(4);
      const claimed = await tx.db
        .update(salesOrderLines)
        .set({
          quantityInvoiced: sql`${salesOrderLines.quantityInvoiced} + ${qtyStr}::numeric`,
        })
        .where(
          and(
            eq(salesOrderLines.id, line.id),
            eq(salesOrderLines.salesOrderId, salesOrderId),
            sql`${salesOrderLines.quantityInvoiced} + ${qtyStr}::numeric <= ${salesOrderLines.quantity}`,
          ),
        )
        .returning({ id: salesOrderLines.id });
      if (claimed.length === 0) {
        throw new ServiceError(
          'CONFLICT',
          'Sales order quantities were invoiced by another transaction. Reload and retry.',
        );
      }
    }

    // Create the invoice — this does GL posting via postJournalEntry internally;
    // its internal inTransaction nests as a savepoint on this transaction.
    const invoice = await createInvoice(tx, {
      customerId: order.customerId,
      date: opts?.date ?? order.date,
      memo: order.memo,
      // The order's tax item and Tax column carry over (null = the order was not taxed).
      taxRateId: order.taxRateId ?? null,
      overrideCreditLimit: opts?.overrideCreditLimit,
      // wave2 sales (B6): the invoice inherits the order shipping details.
      shipDate: order.shipDate,
      shipVia: order.shipVia,
      fob: order.fob,
      trackingNumber: order.trackingNumber,
      shipTo: order.shipTo,
      poNumber: order.poNumber,
      lines: plan.map(({ line, qty }) => ({
        itemId: line.itemId ?? null,
        description: line.description ?? null,
        quantity: qty.toFixed(4),
        rate: line.rate,
        taxable: line.taxable,
        pricing: { origin: 'sales_order' },
      })),
    });

    // Recompute the order status from the post-claim line quantities.
    const refreshed = await tx.db
      .select({
        quantity: salesOrderLines.quantity,
        quantityInvoiced: salesOrderLines.quantityInvoiced,
      })
      .from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, salesOrderId));
    const fullyInvoiced = refreshed.every(
      (l) => !Money.of(l.quantity).minus(Money.of(l.quantityInvoiced ?? '0')).greaterThan(0),
    );
    const newStatus = fullyInvoiced ? ('closed' as const) : ('partial' as const);

    await tx.db
      .update(salesOrders)
      .set({
        status: newStatus,
        // Stamp the invoice that completes the order (legacy full-convert
        // semantics); earlier partial invoices are linked via quantityInvoiced
        // and the audit trail.
        ...(fullyInvoiced && !order.convertedInvoiceId
          ? { convertedInvoiceId: invoice.id }
          : {}),
      })
      .where(and(eq(salesOrders.id, salesOrderId), eq(salesOrders.companyId, tx.companyId)));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'sales_order',
      entityId: salesOrderId,
      oldValues: { status: order.status, convertedInvoiceId: order.convertedInvoiceId },
      newValues: {
        status: newStatus,
        invoiceId: invoice.id,
        invoicedQuantities: plan.map(({ line, qty }) => ({
          lineId: line.id,
          quantity: qty.toFixed(4),
        })),
      },
    });

    return invoice;
  });
}

// ---------------------------------------------------------------------------
// backorderReport
// ---------------------------------------------------------------------------

export interface BackorderReportRow {
  salesOrderId: string;
  orderNumber: number;
  date: Date;
  status: string;
  customerId: string;
  customerName: string;
  lineId: string;
  itemId: string | null;
  itemName: string | null;
  description: string | null;
  quantityOrdered: string;
  quantityInvoiced: string;
  /** Remaining (ordered - invoiced) quantity still to be invoiced/shipped. */
  quantityBackordered: string;
}

/**
 * Backorder report: every open / partially invoiced sales-order line with
 * remaining (uninvoiced) quantity, with customer and item context. This is the
 * QB "Open Sales Orders by Item / Customer" data source.
 */
export async function backorderReport(ctx: ServiceContext): Promise<BackorderReportRow[]> {
  const rows = await ctx.db
    .select({
      salesOrderId: salesOrders.id,
      orderNumber: salesOrders.orderNumber,
      date: salesOrders.date,
      status: salesOrders.status,
      customerId: salesOrders.customerId,
      customerName: customers.displayName,
      lineId: salesOrderLines.id,
      itemId: salesOrderLines.itemId,
      itemName: items.name,
      description: salesOrderLines.description,
      quantityOrdered: salesOrderLines.quantity,
      quantityInvoiced: salesOrderLines.quantityInvoiced,
    })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrderLines.salesOrderId, salesOrders.id))
    .innerJoin(customers, eq(salesOrders.customerId, customers.id))
    .leftJoin(items, eq(salesOrderLines.itemId, items.id))
    .where(
      and(
        eq(salesOrders.companyId, ctx.companyId),
        inArray(salesOrders.status, ['open', 'partial']),
        sql`${salesOrderLines.quantityInvoiced} < ${salesOrderLines.quantity}`,
      ),
    )
    .orderBy(asc(salesOrders.orderNumber), asc(salesOrderLines.lineOrder));

  return rows.map((r) => ({
    ...r,
    quantityBackordered: Money.of(r.quantityOrdered)
      .minus(Money.of(r.quantityInvoiced ?? '0'))
      .toFixed(4),
  }));
}

// ---------------------------------------------------------------------------
// updateSalesOrder (wave2 sales, C1 — edit a saved sales order)
// ---------------------------------------------------------------------------

/**
 * Edit a saved sales order. Sales orders never post to the GL, so this replaces the lines and
 * header (orderNumber/createdAt preserved) and audits old + new values.
 *
 * Lines already (partly) invoiced must be kept — send them back with their `id` — with the same
 * item and a quantity no lower than what has been invoiced; their invoiced quantity carries
 * over. New lines (no id) are added; lines without invoicing may be removed. Closed and void
 * orders cannot be edited. The status is recomputed (partial/closed) from the new quantities.
 */
export async function updateSalesOrder(ctx: ServiceContext, id: string, input: CreateSalesOrderInput) {
  input = await applyCustomerTaxDefaults(ctx, input);
  const existing = await getSalesOrder(ctx, id);
  if (existing.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided sales order.');
  if (existing.status === 'closed') {
    throw new ServiceError(
      'CONFLICT',
      'This sales order is closed (fully invoiced or cancelled), so it can no longer be changed.',
    );
  }
  const { computedLines, subtotal, taxAmount, total } = await prepareSalesOrder(ctx, input);

  // Map input rows to existing lines by id.
  const oldById = new Map(existing.lines.map((l) => [l.id, l]));
  const keepInvoiced = new Map<number, string>(); // new line index -> quantityInvoiced
  const seen = new Set<string>();
  input.lines.forEach((l, i) => {
    if (!l.id) return;
    const old = oldById.get(l.id);
    if (!old) throw validation(`Line ${i + 1}: that sales order line no longer exists — reload and try again.`);
    if (seen.has(l.id)) throw validation(`Line ${i + 1}: the same sales order line appears twice.`);
    seen.add(l.id);
    const invoiced = Money.of(old.quantityInvoiced ?? '0');
    if (invoiced.greaterThan(0)) {
      if ((l.itemId ?? null) !== (old.itemId ?? null)) {
        throw new ServiceError('CONFLICT', `Line ${i + 1} has already been invoiced, so its item cannot be changed.`);
      }
      if (Money.of(computedLines[i].quantity).lessThan(invoiced)) {
        throw new ServiceError(
          'CONFLICT',
          `Line ${i + 1} has already been invoiced for ${invoiced.toFixed(2)}, so its quantity cannot be lower than that.`,
        );
      }
      keepInvoiced.set(i, invoiced.toFixed(4));
    }
  });
  for (const old of existing.lines) {
    if (!seen.has(old.id) && Money.of(old.quantityInvoiced ?? '0').greaterThan(0)) {
      throw new ServiceError('CONFLICT', 'A line that has already been invoiced cannot be removed from the sales order.');
    }
  }
  const anyInvoiced = keepInvoiced.size > 0;
  if (anyInvoiced && input.customerId !== existing.customerId) {
    throw new ServiceError(
      'CONFLICT',
      'This sales order has already been partly invoiced, so its customer cannot be changed.',
    );
  }
  const fullyInvoiced =
    anyInvoiced &&
    computedLines.every((cl, i) => !Money.of(cl.quantity).greaterThan(Money.of(keepInvoiced.get(i) ?? '0')));
  const newStatus = !anyInvoiced ? 'open' : fullyInvoiced ? 'closed' : 'partial';

  return inTransaction(ctx, async (tx) => {
    const renum = await renumberDoc(
      tx, 'sales_order', id, { refNumber: existing.refNumber, number: existing.orderNumber },
      input.refNumber, { allowDuplicate: input.allowDuplicateNumber === true },
    );
    await tx.db.delete(salesOrderLines).where(eq(salesOrderLines.salesOrderId, id));
    await tx.db.insert(salesOrderLines).values(
      computedLines.map((cl, i) => ({
        salesOrderId: id,
        itemId: cl.itemId,
        description: cl.description,
        quantity: cl.quantity,
        rate: cl.rate,
        amount: cl.amount,
        taxable: cl.taxable,
        quantityInvoiced: keepInvoiced.get(i) ?? '0',
        lineOrder: cl.lineOrder,
        pricing: cl.pricing as Record<string, unknown> | null,
      })),
    );
    await tx.db
      .update(salesOrders)
      .set({
        customerId: input.customerId,
        date: input.date,
        subtotal: toAmountString(subtotal),
        taxRateId: input.taxRateId ?? null,
        taxAmount: toAmountString(taxAmount),
        total: toAmountString(total),
        memo: input.memo ?? null,
        status: newStatus,
        ...(renum ? { refNumber: renum.refNumber, orderNumber: renum.number } : {}),
        ...shippingColumns(input, existing),
      })
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, tx.companyId)));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'sales_order',
      entityId: id,
      oldValues: {
        customerId: existing.customerId,
        date: existing.date,
        refNumber: existing.refNumber,
        total: existing.total,
        status: existing.status,
        memo: existing.memo,
        lines: existing.lines.map((l) => ({
          itemId: l.itemId,
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          quantityInvoiced: l.quantityInvoiced,
        })),
      },
      newValues: {
        customerId: input.customerId,
        date: input.date,
        refNumber: renum?.refNumber ?? existing.refNumber,
        duplicateNumber: renum?.duplicate || undefined,
        total: toAmountString(total),
        status: newStatus,
        memo: input.memo ?? null,
        lines: computedLines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate })),
      },
    });
    return getSalesOrder(tx, id);
  });
}
