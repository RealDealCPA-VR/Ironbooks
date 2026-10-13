/**
 * Inventory Center (QB Enterprise): every inventory item with its stock picture, and for one item
 * its details plus every transaction that used it. Read-only.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  billLines,
  bills,
  creditMemoLines,
  creditMemos,
  customers,
  inventoryLayers,
  invoiceLines,
  invoices,
  itemReceiptLines,
  itemReceipts,
  items,
  journalEntries,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  salesReceiptLines,
  salesReceipts,
  uomSets,
  vendors,
} from '@/lib/db/schema';
import { type ServiceContext, notFound } from '../_base';
import { stockStatus } from '../inventory';

export interface InventoryCenterRow {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  isActive: boolean;
  quantityOnHand: string;
  committed: string;
  available: string;
  onPO: string;
  reorderPoint: string | null;
  averageCost: string;
  /** On-hand value: FIFO layers when the item is FIFO-costed, else quantity × average cost. */
  value: string;
  costing: 'fifo' | 'average';
  salesPrice: string | null;
  preferredVendorId: string | null;
  preferredVendorName: string | null;
  needsReorder: boolean;
}

export async function inventoryCenterList(
  ctx: ServiceContext,
  opts: { includeInactive?: boolean; search?: string } = {},
): Promise<InventoryCenterRow[]> {
  const conds = [eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')];
  if (!opts.includeInactive) conds.push(eq(items.isActive, true));
  if (opts.search?.trim()) conds.push(sql`(${items.name} ILIKE ${'%' + opts.search.trim() + '%'} OR ${items.sku} ILIKE ${'%' + opts.search.trim() + '%'})`);
  const rows = await ctx.db
    .select({ item: items, vendorName: vendors.displayName })
    .from(items)
    .leftJoin(vendors, eq(vendors.id, items.preferredVendorId))
    .where(and(...conds))
    .orderBy(asc(items.name));
  if (rows.length === 0) return [];
  const status = await stockStatus(ctx);
  const byId = new Map(status.rows.map((r) => [r.id, r]));
  const layers = await ctx.db
    .select({
      itemId: inventoryLayers.itemId,
      value: sql<string>`COALESCE(SUM(${inventoryLayers.quantityRemaining} * ${inventoryLayers.unitCost}), 0)`,
      n: sql<number>`COUNT(*)`,
    })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, ctx.companyId), inArray(inventoryLayers.itemId, rows.map((r) => r.item.id))))
    .groupBy(inventoryLayers.itemId);
  const fifo = new Map(layers.map((l) => [l.itemId, l]));
  return rows.map(({ item, vendorName }) => {
    const s = byId.get(item.id);
    const qoh = new Decimal(item.quantityOnHand ?? 0);
    const avg = new Decimal(item.averageCost ?? 0);
    const f = fifo.get(item.id);
    const value = f && Number(f.n) > 0 ? new Decimal(f.value) : qoh.times(avg);
    const available = new Decimal(s?.available ?? qoh);
    const onPO = new Decimal(s?.onPO ?? 0);
    const rp = item.reorderPoint != null ? new Decimal(item.reorderPoint) : null;
    return {
      id: item.id,
      name: item.name,
      sku: item.sku,
      description: item.description,
      isActive: item.isActive,
      quantityOnHand: qoh.toFixed(4),
      committed: s?.committed ?? '0.0000',
      available: available.toFixed(4),
      onPO: onPO.toFixed(4),
      reorderPoint: item.reorderPoint,
      averageCost: avg.toFixed(4),
      value: value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      costing: f && Number(f.n) > 0 ? 'fifo' : 'average',
      salesPrice: item.salesPrice,
      preferredVendorId: item.preferredVendorId,
      preferredVendorName: vendorName ?? null,
      needsReorder: rp !== null && available.plus(onPO).lessThanOrEqualTo(rp),
    };
  });
}

export interface ItemTransaction {
  type: string;
  /** Route segment of the document (e.g. 'invoices'), for drill-down links. */
  path: string | null;
  id: string;
  number: string | null;
  date: Date;
  name: string | null;
  /** Signed effect on quantity on hand (+ in, - out); 0 for orders. */
  quantity: string;
  amount: string | null;
  status: string | null;
}

