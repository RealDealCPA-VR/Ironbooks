/**
 * Inventory operations — reorder reporting, physical count adjustments, and low-stock counts.
 *
 * GL impact for physical count adjustments (QB "Adjust Quantity/Value on Hand"):
 *   Shrinkage (countedQty < currentQty, delta < 0):
 *     Dr Adjustment Account                   |delta| * averageCost
 *     Cr 1300 Inventory Asset                 |delta| * averageCost
 *
 *   Overage (countedQty > currentQty, delta > 0):
 *     Dr 1300 Inventory Asset                 delta * averageCost
 *     Cr Adjustment Account                   delta * averageCost
 *
 * The Adjustment Account is the user's pick, defaulting to "Inventory Adjustments" (the same
 * default as inventory.adjustInventory / fifo.ts), with optional Class and Customer:Job on the
 * adjustment line.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  accounts,
  items,
  inventoryLayers,
  inventorySites,
  itemSiteSettings,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import {
  type AdjustmentDimensions,
  adjustmentPostingFields,
  assertNotFifoTracked,
  bookValueRelief,
  fifoLayerValue,
  inventoryDate,
  inventoryNumber,
  resolveAdjustmentAccount,
  carriedValueRemainder,
  sellOutRelief,
  valueRemainderAfter,
} from './inventory';
import { postJournalEntry } from './posting';
import { assertDefaultSiteQuantities } from './inventorySites';

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

/** Load an inventory-type item scoped to the company. Throws NOT_FOUND. */
async function loadInventoryItem(ctx: ServiceContext, itemId: string) {
  const [row] = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.id, itemId)));
  if (!row) throw notFound('Item');
  return row;
}

// ---------------------------------------------------------------------------
// reorderReport
// ---------------------------------------------------------------------------

export interface ReorderReportRow {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: string;
  /** Open sales-order quantity not yet invoiced. */
  committed: string;
  /** Open purchase-order quantity not yet received / billed. */
  onPurchaseOrder: string;
  /** quantityOnHand - committed + onPurchaseOrder. */
  available: string;
  reorderPoint: string;
  /** Max (reorder-up-to) level, from the item's default-site setting; null when not set. */
  maxQuantity: string | null;
  averageCost: string;
  /**
   * Suggested reorder quantity: up to the max level when one is set, else up to the reorder
   * point, net of committed and on-order quantities (at least 1 when nothing is on order).
   */
  suggestedReorderQty: string;
}

export interface ReorderReportResult {
  rows: ReorderReportRow[];
  count: number;
}

/**
 * QB reorder list ("Inventory Stock Status" reorder behaviour). For every active inventory item
 * with a reorder point:
 *   available = on hand - committed (open sales orders) + on order (open purchase orders)
 * The item is listed when available <= reorder point, suggesting a reorder up to the max level
 * (when set) or the reorder point. Items whose open purchase orders already cover the shortfall
 * are left off — so creating POs from the list twice never orders the same shortage twice.
 */
