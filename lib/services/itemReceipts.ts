/**
 * Item Receipts service - QB "Receive Items" (inventory arrives before the vendor bill).
 *
 * createItemReceipt posts:
 *   Dr  Inventory Asset (per line; item.assetAccountId ?? code 1300)   [inventory items]
 *   Dr  Expense (line.accountId ?? item.expenseAccountId)              [non-inventory items]
 *   Cr  Item Receipts Accrual  2050  (find-or-create; liability)
 * and receives stock in the SAME transaction, mirroring bills.ts receipt logic:
 *   - FIFO-tracked items (any inventoryLayers rows) get a new cost layer,
 *   - average-cost items get a weighted-average cost update,
 * with no second GL posting (the receipt's own entry carries the inventory debit).
 *
 * Optional PO link: each receipt line's quantity is claimed against the PO's
 * purchaseOrderLines.quantityBilled via purchaseOrders.claimReceiptQuantities -
 * the same counter convertToBill uses - so a received quantity can never be
 * billed again from the PO. The PO status moves open -> partial -> closed.
 *
 * convertToBill mechanics (documented design choice):
 *   The receipt entry already carries Dr Inventory / Cr 2050 plus the stock
 *   movement, so the bill must NOT receive stock or debit inventory again.
 *   Conversion creates the bill through bills.createBill using ACCOUNT lines
 *   routed at the 2050 accrual (no itemId on the bill lines), which posts:
 *     Dr 2050 Item Receipts Accrual / Cr 2000 Accounts Payable
 *   Net effect of the two entries = Dr Inventory / Cr A/P (the canonical bill
 *   posting), the accrual nets to zero per receipt, inventory quantities and
 *   costs are untouched, and the trial balance stays exact. Because the bill
 *   lines carry no itemId, a later voidBill is also safe (it only reverses
 *   stock for item lines). PO quantities are NOT claimed again.
 *
 * voidItemReceipt: blocked once billed (void the bill is not enough - the
 *   accrual relief would dangle); reverses the GL entry, pulls the received
 *   stock back out (CONFLICT if it was already consumed), and releases any
 *   claimed PO quantities (PO can return to 'open').
 */
import { assertAccountantMayConvert } from './accountantCopy/guard';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  accounts,
  inventoryLayers,
  itemReceiptBillLines,
  itemReceiptLines,
  itemReceipts,
  items,
  journalEntries,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { postJournalEntry, voidJournalEntry } from '@/lib/services/posting';
import { createBill } from '@/lib/services/bills';
import {
  claimReceiptQuantities,
  releaseReceiptQuantities,
} from '@/lib/services/purchaseOrders';
import {
  type InventoryLineDetail,
  attachInventoryDetails,
  loadDocumentInventoryDetails,
  postDocumentInventory,
  reverseDocumentInventory,
} from './inventorySites';
import { assertNoActiveLandedCost } from './landedCost';
import { assertClosedPeriodEdit, retitleEntry } from './postedEdit';
import { layerRoundingTolerance, takeFromDocumentLayers } from './fifo';
import { valueRemainderAfter } from './inventory';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { adjustPoReceivedUnbilled, recomputePoStatus } from './receivingLinks';
import { getHomeCurrencyCode } from './currencies';

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

/**
 * The clearing liability that holds received-not-billed value. QB calls this
 * "Inventory Offset" / item receipts accrual. It is an Other Current Liability (not A/P:
 * it must not show in the A/P figure or need a vendor name); the 2050 code keeps it
 * adjacent to 2000 A/P.
 */
export const ITEM_RECEIPT_ACCRUAL_CODE = '2050';
export const ITEM_RECEIPT_ACCRUAL_NAME = 'Item Receipts Accrual';

export interface ItemReceiptLineInput extends InventoryLineDetail {
  itemId: string;
  description?: string | null;
  /** Units received (> 0). */
  quantity: string | number;
  /** Per-unit cost (>= 0). Line amount = round2(quantity * unitCost), must be > 0. */
  unitCost: string | number;
}

export interface CreateItemReceiptInput {
  vendorId: string;
  date: Date;
  /** Vendor packing slip / reference number. */
  reference?: string | null;
  memo?: string | null;
  /**
   * Optional PO link. When set, EVERY line's item must be on the PO with enough
   * remaining unreceived quantity (quantity - quantityBilled).
   */
  purchaseOrderId?: string | null;
  lines: ItemReceiptLineInput[];
}

export interface ConvertReceiptToBillOptions {
  /** Vendor bill number; defaults to the receipt's reference. */
  billNumber?: string | null;
  /** Bill date; defaults to the receipt date. */
  date?: Date;
  dueDate?: Date | null;
}

// ---------------------------------------------------------------------------
// Helpers (mirror bills.ts - those helpers are module-private there)
// ---------------------------------------------------------------------------

