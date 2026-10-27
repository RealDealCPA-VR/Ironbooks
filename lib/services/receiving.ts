/**
 * Enhanced receiving — QB Desktop Enterprise "Enhanced Inventory Receiving" parity.
 *
 * Receiving and billing are separate events:
 *   1. Receive Items (itemReceipts.createItemReceipt) posts Dr Inventory / Cr 2050 Item Receipts
 *      Accrual at the RECEIPT cost and claims the PO's received quantity.
 *   2. Enter Bill for Received Items (enterBillForReceivedItems, here) bills any subset of open
 *      receipt lines at the VENDOR's quantity and unit cost. One balanced entry via
 *      postJournalEntry:
 *        Dr 2050 Item Receipts Accrual   qty x receipt cost (exactly relieves what was accrued)
 *        Dr/Cr <variance target>         bill amount - accrual (price variance, signed)
 *        Cr 2000 Accounts Payable        qty x billed cost
 *      Variance target (company preference companies.settings.receiving.varianceMode):
 *        'inventory' — inventory items: the share of the variance on stock still on hand is
 *                      capitalized into the item's cost (Dr/Cr Inventory Asset; average cost or
 *                      the receipt's FIFO layers are re-costed); the share on stock already sold
 *                      goes to 5000 Cost of Goods Sold.
 *        'ppv'       — inventory items: the whole variance goes to the Purchase Price Variance
 *                      expense account (item cost unchanged).
 *      Non-inventory items always take the variance to the item's expense account (the same
 *      account the receipt debited).
 *      Billing fewer units than were received leaves the rest open on the receipt (quantity
 *      variance). `closeLine` writes the unbilled remainder off instead (the vendor will never
 *      bill it): Dr 2050 / Cr variance target at receipt cost.
 *   3. PO status: with enhanced receiving on, a PO closes only when fully received AND billed
 *      (receivingLinks.poStatusFromLines).
 *
 * Voiding such a bill (bills.voidBill -> receivingLinks.releaseReceiptBilling) reverses the
 * entry and restores receipt/PO quantities and any inventory cost adjustment.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  accounts,
  bills,
  billLines,
  companies,
  inventoryLayers,
  itemReceiptBillLines,
  itemReceiptLines,
  itemReceipts,
  items,
  landedCostAllocationLines,
  landedCostAllocations,
  purchaseOrderLines,
  purchaseOrders,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { postJournalEntry } from './posting';
import { cogsAccountForItem, fifoLayerValue, valueRemainderAfter } from './inventory';
import { layersWorth } from './fifo';
import { ITEM_RECEIPT_ACCRUAL_CODE, getOrCreateAccrualAccount } from './itemReceipts';
import {
  type ReceivingSettings,
  adjustPoReceivedUnbilled,
  getReceivingSettings,
  poStatusFromLines,
  recomputePoStatus,
  recomputeReceiptStatus,
} from './receivingLinks';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';

type Dec = ReturnType<typeof Money.zero>;

export { getReceivingSettings, type ReceivingSettings };

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function updateReceivingSettings(
  ctx: ServiceContext,
  patch: Partial<ReceivingSettings>,
): Promise<ReceivingSettings> {
  if (patch.varianceMode && patch.varianceMode !== 'inventory' && patch.varianceMode !== 'ppv') {
    throw validation('varianceMode must be "inventory" or "ppv".');
  }
  if (patch.ppvAccountId) {
    const [acct] = await ctx.db
      .select({ id: accounts.id, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, patch.ppvAccountId)));
    if (!acct) throw notFound('Purchase price variance account');
    if (acct.type !== 'expense') throw validation('The purchase price variance account must be an expense account.');
  }
  return inTransaction(ctx, async (tx) => {
    const before = await getReceivingSettings(tx);
    const next: ReceivingSettings = {
      enhancedReceiving: patch.enhancedReceiving ?? before.enhancedReceiving,
      varianceMode: patch.varianceMode ?? before.varianceMode,
      ppvAccountId: patch.ppvAccountId !== undefined ? patch.ppvAccountId : before.ppvAccountId,
    };
    const [row] = await tx.db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, tx.companyId));
    if (!row) throw notFound('Company');
    await tx.db
      .update(companies)
      .set({ settings: { ...(row.settings ?? {}), receiving: next }, updatedAt: new Date() })
      .where(eq(companies.id, tx.companyId));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'receiving_settings',
      entityId: tx.companyId,
      oldValues: before,
      newValues: next,
    });

    // Turning enhanced receiving on/off changes when POs count as closed — re-derive the
    // auto-managed statuses (never reopens a PO the user closed by hand).
    if (next.enhancedReceiving !== before.enhancedReceiving) {
      const open = await tx.db
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.companyId, tx.companyId), inArray(purchaseOrders.status, ['open', 'partial'])));
      for (const po of open) await recomputePoStatus(tx, po.id, 'receiving_settings_changed');
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// Open receipt lines (the "Enter Bill for Received Items" worksheet)
// ---------------------------------------------------------------------------

export interface OpenReceiptLine {
  receiptId: string;
  receiptDate: Date;
  reference: string | null;
  receiptStatus: string;
  purchaseOrderId: string | null;
  poNumber: number | null;
  lineId: string;
  itemId: string;
  itemName: string;
  itemType: string;
  description: string | null;
  quantityReceived: string;
  quantityBilled: string;
  /** Received but not yet billed. */
  quantityOpen: string;
  receiptUnitCost: string;
  /** PO rate for this item (first PO line for the item), when linked to a PO. */
  poUnitCost: string | null;
  poQuantityOrdered: string | null;
}