export async function reorderReport(ctx: ServiceContext): Promise<ReorderReportResult> {
  const rows = await ctx.db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      quantityOnHand: items.quantityOnHand,
      reorderPoint: items.reorderPoint,
      averageCost: items.averageCost,
    })
    .from(items)
    .where(
      and(
        eq(items.companyId, ctx.companyId),
        eq(items.type, 'inventory'),
        eq(items.isActive, true),
        isNotNull(items.reorderPoint),
      ),
    );
  if (rows.length === 0) return { rows: [], count: 0 };
  const itemIds = rows.map((r) => r.id);

  const committedRows = await ctx.db
    .select({
      itemId: salesOrderLines.itemId,
      committed: sql<string>`COALESCE(SUM(GREATEST(${salesOrderLines.quantity} - ${salesOrderLines.quantityInvoiced}, 0)), 0)`,
    })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrderLines.salesOrderId, salesOrders.id))
    .where(
      and(
        eq(salesOrders.companyId, ctx.companyId),
        inArray(salesOrders.status, ['open', 'partial']),
        inArray(salesOrderLines.itemId, itemIds),
      ),
    )
    .groupBy(salesOrderLines.itemId);
  const committedBy = new Map(committedRows.map((r) => [r.itemId, Money.of(r.committed)]));

  const onPoRows = await ctx.db
    .select({
      itemId: purchaseOrderLines.itemId,
      onPO: sql<string>`COALESCE(SUM(GREATEST(${purchaseOrderLines.quantity} - ${purchaseOrderLines.quantityBilled}, 0)), 0)`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .where(
      and(
        eq(purchaseOrders.companyId, ctx.companyId),
        inArray(purchaseOrders.status, ['open', 'partial']),
        inArray(purchaseOrderLines.itemId, itemIds),
      ),
    )
    .groupBy(purchaseOrderLines.itemId);
  const onPoBy = new Map(onPoRows.map((r) => [r.itemId, Money.of(r.onPO)]));

  // Max level: the item-level reorder point is the default site's, so the max comes from the
  // default site's setting (Inventory Sites › reorder points).
  const maxRows = await ctx.db
    .select({ itemId: itemSiteSettings.itemId, maxQuantity: itemSiteSettings.maxQuantity })
    .from(itemSiteSettings)
    .innerJoin(inventorySites, eq(itemSiteSettings.siteId, inventorySites.id))
    .where(
      and(
        eq(itemSiteSettings.companyId, ctx.companyId),
        eq(inventorySites.isDefault, true),
        isNotNull(itemSiteSettings.maxQuantity),
        inArray(itemSiteSettings.itemId, itemIds),
      ),
    );
  const maxBy = new Map(maxRows.map((r) => [r.itemId, Money.of(r.maxQuantity!)]));

  const reportRows: ReorderReportRow[] = [];
  for (const r of rows) {
    if (r.reorderPoint == null) continue;
    const onHand = Money.of(r.quantityOnHand ?? '0');
    const reorder = Money.of(r.reorderPoint);
    const committed = committedBy.get(r.id) ?? Money.zero();
    const onPO = onPoBy.get(r.id) ?? Money.zero();
    const available = onHand.minus(committed).plus(onPO);
    if (available.greaterThan(reorder)) continue;

    const max = maxBy.get(r.id);
    const target = max && max.greaterThan(reorder) ? max : reorder;
    let suggested = target.minus(available);
    if (!suggested.greaterThan(0)) {
      // Already on order up to the target: the open POs cover the shortfall.
      if (onPO.greaterThan(0)) continue;
      suggested = Money.of(1);
    }

    reportRows.push({
      id: r.id,
      name: r.name,
      sku: r.sku ?? null,
      quantityOnHand: onHand.toFixed(4),
      committed: committed.toFixed(4),
      onPurchaseOrder: onPO.toFixed(4),
      available: available.toFixed(4),
      reorderPoint: reorder.toFixed(4),
      maxQuantity: max ? max.toFixed(4) : null,
      averageCost: Money.of(r.averageCost ?? '0').toFixed(4),
      suggestedReorderQty: suggested.toFixed(4),
    });
  }

  return { rows: reportRows, count: reportRows.length };
}

// ---------------------------------------------------------------------------
// lowStockCount
// ---------------------------------------------------------------------------

/** Returns the count of inventory items where quantityOnHand <= reorderPoint. */
export async function lowStockCount(ctx: ServiceContext): Promise<number> {
  const result = await reorderReport(ctx);
  return result.count;
}

// ---------------------------------------------------------------------------
// physicalCount
// ---------------------------------------------------------------------------

export interface PhysicalCountInput extends AdjustmentDimensions {
  itemId: string;
  /** The actual counted quantity from the physical inventory count. */
  countedQty: string | number;
  date: Date;
  /** Offset account; default "Inventory Adjustments" (see AdjustmentDimensions). */
  adjustmentAccountId?: string | null;
}

export interface PhysicalCountResult {
  itemId: string;
  previousQty: string;
  countedQty: string;
  delta: string;
  glAmount: string;
  /** The journal entry posted for the adjustment, or null if delta was 0. */
  journalEntryId: string | null;
  adjustmentAccountId: string | null;
  updatedQty: string;
}

/**
 * Record a physical inventory count adjustment.
 *
 * delta = countedQty - currentQty
 *   - delta < 0 (shrinkage): Dr adjustmentAccount, Cr Inventory Asset
 *   - delta > 0 (overage):   Dr Inventory Asset, Cr adjustmentAccount
 *   - delta = 0: no GL posted, qty unchanged
 */
export async function physicalCount(
  ctx: ServiceContext,
  input: PhysicalCountInput,
): Promise<PhysicalCountResult> {
  // Load + validate in the same transaction as the write: a double-submitted count must see the
  // quantity the first one left, not post the same shrinkage twice.
  return inTransaction(ctx, (tx) => physicalCountInTx(tx, input));
}

async function physicalCountInTx(
  ctx: ServiceContext,
  input: PhysicalCountInput,
): Promise<PhysicalCountResult> {
  const counted = inventoryNumber(input.countedQty, 'Counted quantity');
  input = { ...input, date: inventoryDate(input.date) };
  if (counted.isNegative()) {
    throw validation('countedQty cannot be negative.');
  }

  const item = await loadInventoryItem(ctx, input.itemId);

  // Defense-in-depth: the API route already guards via assertPhysicalCountable,
  // but protect direct programmatic callers too. Physical counts are an
  // average-cost operation on stock-tracked items only.
  if (item.type !== 'inventory') {
    throw validation(
      `Physical counts can only be recorded for inventory-type items; "${item.name}" is type "${item.type}".`,
    );
  }
  await assertNotFifoTracked(ctx, item.id);
  // Advanced Inventory: serial/lot-tracked units need their identity captured — count them
  // through a site adjustment (Inventory Sites › Adjust Quantity) instead.
  if (item.trackingMode && item.trackingMode !== 'none') {
    throw validation(
      `"${item.name}" is ${item.trackingMode}-tracked. Record count differences with Adjust Quantity at Site so the ${item.trackingMode} numbers are captured.`,
    );
  }

  const currentQty = Money.of(item.quantityOnHand ?? '0');
  const avgCost = Money.of(item.averageCost ?? '0');

  const delta = counted.minus(currentQty);

  // No change — update qty to match counted (no-op if equal) and return early
  if (delta.isZero()) {
    return {
      itemId: item.id,
      previousQty: currentQty.toFixed(4),
      countedQty: counted.toFixed(4),
      delta: '0.0000',
      glAmount: '0.00',
      journalEntryId: null,
      adjustmentAccountId: null,
      updatedQty: currentQty.toFixed(4),
    };
  }

  // Book value before minus after (telescopes: counting to zero clears the item's value exactly);
  // counting to zero also takes the value remainder the GL still carries (0061), like a sell-out.
  const atBook = bookValueRelief(currentQty, counted, avgCost);
  const sellOut = delta.isNegative() ? sellOutRelief(item, counted, atBook) : { relief: atBook, remainderRelieved: false };
  const glAmount = sellOut.relief.abs();

  return inTransaction(ctx, async (tx) => {
    // Resolve the inventory asset account
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));

    // The user's Adjustment Account (default "Inventory Adjustments"), Class and Customer:Job.
    const adjustmentAccountId = await resolveAdjustmentAccount(tx, input.adjustmentAccountId);
    const dims = await adjustmentPostingFields(tx, input);

    // Build posting lines
    const amountStr = toAmountString(glAmount);
    const isShrinkage = delta.isNegative();

    const postingLines = isShrinkage
      ? [
          // Shrinkage: Dr Adjustment Account, Cr Inventory
          {
            accountId: adjustmentAccountId,
            debit: amountStr,
            memo: `Physical count shrinkage — item ${item.name}`,
            ...dims,
          },
          {
            accountId: inventoryAccountId,
            credit: amountStr,
            memo: `Physical count shrinkage — item ${item.name}`,
          },
        ]
      : [
          // Overage: Dr Inventory, Cr Adjustment Account
          {
            accountId: inventoryAccountId,
            debit: amountStr,
            memo: `Physical count overage — item ${item.name}`,
          },
          {
            accountId: adjustmentAccountId,
            credit: amountStr,
            memo: `Physical count overage — item ${item.name}`,
            ...dims,
          },
        ];

    const entry = glAmount.isZero() ? null : await postJournalEntry(tx, {
      date: input.date,
      description: `Physical inventory count adjustment — ${item.name}`,
      lines: postingLines,
      sourceRef: `item:${input.itemId}`,
    });

    // Update the item's quantityOnHand to the counted qty
    await tx.db
      .update(items)
      .set({
        quantityOnHand: counted.toFixed(4),
        ...(sellOut.remainderRelieved ? { valueRemainder: '0.00', valueRemainderAvg: avgCost.toFixed(4) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(items.id, input.itemId));
    // A whole-company count lands on the default site; it must not count away stock that
    // physically sits at another site.
    await assertDefaultSiteQuantities(tx, [input.itemId]);

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: input.itemId,
      oldValues: { quantityOnHand: item.quantityOnHand },
      newValues: {
        quantityOnHand: counted.toFixed(4),
        physicalCountDate: input.date.toISOString(),
        postedEntryId: entry?.id ?? null,
      },
    });

    return {
      itemId: item.id,
      previousQty: currentQty.toFixed(4),
      countedQty: counted.toFixed(4),
      delta: delta.toFixed(4),
      glAmount: toAmountString(glAmount),
      journalEntryId: entry?.id ?? null,
      adjustmentAccountId,
      updatedQty: counted.toFixed(4),
    };
  });
}

