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
import { items, accounts, auditLogs, inventoryLayers } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry } from './posting';
import {
  type AdjustmentDimensions,
  adjustmentPostingFields,
  cogsAccountForItem,
  carriedValueRemainder,
  fifoLayerValue,
  inventoryDate,
  inventoryNumber,
  resolveAdjustmentAccount,
  todayCalendarDay,
  zeroValueAdjustment,
} from './inventory';

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
// insertLayersWorth — new cost layers worth exactly a posted amount
// ---------------------------------------------------------------------------

export interface LayersWorthInput {
  itemId: string;
  date: Date;
  /** Units received (> 0). */
  qty: Decimal;
  /** The amount the document posted to the inventory account for them (2dp, >= 0). */
  value: Decimal;
  /** inventory_layers.source_ref (the document that created the units), when it has one. */
  sourceRef?: string | null;
}

/**
 * Insert FIFO cost layers for `qty` units worth exactly `value` — what the document posted to the
 * inventory account. Unit cost is stored to 4 decimals and a layer is worth round2(qty x cost)
 * (fifoLayerValue), so one layer cannot always carry the amount: 3000 units for $1,000.00 at
 * 0.3333 are worth 999.90. Then one unit is split off into its own layer carrying the cents
 * (same date and source, so FIFO order and the document's reversal are unchanged) — the rule
 * landed cost uses (landedCost.ts revalueLayer). Fractional quantities of one unit or less keep a
 * single layer at the nearest cost. Must run inside the caller's transaction.
 */
export async function insertLayersWorth(tx: ServiceContext, input: LayersWorthInput) {
  const { itemId, date, qty } = input;
  const value = Money.round2(input.value);
  const base = { companyId: tx.companyId, itemId, date, sourceRef: input.sourceRef ?? null };
  const nearest = qty.isZero() ? Money.zero() : Money.of(value.dividedBy(qty).toFixed(4));
  if (fifoLayerValue(qty, nearest).equals(value) || !qty.greaterThan(1) || value.isNegative()) {
    return tx.db
      .insert(inventoryLayers)
      .values({ ...base, quantityRemaining: qty.toFixed(4), unitCost: nearest.toFixed(4) })
      .returning();
  }
  // (qty - 1) units at the cost rounded DOWN (never worth more than `value`), and one unit at the
  // cents that leaves — together exactly `value`.
  const rest = qty.minus(1);
  const restCost = value.dividedBy(qty).toDecimalPlaces(4, Decimal.ROUND_DOWN);
  const lastCost = value.minus(fifoLayerValue(rest, restCost));
  return tx.db
    .insert(inventoryLayers)
    .values([
      { ...base, quantityRemaining: rest.toFixed(4), unitCost: restCost.toFixed(4) },
      { ...base, quantityRemaining: '1.0000', unitCost: lastCost.toFixed(4) },
    ])
    .returning();
}

// ---------------------------------------------------------------------------
// seedOpeningLayer
// ---------------------------------------------------------------------------

/**
 * Start FIFO tracking on an item that already holds average-cost stock: when the item has no
 * layer at all, seed an opening layer for its on-hand stock (quantityOnHand @ averageCost) so
 * those units are not orphaned — otherwise the layers (valuation, consumption) would ignore units
 * the GL and quantityOnHand still carry. The value is already in the GL from the average-cost
 * postings, so no entry is posted. No-op when any layer exists or nothing is on hand.
 * Must run inside the caller's transaction.
 */
