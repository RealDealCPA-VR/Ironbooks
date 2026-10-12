/**
 * Advanced Inventory operations: quantity adjustments at a site (with serial/lot capture) and
 * per-site reorder points.
 *
 * adjustQuantityAtSite is QB "Adjust Quantity/Value on Hand" (quantity mode) with a site. The
 * costing side is delegated unchanged to the existing engines — average-cost items through
 * inventory.adjustInventory (Dr Inventory / Cr 3000 for adds, Dr COGS / Cr Inventory for
 * removals), FIFO-tracked items through fifo.receiveStock / fifo.consumeStock — so every value
 * change still posts a balanced entry via posting.ts. The site-tagged movement (sourceType
 * 'adjustment', sourceId = the posted journal entry) is written in the same transaction.
 */
import { and, eq, sql } from 'drizzle-orm';
import { inventoryLayers, itemSiteSettings, items } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { adjustInventory } from './inventory';
import { consumeStock, receiveStock } from './fifo';
import { type InventoryLineDetail, getSite, recordMovements } from './inventorySites';

export interface SiteAdjustmentInput extends InventoryLineDetail {
  itemId: string;
  /** Positive = add stock, negative = remove stock. */
  quantityChange: string | number;
  /** Required for additions. */
  unitCost?: string | number | null;
  date: Date;
  memo?: string | null;
  /**
   * 'auto' (default): FIFO-tracked items (any cost layers) use fifo.ts, others average cost.
   * 'fifo': always use fifo.ts — this is how an item starts FIFO tracking (first layer).
   */
  costing?: 'auto' | 'fifo';
}

export async function adjustQuantityAtSite(ctx: ServiceContext, input: SiteAdjustmentInput) {
  const qty = Money.of(input.quantityChange);
  if (qty.isZero()) throw validation('quantityChange cannot be zero.');

  return inTransaction(ctx, async (tx) => {
    const [item] = await tx.db
      .select()
      .from(items)
      .where(and(eq(items.companyId, tx.companyId), eq(items.id, input.itemId)));
    if (!item) throw notFound('Item');
    if (item.type !== 'inventory') {
      throw validation(`Quantity adjustments only apply to inventory items; "${item.name}" is "${item.type}".`);
    }
    if (input.siteId) await getSite(tx, input.siteId);

    const [layer] = await tx.db
      .select({ id: inventoryLayers.id })
      .from(inventoryLayers)
      .where(and(eq(inventoryLayers.companyId, tx.companyId), eq(inventoryLayers.itemId, item.id)))
      .limit(1);
    const memo = input.memo ?? (qty.greaterThan(0) ? 'Inventory adjustment (add)' : 'Inventory adjustment (remove)');

    let entryId: string;
    let glAmount: string;
    if (layer || input.costing === 'fifo') {
      if (qty.greaterThan(0)) {
        if (input.unitCost == null || input.unitCost === '') {
          throw validation('unitCost is required when adding stock.');
        }
        const res = await receiveStock(tx, {
          itemId: item.id,
          quantity: qty.toFixed(4),
          unitCost: input.unitCost,
          date: input.date,
          memo,
        });
        entryId = res.entryId;
        glAmount = res.totalCost;
      } else {
        const res = await consumeStock(tx, { itemId: item.id, quantity: qty.abs().toFixed(4), date: input.date, memo });
        entryId = res.entryId;
        glAmount = res.totalCOGS;
      }
    } else {
      const res = await adjustInventory(tx, {
        itemId: item.id,
        quantityChange: qty.toFixed(4),
        unitCost: input.unitCost ?? null,
        date: input.date,
        memo,
      });
      entryId = res.entry.id;
      glAmount = res.glAmount;
    }

    const movements = await recordMovements(tx, [
      {
        itemId: item.id,
        siteId: input.siteId ?? null,
        binId: input.binId ?? null,
        quantity: qty,
        serialNumbers: input.serialNumbers ?? null,
        lotNumber: input.lotNumber ?? null,
        lotExpiration: input.lotExpiration ?? null,
        date: input.date,
        sourceType: 'adjustment',
        sourceId: entryId,
        sourceLine: 0,
        memo,
      },
    ]);

    const [after] = await tx.db
      .select({ quantityOnHand: items.quantityOnHand, averageCost: items.averageCost })
      .from(items)
      .where(eq(items.id, item.id));
    return {
      itemId: item.id,
      entryId,
      glAmount,
      quantityOnHand: Money.of(after.quantityOnHand ?? '0').toFixed(4),
      movements,
    };
  });
}