// ---------------------------------------------------------------------------
// adjustInventoryValue — revalue stock without changing quantity
// ---------------------------------------------------------------------------

export interface AdjustInventoryValueInput extends AdjustmentDimensions {
  itemId: string;
  /** Target total value for the on-hand stock. Provide exactly one of newTotalValue / newUnitCost. */
  newTotalValue?: string | number | null;
  /** Target unit cost (applied to every on-hand unit / remaining FIFO layer). */
  newUnitCost?: string | number | null;
  date: Date;
  reason?: string | null;
  /** Offset account; default "Inventory Adjustments" (see AdjustmentDimensions). */
  adjustmentAccountId?: string | null;
}

export interface AdjustInventoryValueResult {
  itemId: string;
  costingMethod: 'fifo' | 'average';
  quantity: string;
  oldValue: string;
  newValue: string;
  /** Signed GL amount: positive = write-up (Dr Inventory), negative = write-down (Cr Inventory). */
  delta: string;
  journalEntryId: string;
  adjustmentAccountId: string;
  /** New averageCost for average items; effective unit cost for FIFO items. */
  newUnitCost: string;
}

/**
 * Inventory VALUE adjustment (QB "Adjust Quantity/Value on Hand" — value mode).
 * Quantity on hand is untouched; only the carrying value changes.
 *
 * GL impact:
 *   Write-up   (newValue > oldValue): Dr Inventory Asset, Cr Adjustment Account
 *   Write-down (newValue < oldValue): Dr Adjustment Account, Cr Inventory Asset
 * (Adjustment Account default "Inventory Adjustments", with optional Class / Customer:Job.)
 *
 * Costing:
 *   - Average items: averageCost = newValue / quantityOnHand.
 *   - FIFO items: remaining layers are revalued — to `newUnitCost` exactly when
 *     given, otherwise each layer's unitCost is scaled proportionally so the
 *     remaining-layer total equals `newTotalValue` (a quantity-uniform cost is
 *     used when the current layer value is $0).
 */