/** Every receipt line from this vendor that is received but not fully billed. */
export async function listOpenReceiptLines(ctx: ServiceContext, vendorId: string): Promise<OpenReceiptLine[]> {
  const [vendor] = await ctx.db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId)));
  if (!vendor) throw notFound('Vendor');

  const rows = await ctx.db
    .select({
      receiptId: itemReceipts.id,
      receiptDate: itemReceipts.date,
      reference: itemReceipts.reference,
      receiptStatus: itemReceipts.status,
      purchaseOrderId: itemReceipts.purchaseOrderId,
      lineId: itemReceiptLines.id,
      itemId: itemReceiptLines.itemId,
      itemName: items.name,
      itemType: items.type,
      description: itemReceiptLines.description,
      quantity: itemReceiptLines.quantity,
      quantityBilled: itemReceiptLines.quantityBilled,
      unitCost: itemReceiptLines.unitCost,
    })
    .from(itemReceiptLines)
    .innerJoin(itemReceipts, eq(itemReceiptLines.itemReceiptId, itemReceipts.id))
    .innerJoin(items, eq(itemReceiptLines.itemId, items.id))
    .where(
      and(
        eq(itemReceipts.companyId, ctx.companyId),
        eq(itemReceipts.vendorId, vendorId),
        inArray(itemReceipts.status, ['open', 'partial']),
        sql`${itemReceiptLines.quantityBilled} < ${itemReceiptLines.quantity}`,
      ),
    )
    .orderBy(asc(itemReceipts.date), asc(itemReceipts.createdAt), asc(itemReceiptLines.lineOrder));

  const poIds = [...new Set(rows.map((r) => r.purchaseOrderId).filter((x): x is string => !!x))];
  const poNumbers = new Map<string, number>();
  const poRefs = new Map<string, string>();
  const poLinesByPo = new Map<string, Array<typeof purchaseOrderLines.$inferSelect>>();
  if (poIds.length > 0) {
    const pos = await ctx.db
      .select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber, refNumber: purchaseOrders.refNumber })
      .from(purchaseOrders)
      .where(inArray(purchaseOrders.id, poIds));
    for (const p of pos) {
      poNumbers.set(p.id, p.poNumber);
      poRefs.set(p.id, p.refNumber || String(p.poNumber));
    }
    const pls = await ctx.db
      .select()
      .from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.purchaseOrderId, poIds))
      .orderBy(asc(purchaseOrderLines.lineOrder));
    for (const l of pls) {
      const list = poLinesByPo.get(l.purchaseOrderId) ?? [];
      list.push(l);
      poLinesByPo.set(l.purchaseOrderId, list);
    }
  }

  return rows.map((r) => {
    const poLines = r.purchaseOrderId
      ? (poLinesByPo.get(r.purchaseOrderId) ?? []).filter((l) => l.itemId === r.itemId)
      : [];
    const ordered = poLines.reduce((s, l) => s.plus(Money.of(l.quantity)), Money.zero());
    return {
      receiptId: r.receiptId,
      receiptDate: r.receiptDate,
      reference: r.reference,
      receiptStatus: r.receiptStatus,
      purchaseOrderId: r.purchaseOrderId,
      poNumber: r.purchaseOrderId ? (poNumbers.get(r.purchaseOrderId) ?? null) : null,
      poRef: r.purchaseOrderId ? (poRefs.get(r.purchaseOrderId) ?? null) : null,
      lineId: r.lineId,
      itemId: r.itemId,
      itemName: r.itemName,
      itemType: r.itemType,
      description: r.description,
      quantityReceived: Money.of(r.quantity).toFixed(4),
      quantityBilled: Money.of(r.quantityBilled).toFixed(4),
      quantityOpen: Money.of(r.quantity).minus(Money.of(r.quantityBilled)).toFixed(4),
      receiptUnitCost: Money.of(r.unitCost).toFixed(4),
      poUnitCost: poLines.length > 0 ? Money.of(poLines[0].rate).toFixed(4) : null,
      poQuantityOrdered: poLines.length > 0 ? ordered.toFixed(4) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Variance computation (shared by preview + post)
// ---------------------------------------------------------------------------

export interface ReceiptBillLineInput {
  /** item_receipt_lines.id */
  receiptLineId: string;
  /** Quantity the vendor is billing (<= the line's open quantity). May be 0 with closeLine. */
  quantity: string | number;
  /** The vendor's unit cost on the bill. */
  unitCost: string | number;
  /** Write off any quantity left unbilled on this receipt line after this bill. */
  closeLine?: boolean;
}

export interface EnterReceiptBillInput {
  vendorId: string;
  billNumber?: string | null;
  date: Date;
  dueDate?: Date | null;
  memo?: string | null;
  lines: ReceiptBillLineInput[];
}

export interface ReceiptBillLinePreview {
  receiptLineId: string;
  receiptId: string;
  itemId: string;
  itemName: string;
  isInventory: boolean;
  quantityReceived: string;
  quantityOpen: string;
  quantityBilled: string;
  /** Received-but-not-billed after this bill (0 when the line is closed). */
  quantityRemaining: string;
  quantityWrittenOff: string;
  receiptUnitCost: string;
  billUnitCost: string;
  poUnitCost: string | null;
  accrualAmount: string;
  billAmount: string;
  /** billAmount - accrual for the billed quantity (positive = vendor charged more). */
  priceVariance: string;
  /** Variance vs the PO price for the billed quantity (informational). */
  poPriceVariance: string | null;
  /** Credit from writing off the unbilled remainder (negative or 0). */
  writeOffVariance: string;
  varianceMode: 'inventory' | 'ppv' | 'expense' | 'none';
  inventoryVariance: string;
  expensedVariance: string;
}

export interface ReceiptBillPreview {
  lines: ReceiptBillLinePreview[];
  billTotal: string;
  accrualRelieved: string;
  totalVariance: string;
  /** The balanced journal entry the bill will post. */
  postingLines: Array<{ accountId: string; accountName: string; debit: string | null; credit: string | null; memo: string }>;
}

interface PlannedLine extends ReceiptBillLinePreview {
  receipt: typeof itemReceipts.$inferSelect;
  line: typeof itemReceiptLines.$inferSelect;
  /** Qty touched by this bill (billed + written off). */
  qtyTouched: Dec;
  varianceAccountId: string | null;
  inventoryAccountId: string | null;
  layerPlan: Array<{ layer: typeof inventoryLayers.$inferSelect; take: Dec }>;
}

async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** Placeholder account id used by previews before the PPV account exists. */
const PPV_PLACEHOLDER = 'ppv:new';
const ACCRUAL_PLACEHOLDER = 'accrual:new';

/**
 * Resolve (or create on first use) the Purchase Price Variance expense account. With
 * `dryRun` nothing is created — a placeholder id is returned instead (previews are read-only).
 */
export async function getOrCreatePpvAccount(
  ctx: ServiceContext,
  settings: ReceivingSettings,
  dryRun = false,
): Promise<string> {
  if (settings.ppvAccountId) {
    const [acct] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, settings.ppvAccountId)));
    if (acct) return acct.id;
  }
  const all = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const byName = all.find((a) => a.type === 'expense' && a.name.toLowerCase() === 'purchase price variance');
  if (byName) return byName.id;
  const used = new Set(all.map((a) => a.code));
  let code = 5150;
  while (used.has(String(code)) && code < 5199) code++;
  if (used.has(String(code))) {
    throw validation('Choose a Purchase Price Variance account in the receiving preferences.');
  }
  if (dryRun) return PPV_PLACEHOLDER;
  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code: String(code),
      name: 'Purchase Price Variance',
      type: 'expense',
      subtype: 'cost_of_goods_sold',
      description: 'Difference between vendor-billed cost and item-receipt cost (enhanced receiving).',
    })
    .returning();
  return created.id;
}

