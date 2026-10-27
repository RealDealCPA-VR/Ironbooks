/**
 * Item utilities:
 *  - changeItemPrices — QB "Change Item Prices": raise/lower sales prices by a percent or amount,
 *    based on the current price or on cost, for chosen items or a whole item type (preview first);
 *  - createPurchaseOrdersFromReorder — turn the reorder list into purchase orders, one per
 *    preferred vendor (items without a preferred vendor are reported, not ordered);
 *  - stockStatusByVendor — QB "Inventory Stock Status by Vendor".
 * Prices and POs are not postings: no GL impact.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { items, vendors } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, inTransaction, validation, writeAudit } from '../_base';
import { stockStatus, todayCalendarDay, type StockStatusRow } from '../inventory';
import { reorderReport } from '../inventoryOps';
import { createPurchaseOrder } from '../purchaseOrders';

// ---------------------------------------------------------------------------
// Change Item Prices
// ---------------------------------------------------------------------------

export type PriceRounding = 'none' | 'cent' | 'dime' | 'dollar' | 'up_99';

export interface ChangeItemPricesInput {
  itemIds?: string[];
  itemType?: 'service' | 'inventory' | 'non_inventory' | 'bundle' | 'other_charge';
  basis?: 'price' | 'cost';
  adjustBy: 'percent' | 'amount';
  value: string | number;
  rounding?: PriceRounding;
  dryRun?: boolean;
}

export interface PriceChangeRow {
  id: string;
  name: string;
  type: string;
  currentPrice: string | null;
  cost: string | null;
  newPrice: string | null;
  /** Why the item was skipped (no basis value, would go negative...). */
  skipped?: string;
}

function roundPrice(v: Decimal, mode: PriceRounding): Decimal {
  switch (mode) {
    case 'none':
      // No extra rounding — but items.sales_price is numeric(15,2), so the price is still kept to
      // the cent: what the preview shows is exactly what gets saved.
      return v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    case 'dime':
      return v.times(10).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).dividedBy(10);
    case 'dollar':
      return v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    case 'up_99': {
      // Next price ending in .99 at or above the value (9.10 → 9.99, 10.00 → 10.99).
      const whole = v.floor();
      const candidate = whole.plus('0.99');
      return candidate.greaterThanOrEqualTo(v) ? candidate : candidate.plus(1);
    }
    case 'cent':
    default:
      return v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
}

const PRICED_TYPES = ['service', 'inventory', 'non_inventory', 'bundle', 'other_charge'] as const;

export async function changeItemPrices(ctx: ServiceContext, input: ChangeItemPricesInput) {
  const value = Money.of(input.value);
  if (!value.isFinite()) throw validation('Enter a number to change prices by.');
  if (input.adjustBy === 'percent' && value.lessThanOrEqualTo(-100)) {
    throw validation('A decrease of 100% or more would make prices zero or negative.');
  }
  const basis = input.basis ?? 'price';
  const rounding = input.rounding ?? 'cent';
  const conds = [eq(items.companyId, ctx.companyId), eq(items.isActive, true), inArray(items.type, [...PRICED_TYPES])];
  if (input.itemIds?.length) conds.push(inArray(items.id, input.itemIds));
  else if (input.itemType) conds.push(eq(items.type, input.itemType));
  else throw validation('Choose the items (or an item type) whose prices should change.');
  const rows = await ctx.db.select().from(items).where(and(...conds));
  if (input.itemIds?.length && rows.length !== new Set(input.itemIds).size) {
    throw validation('Some selected items were not found, are inactive, or cannot carry a price.');
  }

  const changes: PriceChangeRow[] = rows
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => {
      const base = basis === 'cost' ? r.purchaseCost : r.salesPrice;
      const row: PriceChangeRow = {
        id: r.id,
        name: r.name,
        type: r.type,
        currentPrice: r.salesPrice,
        cost: r.purchaseCost,
        newPrice: null,
      };
      if (base == null) {
        row.skipped = basis === 'cost' ? 'No cost entered' : 'No current price';
        return row;
      }
      const b = Money.of(base);
      const raw = input.adjustBy === 'percent' ? b.times(new Decimal(100).plus(value)).dividedBy(100) : b.plus(value);
      const np = roundPrice(raw, rounding);
      if (np.isNegative()) {
        row.skipped = 'The new price would be below zero';
        return row;
      }
      row.newPrice = np.toFixed(2); // the column's scale
      return row;
    });

  const toApply = changes.filter((c) => !c.skipped && c.newPrice !== null && !Money.eq(c.newPrice, c.currentPrice ?? 'NaN'));
  if (input.dryRun) return { dryRun: true, changes, changed: toApply.length };

  await inTransaction(ctx, async (tx) => {
    for (const c of toApply) {
      await tx.db.update(items).set({ salesPrice: c.newPrice, updatedAt: new Date() }).where(eq(items.id, c.id));
      await writeAudit(tx, {
        action: 'update',
        entityType: 'item',
        entityId: c.id,
        oldValues: { salesPrice: c.currentPrice },
        newValues: { salesPrice: c.newPrice, reason: 'Change Item Prices' },
      });
    }
  });
  return { dryRun: false, changes, changed: toApply.length };
}

// ---------------------------------------------------------------------------
// Purchase orders from the reorder list
// ---------------------------------------------------------------------------

export interface ReorderPoInput {
  itemIds?: string[];
  quantities?: Record<string, string | number>;
  date?: Date;
  dryRun?: boolean;
}