/** Resolve an account id by code, scoped to the company. Throws NOT_FOUND. */
async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** Find-or-create the 2050 Item Receipts Accrual liability account. */
export async function getOrCreateAccrualAccount(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, ITEM_RECEIPT_ACCRUAL_CODE)),
    );
  if (row) return row.id;
  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code: ITEM_RECEIPT_ACCRUAL_CODE,
      name: ITEM_RECEIPT_ACCRUAL_NAME,
      type: 'liability',
      subtype: 'other_current_liability',
      description: 'Received-not-billed clearing account for item receipts (QB Receive Items).',
    })
    .returning();
  return created.id;
}

/** True when the item has ever had FIFO cost layers (mirrors bills.ts/inventory). */
async function isFifoTracked(ctx: ServiceContext, itemId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: inventoryLayers.id })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)))
    .limit(1);
  return Boolean(row);
}

type Dec = ReturnType<typeof Money.zero>;

/**
 * Receive stock for one inventory item line (subledger only - the receipt's
 * journal entry already carries the Dr Inventory). Mirrors bills.ts.
 */
async function receiveStock(
  ctx: ServiceContext,
  itemId: string,
  qty: Dec,
  unitCost: Dec,
  date: Date,
  reason: string,
): Promise<void> {
  // Reload inside the tx so multiple lines for the same item compound correctly.
  const [item] = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.id, itemId)));
  if (!item) throw notFound(`Item ${itemId}`);

  const currentQty = Money.of(item.quantityOnHand ?? '0');
  const newQty = currentQty.plus(qty);

  if (await isFifoTracked(ctx, itemId)) {
    await ctx.db.insert(inventoryLayers).values({
      companyId: ctx.companyId,
      itemId,
      date,
      quantityRemaining: qty.toFixed(4),
      unitCost: unitCost.toFixed(4),
      // Tag the layer with its receipt so landed cost can find (and revalue) it.
      sourceRef: reason,
    });
    await ctx.db
      .update(items)
      .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
      .where(eq(items.id, itemId));
  } else {
    const currentAvg = Money.of(item.averageCost ?? '0');
    const newAvg = newQty.isZero()
      ? unitCost
      : currentQty.times(currentAvg).plus(qty.times(unitCost)).dividedBy(newQty);
    await ctx.db
      .update(items)
      .set({
        quantityOnHand: newQty.toFixed(4),
        averageCost: newAvg.toFixed(4),
        // The cents the 4dp average cannot represent stay on record (as bills.ts receivePurchasedStock):
        // the receipt's entry put round2(qty x unit cost) on the inventory account.
        ...valueRemainderAfter(item, currentQty, newQty, newAvg, Money.round2(qty.times(unitCost))),
        updatedAt: new Date(),
      })
      .where(eq(items.id, itemId));
  }

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'item',
    entityId: itemId,
    oldValues: { quantityOnHand: item.quantityOnHand, averageCost: item.averageCost },
    newValues: {
      quantityOnHand: newQty.toFixed(4),
      unitCost: unitCost.toFixed(4),
      reason,
    },
  });
}

/**
 * Reverse a stock receive (receipt void). Mirrors voidBill's reversal: CONFLICT
 * when on-hand no longer covers the received quantity, FIFO layer drawdown
 * preferring layers at this receipt's cost (newest first) then oldest-first,
 * or a weighted-average back-out.
 */