/** Look up the 2050 accrual account without creating it (placeholder when missing). */
async function findAccrualAccount(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, ITEM_RECEIPT_ACCRUAL_CODE)));
  return row?.id ?? ACCRUAL_PLACEHOLDER;
}

async function isFifoTracked(ctx: ServiceContext, itemId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: inventoryLayers.id })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Layers of a receipt's item that bills entered against the receipt (still active: a void deletes
 * its link rows) have already re-costed — the layerIds in their item_receipt_bill_lines
 * layerAdjustments — plus the units landed cost later split off those (they carry the bill's
 * increment too). The next bill on the receipt must not re-cost them again.
 */
async function recostedReceiptLayers(ctx: ServiceContext, receiptId: string, itemId: string): Promise<Set<string>> {
  const links = await ctx.db
    .select({ layerAdjustments: itemReceiptBillLines.layerAdjustments })
    .from(itemReceiptBillLines)
    .where(
      and(
        eq(itemReceiptBillLines.companyId, ctx.companyId),
        eq(itemReceiptBillLines.itemReceiptId, receiptId),
        eq(itemReceiptBillLines.itemId, itemId),
      ),
    );
  const ids = new Set<string>();
  for (const link of links) {
    for (const a of link.layerAdjustments ?? []) if (a.kind !== 'average' && a.layerId) ids.add(a.layerId);
  }
  if (ids.size === 0) return ids;
  const splits = await ctx.db
    .select({ layerAdjustments: landedCostAllocationLines.layerAdjustments })
    .from(landedCostAllocationLines)
    .innerJoin(landedCostAllocations, eq(landedCostAllocationLines.allocationId, landedCostAllocations.id))
    .where(and(eq(landedCostAllocations.companyId, ctx.companyId), eq(landedCostAllocationLines.itemId, itemId)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of splits) {
      for (const a of row.layerAdjustments ?? []) {
        if (a.splitFrom && ids.has(a.splitFrom) && !ids.has(a.layerId)) {
          ids.add(a.layerId);
          grew = true;
        }
      }
    }
  }
  return ids;
}

