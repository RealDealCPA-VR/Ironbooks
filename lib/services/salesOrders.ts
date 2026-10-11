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
import { customers, items, salesOrders, salesOrderLines } from '@/lib/db/schema';
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

export interface SalesOrderLineInput {
  itemId?: string | null;
  description?: string | null;
  quantity: string | number;
  /** Unit price; omit on item lines to price server-side (lib/services/pricing.ts). */
  rate?: string | number | null;
}

export interface CreateSalesOrderInput {
  customerId: string;
  date: Date;
  lines: SalesOrderLineInput[];
  memo?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function nextOrderNumber(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${salesOrders.orderNumber}), 0)` })
    .from(salesOrders)
    .where(eq(salesOrders.companyId, ctx.companyId));
  return (row?.max ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// createSalesOrder
// ---------------------------------------------------------------------------

export async function createSalesOrder(ctx: ServiceContext, input: CreateSalesOrderInput) {
  if (!input.lines || input.lines.length === 0) {
    throw validation('A sales order must have at least one line.');
  }

  // Verify customer belongs to company.
  const [customer] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!customer) throw notFound('Customer');

  // Compute per-line amounts.
  type ComputedLine = {
    itemId: string | null;
    description: string | null;
    quantity: string;
    rate: string;
    amount: string;
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
  const computedLines: ComputedLine[] = [];

  for (let i = 0; i < pricedLines.length; i++) {
    const l = pricedLines[i];
    const qty = Money.of(l.quantity);
    const rate = Money.of(l.rate);
    if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
    if (rate.lessThan(0)) throw validation(`Line ${i + 1}: rate cannot be negative.`);

    const amount = Money.round2(Money.mul(qty, rate));
    subtotal = subtotal.plus(amount);

    computedLines.push({
      itemId: l.itemId ?? null,
      description: l.description ?? null,
      quantity: toAmountString(qty),
      rate: toAmountString(rate),
      amount: toAmountString(amount),
      lineOrder: i,
      pricing: l.pricing,
    });
  }

  const total = Money.round2(subtotal);

  return inTransaction(ctx, async (tx) => {
    const orderNumber = await nextOrderNumber(tx);

    const [order] = await tx.db
      .insert(salesOrders)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        orderNumber,
        date: input.date,
        status: 'open',
        subtotal: toAmountString(subtotal),
        total: toAmountString(total),
        memo: input.memo ?? null,
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
      lines: plan.map(({ line, qty }) => ({
        itemId: line.itemId ?? null,
        description: line.description ?? null,
        quantity: qty.toFixed(4),
        rate: line.rate,
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
