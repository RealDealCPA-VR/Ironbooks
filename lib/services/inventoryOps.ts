/**
 * Inventory operations — reorder reporting, physical count adjustments, and low-stock counts.
 *
 * GL impact for physical count adjustments:
 *   Shrinkage (countedQty < currentQty, delta < 0):
 *     Dr 5900 Inventory Shrinkage (expense)   |delta| * averageCost
 *     Cr 1300 Inventory Asset                 |delta| * averageCost
 *
 *   Overage (countedQty > currentQty, delta > 0):
 *     Dr 1300 Inventory Asset                 delta * averageCost
 *     Cr 5900 Inventory Shrinkage (expense)   delta * averageCost
 *
 * The adjustment account defaults to code '5900' (get-or-create).
 */
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { accounts, items, inventoryLayers } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertNotFifoTracked } from './inventory';
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

/**
 * Get-or-create the Inventory Shrinkage expense account (code '5900').
 * If the company already has one, returns it; otherwise inserts a new row.
 */
async function ensureShrinkageAccount(ctx: ServiceContext): Promise<string> {
  const [existing] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '5900')));
  if (existing) return existing.id;

  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code: '5900',
      name: 'Inventory Shrinkage',
      type: 'expense',
      subtype: 'operating_expenses',
      balance: '0',
    })
    .returning();
  return created.id;
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
  reorderPoint: string;
  averageCost: string;
  /** Suggested reorder quantity = reorderPoint * 2 - quantityOnHand (at least 1). */
  suggestedReorderQty: string;
}

export interface ReorderReportResult {
  rows: ReorderReportRow[];
  count: number;
}

/**
 * Returns all inventory-type items where quantityOnHand <= reorderPoint
 * (and reorderPoint is set), with a suggested reorder quantity.
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

  const reportRows: ReorderReportRow[] = rows
    .filter((r) => {
      if (r.reorderPoint == null) return false;
      const qty = Money.of(r.quantityOnHand ?? '0');
      const reorder = Money.of(r.reorderPoint);
      return qty.lessThanOrEqualTo(reorder);
    })
    .map((r) => {
      const qty = Money.of(r.quantityOnHand ?? '0');
      const reorder = Money.of(r.reorderPoint!);
      // Suggest: (reorderPoint * 2) - quantityOnHand, floor to 4dp, minimum 1
      const suggested = Money.abs(reorder.times(2).minus(qty));
      const suggestedQty = suggested.lessThan(1) ? Money.of(1) : suggested;
      return {
        id: r.id,
        name: r.name,
        sku: r.sku ?? null,
        quantityOnHand: qty.toFixed(4),
        reorderPoint: reorder.toFixed(4),
        averageCost: Money.of(r.averageCost ?? '0').toFixed(4),
        suggestedReorderQty: suggestedQty.toFixed(4),
      };
    });

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

export interface PhysicalCountInput {
  itemId: string;
  /** The actual counted quantity from the physical inventory count. */
  countedQty: string | number;
  date: Date;
  /**
   * The GL account to use for the adjustment offset.
   * Defaults to get-or-create '5900' Inventory Shrinkage.
   */
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
  const counted = Money.of(input.countedQty);
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
  const absDelta = delta.abs();

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

  const glAmount = Money.round2(absDelta.times(avgCost));

  return inTransaction(ctx, async (tx) => {
    // Resolve the inventory asset account
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));

    // Resolve or create the adjustment account
    let adjustmentAccountId: string;
    if (input.adjustmentAccountId) {
      // Verify it belongs to this company
      const [adj] = await tx.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.companyId, tx.companyId),
            eq(accounts.id, input.adjustmentAccountId),
          ),
        );
      if (!adj) throw notFound(`Adjustment account ${input.adjustmentAccountId}`);
      adjustmentAccountId = adj.id;
    } else {
      adjustmentAccountId = await ensureShrinkageAccount(tx);
    }

    // Build posting lines
    const amountStr = toAmountString(glAmount);
    const isShrinkage = delta.isNegative();

    const postingLines = isShrinkage
      ? [
          // Shrinkage: Dr Adjustment (Shrinkage expense), Cr Inventory
          {
            accountId: adjustmentAccountId,
            debit: amountStr,
            memo: `Physical count shrinkage — item ${item.name}`,
          },
          {
            accountId: inventoryAccountId,
            credit: amountStr,
            memo: `Physical count shrinkage — item ${item.name}`,
          },
        ]
      : [
          // Overage: Dr Inventory, Cr Adjustment (Shrinkage reversed)
          {
            accountId: inventoryAccountId,
            debit: amountStr,
            memo: `Physical count overage — item ${item.name}`,
          },
          {
            accountId: adjustmentAccountId,
            credit: amountStr,
            memo: `Physical count overage — item ${item.name}`,
          },
        ];

    const entry = await postJournalEntry(tx, {
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
        postedEntryId: entry.id,
      },
    });

    return {
      itemId: item.id,
      previousQty: currentQty.toFixed(4),
      countedQty: counted.toFixed(4),
      delta: delta.toFixed(4),
      glAmount: toAmountString(glAmount),
      journalEntryId: entry.id,
      adjustmentAccountId,
      updatedQty: counted.toFixed(4),
    };
  });
}