/** Validate the request and compute every amount (read-only when `dryRun`). */
async function planReceiptBill(ctx: ServiceContext, input: EnterReceiptBillInput, dryRun = false) {
  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, input.vendorId)));
  if (!vendor) throw notFound('Vendor');
  if (!input.lines || input.lines.length === 0) {
    throw validation('Select at least one received item to bill.');
  }

  const ids = input.lines.map((l) => l.receiptLineId);
  if (new Set(ids).size !== ids.length) throw validation('A receipt line is listed twice.');

  const rows = await ctx.db
    .select({ line: itemReceiptLines, receipt: itemReceipts })
    .from(itemReceiptLines)
    .innerJoin(itemReceipts, eq(itemReceiptLines.itemReceiptId, itemReceipts.id))
    .where(and(eq(itemReceipts.companyId, ctx.companyId), inArray(itemReceiptLines.id, ids)));
  const byId = new Map(rows.map((r) => [r.line.id, r]));

  const itemIds = [...new Set(rows.map((r) => r.line.itemId))];
  const itemRows = itemIds.length
    ? await ctx.db.select().from(items).where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)))
    : [];
  const itemById = new Map(itemRows.map((i) => [i.id, i]));

  // Receipts with more than one line for the same item: their own layers at another line's cost
  // belong to that other line, so a bill on one line must never re-cost them.
  const receiptIds = [...new Set(rows.map((r) => r.receipt.id))];
  const linesPerReceiptItem = new Map<string, number>();
  if (receiptIds.length) {
    const all = await ctx.db
      .select({ receiptId: itemReceiptLines.itemReceiptId, itemId: itemReceiptLines.itemId })
      .from(itemReceiptLines)
      .where(inArray(itemReceiptLines.itemReceiptId, receiptIds));
    for (const l of all) {
      const key = `${l.receiptId}|${l.itemId}`;
      linesPerReceiptItem.set(key, (linesPerReceiptItem.get(key) ?? 0) + 1);
    }
  }

  // Previously relieved accrual per line (for exact-cent relief on the final bill).
  const prior = await ctx.db
    .select({ lineId: itemReceiptBillLines.itemReceiptLineId, accrual: itemReceiptBillLines.accrualAmount })
    .from(itemReceiptBillLines)
    .where(and(eq(itemReceiptBillLines.companyId, ctx.companyId), inArray(itemReceiptBillLines.itemReceiptLineId, ids)));
  const priorAccrual = new Map<string, Dec>();
  for (const p of prior) priorAccrual.set(p.lineId, (priorAccrual.get(p.lineId) ?? Money.zero()).plus(Money.of(p.accrual)));

  // PO rate per (po, item): first PO line for the item.
  const poIds = [...new Set(rows.map((r) => r.receipt.purchaseOrderId).filter((x): x is string => !!x))];
  const poRate = new Map<string, string>();
  if (poIds.length) {
    const pls = await ctx.db
      .select()
      .from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.purchaseOrderId, poIds))
      .orderBy(asc(purchaseOrderLines.lineOrder));
    for (const l of pls) {
      const key = `${l.purchaseOrderId}|${l.itemId}`;
      if (l.itemId && !poRate.has(key)) poRate.set(key, l.rate);
    }
  }

  const settings = await getReceivingSettings(ctx);
  let ppvAccountId: string | null = null;
  let defaultInventoryAcctId: string | null = null;
  // FIFO layer quantity already planned by earlier rows of this bill (same item, same layer).
  const layerTaken = new Map<string, Dec>();

  const planned: PlannedLine[] = [];
  for (const [i, req] of input.lines.entries()) {
    const n = i + 1;
    const row = byId.get(req.receiptLineId);
    if (!row) throw notFound(`Receipt line on row ${n}`);
    const { line, receipt } = row;
    if (receipt.vendorId !== input.vendorId) throw validation(`Row ${n}: that receipt is from a different vendor.`);
    if (receipt.status === 'void') throw new ServiceError('CONFLICT', `Row ${n}: the item receipt is void.`);
    const item = itemById.get(line.itemId);
    if (!item) throw notFound(`Item on row ${n}`);

    const received = Money.of(line.quantity);
    const open = received.minus(Money.of(line.quantityBilled));
    const qty = Money.of(req.quantity);
    const cost = Money.of(req.unitCost);
    if (qty.isNegative()) throw validation(`Row ${n}: quantity cannot be negative.`);
    if (cost.isNegative()) throw validation(`Row ${n}: unit cost cannot be negative.`);
    if (qty.isZero() && !req.closeLine) throw validation(`Row ${n}: enter a quantity to bill.`);
    if (!open.greaterThan(0)) throw new ServiceError('CONFLICT', `Row ${n}: this receipt line is already fully billed.`);
    if (qty.greaterThan(open)) {
      throw validation(
        `Row ${n}: only ${open.toFixed(4)} of "${item.name}" are received and not yet billed. Receive the extra quantity first.`,
      );
    }

    const receiptCost = Money.of(line.unitCost);
    const writeOffQty = req.closeLine ? open.minus(qty) : Money.zero();
    const touched = qty.plus(writeOffQty);
    const closesLine = !open.minus(touched).greaterThan(0);

    // Accrual relieved: qty x receipt cost, except the bill that finishes the line relieves
    // exactly what is left of the receipt's posted amount (no stranded pennies in 2050).
    const remainingAccrual = Money.of(line.amount).minus(priorAccrual.get(line.id) ?? Money.zero());
    let accrualBilled = Money.round2(qty.times(receiptCost));
    let accrualWrittenOff = Money.round2(writeOffQty.times(receiptCost));
    if (closesLine) {
      if (writeOffQty.greaterThan(0)) accrualWrittenOff = remainingAccrual.minus(accrualBilled);
      else accrualBilled = remainingAccrual;
    }
    const billAmount = Money.round2(qty.times(cost));
    const priceVariance = billAmount.minus(accrualBilled);
    const writeOffVariance = accrualWrittenOff.negated();
    const totalVariance = priceVariance.plus(writeOffVariance);

    const isInventory = item.type === 'inventory';
    let varianceMode: PlannedLine['varianceMode'] = 'none';
    let varianceAccountId: string | null = null;
    let inventoryAccountId: string | null = null;
    let inventoryVariance = Money.zero();
    let expensedVariance = Money.zero();
    let layerPlan: PlannedLine['layerPlan'] = [];

    if (!totalVariance.isZero()) {
      if (!isInventory) {
        varianceMode = 'expense';
        if (!item.expenseAccountId) {
          throw validation(`Row ${n}: item "${item.name}" has no expense account for the price variance.`);
        }
        varianceAccountId = item.expenseAccountId;
        expensedVariance = totalVariance;
      } else if (settings.varianceMode === 'ppv') {
        varianceMode = 'ppv';
        ppvAccountId ??= await getOrCreatePpvAccount(ctx, settings, dryRun);
        varianceAccountId = ppvAccountId;
        expensedVariance = totalVariance;
      } else {
        varianceMode = 'inventory';
        inventoryAccountId = item.assetAccountId ?? (defaultInventoryAcctId ??= await accountIdByCode(ctx, '1300'));
        // The part on units already sold is cost of sales of THIS item: its own COGS account, as
        // its sales post (cogsAccountForItem), not 5000.
        varianceAccountId = await cogsAccountForItem(ctx, item);
        // How much of the touched quantity is still in stock at the receipt's cost?
        let covered = Money.zero();
        if (await isFifoTracked(ctx, item.id)) {
          const layers = await ctx.db
            .select()
            .from(inventoryLayers)
            .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, item.id)))
            .orderBy(desc(inventoryLayers.date), desc(inventoryLayers.createdAt));
          const costKey = receiptCost.toFixed(4);
          const open = layers.filter((l) => Money.of(l.quantityRemaining).greaterThan(0));
          // The receipt's own layers (tagged item_receipt:<id>) still on hand, whatever their cost
          // now (landed cost may have raised it), except those an earlier bill on the receipt
          // already re-costed. Layers at one of this line's costs come first (a receipt with two
          // lines for the item): a receipt stores a line as layer(s) worth exactly its amount
          // (fifo.ts layersWorth) — one layer at the 4dp cost, or (qty - 1) units plus a one-unit
          // layer carrying the cents.
          const ownRef = `item_receipt:${receipt.id}`;
          const ownCosts = new Set([
            costKey,
            ...layersWorth(received, Money.of(line.amount)).map((p) => p.unitCost.toFixed(4)),
          ]);
          const recosted = await recostedReceiptLayers(ctx, receipt.id, item.id);
          const ownOpen = open.filter((l) => l.sourceRef === ownRef && !recosted.has(l.id));
          const atLineCost = (l: (typeof layers)[number]) => ownCosts.has(Money.of(l.unitCost).toFixed(4));
          // Layers at another cost (raised by landed cost) are this line's only when the receipt has
          // no other line for the item; otherwise they may be the other line's units.
          const soleLine = (linesPerReceiptItem.get(`${receipt.id}|${item.id}`) ?? 0) <= 1;
          const own = [...ownOpen.filter(atLineCost), ...(soleLine ? ownOpen.filter((l) => !atLineCost(l)) : [])];
          // Receipts recorded before layers were tagged: older (untagged) layers at the receipt's
          // cost, same date first, newest first. Never when the receipt has layers of its own (its
          // units were sold, or are re-costed already): other stock is not the receipt's.
          const tagged = layers.some((l) => l.sourceRef === ownRef);
          const legacy = tagged
            ? []
            : open.filter((l) => l.sourceRef == null && Money.of(l.unitCost).toFixed(4) === costKey);
          const sameDay = legacy.filter((l) => l.date.getTime() === receipt.date.getTime());
          const ordered = [...own, ...sameDay, ...legacy.filter((l) => !sameDay.includes(l))];
          let need = touched;
          for (const layer of ordered) {
            if (!need.greaterThan(0)) break;
            const avail = Money.of(layer.quantityRemaining).minus(layerTaken.get(layer.id) ?? Money.zero());
            if (!avail.greaterThan(0)) continue;
            const take = need.lessThan(avail) ? need : avail;
            layerTaken.set(layer.id, (layerTaken.get(layer.id) ?? Money.zero()).plus(take));
            layerPlan.push({ layer, take });
            covered = covered.plus(take);
            need = need.minus(take);
          }
        } else {
          const onHand = Money.of(item.quantityOnHand ?? '0');
          covered = onHand.greaterThan(0) ? (touched.lessThan(onHand) ? touched : onHand) : Money.zero();
        }
        inventoryVariance = touched.isZero()
          ? Money.zero()
          : Money.round2(totalVariance.times(covered).dividedBy(touched));
        if (!layerPlan.length) {
          // Average cost: never drive the item's stock value below zero.
          const value = Money.of(item.quantityOnHand ?? '0').times(Money.of(item.averageCost ?? '0'));
          const floor = Money.round2(value).negated();
          if (inventoryVariance.lessThan(floor)) inventoryVariance = floor;
        }
        if (inventoryVariance.isZero()) layerPlan = [];
        expensedVariance = totalVariance.minus(inventoryVariance);
      }
    }

    const poKey = receipt.purchaseOrderId ? `${receipt.purchaseOrderId}|${line.itemId}` : null;
    const poCost = poKey ? (poRate.get(poKey) ?? null) : null;
    planned.push({
      receipt,
      line,
      qtyTouched: touched,
      varianceAccountId,
      inventoryAccountId,
      layerPlan,
      receiptLineId: line.id,
      receiptId: receipt.id,
      itemId: item.id,
      itemName: item.name,
      isInventory,
      quantityReceived: received.toFixed(4),
      quantityOpen: open.toFixed(4),
      quantityBilled: qty.toFixed(4),
      quantityRemaining: open.minus(touched).toFixed(4),
      quantityWrittenOff: writeOffQty.toFixed(4),
      receiptUnitCost: receiptCost.toFixed(4),
      billUnitCost: cost.toFixed(4),
      poUnitCost: poCost ? Money.of(poCost).toFixed(4) : null,
      accrualAmount: toAmountString(accrualBilled.plus(accrualWrittenOff)),
      billAmount: toAmountString(billAmount),
      priceVariance: toAmountString(priceVariance),
      poPriceVariance: poCost ? toAmountString(billAmount.minus(Money.round2(qty.times(poCost)))) : null,
      writeOffVariance: toAmountString(writeOffVariance),
      varianceMode,
      inventoryVariance: toAmountString(inventoryVariance),
      expensedVariance: toAmountString(expensedVariance),
    });
  }

  const billTotal = planned.reduce((s, l) => s.plus(Money.of(l.billAmount)), Money.zero());
  const accrualRelieved = planned.reduce((s, l) => s.plus(Money.of(l.accrualAmount)), Money.zero());
  // A $0 "bill" is allowed only as a pure write-off: closing received quantity the vendor will
  // never bill (QB: close the PO short). It still relieves the accrual through the GL.
  const writeOffOnly = planned.some((l) => Money.gt(l.quantityWrittenOff, 0)) && accrualRelieved.greaterThan(0);
  if (billTotal.isNegative() || (billTotal.isZero() && !writeOffOnly)) {
    throw validation('The bill total must be greater than zero.');
  }

  // Previews are read-only: never create the 2050 account from one (a receipt already did).
  const accrualAccountId = dryRun ? await findAccrualAccount(ctx) : await getOrCreateAccrualAccount(ctx);
  const [apRow] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2000')));
  if (!apRow) throw notFound('Accounts Payable account (code 2000)');
  // A variance / inventory account on A/P would merge into the bill's own A/P line below and
  // put an amount on A/P that the bill (and so A/P aging) does not carry (QB invariant I11).
  if (planned.some((l) => l.varianceAccountId === apRow.id || l.inventoryAccountId === apRow.id)) {
    throw validation("Accounts Payable can't be used as an item's expense, cost or inventory account. Pick an expense or asset account instead.");
  }

  // Aggregate signed amounts per account: positive = debit, negative = credit.
  const signed = new Map<string, { amount: Dec; memo: string }>();
  const add = (accountId: string, amount: Dec, memo: string) => {
    if (amount.isZero()) return;
    const prev = signed.get(accountId);
    signed.set(accountId, { amount: (prev?.amount ?? Money.zero()).plus(amount), memo: prev?.memo ?? memo });
  };
  add(accrualAccountId, accrualRelieved, 'Item receipts accrual relieved');
  for (const l of planned) {
    if (l.inventoryAccountId) add(l.inventoryAccountId, Money.of(l.inventoryVariance), `Price variance capitalized — ${l.itemName}`);
    if (l.varianceAccountId) {
      add(
        l.varianceAccountId,
        Money.of(l.expensedVariance),
        l.varianceMode === 'ppv' ? 'Purchase price variance' : `Price variance — ${l.itemName}`,
      );
    }
  }
  add(apRow.id, billTotal.negated(), `Bill ${input.billNumber ?? ''} — ${vendor.name}`.replace('  ', ' '));

  const acctIds = [...signed.keys()].filter((id) => id !== PPV_PLACEHOLDER && id !== ACCRUAL_PLACEHOLDER);
  const names = new Map(
    (
      await ctx.db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(inArray(accounts.id, acctIds))
    ).map((a) => [a.id, a.name]),
  );
  names.set(PPV_PLACEHOLDER, 'Purchase Price Variance (created when you save)');
  names.set(ACCRUAL_PLACEHOLDER, 'Item Receipts Accrual (created when you save)');
  const postingLines = [...signed.entries()]
    .filter(([, v]) => !v.amount.isZero())
    .map(([accountId, v]) => ({
      accountId,
      accountName: names.get(accountId) ?? accountId,
      debit: v.amount.greaterThan(0) ? toAmountString(v.amount) : null,
      credit: v.amount.lessThan(0) ? toAmountString(v.amount.negated()) : null,
      memo: v.memo,
    }));

  return {
    vendor,
    planned,
    accrualAccountId,
    apAccountId: apRow.id,
    preview: {
      lines: planned.map(({ receipt: _r, line: _l, qtyTouched: _q, varianceAccountId: _v, inventoryAccountId: _i, layerPlan: _p, ...rest }) => rest),
      billTotal: toAmountString(billTotal),
      accrualRelieved: toAmountString(accrualRelieved),
      totalVariance: toAmountString(billTotal.minus(accrualRelieved)),
      postingLines,
    } satisfies ReceiptBillPreview,
  };
}