async function reverseStock(
  ctx: ServiceContext,
  itemId: string,
  qty: Dec,
  unitCost: Dec,
  reason: string,
): Promise<void> {
  const [item] = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.id, itemId)));
  if (!item || item.type !== 'inventory') return;
  if (qty.lessThanOrEqualTo(0)) return;

  const currentQty = Money.of(item.quantityOnHand ?? '0');
  if (currentQty.lessThan(qty)) {
    throw new ServiceError(
      'CONFLICT',
      `Cannot void this item receipt: only ${currentQty.toFixed(4)} of "${item.name}" remain on hand (the received stock has already been consumed).`,
    );
  }
  const newQty = currentQty.minus(qty);
  const fifoTracked = await isFifoTracked(ctx, itemId);
  // The receipt's own layers (receiveStock tags them item_receipt:<id>; the reason ends with the id):
  // exactly what it added, or a CONFLICT when its units were sold / revalued since.
  const own = fifoTracked
    ? await takeFromDocumentLayers(ctx, {
        itemId,
        itemName: item.name,
        sourceRefs: [`item_receipt:${reason.slice(reason.lastIndexOf(':') + 1)}`],
        qty,
        expectedValue: Money.round2(qty.times(unitCost)),
        unitCost,
        action: 'void this item receipt',
      })
    : null;

  if (own) {
    await ctx.db
      .update(items)
      .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
      .where(eq(items.id, itemId));
  } else if (fifoTracked) {
    // Older data (layers not tagged with their receipt): cost match, then oldest-first.
    const layers = await ctx.db
      .select()
      .from(inventoryLayers)
      .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)))
      .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));
    const available = layers.filter((l) => Money.of(l.quantityRemaining).greaterThan(0));
    const costKey = unitCost.toFixed(4);
    const ordered = [
      ...available.filter((l) => Money.of(l.unitCost).toFixed(4) === costKey).reverse(),
      ...available.filter((l) => Money.of(l.unitCost).toFixed(4) !== costKey),
    ];

    let remaining = qty;
    for (const layer of ordered) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const layerQty = Money.of(layer.quantityRemaining);
      const take = remaining.lessThanOrEqualTo(layerQty) ? remaining : layerQty;
      await ctx.db
        .update(inventoryLayers)
        .set({ quantityRemaining: layerQty.minus(take).toFixed(4) })
        .where(eq(inventoryLayers.id, layer.id));
      remaining = remaining.minus(take);
    }
    if (remaining.greaterThan(0)) {
      throw new ServiceError(
        'CONFLICT',
        `Cannot void this item receipt: FIFO layers for "${item.name}" no longer hold the received quantity.`,
      );
    }
    await ctx.db
      .update(items)
      .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
      .where(eq(items.id, itemId));
  } else {
    const currentAvg = Money.of(item.averageCost ?? '0');
    const remainingValue = currentQty.times(currentAvg).minus(qty.times(unitCost));
    // The voided entry takes the receipt's full cost off the inventory account; refuse when the
    // stock left is worth less (written down / sold at a lower average since) instead of clamping
    // the average to 0 and leaving the GL below the item's value.
    if (remainingValue.lessThan(layerRoundingTolerance(currentQty).negated())) {
      throw new ServiceError(
        'CONFLICT',
        `Cannot void this item receipt: the "${item.name}" on hand are valued at ${toAmountString(Money.round2(currentQty.times(currentAvg)))}, less than the ${toAmountString(Money.round2(qty.times(unitCost)))} it added (their cost was written down or the units sold since). Reverse the value adjustment or those sales first.`,
      );
    }
    const newAvg = newQty.isZero()
      ? Money.zero()
      : remainingValue.lessThan(0)
        ? Money.zero()
        : remainingValue.dividedBy(newQty);
    await ctx.db
      .update(items)
      .set({
        quantityOnHand: newQty.toFixed(4),
        averageCost: newAvg.toFixed(4),
        // The voided entry took round2(qty x unit cost) off the inventory account.
        ...valueRemainderAfter(item, currentQty, newQty, newAvg, Money.round2(qty.times(unitCost)).negated()),
        updatedAt: new Date(),
      })
      .where(eq(items.id, itemId));
  }

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'item',
    entityId: itemId,
    oldValues: { quantityOnHand: item.quantityOnHand, averageCost: item.averageCost },
    newValues: { quantityOnHand: newQty.toFixed(4), reason },
  });
}

/**
 * Item receipts post at home-currency cost through the 2050 accrual and have no exchange rate,
 * so a foreign-currency vendor's goods must be entered with a bill (which converts them).
 */
async function assertHomeCurrencyVendor(ctx: ServiceContext, vendorCurrency: string | null) {
  if (!vendorCurrency) return;
  const home = await getHomeCurrencyCode(ctx);
  if (home && vendorCurrency.toUpperCase() === home) return;
  throw validation(
    `This vendor uses ${vendorCurrency}. Receive their items with Enter Bills (which converts to your home currency) instead of an item receipt.`,
  );
}

// ---------------------------------------------------------------------------
// createItemReceipt
// ---------------------------------------------------------------------------

export async function createItemReceipt(ctx: ServiceContext, input: CreateItemReceiptInput) {
  return saveItemReceipt(ctx, input);
}

/**
 * Edit a saved item receipt (wave2 D1) — allowed while nothing of it has been billed. In ONE
 * transaction the old receipt is unwound exactly like a void (entry voided on its old date,
 * stock pulled back out, site movements reversed, PO quantities released) and the new version
 * is posted on the SAME receipt (same id, so FIFO layers / landed-cost links keep pointing at it).
 */
/** Inventory detail of a line as the comparison key (null/undefined/empty treated alike). */
function receiptDetailKey(d: Partial<InventoryLineDetail> | null | undefined): string {
  const serials = [...(d?.serialNumbers ?? [])].map((s) => String(s).trim()).filter(Boolean).sort();
  const exp = d?.lotExpiration ? new Date(d.lotExpiration).toISOString().slice(0, 10) : '';
  return [d?.siteId ?? '', d?.binId ?? '', serials.join(','), (d?.lotNumber ?? '').trim(), exp].join('|');
}