// ---------------------------------------------------------------------------
// adjustInventoryValue — revalue stock without changing quantity
// ---------------------------------------------------------------------------

export interface AdjustInventoryValueInput {
  itemId: string;
  /** Target total value for the on-hand stock. Provide exactly one of newTotalValue / newUnitCost. */
  newTotalValue?: string | number | null;
  /** Target unit cost (applied to every on-hand unit / remaining FIFO layer). */
  newUnitCost?: string | number | null;
  date: Date;
  reason?: string | null;
  /** Offset account; defaults to get-or-create '5900' (Inventory Shrinkage / Adjustment). */
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
 *   Write-up   (newValue > oldValue): Dr Inventory Asset, Cr Adjustment (5900)
 *   Write-down (newValue < oldValue): Dr Adjustment (5900), Cr Inventory Asset
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
  const hasTotal = input.newTotalValue != null && input.newTotalValue !== '';
  const hasUnit = input.newUnitCost != null && input.newUnitCost !== '';
  if (hasTotal === hasUnit) {
    throw validation('Provide exactly one of newTotalValue or newUnitCost.');
  }

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
    oldValue = openLayers.reduce(
      (s, l) => s.plus(Money.of(l.quantityRemaining).times(Money.of(l.unitCost))),
      Money.zero(),
    );
  } else {
    quantity = Money.of(item.quantityOnHand ?? '0');
    oldValue = quantity.times(Money.of(item.averageCost ?? '0'));
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

  const delta = Money.round2(newValue.minus(oldValue));
  if (delta.isZero()) {
    throw validation('The new value equals the current value — nothing to adjust.');
  }

  return inTransaction(ctx, async (tx) => {
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));

    let adjustmentAccountId: string;
    if (input.adjustmentAccountId) {
      const [adj] = await tx.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, tx.companyId), eq(accounts.id, input.adjustmentAccountId)));
      if (!adj) throw notFound(`Adjustment account ${input.adjustmentAccountId}`);
      adjustmentAccountId = adj.id;
    } else {
      adjustmentAccountId = await ensureShrinkageAccount(tx);
    }

    const amountStr = toAmountString(delta.abs());
    const memo = input.reason ?? `Inventory value adjustment — ${item.name}`;
    const isWriteUp = delta.greaterThan(0);
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Inventory value adjustment — ${item.name}`,
      lines: isWriteUp
        ? [
            { accountId: inventoryAccountId, debit: amountStr, memo },
            { accountId: adjustmentAccountId, credit: amountStr, memo },
          ]
        : [
            { accountId: adjustmentAccountId, debit: amountStr, memo },
            { accountId: inventoryAccountId, credit: amountStr, memo },
          ],
      sourceRef: `item:${input.itemId}`,
    });

    let effectiveUnitCost: Decimal;
    if (isFifo) {
      // Revalue remaining layers: exact unit cost when given, else proportional scale.
      if (unitCostTarget) {
        for (const l of openLayers) {
          await tx.db
            .update(inventoryLayers)
            .set({ unitCost: unitCostTarget.toFixed(4) })
            .where(eq(inventoryLayers.id, l.id));
        }
        effectiveUnitCost = unitCostTarget;
      } else if (oldValue.greaterThan(0)) {
        const factor = newValue.dividedBy(oldValue);
        for (const l of openLayers) {
          await tx.db
            .update(inventoryLayers)
            .set({ unitCost: Money.of(l.unitCost).times(factor).toFixed(4) })
            .where(eq(inventoryLayers.id, l.id));
        }
        effectiveUnitCost = newValue.dividedBy(quantity);
      } else {
        // Old value $0: spread the new value uniformly per remaining unit.
        const uniform = newValue.dividedBy(quantity);
        for (const l of openLayers) {
          await tx.db
            .update(inventoryLayers)
            .set({ unitCost: uniform.toFixed(4) })
            .where(eq(inventoryLayers.id, l.id));
        }
        effectiveUnitCost = uniform;
      }
    } else {
      effectiveUnitCost = newValue.dividedBy(quantity);
      await tx.db
        .update(items)
        .set({ averageCost: effectiveUnitCost.toFixed(4), updatedAt: new Date() })
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
  input: { date: Date; counts: BatchCountEntry[]; adjustmentAccountId?: string | null },
): Promise<BatchCountResult> {
  if (!input.counts || input.counts.length === 0) {
    throw validation('counts must contain at least one entry.');
  }
  const seen = new Set<string>();
  for (const c of input.counts) {
    if (seen.has(c.itemId)) throw validation('Duplicate itemId in counts.');
    seen.add(c.itemId);
  }

  const applied: PhysicalCountResult[] = [];
  const skipped: Array<{ itemId: string; reason: string }> = [];

  for (const c of input.counts) {
    try {
      const result = await physicalCount(ctx, {
        itemId: c.itemId,
        countedQty: c.countedQty,
        date: input.date,
        adjustmentAccountId: input.adjustmentAccountId ?? null,
      });
      applied.push(result);
    } catch (err) {
      if (err instanceof ServiceError && (err.code === 'VALIDATION' || err.code === 'NOT_FOUND')) {
        skipped.push({ itemId: c.itemId, reason: err.message });
      } else {
        throw err;
      }
    }
  }

  return { applied, skipped };
}
