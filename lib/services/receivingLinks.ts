/**
 * Enhanced receiving — low-level shared pieces used by purchaseOrders.ts, itemReceipts.ts,
 * bills.ts and receiving.ts. Deliberately imports NO other service module (bills.ts and
 * purchaseOrders.ts both import this file, and receiving.ts imports them), so there is no
 * import cycle.
 *
 * Contents:
 *   - Receiving preferences (companies.settings.receiving): enhanced receiving on/off, where
 *     bill-vs-receipt price variances go ('inventory' or 'ppv'), and the PPV account.
 *   - PO status computation. Legacy: a PO closes once every line is fully consumed (received or
 *     billed). Enhanced receiving: it closes only once every line is fully received AND every
 *     received quantity has been vendor-billed (purchase_order_lines.quantityReceivedUnbilled).
 *   - releaseReceiptBilling: the bill-void hook that unwinds an "enter bill for received items"
 *     bill — receipt line billed quantities, PO received-unbilled counters, and any inventory
 *     cost adjustments the price variance made (the GL side is reversed by voidJournalEntry).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  companies,
  inventoryLayers,
  itemReceiptBillLines,
  itemReceiptLines,
  itemReceipts,
  items,
  purchaseOrderLines,
  purchaseOrders,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, ServiceError, writeAudit } from './_base';

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface ReceivingSettings {
  /**
   * QB "Enhanced Inventory Receiving": receipts and bills are tracked separately on the PO
   * (Received vs Billed) and a PO closes only when fully received AND fully billed.
   */
  enhancedReceiving: boolean;
  /** Where bill-vs-receipt price variances on inventory items are posted. */
  varianceMode: 'inventory' | 'ppv';
  /** Purchase price variance account (expense); auto-created on first use when null. */
  ppvAccountId: string | null;
}

export const DEFAULT_RECEIVING_SETTINGS: ReceivingSettings = {
  enhancedReceiving: false,
  varianceMode: 'inventory',
  ppvAccountId: null,
};

export async function getReceivingSettings(ctx: ServiceContext): Promise<ReceivingSettings> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const raw = ((row?.settings ?? {}) as Record<string, unknown>).receiving as
    | Partial<ReceivingSettings>
    | undefined;
  return {
    enhancedReceiving: Boolean(raw?.enhancedReceiving),
    varianceMode: raw?.varianceMode === 'ppv' ? 'ppv' : 'inventory',
    ppvAccountId: typeof raw?.ppvAccountId === 'string' && raw.ppvAccountId ? raw.ppvAccountId : null,
  };
}

// ---------------------------------------------------------------------------
// PO status
// ---------------------------------------------------------------------------

export interface PoLineQuantities {
  quantity: string;
  quantityBilled: string | null;
  quantityReceivedUnbilled: string | null;
}

/** Pure: open / partial / closed from line quantities. */
export function poStatusFromLines(
  lines: PoLineQuantities[],
  enhancedReceiving: boolean,
): 'open' | 'partial' | 'closed' {
  const consumed = (l: PoLineQuantities) => Money.of(l.quantityBilled ?? '0');
  const awaitingBill = (l: PoLineQuantities) => Money.of(l.quantityReceivedUnbilled ?? '0');
  const anyActivity = lines.some((l) => consumed(l).greaterThan(0));
  const fullyReceived = lines.every((l) => !Money.of(l.quantity).minus(consumed(l)).greaterThan(0));
  const fullyBilled = !enhancedReceiving || lines.every((l) => !awaitingBill(l).greaterThan(0));
  if (fullyReceived && fullyBilled) return 'closed';
  return anyActivity ? 'partial' : 'open';
}

/**
 * Recompute and persist a PO's status (skips void and manually closed POs unless `force`).
 * Returns the resulting status.
 */
export async function recomputePoStatus(
  ctx: ServiceContext,
  poId: string,
  reason: string,
  opts?: { force?: boolean },
): Promise<string> {
  const [po] = await ctx.db
    .select({ id: purchaseOrders.id, status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, ctx.companyId)));
  if (!po) return 'missing';
  if (po.status === 'void') return po.status;
  const lines = await ctx.db
    .select({
      quantity: purchaseOrderLines.quantity,
      quantityBilled: purchaseOrderLines.quantityBilled,
      quantityReceivedUnbilled: purchaseOrderLines.quantityReceivedUnbilled,
    })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, poId));
  const { enhancedReceiving } = await getReceivingSettings(ctx);
  const next = poStatusFromLines(lines, enhancedReceiving);
  // A PO the user closed by hand (cancelled remainder) stays closed unless forced.
  if (po.status === 'closed' && next !== 'closed' && !opts?.force) return po.status;
  if (next !== po.status) {
    await ctx.db.update(purchaseOrders).set({ status: next }).where(eq(purchaseOrders.id, poId));
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'purchase_order',
      entityId: poId,
      oldValues: { status: po.status },
      newValues: { status: next, reason },
    });
  }
  return next;
}

