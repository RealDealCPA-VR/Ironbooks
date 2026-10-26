/**
 * Server helpers behind the fulfillment printouts (app/api/fulfillment/pick-list and
 * packing-slips). The selection travels in the `s` query parameter as JSON so the PDFs can be
 * opened with a plain GET (window.open works the same in the browser and in Electron).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { customers, salesOrders } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';
import { validation } from '@/lib/services/_base';
import { planShipments, type Shipment } from '@/lib/services/fulfillment';
import { fulfillmentSelectionSchema } from '@/lib/validation/pricing';
import type { PickListRow } from '@/lib/pdf/pickList';
import type { PackingSlipData } from '@/lib/pdf/packingSlip';

export async function shipmentsFromQuery(ctx: ServiceContext, raw: string | null): Promise<Shipment[]> {
  let json: unknown;
  try {
    json = JSON.parse(raw ?? '');
  } catch {
    throw validation('Missing or invalid selection.');
  }
  const parsed = z.array(fulfillmentSelectionSchema).min(1).safeParse(json);
  if (!parsed.success) throw validation('Missing or invalid selection.');
  return planShipments(ctx, parsed.data);
}

/** Aggregate shipments into pick-list rows (one per item; free-form lines by description). */
export function pickRows(shipments: Shipment[]): PickListRow[] {
  const rows = new Map<string, PickListRow>();
  for (const s of shipments) {
    for (const l of s.lines) {
      const key = l.itemId ?? `desc:${l.description ?? ''}`;
      const row = rows.get(key) ?? {
        itemName: l.itemName ?? l.description ?? 'Item',
        sku: l.sku,
        description: l.itemName ? l.description : null,
        totalQuantity: '0',
        orders: [],
      };
      row.totalQuantity = String(Math.round((Number(row.totalQuantity) + Number(l.quantity)) * 10000) / 10000);
      row.orders.push({ orderNumber: s.refNumber || s.orderNumber, customerName: s.customerName, quantity: l.quantity });
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
}

function addressLines(addr: Record<string, string> | null | undefined): string[] {
  if (!addr) return [];
  const out: string[] = [];
  if (addr.line1?.trim()) out.push(addr.line1.trim());
  if (addr.line2?.trim()) out.push(addr.line2.trim());
  const csz = [addr.city?.trim(), addr.state?.trim()].filter(Boolean).join(', ');
  const line3 = [csz, addr.zip?.trim()].filter(Boolean).join(' ');
  if (line3) out.push(line3);
  if (addr.country?.trim()) out.push(addr.country.trim());
  return out;
}

/**
 * One packing slip per sales order. Ship to: the sales order's own ship-to address (QB
 * Enterprise: the order can go to any of the customer's ship-to addresses), else the customer's
 * shipping address, else the billing address.
 */
export async function packingSlipData(
  ctx: ServiceContext,
  companyName: string,
  shipments: Shipment[],
  date: string,
): Promise<PackingSlipData[]> {
  const ids = [...new Set(shipments.map((s) => s.customerId))];
  const rows = ids.length
    ? await ctx.db
        .select({ id: customers.id, shippingAddress: customers.shippingAddress, billingAddress: customers.billingAddress })
        .from(customers)
        .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, ids)))
    : [];
  const addr = new Map(rows.map((r) => [r.id, addressLines(r.shippingAddress ?? r.billingAddress)]));
  const orderIds = [...new Set(shipments.map((s) => s.salesOrderId))];
  const orders = orderIds.length
    ? await ctx.db
        .select({ id: salesOrders.id, shipTo: salesOrders.shipTo })
        .from(salesOrders)
        .where(and(eq(salesOrders.companyId, ctx.companyId), inArray(salesOrders.id, orderIds)))
    : [];
  const orderShipTo = new Map(orders.map((o) => [o.id, addressLines(o.shipTo as Record<string, string> | null)]));
  return shipments.map((s) => ({
    company: { name: companyName },
    customerName: s.customerName,
    shipToLines: orderShipTo.get(s.salesOrderId)?.length ? orderShipTo.get(s.salesOrderId)! : (addr.get(s.customerId) ?? []),
    slip: { invoiceNumber: '', label: `Sales Order #${s.refNumber || s.orderNumber}`, date, orderNumber: null },
    lines: s.lines.map((l) => ({ itemName: l.itemName, description: l.description ?? '', quantity: l.quantity })),
  }));
}