export async function seedOpeningLayer(tx: ServiceContext, itemId: string, date: Date): Promise<void> {
  const [anyLayer] = await tx.db
    .select({ id: inventoryLayers.id })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, tx.companyId), eq(inventoryLayers.itemId, itemId)))
    .limit(1);
  if (anyLayer) return;
  const [current] = await tx.db
    .select({
      quantityOnHand: items.quantityOnHand,
      averageCost: items.averageCost,
      valueRemainder: items.valueRemainder,
      valueRemainderAvg: items.valueRemainderAvg,
    })
    .from(items)
    .where(and(eq(items.companyId, tx.companyId), eq(items.id, itemId)));
  if (!current) return;
  const openingQty = Money.of(current.quantityOnHand ?? '0');
  if (!openingQty.greaterThan(0)) return;
  // What the GL carries for the stock: its book value plus the value remainder (0061) the 4dp
  // average could not show — the layers take both, so the GL stays equal to the FIFO valuation and
  // using the last unit clears the account to $0.
  const value = Money.round2(openingQty.times(Money.of(current.averageCost ?? '0'))).plus(carriedValueRemainder(current));
  const opening = await insertLayersWorth(tx, { itemId, date, qty: openingQty, value });
  if (!Money.of(current.valueRemainder ?? '0').isZero()) {
    await tx.db
      .update(items)
      .set({ valueRemainder: '0.00', valueRemainderAvg: null, updatedAt: new Date() })
      .where(and(eq(items.companyId, tx.companyId), eq(items.id, itemId)));
  }
  await writeAudit(tx, {
    action: 'create',
    entityType: 'inventory_layer',
    entityId: opening[0].id,
    newValues: {
      itemId,
      quantity: openingQty.toFixed(4),
      value: toAmountString(value),
      layers: opening.map((l) => ({ id: l.id, quantity: l.quantityRemaining, unitCost: l.unitCost })),
      reason: 'opening layer for existing average-cost stock',
    },
  });
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
  /** Null when the stock was received at $0 (nothing posted). */
  entryId: string | null;
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
  const qty = inventoryNumber(input.quantity, 'Quantity');
  if (qty.lessThanOrEqualTo(0)) throw validation('quantity must be positive.');

  const unitCost = inventoryNumber(input.unitCost, 'Unit cost');
  if (unitCost.isNegative()) throw validation('unitCost cannot be negative.');
  input = { ...input, date: inventoryDate(input.date) };

  // Validate item exists in company scope
  const item = await loadItem(ctx, input.itemId);

  const totalCost = Money.round2(qty.times(unitCost));

  return inTransaction(ctx, async (tx) => {
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));
    const offsetAccountId = await resolveAdjustmentAccount(tx, input.adjustmentAccountId);
    const dims = await adjustmentPostingFields(tx, input);

    await seedOpeningLayer(tx, input.itemId, input.date);

    // Post GL: Dr Inventory, Cr Adjustment Account (stock received at $0 posts nothing).
    const entry = totalCost.isZero()
      ? await zeroValueAdjustment(tx, input.date, input.itemId, `Inventory adjustment — ${item.name}`)
      : await postJournalEntry(tx, {
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

    // Insert the inventory cost layer(s): worth exactly what the entry posted.
    const [layer] = await insertLayersWorth(tx, { itemId: input.itemId, date: input.date, qty, value: totalCost });

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
        entryId: entry?.id ?? null,
      },
    });

    return {
      layerId: layer.id,
      itemId: input.itemId,
      quantity: qty.toFixed(4),
      unitCost: unitCost.toFixed(4),
      totalCost: toAmountString(totalCost),
      entryId: entry?.id ?? null,
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
  // Oldest first; layers written in one transaction share created_at (a bill's lines, the unit
  // insertLayersWorth splits off), so the id settles their order — the same sale always draws
  // the same units (a re-saved invoice costs the same).
  const layers = await tx.db
    .select()
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, tx.companyId), eq(inventoryLayers.itemId, itemId)))
    .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt), asc(inventoryLayers.id));
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
    // The layer's value before minus after (inventory.ts fifoLayerValue, the valuation reports'
    // rule): telescopes over partial draws, so emptying a layer relieves exactly the value it
    // still carried, and the GL stays equal to the sum of the remaining layers' values.
    const layerCost = fifoLayerValue(layerQty, unitCost).minus(fifoLayerValue(layerQty.minus(take), unitCost));
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

/**
 * How far the value a reversal takes out of layers may differ from the amount the document posted
 * by rounding alone: the cent, plus a 4-decimal unit cost times the quantity.
 */
export function layerRoundingTolerance(qty: Decimal): Decimal {
  return Money.of('0.01').plus(qty.abs().times('0.00005'));
}

export interface DocumentLayerReversal {
  itemId: string;
  itemName: string;
  /**
   * inventory_layers.source_ref of the layers the document created (bill:<id>, expense:<id>,
   * item_receipt:<id>, creditmemo-cogs:<memoId>:<lineId>). Several candidates may be given; the
   * ones the document actually used are found by their layers.
   */
  sourceRefs: string[];
  qty: Decimal;
  /** The home amount the document posted for these units — what its voided entry takes off the GL. */
  expectedValue: Decimal;
  /** The line's unit cost (picks the closest layer when the document made several); default value / qty. */
  unitCost?: Decimal | null;
  /** What is refused, for the message: e.g. "void this bill", "reverse this check's receipt". */
  action: string;
  /** Date of the rounding true-up entry, when one is needed (default: now). */
  trueUpDate?: Date | null;
}