export async function createPurchaseOrdersFromReorder(ctx: ServiceContext, input: ReorderPoInput = {}) {
  const report = await reorderReport(ctx);
  let rows = report.rows;
  if (input.itemIds?.length) {
    const wanted = new Set(input.itemIds);
    rows = rows.filter((r) => wanted.has(r.id));
    if (rows.length !== wanted.size) {
      throw validation('Some selected items are not on the reorder list (they are above their reorder point).');
    }
  }
  if (rows.length === 0) throw validation('Nothing needs reordering right now.');
  const meta = await ctx.db
    .select({ id: items.id, preferredVendorId: items.preferredVendorId, purchaseCost: items.purchaseCost, description: items.description })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, rows.map((r) => r.id))));
  const metaById = new Map(meta.map((m) => [m.id, m]));
  const vendorIds = [...new Set(meta.map((m) => m.preferredVendorId).filter((v): v is string => !!v))];
  const vendorRows = vendorIds.length
    ? await ctx.db.select({ id: vendors.id, name: vendors.displayName, isActive: vendors.isActive }).from(vendors).where(inArray(vendors.id, vendorIds))
    : [];
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));

  const groups = new Map<string, Array<{ itemId: string; name: string; quantity: string; rate: string; description: string | null }>>();
  const withoutVendor: Array<{ itemId: string; name: string }> = [];
  for (const r of rows) {
    const m = metaById.get(r.id);
    const vendorId = m?.preferredVendorId;
    if (!vendorId || !vendorById.get(vendorId)?.isActive) {
      withoutVendor.push({ itemId: r.id, name: r.name });
      continue;
    }
    const override = input.quantities?.[r.id];
    const qty = override != null && override !== '' ? Money.of(override) : Money.of(r.suggestedReorderQty);
    if (qty.lessThanOrEqualTo(0)) throw validation(`The order quantity for "${r.name}" must be greater than zero.`);
    const rate = Money.of(m?.purchaseCost ?? r.averageCost ?? 0);
    const list = groups.get(vendorId) ?? [];
    list.push({ itemId: r.id, name: r.name, quantity: qty.toFixed(4), rate: rate.toFixed(4), description: m?.description ?? r.name });
    groups.set(vendorId, list);
  }
  const plan = [...groups.entries()].map(([vendorId, lines]) => ({
    vendorId,
    vendorName: vendorById.get(vendorId)?.name ?? '',
    lines,
    total: lines.reduce((s, l) => s.plus(Money.round2(Money.of(l.quantity).times(l.rate))), new Decimal(0)).toFixed(2),
  }));
  if (input.dryRun) return { dryRun: true, purchaseOrders: plan, withoutVendor };
  if (plan.length === 0) {
    throw validation('None of these items has an active preferred vendor. Set one on each item first.');
  }
  // Today's calendar day (the stored-date convention), not the UTC instant: in the evening west of
  // UTC that is already tomorrow.
  const date = input.date ?? todayCalendarDay();
  const created = await inTransaction(ctx, async (tx) => {
    const out = [];
    for (const p of plan) {
      const po = await createPurchaseOrder(tx, {
        vendorId: p.vendorId,
        date,
        memo: 'Created from the reorder list',
        lines: p.lines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate })),
      });
      out.push({ ...p, purchaseOrderId: (po as { id: string }).id, poNumber: (po as { refNumber?: string | null; poNumber?: number }).refNumber || (po as { poNumber?: number }).poNumber || null });
    }
    return out;
  });
  return { dryRun: false, purchaseOrders: created, withoutVendor };
}

// ---------------------------------------------------------------------------
// Stock status by vendor
// ---------------------------------------------------------------------------

export interface StockStatusVendorGroup {
  vendorId: string | null;
  vendorName: string;
  rows: StockStatusRow[];
}

export async function stockStatusByVendor(ctx: ServiceContext): Promise<{ groups: StockStatusVendorGroup[] }> {
  const status = await stockStatus(ctx);
  if (status.rows.length === 0) return { groups: [] };
  const meta = await ctx.db
    .select({ id: items.id, preferredVendorId: items.preferredVendorId })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, status.rows.map((r) => r.id))));
  const vendorOf = new Map(meta.map((m) => [m.id, m.preferredVendorId]));
  const vendorIds = [...new Set(meta.map((m) => m.preferredVendorId).filter((v): v is string => !!v))];
  const vendorRows = vendorIds.length
    ? await ctx.db.select({ id: vendors.id, name: vendors.displayName }).from(vendors).where(inArray(vendors.id, vendorIds))
    : [];
  const nameOf = new Map(vendorRows.map((v) => [v.id, v.name]));
  const groups = new Map<string, StockStatusVendorGroup>();
  for (const r of status.rows) {
    const vid = vendorOf.get(r.id) ?? null;
    const key = vid ?? '';
    const g = groups.get(key) ?? { vendorId: vid, vendorName: vid ? nameOf.get(vid) ?? '' : 'No preferred vendor', rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return {
    groups: [...groups.values()].sort((a, b) => (a.vendorId === null ? 1 : b.vendorId === null ? -1 : a.vendorName.localeCompare(b.vendorName))),
  };
}

/** Items using a vendor as preferred vendor (vendor detail / merge preview). */
export async function itemsWithPreferredVendor(ctx: ServiceContext, vendorId: string) {
  return ctx.db
    .select({ id: items.id, name: items.name })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.preferredVendorId, vendorId), ne(items.isActive, false)));
}
