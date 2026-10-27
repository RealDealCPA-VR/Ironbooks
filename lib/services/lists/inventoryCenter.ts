/**
 * Inventory Center (QB Enterprise): every inventory item with its stock picture, and for one item
 * its details plus every transaction that used it. Read-only.
 */
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  auditLogs,
  billLines,
  bills,
  creditMemoLines,
  creditMemos,
  customers,
  expenseLines,
  expenses,
  inventoryLayers,
  inventoryMovements,
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
  vendorCreditLines,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { type ServiceContext, notFound } from '../_base';
import { carriedValueRemainder, fifoLayerValueSql, stockStatus } from '../inventory';
import { Money } from '@/lib/money';

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
  /**
   * On-hand value as the Inventory Valuation Summary shows it: FIFO layers when the item is
   * FIFO-costed, else quantity × average cost plus the item's value remainder.
   */
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
      value: fifoLayerValueSql(), // the valuation reports' rule (per-layer cents)
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
    // Average cost: the book value plus the value remainder the GL carries for the item (the
    // cents a 4dp average cannot show), exactly as the Inventory Valuation Summary values it.
    const value =
      f && Number(f.n) > 0 ? new Decimal(f.value) : Money.round2(qoh.times(avg)).plus(carriedValueRemainder(item));
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
    .select({ id: creditMemos.id, number: sql<string>`COALESCE(NULLIF(${creditMemos.refNumber}, ''), CAST(${creditMemos.memoNumber} AS TEXT))`, date: creditMemos.date, name: customers.displayName, qty: creditMemoLines.quantity, restock: creditMemoLines.restock, amount: creditMemoLines.amount, status: creditMemos.status })
    .from(creditMemoLines)
    .innerJoin(creditMemos, eq(creditMemos.id, creditMemoLines.creditMemoId))
    .leftJoin(customers, eq(customers.id, creditMemos.customerId))
    .where(and(eq(creditMemos.companyId, c), eq(creditMemoLines.itemId, itemId)))) {
    // A line not marked "restock" (damaged goods) puts nothing back on hand.
    tx.push({ type: 'Credit Memo', path: 'credit-memos', id: r.id, number: String(r.number), date: r.date, name: r.name, quantity: r.status === 'void' || !r.restock ? '0.0000' : pos(r.qty), amount: r.amount, status: r.status });
  }
  for (const r of await ctx.db
    .select({ id: bills.id, number: bills.billNumber, date: bills.date, name: vendors.displayName, qty: billLines.quantity, amount: billLines.amount, status: bills.status })
    .from(billLines)
    .innerJoin(bills, eq(bills.id, billLines.billId))
    .leftJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(and(eq(bills.companyId, c), eq(billLines.itemId, itemId)))) {
    tx.push({ type: 'Bill', path: 'bills', id: r.id, number: r.number, date: r.date, name: r.name, quantity: r.status === 'void' ? '0.0000' : pos(r.qty), amount: r.amount, status: r.status });
  }
  // Checks / credit-card charges with an Items tab (Write Checks, Enter Credit Card Charges).
  for (const r of await ctx.db
    .select({ id: expenses.id, number: expenses.reference, date: expenses.date, method: expenses.method, payee: expenses.payeeName, vendor: vendors.displayName, qty: expenseLines.quantity, amount: expenseLines.amount, voidedAt: expenses.voidedAt })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenses.id, expenseLines.expenseId))
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .where(and(eq(expenses.companyId, c), eq(expenseLines.itemId, itemId)))) {
    const type = r.method === 'credit_card' ? 'Credit Card Charge' : r.method === 'cash' ? 'Cash Expense' : 'Check';
    tx.push({ type, path: 'expenses', id: r.id, number: r.number, date: r.date, name: r.vendor ?? r.payee, quantity: r.voidedAt || r.qty == null ? '0.0000' : pos(r.qty), amount: r.amount, status: r.voidedAt ? 'void' : null });
  }
  // Vendor credits returning the item (Items tab).
  for (const r of await ctx.db
    .select({ id: vendorCredits.id, number: vendorCredits.refNumber, date: vendorCredits.date, name: vendors.displayName, qty: vendorCreditLines.quantity, amount: vendorCreditLines.amount, status: vendorCredits.status })
    .from(vendorCreditLines)
    .innerJoin(vendorCredits, eq(vendorCredits.id, vendorCreditLines.vendorCreditId))
    .leftJoin(vendors, eq(vendors.id, vendorCredits.vendorId))
    .where(and(eq(vendorCredits.companyId, c), eq(vendorCreditLines.itemId, itemId)))) {
    tx.push({ type: 'Vendor Credit', path: 'vendor-credits', id: r.id, number: r.number, date: r.date, name: r.name, quantity: r.status === 'void' || r.qty == null ? '0.0000' : neg(r.qty), amount: r.amount, status: r.status });
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
  // Build / unbuild assemblies (the item as a component or as the assembly): its site movements.
  for (const r of await ctx.db
    .select({
      id: inventoryMovements.sourceId,
      sourceType: inventoryMovements.sourceType,
      date: sql<Date>`MIN(${inventoryMovements.date})`,
      qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.companyId, c),
        eq(inventoryMovements.itemId, itemId),
        inArray(inventoryMovements.sourceType, ['build', 'unbuild']),
      ),
    )
    .groupBy(inventoryMovements.sourceId, inventoryMovements.sourceType)) {
    if (!r.id) continue;
    tx.push({ type: r.sourceType === 'build' ? 'Build Assembly' : 'Unbuild Assembly', path: null, id: r.id, number: null, date: new Date(r.date), name: null, quantity: new Decimal(r.qty).toFixed(4), amount: null, status: null });
  }
  // Adjustments, opening stock, physical counts and FIFO receipts post with sourceRef item:<id>.
  // The quantity each moved: its site movement (Adjust Quantity), else what its audit row records
  // (physical count, opening stock, FIFO consumption); value-only entries move none.
  const adjustmentEntries = await ctx.db
    .select({ id: journalEntries.id, number: journalEntries.entryNumber, date: journalEntries.date, description: journalEntries.description, status: journalEntries.status })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, c), eq(journalEntries.sourceRef, `item:${itemId}`)))
    .orderBy(desc(journalEntries.date));
  const movedBy = new Map<string, Decimal>();
  if (adjustmentEntries.length > 0) {
    for (const m of await ctx.db
      .select({ sourceId: inventoryMovements.sourceId, qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)` })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.companyId, c),
          eq(inventoryMovements.itemId, itemId),
          eq(inventoryMovements.sourceType, 'adjustment'),
          sql`${inventoryMovements.reversalOfId} IS NULL`,
        ),
      )
      .groupBy(inventoryMovements.sourceId)) {
      if (m.sourceId) movedBy.set(m.sourceId, new Decimal(m.qty));
    }
    const num = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? new Decimal(v) : null);
    // Only the audit rows of the entries still without a quantity (physical counts, opening stock,
    // FIFO removals with no site movement) — never the item's whole audit history, which holds a
    // row (with its layer draws) for every FIFO sale and receipt.
    const missing = adjustmentEntries.filter((r) => r.status === 'posted' && !movedBy.has(r.id)).map((r) => r.id);
    const auditRows: Array<{ oldValues: unknown; newValues: unknown }> = [];
    for (let at = 0; at < missing.length; at += 500) {
      const ids = missing.slice(at, at + 500);
      auditRows.push(
        ...(await ctx.db
          .select({ oldValues: auditLogs.oldValues, newValues: auditLogs.newValues })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.companyId, c),
              eq(auditLogs.entityType, 'item'),
              eq(auditLogs.entityId, itemId),
              or(
                inArray(sql<string>`${auditLogs.newValues}->>'postedEntryId'`, ids),
                inArray(sql<string>`${auditLogs.newValues}->>'entryId'`, ids),
                inArray(sql<string>`${auditLogs.newValues}->'openingStock'->>'entryId'`, ids),
              ),
            ),
          )),
      );
    }
    for (const a of auditRows) {
      const nv = (a.newValues ?? {}) as Record<string, unknown>;
      const ov = (a.oldValues ?? {}) as Record<string, unknown>;
      const opening = nv.openingStock as Record<string, unknown> | undefined;
      const newQty = num(nv.quantityOnHand);
      const oldQty = num(ov.quantityOnHand);
      if (typeof nv.postedEntryId === 'string' && newQty && oldQty) {
        if (!movedBy.has(nv.postedEntryId)) movedBy.set(nv.postedEntryId, newQty.minus(oldQty));
      } else if (typeof nv.entryId === 'string' && num(nv.quantityConsumed)) {
        if (!movedBy.has(nv.entryId)) movedBy.set(nv.entryId, num(nv.quantityConsumed)!.negated());
      } else if (opening && typeof opening.entryId === 'string' && num(opening.quantity)) {
        if (!movedBy.has(opening.entryId)) movedBy.set(opening.entryId, num(opening.quantity)!);
      }
    }
  }
  for (const r of adjustmentEntries) {
    const moved = r.status === 'posted' ? movedBy.get(r.id) : undefined;
    tx.push({ type: 'Inventory Adjustment', path: 'journal', id: r.id, number: String(r.number), date: r.date, name: r.description, quantity: moved ? moved.toFixed(4) : '0.0000', amount: null, status: r.status });
  }

  tx.sort((a, b) => b.date.getTime() - a.date.getTime());
  return { item, stock: center, uomSet: uom, transactions: tx };
}