/**
 * Pull units back out of the FIFO layers ONE document created, for a void / edit of that
 * document (whose journal entry is voided, so exactly the value it posted leaves the GL):
 *  - the document's own layers first (closest unit cost, newest), then layers at one of their
 *    costs (units a voided sale restored at that cost are worth the same);
 *  - CONFLICT when they no longer hold the quantity: some of the units it received were sold or
 *    used (QuickBooks refuses to void a purchase whose items are gone, too);
 *  - CONFLICT when they hold it at a different value than the document posted (beyond rounding):
 *    their cost was changed since (inventory value adjustment), so taking them out would leave the
 *    inventory account and the valuation apart.
 * Returns null — touching nothing — when the document created no tagged layer for the item (older
 * data), so the caller can fall back to its legacy matching. Writes the layers only.
 */
export async function takeFromDocumentLayers(
  tx: ServiceContext,
  input: DocumentLayerReversal,
): Promise<{ cost: Decimal } | null> {
  const layers = await tx.db
    .select()
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, tx.companyId), eq(inventoryLayers.itemId, input.itemId)))
    .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));
  const refs = new Set(input.sourceRefs);
  const own = layers.filter((l) => l.sourceRef != null && refs.has(l.sourceRef));
  if (own.length === 0) return null;

  const qty = input.qty;
  const open = (l: (typeof layers)[number]) => Money.of(l.quantityRemaining).greaterThan(0);
  const target = input.unitCost ?? (qty.isZero() ? Money.zero() : input.expectedValue.dividedBy(qty));
  const distance = (l: (typeof layers)[number]) => Money.of(l.unitCost).minus(target).abs();
  const ownOpen = own
    .filter(open)
    .sort((a, b) => distance(a).comparedTo(distance(b)) || b.createdAt.getTime() - a.createdAt.getTime());
  const ownCosts = new Set(own.map((l) => Money.of(l.unitCost).toFixed(4)));
  const sameCost = layers
    .filter((l) => !own.includes(l) && open(l) && ownCosts.has(Money.of(l.unitCost).toFixed(4)))
    .reverse();

  // Plan first, write after both checks pass.
  const plan: Array<{ id: string; left: Decimal }> = [];
  let remaining = new Decimal(qty);
  let value = Money.zero();
  for (const layer of [...ownOpen, ...sameCost]) {
    if (!remaining.greaterThan(0)) break;
    const layerQty = Money.of(layer.quantityRemaining);
    const take = remaining.lessThanOrEqualTo(layerQty) ? remaining : layerQty;
    value = value.plus(fifoLayerValue(layerQty, layer.unitCost).minus(fifoLayerValue(layerQty.minus(take), layer.unitCost)));
    plan.push({ id: layer.id, left: layerQty.minus(take) });
    remaining = remaining.minus(take);
  }
  if (remaining.greaterThan(0)) {
    throw new ServiceError(
      'CONFLICT',
      `Cannot ${input.action}: ${remaining.toFixed(4)} of the ${qty.toFixed(4)} "${input.itemName}" it received have since been sold or used. Void or edit those transactions first.`,
    );
  }
  if (Money.round2(value).minus(Money.round2(input.expectedValue)).abs().greaterThan(layerRoundingTolerance(qty))) {
    throw new ServiceError(
      'CONFLICT',
      `Cannot ${input.action}: the "${input.itemName}" it received are now valued at ${toAmountString(value)}, not the ${toAmountString(input.expectedValue)} it posted (their cost was adjusted since). Reverse the inventory value adjustment first.`,
    );
  }
  for (const p of plan) {
    await tx.db
      .update(inventoryLayers)
      .set({ quantityRemaining: p.left.toFixed(4) })
      .where(eq(inventoryLayers.id, p.id));
  }
  // Within rounding, the layers may still carry a cent more or less than the document posted (a
  // 4-decimal unit cost times the quantity, or a value adjustment smaller than that). The voided
  // entry takes the posted amount off the GL; true the inventory account up to the value the
  // layers actually gave back (against the item's COGS account), so GL == valuation to the cent.
  await postInventoryTrueUp(tx, {
    itemId: input.itemId,
    itemName: input.itemName,
    amount: Money.round2(input.expectedValue).minus(Money.round2(value)),
    date: input.trueUpDate ?? todayCalendarDay(),
    action: input.action,
  });
  return { cost: Money.round2(value) };
}

/**
 * Rounding true-up between an item's inventory asset account and its COGS account: `amount` > 0
 * debits inventory, < 0 credits it; $0 posts nothing. Used when a reversal moves the layers by a
 * cent more or less than the voided entry moved the GL, so GL == FIFO valuation to the cent.
 */