// ---------------------------------------------------------------------------
// Per-site reorder points
// ---------------------------------------------------------------------------

export async function listSiteReorderPoints(ctx: ServiceContext, opts?: { itemId?: string; siteId?: string }) {
  const conds = [eq(itemSiteSettings.companyId, ctx.companyId)];
  if (opts?.itemId) conds.push(eq(itemSiteSettings.itemId, opts.itemId));
  if (opts?.siteId) conds.push(eq(itemSiteSettings.siteId, opts.siteId));
  return ctx.db.select().from(itemSiteSettings).where(and(...conds));
}

function parseOptionalQty(v: string | number | null | undefined, label: string): string | null {
  if (v == null || v === '') return null;
  let d;
  try {
    d = Money.of(v);
  } catch {
    throw validation(`${label} must be a number.`);
  }
  if (d.isNegative()) throw validation(`${label} cannot be negative.`);
  return d.toFixed(4);
}

/** Set (or clear, with null/'') an item's reorder point / max level at one site. */
export async function setSiteReorderPoint(
  ctx: ServiceContext,
  input: {
    itemId: string;
    siteId: string;
    reorderPoint?: string | number | null;
    maxQuantity?: string | number | null;
  },
) {
  const reorderPoint = parseOptionalQty(input.reorderPoint, 'Reorder point');
  const maxQuantity = parseOptionalQty(input.maxQuantity, 'Max quantity');
  if (reorderPoint && maxQuantity && Money.of(maxQuantity).lessThan(Money.of(reorderPoint))) {
    throw validation('Max quantity cannot be below the reorder point.');
  }

  return inTransaction(ctx, async (tx) => {
    const [item] = await tx.db
      .select({ id: items.id, type: items.type })
      .from(items)
      .where(and(eq(items.companyId, tx.companyId), eq(items.id, input.itemId)));
    if (!item) throw notFound('Item');
    if (item.type !== 'inventory') throw validation('Reorder points apply to inventory items only.');
    await getSite(tx, input.siteId);

    const [existing] = await tx.db
      .select()
      .from(itemSiteSettings)
      .where(
        and(
          eq(itemSiteSettings.companyId, tx.companyId),
          eq(itemSiteSettings.itemId, input.itemId),
          eq(itemSiteSettings.siteId, input.siteId),
        ),
      );

    let row;
    if (!reorderPoint && !maxQuantity) {
      if (existing) await tx.db.delete(itemSiteSettings).where(eq(itemSiteSettings.id, existing.id));
      row = null;
    } else if (existing) {
      [row] = await tx.db
        .update(itemSiteSettings)
        .set({ reorderPoint, maxQuantity, updatedAt: sql`now()` })
        .where(eq(itemSiteSettings.id, existing.id))
        .returning();
    } else {
      [row] = await tx.db
        .insert(itemSiteSettings)
        .values({ companyId: tx.companyId, itemId: input.itemId, siteId: input.siteId, reorderPoint, maxQuantity })
        .returning();
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item_site_settings',
      entityId: input.itemId,
      oldValues: existing
        ? { siteId: input.siteId, reorderPoint: existing.reorderPoint, maxQuantity: existing.maxQuantity }
        : { siteId: input.siteId },
      newValues: { siteId: input.siteId, reorderPoint, maxQuantity },
    });
    return row;
  });
}