/**
 * A reference / memo / line-description edit of a saved receipt changes nothing in the ledger or
 * the stock (same vendor, date, PO link, items, quantities, costs and receiving site / bin /
 * serials / lot). QB allows it on any receipt, also once its items were sold or it was billed, so
 * it must not go through the void + repost path, which refuses when the received units are gone.
 */
async function isLedgerNeutralReceiptEdit(
  ctx: ServiceContext,
  receipt: typeof itemReceipts.$inferSelect,
  input: CreateItemReceiptInput,
): Promise<boolean> {
  if (!receipt.postedEntryId || receipt.vendorId !== input.vendorId) return false;
  if ((receipt.purchaseOrderId ?? null) !== (input.purchaseOrderId ?? null)) return false;
  if (new Date(receipt.date).toISOString().slice(0, 10) !== new Date(input.date).toISOString().slice(0, 10)) return false;
  const oldLines = await ctx.db
    .select()
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, receipt.id))
    .orderBy(asc(itemReceiptLines.lineOrder));
  if (!input.lines || oldLines.length !== input.lines.length) return false;
  const details = await loadDocumentInventoryDetails(ctx, 'item_receipt', receipt.id);
  for (const [i, n] of input.lines.entries()) {
    const o = oldLines[i];
    let qty: Dec;
    let cost: Dec;
    try {
      qty = Money.of(Money.of(n.quantity).toFixed(4));
      cost = Money.of(Money.of(n.unitCost).toFixed(4));
    } catch {
      return false;
    }
    if (o.itemId !== n.itemId || !qty.equals(Money.of(o.quantity)) || !cost.equals(Money.of(o.unitCost))) return false;
    const given =
      n.siteId !== undefined ||
      n.binId !== undefined ||
      n.serialNumbers !== undefined ||
      n.lotNumber !== undefined ||
      n.lotExpiration !== undefined;
    if (given && receiptDetailKey(n) !== receiptDetailKey(details.get(o.lineOrder))) return false;
  }
  const [entry] = await ctx.db
    .select({ status: journalEntries.status })
    .from(journalEntries)
    .where(and(eq(journalEntries.id, receipt.postedEntryId), eq(journalEntries.companyId, ctx.companyId)));
  return entry?.status === 'posted';
}

/** Ledger-neutral receipt edit (see isLedgerNeutralReceiptEdit): reference, memo, descriptions. */
async function updateReceiptHeaderInTx(tx: ServiceContext, id: string, input: CreateItemReceiptInput) {
  const [cur] = await tx.db.select().from(itemReceipts).where(and(eq(itemReceipts.id, id), eq(itemReceipts.companyId, tx.companyId)));
  if (!cur || cur.status === 'void' || !(await isLedgerNeutralReceiptEdit(tx, cur, input))) {
    throw new ServiceError('CONFLICT', 'This item receipt was changed by someone else while you edited it. Reload it and try again.');
  }
  // Closing date: even a memo change to a closed-period receipt needs the password.
  await assertClosedPeriodEdit(tx, { entryId: cur.postedEntryId, what: 'item receipt', date: cur.date });
  const [vendor] = await tx.db.select({ name: vendors.displayName }).from(vendors).where(eq(vendors.id, cur.vendorId));
  const [updated] = await tx.db
    .update(itemReceipts)
    .set({ reference: input.reference ?? null, memo: input.memo ?? null })
    .where(eq(itemReceipts.id, id))
    .returning();
  const oldLines = await tx.db
    .select()
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, id))
    .orderBy(asc(itemReceiptLines.lineOrder));
  const names = new Map(
    (
      await tx.db
        .select({ id: items.id, name: items.name })
        .from(items)
        .where(and(eq(items.companyId, tx.companyId), inArray(items.id, oldLines.map((l) => l.itemId))))
    ).map((r) => [r.id, r.name] as const),
  );
  for (const [i, o] of oldLines.entries()) {
    await tx.db
      .update(itemReceiptLines)
      .set({ description: input.lines[i].description ?? names.get(o.itemId) ?? null })
      .where(eq(itemReceiptLines.id, o.id));
  }
  await retitleEntry(tx, cur.postedEntryId, {
    description: `Item receipt ${input.reference ? `#${input.reference}` : id} - ${vendor?.name ?? ''}`.trim(),
    reference: input.reference ?? null,
  });
  await writeAudit(tx, {
    action: 'update',
    entityType: 'item_receipt',
    entityId: id,
    oldValues: { reference: cur.reference, memo: cur.memo, lines: oldLines.map((l) => ({ description: l.description })) },
    newValues: {
      reference: input.reference ?? null,
      memo: input.memo ?? null,
      ledger: 'unchanged',
      lines: input.lines.map((l) => ({ description: l.description ?? null })),
    },
  });
  const lines = await tx.db
    .select()
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, id))
    .orderBy(asc(itemReceiptLines.lineOrder));
  return { ...updated, lines };
}