async function postInventoryTrueUp(
  tx: ServiceContext,
  input: { itemId: string; itemName: string; amount: Decimal; date: Date; action: string },
): Promise<void> {
  const trueUp = Money.round2(input.amount);
  if (trueUp.isZero()) return;
  const [item] = await tx.db
    .select({ assetAccountId: items.assetAccountId, expenseAccountId: items.expenseAccountId })
    .from(items)
    .where(and(eq(items.companyId, tx.companyId), eq(items.id, input.itemId)));
  const inventoryAccountId = item?.assetAccountId ?? (await accountIdByCode(tx, '1300'));
  const offsetAccountId = await cogsAccountForItem(tx, item ?? {});
  const amount = toAmountString(trueUp.abs());
  const memo = `Rounding — ${input.itemName} (${input.action})`;
  await postJournalEntry(tx, {
    date: input.date,
    description: memo,
    sourceRef: `item:${input.itemId}`,
    lines: trueUp.greaterThan(0)
      ? [
          { accountId: inventoryAccountId, debit: amount, memo },
          { accountId: offsetAccountId, credit: amount, memo },
        ]
      : [
          { accountId: offsetAccountId, debit: amount, memo },
          { accountId: inventoryAccountId, credit: amount, memo },
        ],
  });
}

export interface ConsumptionRestore {
  itemId: string;
  itemName: string;
  /** The journal entry consumeStock posted for the units (its audit row records the layers drawn). */
  entryId: string;
  qty: Decimal;
  /** The value the voided COGS entry gives back to the inventory account. */
  value: Decimal;
  /** The sale's date: a fallback layer's date and a rounding true-up's date. */
  date: Date;
  /** What is being undone, for the true-up memo (e.g. "void invoice"). */
  action: string;
}

/**
 * Put the units a FIFO sale (consumeStock) took back into the layers they came from, for a void /
 * edit of the sale (whose COGS entry is voided, so exactly `value` returns to the GL). Returning
 * them as a NEW layer dated the sale put them behind every receipt in between: re-saving an
 * unchanged invoice re-costed the sale out of the newer, dearer layers, and the next sale after a
 * void was costed out of FIFO order.
 *  - The layers drawn are the ones consumeStock recorded for the entry (its audit row).
 *  - While they still carry the cost they had (no value adjustment since), the units go back into
 *    them; the cent a later partial draw can shift (per-layer rounding) is trued up against the
 *    item's COGS account, as takeFromDocumentLayers does, so GL == valuation to the cent.
 *  - Otherwise (no record for older data, a revalued or merged-away layer) they come back as a new
 *    layer worth exactly `value` (insertLayersWorth), dated the sale.
 * Writes the layers only; the caller voids the entry and puts the quantity back on hand.
 */
export async function restoreConsumedStock(tx: ServiceContext, input: ConsumptionRestore): Promise<void> {
  if (!input.qty.greaterThan(0)) return;
  const [audit] = await tx.db
    .select({ newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, tx.companyId),
        eq(auditLogs.entityType, 'item'),
        eq(auditLogs.entityId, input.itemId),
        sql`${auditLogs.newValues}->>'entryId' = ${input.entryId}`,
      ),
    )
    .limit(1);
  await restoreLayerDraws(tx, { ...input, recorded: (audit?.newValues as { layers?: unknown } | null | undefined)?.layers });
}

/**
 * The core of restoreConsumedStock: put `qty` units worth `value` back into the layers a draw
 * took them from (`recorded`: the ConsumedLayer list takeFromLayers returned, as stored in the
 * audit trail), or — when the record is missing / no longer matches — into a new layer worth
 * exactly `value`. Used by sales (consumeStock) and vendor-credit returns.
 */