export async function adjustInventoryValue(
  ctx: ServiceContext,
  input: AdjustInventoryValueInput,
): Promise<AdjustInventoryValueResult> {
  // Load + validate in the same transaction as the write: a double-submitted revaluation must
  // see the value the first one left, not post the same write-up twice.
  return inTransaction(ctx, (tx) => adjustInventoryValueInTx(tx, input));
}

async function adjustInventoryValueInTx(
  ctx: ServiceContext,
  input: AdjustInventoryValueInput,
): Promise<AdjustInventoryValueResult> {
  const hasTotal = input.newTotalValue != null && input.newTotalValue !== '';
  const hasUnit = input.newUnitCost != null && input.newUnitCost !== '';
  if (hasTotal === hasUnit) {
    throw validation('Provide exactly one of newTotalValue or newUnitCost.');
  }
  if (hasTotal) inventoryNumber(input.newTotalValue, 'New total value');
  if (hasUnit) inventoryNumber(input.newUnitCost, 'New unit cost');
  input = { ...input, date: inventoryDate(input.date) };

  const item = await loadInventoryItem(ctx, input.itemId);
  if (item.type !== 'inventory') {
    throw validation(
      `Value adjustments only apply to inventory-type items; "${item.name}" is type "${item.type}".`,
    );
  }

  // Detect costing method the same way assertNotFifoTracked does: any layer rows = FIFO.
  const layers = await ctx.db
    .select()
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, input.itemId)))
    .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));
  const isFifo = layers.length > 0;
  const openLayers = layers.filter((l) => Money.of(l.quantityRemaining).greaterThan(0));

  let quantity: Decimal;
  let oldValue: Decimal;
  if (isFifo) {
    quantity = openLayers.reduce((s, l) => s.plus(Money.of(l.quantityRemaining)), Money.zero());
    // The layers' book value as the valuation reports and the GL carry it (per-layer cents).
    oldValue = openLayers.reduce((s, l) => s.plus(fifoLayerValue(l.quantityRemaining, l.unitCost)), Money.zero());
  } else {
    quantity = Money.of(item.quantityOnHand ?? '0');
    // What the GL carries for the item: its book value plus the value remainder (0061), so the
    // adjustment lands the inventory account on exactly the value asked for.
    oldValue = Money.round2(quantity.times(Money.of(item.averageCost ?? '0'))).plus(carriedValueRemainder(item));
  }

  if (!quantity.greaterThan(0)) {
    throw validation('Cannot adjust value: the item has no stock on hand to revalue.');
  }

  let unitCostTarget: Decimal | null = null;
  if (hasUnit) {
    unitCostTarget = Money.of(input.newUnitCost!);
    if (unitCostTarget.isNegative()) throw validation('newUnitCost cannot be negative.');
  }
  const newValue = hasUnit ? quantity.times(unitCostTarget!) : Money.of(input.newTotalValue!);
  if (newValue.isNegative()) throw validation('newTotalValue cannot be negative.');

  // FIFO: each open layer's new unit cost (stored at 4dp) decides its new book value; the entry
  // posts exactly the change in the layers' value, so the GL stays equal to the sum of the layer
  // values (a target total the 4-decimal costs cannot hit exactly lands within a cent of it).
  const layerCosts = new Map<string, Decimal>();
  let bookedNewValue = newValue;
  if (isFifo) {
    for (const l of openLayers) {
      const cost = unitCostTarget
        ? unitCostTarget
        : oldValue.greaterThan(0)
          ? Money.of(l.unitCost).times(newValue.dividedBy(oldValue))
          : newValue.dividedBy(quantity);
      layerCosts.set(l.id, Money.of(cost.toFixed(4)));
    }
    bookedNewValue = openLayers.reduce(
      (s, l) => s.plus(fifoLayerValue(l.quantityRemaining, layerCosts.get(l.id)!)),
      Money.zero(),
    );
  }

  const delta = Money.round2(bookedNewValue.minus(oldValue));
  if (delta.isZero()) {
    throw validation('The new value equals the current value — nothing to adjust.');
  }

  return inTransaction(ctx, async (tx) => {
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));

    const adjustmentAccountId = await resolveAdjustmentAccount(tx, input.adjustmentAccountId);
    const dims = await adjustmentPostingFields(tx, input);

    const amountStr = toAmountString(delta.abs());
    const memo = input.reason ?? `Inventory value adjustment — ${item.name}`;
    const isWriteUp = delta.greaterThan(0);
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Inventory value adjustment — ${item.name}`,
      lines: isWriteUp
        ? [
            { accountId: inventoryAccountId, debit: amountStr, memo },
            { accountId: adjustmentAccountId, credit: amountStr, memo, ...dims },
          ]
        : [
            { accountId: adjustmentAccountId, debit: amountStr, memo, ...dims },
            { accountId: inventoryAccountId, credit: amountStr, memo },
          ],
      sourceRef: `item:${input.itemId}`,
    });

    let effectiveUnitCost: Decimal;
    if (isFifo) {
      // Revalue remaining layers (costs worked out above): exact unit cost when given, else a
      // proportional scale, else (old value $0) the new value spread uniformly per unit.
      for (const l of openLayers) {
        await tx.db
          .update(inventoryLayers)
          .set({ unitCost: layerCosts.get(l.id)!.toFixed(4) })
          .where(eq(inventoryLayers.id, l.id));
      }
      effectiveUnitCost = unitCostTarget ?? newValue.dividedBy(quantity);
    } else {
      effectiveUnitCost = newValue.dividedBy(quantity);
      await tx.db
        .update(items)
        .set({
          averageCost: effectiveUnitCost.toFixed(4),
          // The cents the 4dp average cannot represent of the new value stay on record (0061).
          ...valueRemainderAfter(item, quantity, quantity, effectiveUnitCost, delta),
          updatedAt: new Date(),
        })
        .where(eq(items.id, input.itemId));
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: input.itemId,
      oldValues: { averageCost: item.averageCost, totalValue: toAmountString(Money.round2(oldValue)) },
      newValues: {
        averageCost: effectiveUnitCost.toFixed(4),
        totalValue: toAmountString(Money.round2(newValue)),
        valueAdjustmentDelta: toAmountString(delta),
        reason: input.reason ?? null,
        postedEntryId: entry.id,
      },
    });

    return {
      itemId: input.itemId,
      costingMethod: (isFifo ? 'fifo' : 'average') as 'fifo' | 'average',
      quantity: quantity.toFixed(4),
      oldValue: toAmountString(Money.round2(oldValue)),
      newValue: toAmountString(Money.round2(newValue)),
      delta: toAmountString(delta),
      journalEntryId: entry.id,
      adjustmentAccountId,
      newUnitCost: effectiveUnitCost.toFixed(4),
    };
  });
}

// ---------------------------------------------------------------------------
// physicalWorksheet — printable / CSV count sheet data
// ---------------------------------------------------------------------------

export interface WorksheetRow {
  id: string;
  name: string;
  sku: string | null;
  unitOfMeasure: string | null;
  quantityOnHand: string;
  averageCost: string;
  /**
   * FIFO-tracked items cannot be counted through physicalCount (the guard in
   * inventory.assertNotFifoTracked); the worksheet flags them so the count
   * grid can disable entry with a clear note.
   */
  fifoTracked: boolean;
}

/** All active inventory items with on-hand quantities — the physical count sheet. */
export async function physicalWorksheet(ctx: ServiceContext): Promise<{ rows: WorksheetRow[] }> {
  const rows = await ctx.db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      unitOfMeasure: items.unitOfMeasure,
      quantityOnHand: items.quantityOnHand,
      averageCost: items.averageCost,
    })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.isActive, true), eq(items.type, 'inventory')));

  const layerAgg = await ctx.db
    .select({ itemId: inventoryLayers.itemId, cnt: sql<number>`count(*)` })
    .from(inventoryLayers)
    .where(eq(inventoryLayers.companyId, ctx.companyId))
    .groupBy(inventoryLayers.itemId);
  const fifoSet = new Set(layerAgg.filter((r) => Number(r.cnt) > 0).map((r) => r.itemId));

  return {
    rows: rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        sku: r.sku ?? null,
        unitOfMeasure: r.unitOfMeasure ?? null,
        quantityOnHand: Money.of(r.quantityOnHand ?? '0').toFixed(4),
        averageCost: Money.of(r.averageCost ?? '0').toFixed(4),
        fifoTracked: fifoSet.has(r.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// batchPhysicalCount — apply a whole count sheet at once
// ---------------------------------------------------------------------------

export interface BatchCountEntry {
  itemId: string;
  countedQty: string | number;
}

export interface BatchCountResult {
  applied: PhysicalCountResult[];
  skipped: Array<{ itemId: string; reason: string }>;
}

/**
 * Apply a batch of physical counts. Each entry goes through `physicalCount`
 * (which posts the shrinkage/overage GL per item). Items the guard rejects —
 * FIFO-tracked items and non-inventory types — are reported in `skipped` with
 * the guard's message instead of failing the whole batch.
 */
export async function batchPhysicalCount(
  ctx: ServiceContext,
  input: { date: Date; counts: BatchCountEntry[] } & AdjustmentDimensions,
): Promise<BatchCountResult> {
  if (!input.counts || input.counts.length === 0) {
    throw validation('counts must contain at least one entry.');
  }
  // One date for the whole sheet: a bad one fails the batch up front (not every item as "skipped").
  input = { ...input, date: inventoryDate(input.date) };
  const seen = new Set<string>();
  for (const c of input.counts) {
    if (seen.has(c.itemId)) throw validation('Duplicate itemId in counts.');
    seen.add(c.itemId);
  }

  // One outer transaction: each item's count runs in its own savepoint, so an item refused
  // for a per-item reason (bad input, missing item, or a site guard CONFLICT) is rolled back and
  // reported as skipped, while any other failure aborts the whole batch — never half-applied.
  return inTransaction(ctx, async (tx) => {
    // A bad Adjustment Account / Class / Customer:Job fails the whole batch up front instead of
    // skipping every item one by one.
    await resolveAdjustmentAccount(tx, input.adjustmentAccountId);
    await adjustmentPostingFields(tx, input);
    const applied: PhysicalCountResult[] = [];
    const skipped: Array<{ itemId: string; reason: string }> = [];

    for (const c of input.counts) {
      try {
        const result = await physicalCount(tx, {
          itemId: c.itemId,
          countedQty: c.countedQty,
          date: input.date,
          adjustmentAccountId: input.adjustmentAccountId ?? null,
          classId: input.classId ?? null,
          customerId: input.customerId ?? null,
          jobId: input.jobId ?? null,
        });
        applied.push(result);
      } catch (err) {
        if (
          err instanceof ServiceError &&
          (err.code === 'VALIDATION' || err.code === 'NOT_FOUND' || err.code === 'CONFLICT')
        ) {
          skipped.push({ itemId: c.itemId, reason: err.message });
        } else {
          throw err;
        }
      }
    }

    return { applied, skipped };
  });
}
