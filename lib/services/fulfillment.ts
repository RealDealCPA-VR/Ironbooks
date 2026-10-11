/**
 * Sales Order Fulfillment Worksheet — QB Desktop Enterprise parity.
 *
 * Shows every open sales-order line with ordered / invoiced / remaining quantities and how much
 * can ship right now, then batch-invoices what can ship (and prints pick lists / packing slips —
 * see app/api/fulfillment/*).
 *
 * Availability ("respect committed stock"): on-hand stock of each inventory item is first
 * reserved for components of PENDING assembly builds, then allocated to open sales-order lines
 * in priority order — order date, then order number, then line order (first come, first
 * served). A line can ship min(remaining, stock left after earlier lines). The allocation always
 * runs over ALL open orders, so filtering the worksheet never changes what a line can ship.
 * Non-inventory, service and other non-stock lines can always ship in full.
 *
 * Ship status per line and per order: 'complete' (everything remaining can ship), 'partial'
 * (some of it), 'none'.
 *
 * Batch invoicing reuses salesOrders.convertToInvoice per order (its own transaction, its own
 * over-invoicing guard, GL via postJournalEntry inside createInvoice), so one failing order never
 * blocks the others and each posted invoice stays balanced.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  assemblyComponents,
  customers,
  items,
  pendingBuilds,
  salesOrderLines,
  salesOrders,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, validation } from './_base';
import { convertToInvoice } from './salesOrders';

type Dec = ReturnType<typeof Money.zero>;
export type ShipStatus = 'complete' | 'partial' | 'none';

export interface WorksheetFilters {
  customerId?: string | null;
  itemId?: string | null;
  /** Inclusive order-date range. */
  from?: Date | null;
  to?: Date | null;
  shipStatus?: ShipStatus | null;
  salesOrderIds?: string[] | null;
}

export interface WorksheetLine {
  lineId: string;
  itemId: string | null;
  itemName: string | null;
  sku: string | null;
  description: string | null;
  tracksStock: boolean;
  rate: string;
  quantityOrdered: string;
  quantityInvoiced: string;
  quantityRemaining: string;
  /** Item on hand (null for non-stock lines). */
  quantityOnHand: string | null;
  /** On hand minus everything committed (all open SOs + pending builds) — QB "Available". */
  quantityAvailable: string | null;
  /** Stock reserved for earlier orders/builds before this line. */
  quantityAllocatedBefore: string | null;
  canShip: string;
  shipStatus: ShipStatus;
}

export interface WorksheetOrder {
  salesOrderId: string;
  orderNumber: number;
  date: Date;
  status: string;
  customerId: string;
  customerName: string;
  /** Remaining (uninvoiced) value of the order. */
  openAmount: string;
  /** Value of what can ship now. */
  shippableAmount: string;
  shipStatus: ShipStatus;
  lines: WorksheetLine[];
}

export interface WorksheetItem {
  itemId: string;
  name: string;
  onHand: string;
  committedToOrders: string;
  committedToBuilds: string;
  available: string;
}

export interface WorksheetResult {
  orders: WorksheetOrder[];
  items: WorksheetItem[];
  totals: { orders: number; complete: number; partial: number; none: number; shippableAmount: string };
}

function shipStatusOf(canShip: Dec, remaining: Dec): ShipStatus {
  if (!remaining.greaterThan(0)) return 'complete';
  if (canShip.greaterThanOrEqualTo(remaining)) return 'complete';
  return canShip.greaterThan(0) ? 'partial' : 'none';
}