export async function updateItemReceipt(ctx: ServiceContext, id: string, input: CreateItemReceiptInput) {
  const [receipt] = await ctx.db
    .select()
    .from(itemReceipts)
    .where(and(eq(itemReceipts.id, id), eq(itemReceipts.companyId, ctx.companyId)));
  if (!receipt) throw notFound('Item receipt');
  if (receipt.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided item receipt.');
  // Reference / memo / description only: allowed on any receipt and never reposts (see above) —
  // except while landed cost is allocated onto it (locked until the allocation is voided).
  if (await isLedgerNeutralReceiptEdit(ctx, receipt, input)) {
    await assertNoActiveLandedCost(ctx, { itemReceiptId: id });
    return inTransaction(ctx, (tx) => updateReceiptHeaderInTx(tx, id, input));
  }
  if (receipt.status !== 'open') {
    throw new ServiceError(
      'CONFLICT',
      'This item receipt has been (partly) billed, so it can no longer be edited. Void the bill first.',
    );
  }
  return saveItemReceipt(ctx, input, receipt);
}

async function saveItemReceipt(
  ctx: ServiceContext,
  input: CreateItemReceiptInput,
  existing?: typeof itemReceipts.$inferSelect,
) {
  // --- Validate vendor ---
  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName, currency: vendors.currency })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');
  await assertHomeCurrencyVendor(ctx, vendor.currency);

  if (!input.lines || input.lines.length === 0) {
    throw validation('An item receipt must have at least one line.');
  }

  // --- Pre-load referenced items (debit routing + inventory typing) ---
  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const itemRows = await ctx.db
    .select({
      id: items.id,
      type: items.type,
      name: items.name,
      assetAccountId: items.assetAccountId,
      expenseAccountId: items.expenseAccountId,
    })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
  const itemMap = new Map(itemRows.map((r) => [r.id, r]));
  for (const id of itemIds) {
    if (!itemMap.has(id)) throw notFound(`Item ${id}`);
  }

  // --- Resolve lines (Money math; no JS floats) ---
  type ResolvedLine = {
    itemId: string;
    accountId: string; // debit target
    description: string | null;
    quantity: Dec;
    unitCost: Dec;
    amount: string; // 2dp
    isInventory: boolean;
  };
  const resolved: ResolvedLine[] = [];
  let total = Money.zero();
  let defaultInventoryAcctId: string | null = null;

  for (const [i, line] of input.lines.entries()) {
    const item = itemMap.get(line.itemId)!;
    // Quantity and unit cost are stored at 4 places (item_receipt_lines, FIFO layers); the amount
    // is worked out from the stored values (as purchase orders do). A cost typed past 4 decimals
    // (0.33333 x 1000) used to post 333.33 while the stored cost / FIFO layer valued 333.30, so
    // the inventory GL drifted from the stock valuation and a void left the cents behind.
    let qty: Dec;
    let unitCost: Dec;
    try {
      qty = Money.of(Money.of(line.quantity).toFixed(4));
      unitCost = Money.of(Money.of(line.unitCost).toFixed(4));
    } catch {
      throw validation(`Line ${i + 1}: enter the quantity and unit cost as numbers.`);
    }
    if (!qty.isFinite() || !unitCost.isFinite()) {
      throw validation(`Line ${i + 1}: enter the quantity and unit cost as numbers.`);
    }
    if (qty.lessThanOrEqualTo(0)) {
      throw validation(`Line ${i + 1}: quantity must be greater than zero.`);
    }
    if (unitCost.isNegative()) {
      throw validation(`Line ${i + 1}: unit cost cannot be negative.`);
    }
    // A $0 line (items received at no charge — a no-charge line of a purchase order) stocks the
    // units at $0 and posts nothing; the receipt's total must still be more than zero (below).
    const amount = Money.round2(qty.times(unitCost));

    const isInventory = item.type === 'inventory';
    let accountId: string;
    if (isInventory) {
      if (item.assetAccountId) {
        accountId = item.assetAccountId;
      } else {
        defaultInventoryAcctId ??= await accountIdByCode(ctx, '1300');
        accountId = defaultInventoryAcctId;
      }
    } else {
      if (!item.expenseAccountId) {
        throw validation(
          `Line ${i + 1}: item "${item.name}" has no expense account - set one on the item before receiving it.`,
        );
      }
      accountId = item.expenseAccountId;
    }

    resolved.push({
      itemId: line.itemId,
      accountId,
      description: line.description ?? item.name,
      quantity: qty,
      unitCost,
      amount: toAmountString(amount),
      isInventory,
    });
    total = total.plus(amount);
  }
  if (!total.greaterThan(0)) {
    throw validation('The item receipt total must be more than zero (quantity x unit cost on at least one line).');
  }
  const totalStr = toAmountString(total);

  return inTransaction(ctx, async (tx) => {
    // Find-or-create the accrual account INSIDE the transaction: PGlite serializes transactions,
    // so two first receipts saved at once find one 2050 account instead of each creating one.
    const accrualAccountId = await getOrCreateAccrualAccount(tx);

    // --- Edit: unwind the saved version first (mirrors voidItemReceipt, minus the status flip) ---
    let oldLines: Array<typeof itemReceiptLines.$inferSelect> = [];
    if (existing) {
      const [cur] = await tx.db.select().from(itemReceipts).where(eq(itemReceipts.id, existing.id));
      if (!cur || cur.status !== 'open') {
        throw new ServiceError('CONFLICT', 'This item receipt can no longer be edited (it was billed or voided).');
      }
      oldLines = await tx.db
        .select()
        .from(itemReceiptLines)
        .where(eq(itemReceiptLines.itemReceiptId, existing.id))
        .orderBy(asc(itemReceiptLines.lineOrder));
      if (oldLines.some((l) => Money.of(l.quantityBilled ?? '0').greaterThan(0))) {
        throw new ServiceError('CONFLICT', 'Part of this item receipt was already billed, so it can no longer be edited.');
      }
      await assertNoActiveLandedCost(tx, { itemReceiptId: existing.id });
      if (cur.postedEntryId) await voidJournalEntry(tx, cur.postedEntryId);
      for (const line of oldLines) {
        await reverseStock(tx, line.itemId, Money.of(line.quantity), Money.of(line.unitCost), `item_receipt_edit:${existing.id}`);
      }
      await reverseDocumentInventory(tx, 'item_receipt', existing.id);
      if (cur.purchaseOrderId) {
        await releaseReceiptQuantities(
          tx,
          cur.purchaseOrderId,
          oldLines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
          { sourceRef: `item_receipt_edit:${existing.id}` },
        );
      }
      await tx.db.delete(itemReceiptLines).where(eq(itemReceiptLines.itemReceiptId, existing.id));
    }

    // --- Claim PO quantities first (guarded; throws before anything posts) ---
    if (input.purchaseOrderId) {
      await claimReceiptQuantities(
        tx,
        input.purchaseOrderId,
        resolved.map((l) => ({ itemId: l.itemId, quantity: l.quantity.toFixed(4) })),
        { vendorId: input.vendorId, sourceRef: 'item_receipt_claim' },
      );
    }

    // --- Insert (or, on edit, rewrite) the receipt header ---
    const header = {
      vendorId: input.vendorId,
      purchaseOrderId: input.purchaseOrderId ?? null,
      date: input.date,
      reference: input.reference ?? null,
      status: 'open',
      total: totalStr,
      memo: input.memo ?? null,
    };
    const [receipt] = existing
      ? await tx.db.update(itemReceipts).set(header).where(eq(itemReceipts.id, existing.id)).returning()
      : await tx.db
          .insert(itemReceipts)
          .values({ companyId: tx.companyId, ...header })
          .returning();

    // --- Insert lines ---
    const insertedLines = await tx.db
      .insert(itemReceiptLines)
      .values(
        resolved.map((l, idx) => ({
          itemReceiptId: receipt.id,
          itemId: l.itemId,
          description: l.description,
          quantity: l.quantity.toFixed(4),
          unitCost: l.unitCost.toFixed(4),
          amount: l.amount,
          lineOrder: idx,
        })),
      )
      .returning();

    // --- Post Dr Inventory/Expense (per line) / Cr 2050 accrual (total) ---
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Item receipt ${input.reference ? `#${input.reference}` : receipt.id} - ${vendor.name}`,
      reference: input.reference ?? null,
      sourceRef: `item_receipt:${receipt.id}`,
      lines: [
        // A $0 no-charge line posts nothing.
        ...resolved
          .filter((l) => Money.gt(l.amount, 0))
          .map((l) => ({
            accountId: l.accountId,
            debit: l.amount,
            memo: l.description,
          })),
        {
          accountId: accrualAccountId,
          credit: totalStr,
          memo: `Item receipt ${input.reference ?? receipt.id} - ${vendor.name}`,
        },
      ],
    });

    const [updated] = await tx.db
      .update(itemReceipts)
      .set({ postedEntryId: entry.id })
      .where(eq(itemReceipts.id, receipt.id))
      .returning();

    // --- Receive stock for inventory lines (subledger only; same tx) ---
    for (const l of resolved) {
      if (!l.isInventory) continue;
      await receiveStock(tx, l.itemId, l.quantity, l.unitCost, input.date, `item_receipt:${receipt.id}`);
    }

    // --- Advanced Inventory: receiving site / bin / serials / lot ---
    await postDocumentInventory(tx, {
      sourceType: 'item_receipt',
      sourceId: receipt.id,
      date: input.date,
      direction: 'in',
      lines: resolved.map((l, idx) => {
        const src = input.lines[idx];
        return {
          lineOrder: idx,
          itemId: l.isInventory ? l.itemId : null,
          quantity: l.quantity,
          siteId: src?.siteId,
          binId: src?.binId,
          serialNumbers: src?.serialNumbers,
          lotNumber: src?.lotNumber,
          lotExpiration: src?.lotExpiration,
        };
      }),
      memo: `Item receipt ${input.reference ?? ''}`.trim(),
      carryForward: Boolean(existing),
    });

    await writeAudit(tx, {
      action: existing ? 'update' : 'create',
      entityType: 'item_receipt',
      entityId: receipt.id,
      oldValues: existing
        ? {
            vendorId: existing.vendorId,
            date: existing.date,
            total: existing.total,
            postedEntryId: existing.postedEntryId,
            lines: oldLines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost })),
          }
        : undefined,
      newValues: {
        vendorId: input.vendorId,
        purchaseOrderId: input.purchaseOrderId ?? null,
        total: totalStr,
        linesCount: resolved.length,
      },
    });

    return { ...updated, lines: insertedLines };
  });
}

// ---------------------------------------------------------------------------
// listItemReceipts / getItemReceipt
// ---------------------------------------------------------------------------

export async function listItemReceipts(
  ctx: ServiceContext,
  opts?: { vendorId?: string; status?: string },
) {
  const conditions = [eq(itemReceipts.companyId, ctx.companyId)];
  if (opts?.vendorId) conditions.push(eq(itemReceipts.vendorId, opts.vendorId));
  if (opts?.status) conditions.push(eq(itemReceipts.status, opts.status));

  return ctx.db
    .select()
    .from(itemReceipts)
    .where(and(...conditions))
    .orderBy(desc(itemReceipts.date), desc(itemReceipts.createdAt));
}

export async function getItemReceipt(ctx: ServiceContext, id: string) {
  const [receipt] = await ctx.db
    .select()
    .from(itemReceipts)
    .where(and(eq(itemReceipts.id, id), eq(itemReceipts.companyId, ctx.companyId)));
  if (!receipt) throw notFound('Item receipt');

  const lines = await ctx.db
    .select()
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, id))
    .orderBy(asc(itemReceiptLines.lineOrder));

  return { ...receipt, lines: await attachInventoryDetails(ctx, 'item_receipt', id, lines) };
}

// ---------------------------------------------------------------------------
// convertToBill
// ---------------------------------------------------------------------------

/**
 * Enter the vendor's bill for a received-not-billed item receipt. Creates a
 * real A/P bill whose lines all debit the 2050 accrual (see the module header
 * for why this keeps inventory and the trial balance exact), then marks the
 * receipt 'billed'. Returns the created bill.
 */
export async function convertToBill(
  ctx: ServiceContext,
  receiptId: string,
  opts?: ConvertReceiptToBillOptions,
) {
  await assertAccountantMayConvert(ctx, 'Turning an item receipt into a bill'); // Accountant's Copy (I1)
  const [receipt] = await ctx.db
    .select()
    .from(itemReceipts)
    .where(and(eq(itemReceipts.id, receiptId), eq(itemReceipts.companyId, ctx.companyId)));
  if (!receipt) throw notFound('Item receipt');
  if (receipt.status === 'billed') {
    throw new ServiceError('CONFLICT', 'This item receipt has already been converted to a bill.');
  }
  if (receipt.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot convert a voided item receipt to a bill.');
  }
  const [rv] = await ctx.db.select({ currency: vendors.currency }).from(vendors).where(eq(vendors.id, receipt.vendorId));
  await assertHomeCurrencyVendor(ctx, rv?.currency ?? null);

  const lines = await ctx.db
    .select()
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, receiptId))
    .orderBy(asc(itemReceiptLines.lineOrder));
  if (lines.length === 0) throw validation('Item receipt has no lines to bill.');

  // Item names for readable bill-line descriptions.
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const itemRows = await ctx.db
    .select({ id: items.id, name: items.name })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
  const nameById = new Map(itemRows.map((r) => [r.id, r.name]));

  return inTransaction(ctx, async (tx) => {
    const accrualAccountId = await getOrCreateAccrualAccount(tx);
    // Claim the receipt first (guarded conditional UPDATE) so a concurrent
    // conversion can never post a second bill against the same accrual.
    const claimed = await tx.db
      .update(itemReceipts)
      .set({ status: 'billed' })
      .where(
        and(
          eq(itemReceipts.id, receiptId),
          eq(itemReceipts.companyId, tx.companyId),
          eq(itemReceipts.status, 'open'),
        ),
      )
      .returning({ id: itemReceipts.id });
    if (claimed.length === 0) {
      throw new ServiceError(
        'CONFLICT',
        'This item receipt was converted or voided by another transaction. Reload and retry.',
      );
    }

    // Bill lines all debit the accrual: Dr 2050 / Cr 2000 A/P. No itemId on the
    // lines: stock was already received by the receipt (and voidBill must not
    // reverse stock for these lines).
    const bill = await createBill(tx, {
      vendorId: receipt.vendorId,
      billNumber: opts?.billNumber ?? receipt.reference ?? null,
      date: opts?.date ?? receipt.date,
      dueDate: opts?.dueDate ?? null,
      memo:
        receipt.memo ??
        `Bill for item receipt ${receipt.reference ?? receipt.id} (accrual relief)`,
      lines: lines.map((l) => ({
        accountId: accrualAccountId,
        description: `${nameById.get(l.itemId) ?? 'Item'} - received ${Money.of(l.quantity).toFixed(4)} @ ${Money.of(l.unitCost).toFixed(4)}${l.description ? ` (${l.description})` : ''}`,
        quantity: l.quantity,
        amount: l.amount,
      })),
    });

    await tx.db
      .update(itemReceipts)
      .set({ convertedBillId: bill.id })
      .where(eq(itemReceipts.id, receiptId));

    // Enhanced-receiving bookkeeping: the whole receipt is now billed at its own cost (no
    // variance). Link rows let voidBill put the quantities back to "awaiting bill".
    for (const l of lines) {
      await tx.db
        .update(itemReceiptLines)
        .set({ quantityBilled: l.quantity })
        .where(eq(itemReceiptLines.id, l.id));
    }
    await tx.db.insert(itemReceiptBillLines).values(
      lines.map((l) => ({
        companyId: tx.companyId,
        billId: bill.id,
        itemReceiptId: receiptId,
        itemReceiptLineId: l.id,
        itemId: l.itemId,
        quantity: l.quantity,
        receiptUnitCost: l.unitCost,
        billUnitCost: l.unitCost,
        accrualAmount: l.amount,
        billAmount: l.amount,
      })),
    );
    if (receipt.purchaseOrderId) {
      for (const l of lines) {
        await adjustPoReceivedUnbilled(tx, receipt.purchaseOrderId, l.itemId, Money.of(l.quantity).negated());
      }
      await recomputePoStatus(tx, receipt.purchaseOrderId, `item_receipt_billed:${receiptId}`);
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item_receipt',
      entityId: receiptId,
      oldValues: { status: 'open' },
      newValues: { status: 'billed', convertedBillId: bill.id },
    });

    return bill;
  });
}

// ---------------------------------------------------------------------------
// voidItemReceipt
// ---------------------------------------------------------------------------

export async function voidItemReceipt(ctx: ServiceContext, id: string) {
  // Load + validate in the same transaction as the void: a double-submitted void (or a void
  // racing the conversion to a bill) must see the receipt's current status, not take its stock
  // out and release the PO quantities twice.
  return inTransaction(ctx, (tx) => voidItemReceiptInTx(tx, id));
}

async function voidItemReceiptInTx(ctx: ServiceContext, id: string) {
  const [receipt] = await ctx.db
    .select()
    .from(itemReceipts)
    .where(and(eq(itemReceipts.id, id), eq(itemReceipts.companyId, ctx.companyId)));
  if (!receipt) throw notFound('Item receipt');

  if (receipt.status === 'void') return receipt; // idempotent

  if (receipt.status === 'billed' || receipt.status === 'partial') {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void an item receipt that has been (partly) billed. Void the bill first - then the receipt.',
    );
  }

  const lines = await ctx.db
    .select()
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, id))
    .orderBy(asc(itemReceiptLines.lineOrder));

  return inTransaction(ctx, async (tx) => {
    // Landed cost capitalised onto this receipt must be voided first (its value sits in the
    // receipt's cost layers / average cost).
    await assertNoActiveLandedCost(tx, { itemReceiptId: id });

    // Reverse the GL entry (Dr 2050 / Cr Inventory at the receipt's cost).
    if (receipt.postedEntryId) {
      await voidJournalEntry(tx, receipt.postedEntryId);
    }

    // Pull the received stock back out of the subledger.
    for (const line of lines) {
      await reverseStock(
        tx,
        line.itemId,
        Money.of(line.quantity),
        Money.of(line.unitCost),
        `item_receipt_void:${id}`,
      );
    }

    // Take the units back out of the site/bin (and serials/lots) they were received into.
    await reverseDocumentInventory(tx, 'item_receipt', id);

    // Release the PO quantities this receipt claimed.
    if (receipt.purchaseOrderId) {
      await releaseReceiptQuantities(
        tx,
        receipt.purchaseOrderId,
        lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
        { sourceRef: `item_receipt_void:${id}` },
      );
    }

    const [updated] = await tx.db
      .update(itemReceipts)
      .set({ status: 'void', voidedAt: new Date() })
      .where(eq(itemReceipts.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'item_receipt',
      entityId: id,
      oldValues: { status: receipt.status },
      newValues: { status: 'void' },
    });

    return updated;
  });
}