/**
 * Move `delta` (signed) through a PO's received-not-billed counter for one item, spread across
 * the PO's lines for that item (lineOrder; decrements walk the same order). Never goes below
 * zero: receipts entered before enhanced receiving existed carry no counter, so decrements are
 * clamped instead of failing.
 */
export async function adjustPoReceivedUnbilled(
  ctx: ServiceContext,
  poId: string,
  itemId: string,
  delta: ReturnType<typeof Money.zero>,
): Promise<void> {
  if (delta.isZero()) return;
  const lines = await ctx.db
    .select()
    .from(purchaseOrderLines)
    .where(and(eq(purchaseOrderLines.purchaseOrderId, poId), eq(purchaseOrderLines.itemId, itemId)))
    .orderBy(asc(purchaseOrderLines.lineOrder));
  let left = delta.abs();
  for (const line of lines) {
    if (!left.greaterThan(0)) break;
    const current = Money.of(line.quantityReceivedUnbilled ?? '0');
    let move: ReturnType<typeof Money.zero>;
    if (delta.greaterThan(0)) {
      // Increment up to what this line has received (quantityBilled is the consumed counter).
      const room = Money.of(line.quantityBilled ?? '0').minus(current);
      if (!room.greaterThan(0)) continue;
      move = left.lessThan(room) ? left : room;
      await ctx.db
        .update(purchaseOrderLines)
        .set({ quantityReceivedUnbilled: current.plus(move).toFixed(4) })
        .where(eq(purchaseOrderLines.id, line.id));
    } else {
      if (!current.greaterThan(0)) continue;
      move = left.lessThan(current) ? left : current;
      await ctx.db
        .update(purchaseOrderLines)
        .set({ quantityReceivedUnbilled: current.minus(move).toFixed(4) })
        .where(eq(purchaseOrderLines.id, line.id));
    }
    left = left.minus(move);
  }
}

// ---------------------------------------------------------------------------
// Receipt status
// ---------------------------------------------------------------------------

/** Recompute an item receipt's status from its lines: open / partial / billed. */
export async function recomputeReceiptStatus(
  ctx: ServiceContext,
  receiptId: string,
  billId: string | null,
): Promise<string> {
  const [receipt] = await ctx.db
    .select()
    .from(itemReceipts)
    .where(and(eq(itemReceipts.id, receiptId), eq(itemReceipts.companyId, ctx.companyId)));
  if (!receipt || receipt.status === 'void') return receipt?.status ?? 'missing';
  const lines = await ctx.db
    .select({ quantity: itemReceiptLines.quantity, quantityBilled: itemReceiptLines.quantityBilled })
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, receiptId));
  const fully = lines.every((l) => !Money.of(l.quantity).minus(Money.of(l.quantityBilled)).greaterThan(0));
  const any = lines.some((l) => Money.of(l.quantityBilled).greaterThan(0));
  const status = fully ? 'billed' : any ? 'partial' : 'open';
  const convertedBillId =
    status === 'billed' ? (receipt.convertedBillId ?? billId) : null;
  if (status !== receipt.status || convertedBillId !== receipt.convertedBillId) {
    await ctx.db
      .update(itemReceipts)
      .set({ status, convertedBillId })
      .where(eq(itemReceipts.id, receiptId));
  }
  return status;
}

// ---------------------------------------------------------------------------
// Bill-void hook
// ---------------------------------------------------------------------------

