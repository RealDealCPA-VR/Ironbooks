/**
 * FIFO inventory valuation service.
 *
 * Uses the `inventoryLayers` table (one row per receipt batch) to track individual
 * cost lots. Consumption depletes the oldest (earliest-date) layers first (FIFO),
 * computing an exact weighted COGS from the actually-consumed layer quantities and
 * costs rather than a running average.
 *
 * GL impact (the inventory side honors item.assetAccountId when configured,
 * falling back to account code 1300, matching the average-cost services):
 *   receiveStock (QB Adjust Quantity/Value on Hand, quantity up):
 *     Dr Inventory Asset (item.assetAccountId ?? 1300)   qty * unitCost
 *     Cr Adjustment Account                               qty * unitCost
 *
 *   consumeStock:
 *     Dr 5000 COGS (sales) or the Adjustment Account      computed COGS (exact FIFO cost)
 *     Cr Inventory Asset (item.assetAccountId ?? 1300)   computed COGS
 *
 * p1 purchases: the Adjustment Account is user-chosen (default "Inventory Adjustments", an
 * expense account created when missing — inventory.ts ensureInventoryAdjustmentAccount), with
 * Class and Customer:Job on the adjustment line, like QB. Owner's Equity is never the offset.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { items, accounts, inventoryLayers } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry } from './posting';
import { type AdjustmentDimensions, adjustmentPostingFields, resolveAdjustmentAccount } from './inventory';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve an account id by code for the current company. Throws NOT_FOUND. */
async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** Load an item scoped to the company. Throws NOT_FOUND. */
async function loadItem(ctx: ServiceContext, itemId: string) {
  const [row] = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.id, itemId)));
  if (!row) throw notFound('Item');
  return row;
}

// ---------------------------------------------------------------------------
// receiveStock
// ---------------------------------------------------------------------------

export interface ReceiveStockInput extends AdjustmentDimensions {
  itemId: string;
  quantity: string | number;
  unitCost: string | number;
  date: Date;
  memo?: string | null;
}

export interface ReceiveStockResult {
  layerId: string;
  itemId: string;
  quantity: string;
  unitCost: string;
  totalCost: string;
  entryId: string;
}

/**
 * Record a stock receipt: inserts a new inventory layer (FIFO lot) and posts
 * Dr Inventory / Cr the Adjustment Account (default "Inventory Adjustments") for qty * unitCost,
 * tagged with the optional Class and Customer:Job.
 */
export async function receiveStock(
  ctx: ServiceContext,
  input: ReceiveStockInput,
): Promise<ReceiveStockResult> {
  const qty = Money.of(input.quantity);
  if (qty.lessThanOrEqualTo(0)) throw validation('quantity must be positive.');

  const unitCost = Money.of(input.unitCost);
  if (unitCost.isNegative()) throw validation('unitCost cannot be negative.');

  // Validate item exists in company scope
  const item = await loadItem(ctx, input.itemId);

  const totalCost = Money.round2(qty.times(unitCost));

  return inTransaction(ctx, async (tx) => {
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));
    const offsetAccountId = await resolveAdjustmentAccount(tx, input.adjustmentAccountId);
    const dims = await adjustmentPostingFields(tx, input);

    // Post GL: Dr Inventory, Cr Adjustment Account
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: input.memo ?? `Inventory adjustment — ${item.name}`,
      lines: [
        {
          accountId: inventoryAccountId,
          debit: toAmountString(totalCost),
          memo: input.memo ?? 'FIFO stock receipt',
        },
        {
          accountId: offsetAccountId,
          credit: toAmountString(totalCost),
          memo: input.memo ?? 'Inventory adjustment',
          ...dims,
        },
      ],
      sourceRef: `item:${input.itemId}`,
    });

    // Insert the inventory cost layer
    const [layer] = await tx.db
      .insert(inventoryLayers)
      .values({
        companyId: tx.companyId,
        itemId: input.itemId,
        date: input.date,
        quantityRemaining: qty.toFixed(4),
        unitCost: unitCost.toFixed(4),
      })
      .returning();

    // Also keep item.quantityOnHand in sync
    await tx.db
      .update(items)
      .set({
        quantityOnHand: sql`COALESCE(${items.quantityOnHand}, 0) + ${qty.toFixed(4)}`,
        updatedAt: new Date(),
      })
      .where(eq(items.id, input.itemId));

    await writeAudit(tx, {
      action: 'create',
      entityType: 'inventory_layer',
      entityId: layer.id,
      newValues: {
        itemId: input.itemId,
        quantity: qty.toFixed(4),
        unitCost: unitCost.toFixed(4),
        totalCost: toAmountString(totalCost),
        entryId: entry.id,
      },
    });

    return {
      layerId: layer.id,
      itemId: input.itemId,
      quantity: qty.toFixed(4),
      unitCost: unitCost.toFixed(4),
      totalCost: toAmountString(totalCost),
      entryId: entry.id,
    };
  });
}