/** Compute variances and the journal entry WITHOUT saving anything (for the UI). */
export async function previewReceiptBill(ctx: ServiceContext, input: EnterReceiptBillInput): Promise<ReceiptBillPreview> {
  return (await planReceiptBill(ctx, input, true)).preview;
}

// ---------------------------------------------------------------------------
// enterBillForReceivedItems
// ---------------------------------------------------------------------------

export async function enterBillForReceivedItems(ctx: ServiceContext, input: EnterReceiptBillInput) {
  return inTransaction(ctx, async (tx) => {
    // Plan INSIDE the transaction so quantities/costs/layers cannot shift underneath us.
    const { vendor, planned, preview, accrualAccountId, apAccountId } = await planReceiptBill(tx, input);

    const [bill] = await tx.db
      .insert(bills)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId,
        billNumber: input.billNumber ?? null,
        date: input.date,
        dueDate: input.dueDate ?? null,
        memo:
          input.memo ??
          (Money.isZero(preview.billTotal)
            ? `Write-off of unbilled received items — ${vendor.name}`
            : `Bill for received items — ${vendor.name}`),
        // A pure write-off owes the vendor nothing.
        status: Money.isZero(preview.billTotal) ? 'paid' : 'open',
        total: preview.billTotal,
        amountPaid: '0.00',
        amountCredited: '0.00',
        balanceDue: preview.billTotal,
      })
      .returning();

    // Bill lines mirror the GL: the accrual relief per receipt line, plus signed variance lines.
    // No itemId on any line — stock was received by the receipt (voidBill must not reverse it).
    const lineRows: Array<typeof billLines.$inferInsert> = [];
    let order = 0;
    for (const l of planned) {
      const memo = `${l.itemName} — ${Money.of(l.quantityBilled).toString()} @ ${Money.of(l.billUnitCost).toFixed(2)} (received @ ${Money.of(l.receiptUnitCost).toFixed(2)})`;
      lineRows.push({
        billId: bill.id,
        accountId: accrualAccountId,
        description: memo,
        quantity: l.quantityBilled,
        amount: l.accrualAmount,
        lineOrder: order++,
      });
      if (!Money.isZero(l.inventoryVariance) && l.inventoryAccountId) {
        lineRows.push({
          billId: bill.id,
          accountId: l.inventoryAccountId,
          description: `Price variance capitalized — ${l.itemName}`,
          quantity: '1',
          amount: l.inventoryVariance,
          lineOrder: order++,
        });
      }
      if (!Money.isZero(l.expensedVariance) && l.varianceAccountId) {
        lineRows.push({
          billId: bill.id,
          accountId: l.varianceAccountId,
          description:
            Money.gt(l.quantityWrittenOff, 0)
              ? `Variance incl. write-off of ${Money.of(l.quantityWrittenOff).toString()} unbilled — ${l.itemName}`
              : `Price variance — ${l.itemName}`,
          quantity: '1',
          amount: l.expensedVariance,
          lineOrder: order++,
        });
      }
    }
    await tx.db.insert(billLines).values(lineRows);

    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Bill ${input.billNumber ? `#${input.billNumber}` : bill.id} — received items (${vendor.name})`,
      reference: input.billNumber ?? null,
      sourceRef: `bill:${bill.id}`,
      lines: preview.postingLines.map((p) => ({
        accountId: p.accountId,
        debit: p.debit,
        credit: p.credit,
        memo: p.memo,
        // The bill's own A/P line (posting.ts PostingLine.controlLine).
        ...(p.accountId === apAccountId ? { controlLine: true } : {}),
      })),
    });
    const [updated] = await tx.db
      .update(bills)
      .set({ postedEntryId: entry.id, updatedAt: new Date() })
      .where(eq(bills.id, bill.id))
      .returning();

    // Subledger: receipt quantities, inventory cost adjustments, PO counters, link rows.
    const receiptIds = new Set<string>();
    const poIds = new Set<string>();
    for (const l of planned) {
      receiptIds.add(l.receiptId);
      const touchedStr = l.qtyTouched.toFixed(4);
      const claimed = await tx.db
        .update(itemReceiptLines)
        .set({ quantityBilled: sql`${itemReceiptLines.quantityBilled} + ${touchedStr}::numeric` })
        .where(
          and(
            eq(itemReceiptLines.id, l.receiptLineId),
            sql`${itemReceiptLines.quantityBilled} + ${touchedStr}::numeric <= ${itemReceiptLines.quantity}`,
          ),
        )
        .returning({ id: itemReceiptLines.id });
      if (claimed.length === 0) {
        throw new ServiceError('CONFLICT', 'These received items were billed by another transaction. Reload and retry.');
      }

      const layerAdjustments: Array<Record<string, string>> = [];
      const invVariance = Money.of(l.inventoryVariance);
      if (!invVariance.isZero()) {
        if (l.layerPlan.length > 0) {
          // The bill moves the inventory account by exactly invVariance, so the covered units'
          // layers must gain exactly that: each planned piece takes its share to the cent and its
          // units are stored as layer(s) worth exactly their new value (fifo.ts layersWorth). A
          // common 4dp unit delta cannot carry it (3000 units + $100.00 = 0.0333 each = $99.90).
          const coveredQty = l.layerPlan.reduce((s, p) => s.plus(p.take), Money.zero());
          let allocated = Money.zero();
          for (const [k, { layer: planned0, take }] of l.layerPlan.entries()) {
            const share =
              k === l.layerPlan.length - 1
                ? invVariance.minus(allocated)
                : Money.round2(invVariance.times(take).dividedBy(coveredQty));
            allocated = allocated.plus(share);
            // Re-read: an earlier row of this bill may already have split this layer.
            const [layer] = await tx.db.select().from(inventoryLayers).where(eq(inventoryLayers.id, planned0.id));
            const remaining = Money.of(layer.quantityRemaining);
            if (take.greaterThan(remaining)) {
              throw new ServiceError('CONFLICT', 'Inventory changed while billing. Reload and retry.');
            }
            const cost = Money.of(layer.unitCost);
            const rest = remaining.minus(take);
            // What the taken units are worth now: the layer's value before minus after (the rule
            // takeFromLayers relieves by), so the units left in the layer keep their own value.
            const target = fifoLayerValue(remaining, cost).minus(fifoLayerValue(rest, cost)).plus(share);
            if (target.isNegative()) throw validation(`Price variance would make "${l.itemName}" cost negative.`);
            const pieces = layersWorth(take, target);
            const unitDelta = (p: { unitCost: Dec }) => p.unitCost.minus(cost).toFixed(4);
            const insertPiece = async (p: { qty: Dec; unitCost: Dec }) => {
              // Same date and source keeps FIFO order, and landed cost still finds the receipt's units.
              const [split] = await tx.db
                .insert(inventoryLayers)
                .values({
                  companyId: tx.companyId,
                  itemId: l.itemId,
                  date: layer.date,
                  quantityRemaining: p.qty.toFixed(4),
                  unitCost: p.unitCost.toFixed(4),
                  sourceRef: layer.sourceRef,
                })
                .returning();
              // A void restores the cost and merges the units back into `splitFrom`
              // (receivingLinks.releaseReceiptBilling).
              layerAdjustments.push({ layerId: split.id, splitFrom: layer.id, quantity: p.qty.toFixed(4), unitDelta: unitDelta(p) });
            };
            if (rest.isZero()) {
              // The whole layer is re-costed (one unit split off when the cents need it).
              const [first, ...more] = pieces;
              await tx.db
                .update(inventoryLayers)
                .set({ quantityRemaining: first.qty.toFixed(4), unitCost: first.unitCost.toFixed(4) })
                .where(eq(inventoryLayers.id, layer.id));
              layerAdjustments.push({ layerId: layer.id, quantity: first.qty.toFixed(4), unitDelta: unitDelta(first) });
              for (const p of more) await insertPiece(p);
            } else {
              // Split: the re-costed units become their own layer(s).
              await tx.db
                .update(inventoryLayers)
                .set({ quantityRemaining: rest.toFixed(4) })
                .where(eq(inventoryLayers.id, layer.id));
              for (const p of pieces) await insertPiece(p);
            }
          }
        } else {
          const [item] = await tx.db.select().from(items).where(eq(items.id, l.itemId));
          const onHand = Money.of(item.quantityOnHand ?? '0');
          const value = onHand.times(Money.of(item.averageCost ?? '0')).plus(invVariance);
          const newAvg = onHand.greaterThan(0) && value.greaterThan(0) ? value.dividedBy(onHand) : Money.zero();
          await tx.db
            .update(items)
            .set({
              averageCost: newAvg.toFixed(4),
              // The bill capitalized invVariance on the inventory account; what the new book value
              // does not show of it stays on record as the value remainder (0061).
              ...valueRemainderAfter(item, onHand, onHand, newAvg, invVariance),
              updatedAt: new Date(),
            })
            .where(eq(items.id, l.itemId));
          // Snapshot the stock the variance was spread over so a later void can tell whether
          // any of it has since left inventory (see releaseReceiptBilling).
          layerAdjustments.push({ kind: 'average', onHand: onHand.toFixed(4) });
          await writeAudit(tx, {
            action: 'update',
            entityType: 'item',
            entityId: l.itemId,
            oldValues: { averageCost: item.averageCost },
            newValues: { averageCost: newAvg.toFixed(4), reason: `bill_price_variance:${bill.id}` },
          });
        }
      }

      await tx.db.insert(itemReceiptBillLines).values({
        companyId: tx.companyId,
        billId: bill.id,
        itemReceiptId: l.receiptId,
        itemReceiptLineId: l.receiptLineId,
        itemId: l.itemId,
        quantity: touchedStr,
        receiptUnitCost: l.receiptUnitCost,
        billUnitCost: l.billUnitCost,
        accrualAmount: l.accrualAmount,
        billAmount: l.billAmount,
        variance: toAmountString(Money.of(l.billAmount).minus(Money.of(l.accrualAmount))),
        varianceMode: l.varianceMode,
        inventoryVariance: l.inventoryVariance,
        expensedVariance: l.expensedVariance,
        layerAdjustments: layerAdjustments.length ? layerAdjustments : null,
        writtenOff: Money.gt(l.quantityWrittenOff, 0),
      });

      if (l.receipt.purchaseOrderId) {
        poIds.add(l.receipt.purchaseOrderId);
        await adjustPoReceivedUnbilled(tx, l.receipt.purchaseOrderId, l.itemId, l.qtyTouched.negated());
      }
    }

    for (const receiptId of receiptIds) await recomputeReceiptStatus(tx, receiptId, bill.id);
    for (const poId of poIds) await recomputePoStatus(tx, poId, `receipt_bill:${bill.id}`);

    await writeAudit(tx, {
      action: 'create',
      entityType: 'bill',
      entityId: bill.id,
      newValues: {
        source: 'item_receipts',
        total: preview.billTotal,
        accrualRelieved: preview.accrualRelieved,
        totalVariance: preview.totalVariance,
        lines: preview.lines.map((l) => ({
          receiptLineId: l.receiptLineId,
          quantity: l.quantityBilled,
          writtenOff: l.quantityWrittenOff,
          unitCost: l.billUnitCost,
          variance: l.priceVariance,
          varianceMode: l.varianceMode,
        })),
      },
    });

    return { ...updated, preview };
  });
}

// ---------------------------------------------------------------------------
// PO receiving status (Ordered / Received / Billed per line)
// ---------------------------------------------------------------------------

export interface PoReceivingLine {
  lineId: string;
  itemId: string | null;
  description: string | null;
  ordered: string;
  received: string;
  billed: string;
  rate: string;
}

/**
 * Ordered vs received vs billed for every line of a PO. `received` counts item receipts AND
 * direct PO-to-bill conversions (which receive stock); `billed` excludes received-not-billed
 * receipt quantity.
 */
export async function poReceivingStatus(ctx: ServiceContext, poId: string) {
  const [po] = await ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.companyId, ctx.companyId), eq(purchaseOrders.id, poId)));
  if (!po) throw notFound('Purchase order');
  const lines = await ctx.db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, poId))
    .orderBy(asc(purchaseOrderLines.lineOrder));
  const { enhancedReceiving } = await getReceivingSettings(ctx);
  return {
    purchaseOrderId: po.id,
    poNumber: po.poNumber,
    status: po.status,
    computedStatus: poStatusFromLines(lines, enhancedReceiving),
    lines: lines.map((l) => ({
      lineId: l.id,
      itemId: l.itemId,
      description: l.description,
      ordered: Money.of(l.quantity).toFixed(4),
      received: Money.of(l.quantityBilled).toFixed(4),
      billed: Money.of(l.quantityBilled).minus(Money.of(l.quantityReceivedUnbilled)).toFixed(4),
      rate: Money.of(l.rate).toFixed(4),
    })) satisfies PoReceivingLine[],
  };
}