/** True when the bill was entered against item receipts (it must not be edited in place). */
export async function billHasReceiptLinks(ctx: ServiceContext, billId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: itemReceiptBillLines.id })
    .from(itemReceiptBillLines)
    .where(and(eq(itemReceiptBillLines.companyId, ctx.companyId), eq(itemReceiptBillLines.billId, billId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Unwind everything a receipt-based bill did outside the GL. Call INSIDE voidBill's
 * transaction, after its journal entry was voided:
 *   - receipt lines' quantityBilled and receipt status (billed/partial -> partial/open),
 *   - PO received-not-billed counters and PO status,
 *   - inventory cost adjustments from price variances capitalized into inventory
 *     (CONFLICT when that stock has since been sold — the variance then lives in COGS and the
 *     user must enter a vendor credit instead of voiding).
 */
export async function releaseReceiptBilling(ctx: ServiceContext, billId: string): Promise<void> {
  const links = await ctx.db
    .select()
    .from(itemReceiptBillLines)
    .where(and(eq(itemReceiptBillLines.companyId, ctx.companyId), eq(itemReceiptBillLines.billId, billId)));
  if (links.length === 0) return;

  const receiptIds = new Set<string>();
  const poItemDeltas = new Map<string, ReturnType<typeof Money.zero>>(); // `${poId}|${itemId}`

  for (const link of links) {
    receiptIds.add(link.itemReceiptId);
    const qty = Money.of(link.quantity);

    // 1) Receipt line billed quantity.
    const released = await ctx.db
      .update(itemReceiptLines)
      .set({ quantityBilled: sql`${itemReceiptLines.quantityBilled} - ${qty.toFixed(4)}::numeric` })
      .where(
        and(
          eq(itemReceiptLines.id, link.itemReceiptLineId),
          sql`${itemReceiptLines.quantityBilled} - ${qty.toFixed(4)}::numeric >= 0`,
        ),
      )
      .returning({ id: itemReceiptLines.id });
    if (released.length === 0) {
      throw new ServiceError('CONFLICT', 'Item receipt quantities changed in another transaction. Reload and retry.');
    }

    // 2) Inventory cost adjustment made by the variance.
    const invVariance = Money.of(link.inventoryVariance);
    if (!invVariance.isZero()) {
      const adjustments = (link.layerAdjustments ?? []) as Array<Record<string, string>>;
      if (adjustments.length > 0) {
        for (const adj of adjustments) {
          const [layer] = await ctx.db
            .select()
            .from(inventoryLayers)
            .where(and(eq(inventoryLayers.id, adj.layerId), eq(inventoryLayers.companyId, ctx.companyId)));
          if (!layer || Money.of(layer.quantityRemaining).lessThan(adj.quantity)) {
            throw new ServiceError(
              'CONFLICT',
              'Cannot void this bill: stock whose cost it adjusted has since been sold. Enter a vendor credit for the difference instead.',
            );
          }
          await ctx.db
            .update(inventoryLayers)
            .set({ unitCost: Money.of(layer.unitCost).minus(adj.unitDelta).toFixed(4) })
            .where(eq(inventoryLayers.id, layer.id));
        }
      } else {
        const [item] = await ctx.db
          .select()
          .from(items)
          .where(and(eq(items.id, link.itemId), eq(items.companyId, ctx.companyId)));
        const onHand = Money.of(item?.quantityOnHand ?? '0');
        const value = onHand.times(Money.of(item?.averageCost ?? '0')).minus(invVariance);
        if (!item || !onHand.greaterThan(0) || value.lessThan('-0.005')) {
          throw new ServiceError(
            'CONFLICT',
            'Cannot void this bill: stock whose cost it adjusted has since been sold. Enter a vendor credit for the difference instead.',
          );
        }
        const newAvg = value.lessThan(0) ? Money.zero() : value.dividedBy(onHand);
        await ctx.db
          .update(items)
          .set({ averageCost: newAvg.toFixed(4), updatedAt: new Date() })
          .where(eq(items.id, item.id));
        await writeAudit(ctx, {
          action: 'update',
          entityType: 'item',
          entityId: item.id,
          oldValues: { averageCost: item.averageCost },
          newValues: { averageCost: newAvg.toFixed(4), reason: `bill_void_variance:${billId}` },
        });
      }
    }

    // 3) PO received-not-billed counter (collected per PO/item).
    const [receipt] = await ctx.db
      .select({ purchaseOrderId: itemReceipts.purchaseOrderId })
      .from(itemReceipts)
      .where(eq(itemReceipts.id, link.itemReceiptId));
    if (receipt?.purchaseOrderId) {
      const key = `${receipt.purchaseOrderId}|${link.itemId}`;
      poItemDeltas.set(key, (poItemDeltas.get(key) ?? Money.zero()).plus(qty));
    }
  }

  const poIds = new Set<string>();
  for (const [key, qty] of poItemDeltas) {
    const [poId, itemId] = key.split('|');
    poIds.add(poId);
    await adjustPoReceivedUnbilled(ctx, poId, itemId, qty);
  }

  await ctx.db.delete(itemReceiptBillLines).where(eq(itemReceiptBillLines.billId, billId));

  for (const receiptId of receiptIds) {
    const before = await ctx.db
      .select({ status: itemReceipts.status })
      .from(itemReceipts)
      .where(eq(itemReceipts.id, receiptId));
    const status = await recomputeReceiptStatus(ctx, receiptId, null);
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'item_receipt',
      entityId: receiptId,
      oldValues: { status: before[0]?.status },
      newValues: { status, reason: `bill_void:${billId}` },
    });
  }
  for (const poId of poIds) await recomputePoStatus(ctx, poId, `bill_void:${billId}`, { force: true });
}