// ---------------------------------------------------------------------------
// consumeStock
// ---------------------------------------------------------------------------

export interface ConsumeStockInput extends AdjustmentDimensions {
  itemId: string;
  quantity: string | number;
  date: Date;
  memo?: string | null;
  /**
   * 'cogs' (default — sales relief, Dr 5000 COGS) or 'adjustment' (QB Adjust Quantity on Hand:
   * Dr the Adjustment Account, default "Inventory Adjustments", with Class / Customer:Job).
   */
  purpose?: 'cogs' | 'adjustment';
}

/**
 * Deplete `qty` from an item's FIFO layers, oldest first, and return the exact cost taken.
 * Writes the layers only (no GL, no quantityOnHand) — callers post and keep the item in sync.
 * Throws VALIDATION when the layers hold less than `qty`.
 */
export async function takeFromLayers(
  tx: ServiceContext,
  itemId: string,
  qty: Decimal,
): Promise<{ cost: Decimal; layers: ConsumedLayer[] }> {
  const layers = await tx.db
    .select()
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, tx.companyId), eq(inventoryLayers.itemId, itemId)))
    .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));
  const available = layers.filter((l) => Money.of(l.quantityRemaining).greaterThan(0));
  const totalAvailable = available.reduce((sum, l) => sum.plus(Money.of(l.quantityRemaining)), Money.zero());
  if (qty.greaterThan(totalAvailable)) {
    throw validation(
      `Insufficient stock: need ${qty.toFixed(4)} but only ${totalAvailable.toFixed(4)} available (FIFO layers).`,
    );
  }
  let remaining = new Decimal(qty);
  let cost = Money.zero();
  const taken: ConsumedLayer[] = [];
  for (const layer of available) {
    if (remaining.isZero()) break;
    const layerQty = Money.of(layer.quantityRemaining);
    const unitCost = Money.of(layer.unitCost);
    const take = remaining.lessThanOrEqualTo(layerQty) ? remaining : layerQty;
    const layerCost = Money.round2(take.times(unitCost));
    cost = cost.plus(layerCost);
    taken.push({
      layerId: layer.id,
      quantityTaken: take.toFixed(4),
      unitCost: unitCost.toFixed(4),
      layerCost: toAmountString(layerCost),
    });
    await tx.db
      .update(inventoryLayers)
      .set({ quantityRemaining: layerQty.minus(take).toFixed(4) })
      .where(eq(inventoryLayers.id, layer.id));
    remaining = remaining.minus(take);
  }
  return { cost: Money.round2(cost), layers: taken };
}

export interface ConsumedLayer {
  layerId: string;
  quantityTaken: string;
  unitCost: string;
  layerCost: string;
}

export interface ConsumeStockResult {
  itemId: string;
  quantityConsumed: string;
  totalCOGS: string;
  layers: ConsumedLayer[];
  entryId: string;
}

/**
 * Consume stock via FIFO: deplete oldest layers first, compute exact COGS from
 * consumed layer quantities, post Dr 5000 COGS / Cr 1300 Inventory.
 * Throws VALIDATION if insufficient stock across all remaining layers.
 */