export async function inventoryItemDetail(ctx: ServiceContext, itemId: string) {
  const [item] = await ctx.db.select().from(items).where(and(eq(items.id, itemId), eq(items.companyId, ctx.companyId)));
  if (!item) throw notFound('Item');
  const center = (await inventoryCenterList(ctx, { includeInactive: true })).find((r) => r.id === itemId) ?? null;
  const uom = item.uomSetId
    ? (await ctx.db.select({ name: uomSets.name, base: uomSets.baseUnitName }).from(uomSets).where(eq(uomSets.id, item.uomSetId)))[0] ?? null
    : null;
  const c = ctx.companyId;
  const tx: ItemTransaction[] = [];
  const neg = (q: string | number) => new Decimal(q).negated().toFixed(4);
  const pos = (q: string | number) => new Decimal(q).toFixed(4);

  for (const r of await ctx.db
    .select({ id: invoices.id, number: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))`, date: invoices.date, name: customers.displayName, qty: invoiceLines.quantity, amount: invoiceLines.amount, status: invoices.status })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.companyId, c), eq(invoiceLines.itemId, itemId)))) {
    tx.push({ type: 'Invoice', path: 'invoices', id: r.id, number: String(r.number), date: r.date, name: r.name, quantity: r.status === 'void' || r.status === 'draft' ? '0.0000' : neg(r.qty), amount: r.amount, status: r.status });
  }
  for (const r of await ctx.db
    .select({ id: salesReceipts.id, number: sql<string>`COALESCE(NULLIF(${salesReceipts.refNumber}, ''), CAST(${salesReceipts.receiptNumber} AS TEXT))`, date: salesReceipts.date, name: customers.displayName, qty: salesReceiptLines.quantity, amount: salesReceiptLines.amount, status: salesReceipts.status })
    .from(salesReceiptLines)
    .innerJoin(salesReceipts, eq(salesReceipts.id, salesReceiptLines.salesReceiptId))
    .leftJoin(customers, eq(customers.id, salesReceipts.customerId))
    .where(and(eq(salesReceipts.companyId, c), eq(salesReceiptLines.itemId, itemId)))) {
    tx.push({ type: 'Sales Receipt', path: 'sales-receipts', id: r.id, number: String(r.number), date: r.date, name: r.name, quantity: r.status === 'void' ? '0.0000' : neg(r.qty), amount: r.amount, status: r.status });
  }
  for (const r of await ctx.db
    .select({ id: creditMemos.id, number: sql<string>`COALESCE(NULLIF(${creditMemos.refNumber}, ''), CAST(${creditMemos.memoNumber} AS TEXT))`, date: creditMemos.date, name: customers.displayName, qty: creditMemoLines.quantity, amount: creditMemoLines.amount, status: creditMemos.status })
    .from(creditMemoLines)
    .innerJoin(creditMemos, eq(creditMemos.id, creditMemoLines.creditMemoId))
    .leftJoin(customers, eq(customers.id, creditMemos.customerId))
    .where(and(eq(creditMemos.companyId, c), eq(creditMemoLines.itemId, itemId)))) {
    tx.push({ type: 'Credit Memo', path: 'credit-memos', id: r.id, number: String(r.number), date: r.date, name: r.name, quantity: r.status === 'void' ? '0.0000' : pos(r.qty), amount: r.amount, status: r.status });
  }
  for (const r of await ctx.db
    .select({ id: bills.id, number: bills.billNumber, date: bills.date, name: vendors.displayName, qty: billLines.quantity, amount: billLines.amount, status: bills.status })
    .from(billLines)
    .innerJoin(bills, eq(bills.id, billLines.billId))
    .leftJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(and(eq(bills.companyId, c), eq(billLines.itemId, itemId)))) {
    tx.push({ type: 'Bill', path: 'bills', id: r.id, number: r.number, date: r.date, name: r.name, quantity: r.status === 'void' ? '0.0000' : pos(r.qty), amount: r.amount, status: r.status });
  }
  for (const r of await ctx.db
    .select({ id: itemReceipts.id, number: itemReceipts.reference, date: itemReceipts.date, name: vendors.displayName, qty: itemReceiptLines.quantity, amount: itemReceiptLines.amount, status: itemReceipts.status })
    .from(itemReceiptLines)
    .innerJoin(itemReceipts, eq(itemReceipts.id, itemReceiptLines.itemReceiptId))
    .leftJoin(vendors, eq(vendors.id, itemReceipts.vendorId))
    .where(and(eq(itemReceipts.companyId, c), eq(itemReceiptLines.itemId, itemId)))) {
    tx.push({ type: 'Item Receipt', path: 'item-receipts', id: r.id, number: r.number, date: r.date, name: r.name, quantity: r.status === 'void' ? '0.0000' : pos(r.qty), amount: r.amount, status: r.status });
  }
  for (const r of await ctx.db
    .select({ id: purchaseOrders.id, number: sql<string>`COALESCE(NULLIF(${purchaseOrders.refNumber}, ''), CAST(${purchaseOrders.poNumber} AS TEXT))`, date: purchaseOrders.date, name: vendors.displayName, qty: purchaseOrderLines.quantity, amount: purchaseOrderLines.amount, status: purchaseOrders.status })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .leftJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(and(eq(purchaseOrders.companyId, c), eq(purchaseOrderLines.itemId, itemId)))) {
    tx.push({ type: 'Purchase Order', path: 'purchase-orders', id: r.id, number: String(r.number), date: r.date, name: r.name, quantity: '0.0000', amount: r.amount, status: r.status });
  }
  for (const r of await ctx.db
    .select({ id: salesOrders.id, number: sql<string>`COALESCE(NULLIF(${salesOrders.refNumber}, ''), CAST(${salesOrders.orderNumber} AS TEXT))`, date: salesOrders.date, name: customers.displayName, amount: salesOrderLines.amount, status: salesOrders.status })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrders.id, salesOrderLines.salesOrderId))
    .leftJoin(customers, eq(customers.id, salesOrders.customerId))
    .where(and(eq(salesOrders.companyId, c), eq(salesOrderLines.itemId, itemId)))) {
    tx.push({ type: 'Sales Order', path: 'sales-orders', id: r.id, number: String(r.number), date: r.date, name: r.name, quantity: '0.0000', amount: r.amount, status: r.status });
  }
  // Adjustments, opening stock, physical counts and FIFO receipts post with sourceRef item:<id>.
  for (const r of await ctx.db
    .select({ id: journalEntries.id, number: journalEntries.entryNumber, date: journalEntries.date, description: journalEntries.description, status: journalEntries.status })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, c), eq(journalEntries.sourceRef, `item:${itemId}`)))
    .orderBy(desc(journalEntries.date))) {
    tx.push({ type: 'Inventory Adjustment', path: 'journal', id: r.id, number: String(r.number), date: r.date, name: r.description, quantity: '0.0000', amount: null, status: r.status });
  }

  tx.sort((a, b) => b.date.getTime() - a.date.getTime());
  return { item, stock: center, uomSet: uom, transactions: tx };
}