/** Build the worksheet (read-only). */
export async function fulfillmentWorksheet(
  ctx: ServiceContext,
  filters: WorksheetFilters = {},
): Promise<WorksheetResult> {
  const rows = await ctx.db
    .select({
      salesOrderId: salesOrders.id,
      orderNumber: salesOrders.orderNumber,
      date: salesOrders.date,
      status: salesOrders.status,
      customerId: salesOrders.customerId,
      customerName: customers.displayName,
      lineId: salesOrderLines.id,
      lineOrder: salesOrderLines.lineOrder,
      itemId: salesOrderLines.itemId,
      description: salesOrderLines.description,
      quantity: salesOrderLines.quantity,
      quantityInvoiced: salesOrderLines.quantityInvoiced,
      rate: salesOrderLines.rate,
    })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrderLines.salesOrderId, salesOrders.id))
    .innerJoin(customers, eq(salesOrders.customerId, customers.id))
    .where(and(eq(salesOrders.companyId, ctx.companyId), inArray(salesOrders.status, ['open', 'partial'])))
    .orderBy(asc(salesOrders.date), asc(salesOrders.orderNumber), asc(salesOrderLines.lineOrder));

  const itemIds = [...new Set(rows.map((r) => r.itemId).filter((x): x is string => !!x))];
  const itemRows = itemIds.length
    ? await ctx.db
        .select({
          id: items.id,
          name: items.name,
          sku: items.sku,
          type: items.type,
          quantityOnHand: items.quantityOnHand,
        })
        .from(items)
        .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)))
    : [];
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  const tracks = (itemId: string | null) => !!itemId && itemById.get(itemId)?.type === 'inventory';

  // Components committed to pending assembly builds.
  const buildCommit = new Map<string, Dec>();
  const builds = await ctx.db
    .select({ assemblyItemId: pendingBuilds.assemblyItemId, quantity: pendingBuilds.quantity })
    .from(pendingBuilds)
    .where(and(eq(pendingBuilds.companyId, ctx.companyId), eq(pendingBuilds.status, 'pending')));
  if (builds.length > 0) {
    const bom = await ctx.db
      .select()
      .from(assemblyComponents)
      .where(
        and(
          eq(assemblyComponents.companyId, ctx.companyId),
          inArray(assemblyComponents.assemblyItemId, [...new Set(builds.map((b) => b.assemblyItemId))]),
        ),
      );
    for (const b of builds) {
      for (const c of bom.filter((x) => x.assemblyItemId === b.assemblyItemId)) {
        const need = Money.of(b.quantity).times(Money.of(c.quantity));
        buildCommit.set(c.componentItemId, (buildCommit.get(c.componentItemId) ?? Money.zero()).plus(need));
      }
    }
  }

  // Committed to open sales orders (all of them).
  const soCommit = new Map<string, Dec>();
  for (const r of rows) {
    if (!tracks(r.itemId)) continue;
    const rem = Money.of(r.quantity).minus(Money.of(r.quantityInvoiced));
    if (rem.greaterThan(0)) soCommit.set(r.itemId!, (soCommit.get(r.itemId!) ?? Money.zero()).plus(rem));
  }

  // First-come-first-served allocation of what is left after builds.
  const allocated = new Map<string, Dec>();
  const orders = new Map<string, WorksheetOrder>();
  for (const r of rows) {
    const remaining = Money.of(r.quantity).minus(Money.of(r.quantityInvoiced));
    if (!remaining.greaterThan(0)) continue;
    const item = r.itemId ? itemById.get(r.itemId) : undefined;
    const stock = tracks(r.itemId);
    let canShip = remaining;
    let onHand: Dec | null = null;
    let before: Dec | null = null;
    let available: Dec | null = null;
    if (stock) {
      onHand = Money.of(item!.quantityOnHand ?? '0');
      const reservedBuilds = buildCommit.get(r.itemId!) ?? Money.zero();
      before = reservedBuilds.plus(allocated.get(r.itemId!) ?? Money.zero());
      const free = onHand.minus(before);
      canShip = free.greaterThan(0) ? (free.lessThan(remaining) ? free : remaining) : Money.zero();
      allocated.set(r.itemId!, (allocated.get(r.itemId!) ?? Money.zero()).plus(remaining));
      available = onHand.minus(reservedBuilds).minus(soCommit.get(r.itemId!) ?? Money.zero());
    }

    let order = orders.get(r.salesOrderId);
    if (!order) {
      order = {
        salesOrderId: r.salesOrderId,
        orderNumber: r.orderNumber,
        date: r.date,
        status: r.status,
        customerId: r.customerId,
        customerName: r.customerName,
        openAmount: '0.00',
        shippableAmount: '0.00',
        shipStatus: 'none',
        lines: [],
      };
      orders.set(r.salesOrderId, order);
    }
    order.lines.push({
      lineId: r.lineId,
      itemId: r.itemId,
      itemName: item?.name ?? null,
      sku: item?.sku ?? null,
      description: r.description,
      tracksStock: stock,
      rate: Money.of(r.rate).toFixed(2),
      quantityOrdered: Money.of(r.quantity).toFixed(4),
      quantityInvoiced: Money.of(r.quantityInvoiced).toFixed(4),
      quantityRemaining: remaining.toFixed(4),
      quantityOnHand: onHand ? onHand.toFixed(4) : null,
      quantityAvailable: available ? available.toFixed(4) : null,
      quantityAllocatedBefore: before ? before.toFixed(4) : null,
      canShip: canShip.toFixed(4),
      shipStatus: shipStatusOf(canShip, remaining),
    });
    order.openAmount = toAmountString(Money.of(order.openAmount).plus(Money.round2(remaining.times(Money.of(r.rate)))));
    order.shippableAmount = toAmountString(
      Money.of(order.shippableAmount).plus(Money.round2(canShip.times(Money.of(r.rate)))),
    );
  }

  for (const o of orders.values()) {
    const all = o.lines.every((l) => l.shipStatus === 'complete');
    const any = o.lines.some((l) => Money.gt(l.canShip, 0));
    o.shipStatus = all ? 'complete' : any ? 'partial' : 'none';
  }

  // Filters apply AFTER allocation so they never change availability.
  const fromDay = filters.from ? filters.from.toISOString().slice(0, 10) : null;
  const toDay = filters.to ? filters.to.toISOString().slice(0, 10) : null;
  const wantedOrders = filters.salesOrderIds?.length ? new Set(filters.salesOrderIds) : null;
  const result = [...orders.values()].filter((o) => {
    const day = o.date.toISOString().slice(0, 10);
    if (filters.customerId && o.customerId !== filters.customerId) return false;
    if (fromDay && day < fromDay) return false;
    if (toDay && day > toDay) return false;
    if (filters.shipStatus && o.shipStatus !== filters.shipStatus) return false;
    if (wantedOrders && !wantedOrders.has(o.salesOrderId)) return false;
    if (filters.itemId && !o.lines.some((l) => l.itemId === filters.itemId)) return false;
    return true;
  });

  const itemSummary: WorksheetItem[] = itemRows
    .filter((i) => i.type === 'inventory')
    .map((i) => {
      const onHand = Money.of(i.quantityOnHand ?? '0');
      const so = soCommit.get(i.id) ?? Money.zero();
      const bc = buildCommit.get(i.id) ?? Money.zero();
      return {
        itemId: i.id,
        name: i.name,
        onHand: onHand.toFixed(4),
        committedToOrders: so.toFixed(4),
        committedToBuilds: bc.toFixed(4),
        available: onHand.minus(so).minus(bc).toFixed(4),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    orders: result,
    items: itemSummary,
    totals: {
      orders: result.length,
      complete: result.filter((o) => o.shipStatus === 'complete').length,
      partial: result.filter((o) => o.shipStatus === 'partial').length,
      none: result.filter((o) => o.shipStatus === 'none').length,
      shippableAmount: toAmountString(result.reduce((s, o) => s.plus(Money.of(o.shippableAmount)), Money.zero())),
    },
  };
}

// ---------------------------------------------------------------------------
// Selection -> shipment plan (shared by batch invoicing and the printouts)
// ---------------------------------------------------------------------------

export interface FulfillmentSelection {
  salesOrderId: string;
  /** Explicit quantities; omitted = every line's "can ship" quantity. */
  lines?: Array<{ lineId: string; quantity: string | number }> | null;
}

export interface ShipmentLine {
  lineId: string;
  itemId: string | null;
  itemName: string | null;
  sku: string | null;
  description: string | null;
  quantity: string;
  rate: string;
}

export interface Shipment {
  salesOrderId: string;
  orderNumber: number;
  date: Date;
  customerId: string;
  customerName: string;
  lines: ShipmentLine[];
}

/**
 * Resolve selections into per-order quantities to ship. Explicit quantities may not exceed a
 * line's remaining quantity, and for stock items may not exceed the physical stock left after
 * pending builds and the other shipments in this same batch (an explicit quantity CAN take stock
 * the worksheet reserved for an earlier order — that is the user's call, as in QB).
 */
export async function planShipments(
  ctx: ServiceContext,
  selections: FulfillmentSelection[],
): Promise<Shipment[]> {
  if (!selections || selections.length === 0) throw validation('Select at least one sales order.');
  const ids = selections.map((s) => s.salesOrderId);
  if (new Set(ids).size !== ids.length) throw validation('A sales order is selected twice.');

  const ws = await fulfillmentWorksheet(ctx);
  const byId = new Map(ws.orders.map((o) => [o.salesOrderId, o]));
  const physicalLeft = new Map<string, Dec>();
  for (const i of ws.items) {
    physicalLeft.set(i.itemId, Money.of(i.onHand).minus(Money.of(i.committedToBuilds)));
  }

  // Ship in worksheet priority order so defaults match the screen.
  const ordered = [...selections].sort((a, b) => {
    const oa = ws.orders.findIndex((o) => o.salesOrderId === a.salesOrderId);
    const ob = ws.orders.findIndex((o) => o.salesOrderId === b.salesOrderId);
    return oa - ob;
  });

  const shipments: Shipment[] = [];
  for (const sel of ordered) {
    const order = byId.get(sel.salesOrderId);
    if (!order) {
      throw validation('A selected sales order is not open (it may be closed, void, or fully invoiced).');
    }
    const lineById = new Map(order.lines.map((l) => [l.lineId, l]));
    // An explicit (even empty) line list is honoured as-is; omitted = everything that can ship.
    const requests = sel.lines
      ? sel.lines.map((r) => {
          const line = lineById.get(r.lineId);
          if (!line) throw validation(`Sales order #${order.orderNumber}: a selected line is not open.`);
          return { line, qty: Money.of(r.quantity) };
        })
      : order.lines.map((line) => ({ line, qty: Money.of(line.canShip) }));

    const lines: ShipmentLine[] = [];
    for (const { line, qty } of requests) {
      if (qty.isNegative()) throw validation(`Sales order #${order.orderNumber}: quantity cannot be negative.`);
      if (!qty.greaterThan(0)) continue;
      if (qty.greaterThan(line.quantityRemaining)) {
        throw validation(
          `Sales order #${order.orderNumber}: only ${Money.of(line.quantityRemaining).toString()} of ${line.itemName ?? line.description ?? 'a line'} remain to ship.`,
        );
      }
      if (line.tracksStock && line.itemId) {
        const left = physicalLeft.get(line.itemId) ?? Money.zero();
        if (qty.greaterThan(left)) {
          throw validation(
            `Sales order #${order.orderNumber}: not enough ${line.itemName ?? 'stock'} on hand (${left.toString()} available to ship).`,
          );
        }
        physicalLeft.set(line.itemId, left.minus(qty));
      }
      lines.push({
        lineId: line.lineId,
        itemId: line.itemId,
        itemName: line.itemName,
        sku: line.sku,
        description: line.description,
        quantity: qty.toFixed(4),
        rate: line.rate,
      });
    }
    if (lines.length > 0) {
      shipments.push({
        salesOrderId: order.salesOrderId,
        orderNumber: order.orderNumber,
        date: order.date,
        customerId: order.customerId,
        customerName: order.customerName,
        lines,
      });
    }
  }
  return shipments;
}

// ---------------------------------------------------------------------------
// Batch invoicing
// ---------------------------------------------------------------------------

export interface BatchInvoiceResult {
  salesOrderId: string;
  orderNumber: number;
  customerName: string;
  ok: boolean;
  invoiceId?: string;
  invoiceNumber?: number;
  total?: string;
  error?: string;
}

/**
 * Create one invoice per selected sales order for what can ship. Orders with nothing to ship
 * are reported (not invoiced). Each order commits independently.
 */
export async function batchInvoiceSalesOrders(
  ctx: ServiceContext,
  input: { selections: FulfillmentSelection[]; date?: Date | null },
): Promise<{ results: BatchInvoiceResult[]; invoiced: number; failed: number }> {
  const shipments = await planShipments(ctx, input.selections);
  const results: BatchInvoiceResult[] = [];
  const shippedIds = new Set(shipments.map((s) => s.salesOrderId));

  for (const s of shipments) {
    try {
      const invoice = await convertToInvoice(ctx, s.salesOrderId, {
        date: input.date ?? undefined,
        lines: s.lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity })),
      });
      results.push({
        salesOrderId: s.salesOrderId,
        orderNumber: s.orderNumber,
        customerName: s.customerName,
        ok: true,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        total: invoice.total,
      });
    } catch (err) {
      results.push({
        salesOrderId: s.salesOrderId,
        orderNumber: s.orderNumber,
        customerName: s.customerName,
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to invoice this order.',
      });
    }
  }

  // Selected orders with nothing shippable.
  const ws = await fulfillmentWorksheet(ctx, { salesOrderIds: input.selections.map((s) => s.salesOrderId) });
  for (const sel of input.selections) {
    if (shippedIds.has(sel.salesOrderId)) continue;
    const o = ws.orders.find((x) => x.salesOrderId === sel.salesOrderId);
    results.push({
      salesOrderId: sel.salesOrderId,
      orderNumber: o?.orderNumber ?? 0,
      customerName: o?.customerName ?? '',
      ok: false,
      error: 'Nothing can ship on this order yet.',
    });
  }

  return {
    results,
    invoiced: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}