export async function consumeStock(
  ctx: ServiceContext,
  input: ConsumeStockInput,
): Promise<ConsumeStockResult> {
  const needQty = Money.of(input.quantity);
  if (needQty.lessThanOrEqualTo(0)) throw validation('quantity must be positive.');

  // Validate item exists
  const item = await loadItem(ctx, input.itemId);

  return inTransaction(ctx, async (tx) => {
    // Deplete layers FIFO (oldest first) for the exact cost.
    const { cost: cogsAmount, layers: consumedLayers } = await takeFromLayers(tx, input.itemId, needQty);

    // Post GL: Dr COGS (sales) / Adjustment Account (adjustments), Cr Inventory
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));
    const isAdjustment = input.purpose === 'adjustment';
    const cogsAccountId = isAdjustment
      ? await resolveAdjustmentAccount(tx, input.adjustmentAccountId)
      : await accountIdByCode(tx, '5000');
    const dims = isAdjustment ? await adjustmentPostingFields(tx, input) : {};

    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: input.memo ?? (isAdjustment ? `Inventory adjustment — ${item.name}` : `FIFO COGS — item ${input.itemId}`),
      lines: [
        {
          accountId: cogsAccountId,
          debit: toAmountString(cogsAmount),
          memo: input.memo ?? (isAdjustment ? 'Inventory adjustment' : 'FIFO COGS'),
          ...dims,
        },
        {
          accountId: inventoryAccountId,
          credit: toAmountString(cogsAmount),
          memo: input.memo ?? 'FIFO inventory reduction',
        },
      ],
      sourceRef: `item:${input.itemId}`,
    });

    // Keep item.quantityOnHand in sync
    await tx.db
      .update(items)
      .set({
        quantityOnHand: sql`COALESCE(${items.quantityOnHand}, 0) - ${needQty.toFixed(4)}`,
        updatedAt: new Date(),
      })
      .where(eq(items.id, input.itemId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: input.itemId,
      newValues: {
        quantityConsumed: needQty.toFixed(4),
        totalCOGS: toAmountString(cogsAmount),
        entryId: entry.id,
        layers: consumedLayers,
      },
    });

    return {
      itemId: input.itemId,
      quantityConsumed: needQty.toFixed(4),
      totalCOGS: toAmountString(cogsAmount),
      layers: consumedLayers,
      entryId: entry.id,
    };
  });
}

// ---------------------------------------------------------------------------
// fifoValuation
// ---------------------------------------------------------------------------

export interface FifoValuationRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  layers: Array<{
    layerId: string;
    date: Date;
    quantityRemaining: string;
    unitCost: string;
    layerValue: string;
  }>;
  totalQuantity: string;
  totalValue: string;
}

export interface FifoValuationResult {
  items: FifoValuationRow[];
  grandTotal: string;
}

/**
 * Compute FIFO inventory valuation: for each item, list all remaining layers
 * with their quantities and costs, summing to a per-item total and a grand total.
 */
export async function fifoValuation(ctx: ServiceContext): Promise<FifoValuationResult> {
  // Load all layers with remaining qty for this company
  const layers = await ctx.db
    .select({
      id: inventoryLayers.id,
      itemId: inventoryLayers.itemId,
      date: inventoryLayers.date,
      quantityRemaining: inventoryLayers.quantityRemaining,
      unitCost: inventoryLayers.unitCost,
    })
    .from(inventoryLayers)
    .where(eq(inventoryLayers.companyId, ctx.companyId))
    .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));

  // Load item metadata for all referenced item IDs
  const itemIds = [...new Set(layers.map((l) => l.itemId))];

  const itemRows =
    itemIds.length === 0
      ? []
      : await ctx.db
          .select({ id: items.id, name: items.name, sku: items.sku })
          .from(items)
          .where(and(eq(items.companyId, ctx.companyId)));

  const itemMap = new Map(itemRows.map((r) => [r.id, r]));

  // Group layers by item
  const byItem = new Map<string, typeof layers>();
  for (const layer of layers) {
    const existing = byItem.get(layer.itemId) ?? [];
    existing.push(layer);
    byItem.set(layer.itemId, existing);
  }

  let grandTotal = Money.zero();
  const valuationRows: FifoValuationRow[] = [];

  for (const [itemId, itemLayers] of byItem) {
    const meta = itemMap.get(itemId);
    let itemTotal = Money.zero();
    let itemQty = Money.zero();

    const layerDetails = itemLayers
      .filter((l) => Money.of(l.quantityRemaining).greaterThan(0))
      .map((l) => {
        const qty = Money.of(l.quantityRemaining);
        const cost = Money.of(l.unitCost);
        const value = Money.round2(qty.times(cost));
        itemTotal = itemTotal.plus(value);
        itemQty = itemQty.plus(qty);
        return {
          layerId: l.id,
          date: l.date,
          quantityRemaining: qty.toFixed(4),
          unitCost: cost.toFixed(4),
          layerValue: toAmountString(value),
        };
      });

    if (layerDetails.length === 0) continue;

    grandTotal = grandTotal.plus(itemTotal);

    valuationRows.push({
      itemId,
      itemName: meta?.name ?? itemId,
      sku: meta?.sku ?? null,
      layers: layerDetails,
      totalQuantity: itemQty.toFixed(4),
      totalValue: toAmountString(itemTotal),
    });
  }

  return {
    items: valuationRows,
    grandTotal: toAmountString(grandTotal),
  };
}