export async function restoreLayerDraws(
  tx: ServiceContext,
  input: Omit<ConsumptionRestore, 'entryId'> & { recorded: unknown },
): Promise<void> {
  const qty = input.qty;
  const value = Money.round2(input.value);
  if (!qty.greaterThan(0)) return;
  const fallback = async () => {
    await insertLayersWorth(tx, { itemId: input.itemId, date: input.date, qty, value });
  };
  const recorded = input.recorded;
  if (!Array.isArray(recorded) || recorded.length === 0) return fallback();
  const draws: Array<{ layerId: string; take: Decimal; unitCost: Decimal }> = [];
  for (const r of recorded) {
    const d0 = r as { layerId?: unknown; quantityTaken?: unknown; unitCost?: unknown };
    if (typeof d0.layerId !== 'string' || typeof d0.quantityTaken !== 'string' || typeof d0.unitCost !== 'string') {
      return fallback();
    }
    draws.push({ layerId: d0.layerId, take: Money.of(d0.quantityTaken), unitCost: Money.of(d0.unitCost) });
  }
  const drawnQty = draws.reduce((sum, d0) => sum.plus(d0.take), Money.zero());
  if (!drawnQty.equals(qty)) return fallback();

  const layerRows = await tx.db
    .select()
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, tx.companyId), eq(inventoryLayers.itemId, input.itemId)));
  const byId = new Map(layerRows.map((l) => [l.id, l]));
  const plan: Array<{ id: string; left: Decimal }> = [];
  let restored = Money.zero();
  for (const d0 of draws) {
    const layer = byId.get(d0.layerId);
    // Gone, or revalued since (its units now carry another cost than the sale relieved).
    if (!layer || !Money.of(layer.unitCost).equals(d0.unitCost)) return fallback();
    const now = Money.of(layer.quantityRemaining);
    const left = now.plus(d0.take);
    restored = restored.plus(fifoLayerValue(left, layer.unitCost).minus(fifoLayerValue(now, layer.unitCost)));
    plan.push({ id: layer.id, left });
  }
  if (restored.minus(value).abs().greaterThan(layerRoundingTolerance(qty))) return fallback();

  for (const p of plan) {
    await tx.db
      .update(inventoryLayers)
      .set({ quantityRemaining: p.left.toFixed(4) })
      .where(eq(inventoryLayers.id, p.id));
  }
  await postInventoryTrueUp(tx, {
    itemId: input.itemId,
    itemName: input.itemName,
    amount: restored.minus(value),
    date: input.date,
    action: input.action,
  });
}

/**
 * Candidate layer source refs of a purchase document from a reversal reason such as
 * "bill_void:<id>" / "expense_edit:<id>": the document id is the reason's last segment.
 */
export function purchaseLayerRefs(reason: string): string[] {
  const id = reason.slice(reason.lastIndexOf(':') + 1);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? [`bill:${id}`, `expense:${id}`] : [];
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
  /** Null when an adjustment removed units that carry no cost (nothing posted). */
  entryId: string | null;
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
  const needQty = inventoryNumber(input.quantity, 'Quantity');
  if (needQty.lessThanOrEqualTo(0)) throw validation('quantity must be positive.');
  input = { ...input, date: inventoryDate(input.date) };

  // Validate item exists
  const item = await loadItem(ctx, input.itemId);

  return inTransaction(ctx, async (tx) => {
    // Deplete layers FIFO (oldest first) for the exact cost.
    const { cost: cogsAmount, layers: consumedLayers } = await takeFromLayers(tx, input.itemId, needQty);
    if (cogsAmount.isZero() && input.purpose !== 'adjustment') {
      // A sale is reversed through its COGS entry (void / edit put the units back from it), so a
      // sale of units that carry no cost is refused plainly, as for average-cost items.
      throw validation(
        `Inventory item "${item.name}" has no cost in the units it would sell. Receive stock with a unit cost (bill or inventory adjustment) before selling it.`,
      );
    }

    // Post GL: Dr COGS (sales) / Adjustment Account (adjustments), Cr Inventory
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));
    const isAdjustment = input.purpose === 'adjustment';
    // A sale posts to the item's own COGS account (5000 by default) with the sale's class.
    const cogsAccountId = isAdjustment
      ? await resolveAdjustmentAccount(tx, input.adjustmentAccountId)
      : await cogsAccountForItem(tx, item);
    const dims = isAdjustment ? await adjustmentPostingFields(tx, input) : input.classId ? { classId: input.classId } : {};

    // Removing units that carry no cost (an adjustment) posts nothing; a sale was refused above.
    const entry = cogsAmount.isZero()
      ? await zeroValueAdjustment(tx, input.date, input.itemId, `Inventory adjustment — ${item.name}`)
      : await postJournalEntry(tx, {
          date: input.date,
          description: input.memo ?? (isAdjustment ? `Inventory adjustment — ${item.name}` : `Cost of goods sold — ${item.name}`),
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
        entryId: entry?.id ?? null,
        layers: consumedLayers,
      },
    });

    return {
      itemId: input.itemId,
      quantityConsumed: needQty.toFixed(4),
      totalCOGS: toAmountString(cogsAmount),
      layers: consumedLayers,
      entryId: entry?.id ?? null,
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
        const value = fifoLayerValue(qty, cost);
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
