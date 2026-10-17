/**
 * Landed cost (QB Desktop Enterprise Advanced Inventory parity).
 *
 * Freight, duty and other charges arrive on a vendor bill as ordinary expense lines
 * (Dr Freight-In / Cr A/P). Allocating landed cost moves that charge into the cost of the
 * inventory it relates to — the lines of one or more item receipts — spread by quantity,
 * value or weight (penny-exact via money.allocate).
 *
 * GL (one balanced entry per receipt line, through postJournalEntry, sourceRef `item:<itemId>`
 * so the inventory valuation detail / as-of reports see the value change):
 *
 *   Dr Inventory Asset (item account ?? 1300)   portion for units still on hand
 *   Dr 5000 COGS                               portion for units already sold
 *   Cr <charge account> (the bill line's account)   allocated amount
 *
 * Cost subledger (keeps "inventory GL == inventory valuation"):
 *   - FIFO items: the units still on hand from that receipt are its tagged cost layers
 *     (inventory_layers.source_ref = "item_receipt:<id>"); their unit cost is raised by the
 *     inventory portion. The per-layer increments are recorded so a void backs them out exactly.
 *   - Average-cost items: the on-hand share is min(on hand, received) / received (an average
 *     pool cannot tell which units were sold); averageCost absorbs the inventory portion.
 *   - Unit costs are stored at 4dp, so the inventory debit is the item's actual book-value change
 *     (to the cent, as inventoryValuation measures it) and any sub-cent-per-unit remainder goes to
 *     COGS. FIFO layers split off one unit to carry the remainder, so integer layers stay exact.
 *
 * Voiding reverses the entries and the cost changes, but only while the affected stock is
 * untouched since the allocation (FIFO layers — together with any units later allocations split
 * off them — still hold the same quantity; average items still have the same quantity on hand). Otherwise part of the capitalised cost has already flowed to
 * COGS through sales and an exact reversal is impossible — the user records a value adjustment
 * instead. Bills and item receipts with active allocations cannot be edited or voided.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  accounts,
  billLines,
  bills,
  inventoryLayers,
  itemReceiptLines,
  itemReceipts,
  items,
  landedCostAllocationLines,
  landedCostAllocations,
  vendors,
} from '@/lib/db/schema';
import Decimal from 'decimal.js';
import { Money, allocate, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry } from './posting';
import { valueRemainderAfter } from './inventory';

export type LandedCostMethod = 'quantity' | 'value' | 'weight';

export interface AllocateLandedCostInput {
  billId: string;
  /** The charge (freight/duty/…) line on the bill. */
  billLineId: string;
  /** Amount to allocate; defaults to the line's unallocated remainder. */
  amount?: string | number | null;
  method: LandedCostMethod;
  /** Item receipts whose inventory lines share the charge. */
  itemReceiptIds: string[];
  /** Posting date; defaults to the bill date. */
  date?: Date | null;
  memo?: string | null;
}

export interface LandedCostPreviewLine {
  itemReceiptId: string;
  itemReceiptLineId: string;
  itemId: string;
  itemName: string;
  quantity: string;
  lineValue: string;
  basis: string;
  amount: string;
  /** Portion capitalised into inventory (units still on hand). */
  inventoryAmount: string;
  /** Portion expensed to COGS (units already sold). */
  cogsAmount: string;
}

export interface LandedCostPreview {
  billId: string;
  billLineId: string;
  chargeAccountId: string;
  method: LandedCostMethod;
  amount: string;
  lines: LandedCostPreviewLine[];
}

type Dec = ReturnType<typeof Money.zero>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/**
 * An item's book value exactly as inventoryValuation reports it (FIFO: the sum of its layers'
 * values, each rounded to the cent — inventory.ts fifoLayerValue; average: QOH × average cost
 * rounded to the cent). Landed cost posts the change in this figure so the inventory GL can never
 * drift from valuation through 4dp unit-cost rounding.
 */
/** Change in an average-cost item's book value round2(qty x average) when its average moves. */
function bookValueDelta(qty: Dec, oldAvg: string | null, newAvg: Dec): Dec {
  return Money.round2(qty.times(Money.of(newAvg.toFixed(4)))).minus(Money.round2(qty.times(Money.of(oldAvg ?? '0'))));
}

async function itemBookValue(ctx: ServiceContext, itemId: string, fifo: boolean): Promise<Dec> {
  if (fifo) {
    const [row] = await ctx.db
      .select({
        value: sql<string>`COALESCE(SUM(ROUND(${inventoryLayers.quantityRemaining} * ${inventoryLayers.unitCost}, 2)), 0)`,
      })
      .from(inventoryLayers)
      .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)));
    return Money.round2(row?.value ?? '0');
  }
  const [item] = await ctx.db
    .select({ qoh: items.quantityOnHand, avg: items.averageCost })
    .from(items)
    .where(eq(items.id, itemId));
  return Money.round2(Money.of(item?.qoh ?? '0').times(Money.of(item?.avg ?? '0')));
}

/**
 * One FIFO layer's unit-cost increment, as recorded on an allocation line. `splitFrom` marks a
 * one-unit layer split off `splitFrom` by that allocation (see revalueLayer).
 */
type LayerAdjustment = { layerId: string; quantity: string; unitCostDelta: string; splitFrom?: string };

/**
 * Raise a FIFO layer's value by exactly `part`. Unit cost is stored at 4dp, so the per-unit
 * increment is rounded down and, when that leaves a remainder, one unit is split off into its
 * own layer carrying the remainder (same date/source, so FIFO order is unchanged). Returns the
 * per-layer increments a void backs out.
 */
async function revalueLayer(
  ctx: ServiceContext,
  layer: typeof inventoryLayers.$inferSelect,
  part: Dec,
): Promise<LayerAdjustment[]> {
  const qty = Money.of(layer.quantityRemaining);
  const cost = Money.of(layer.unitCost);
  const delta = part.dividedBy(qty).toDecimalPlaces(4, Decimal.ROUND_DOWN);
  const remainder = part.minus(qty.times(delta));
  const splittable =
    remainder.greaterThan(0) && qty.greaterThan(1) && remainder.toDecimalPlaces(4).equals(remainder);
  if (!splittable) {
    // Exact already, or a fractional layer that cannot carry the remainder exactly — the caller
    // expenses whatever the rounded cost does not capture.
    await ctx.db
      .update(inventoryLayers)
      .set({ unitCost: cost.plus(delta).toFixed(4) })
      .where(eq(inventoryLayers.id, layer.id));
    return [{ layerId: layer.id, quantity: qty.toFixed(4), unitCostDelta: delta.toFixed(4) }];
  }
  const rest = qty.minus(1);
  await ctx.db
    .update(inventoryLayers)
    .set({ quantityRemaining: rest.toFixed(4), unitCost: cost.plus(delta).toFixed(4) })
    .where(eq(inventoryLayers.id, layer.id));
  const unitDelta = delta.plus(remainder);
  const [split] = await ctx.db
    .insert(inventoryLayers)
    .values({
      companyId: layer.companyId,
      itemId: layer.itemId,
      date: layer.date,
      quantityRemaining: '1.0000',
      unitCost: cost.plus(unitDelta).toFixed(4),
      sourceRef: layer.sourceRef,
    })
    .returning();
  return [
    { layerId: layer.id, quantity: rest.toFixed(4), unitCostDelta: delta.toFixed(4) },
    { layerId: split.id, quantity: '1.0000', unitCostDelta: unitDelta.toFixed(4), splitFrom: layer.id },
  ];
}

/** A posting line for a signed amount: positive debits, negative credits. */
function signedLine(accountId: string, amount: Dec, memo: string) {
  return amount.isNegative()
    ? { accountId, credit: toAmountString(amount.negated()), memo }
    : { accountId, debit: toAmountString(amount), memo };
}

/** Sum of active (non-void) allocations per bill line. */
async function allocatedByBillLine(ctx: ServiceContext, billLineIds: string[]): Promise<Map<string, Dec>> {
  if (billLineIds.length === 0) return new Map();
  const rows = await ctx.db
    .select({
      billLineId: landedCostAllocations.billLineId,
      total: sql<string>`COALESCE(SUM(${landedCostAllocations.amount}), 0)`,
    })
    .from(landedCostAllocations)
    .where(
      and(
        eq(landedCostAllocations.companyId, ctx.companyId),
        eq(landedCostAllocations.status, 'posted'),
        inArray(landedCostAllocations.billLineId, billLineIds),
      ),
    )
    .groupBy(landedCostAllocations.billLineId);
  return new Map(rows.map((r) => [r.billLineId, Money.of(r.total)]));
}

/**
 * Guard used by bills/item receipts: refuse to edit/void a document while landed cost
 * allocated from (bill) or onto (receipt) it is still active.
 */
export async function assertNoActiveLandedCost(
  ctx: ServiceContext,
  ref: { billId?: string; itemReceiptId?: string },
): Promise<void> {
  if (ref.billId) {
    const [row] = await ctx.db
      .select({ id: landedCostAllocations.id })
      .from(landedCostAllocations)
      .where(
        and(
          eq(landedCostAllocations.companyId, ctx.companyId),
          eq(landedCostAllocations.billId, ref.billId),
          eq(landedCostAllocations.status, 'posted'),
        ),
      )
      .limit(1);
    if (row) {
      throw new ServiceError(
        'CONFLICT',
        'This bill has landed cost allocated from it. Void the landed cost allocation first.',
      );
    }
  }
  if (ref.itemReceiptId) {
    const [row] = await ctx.db
      .select({ id: landedCostAllocationLines.id })
      .from(landedCostAllocationLines)
      .innerJoin(landedCostAllocations, eq(landedCostAllocationLines.allocationId, landedCostAllocations.id))
      .where(
        and(
          eq(landedCostAllocations.companyId, ctx.companyId),
          eq(landedCostAllocations.status, 'posted'),
          eq(landedCostAllocationLines.itemReceiptId, ref.itemReceiptId),
        ),
      )
      .limit(1);
    if (row) {
      throw new ServiceError(
        'CONFLICT',
        'Landed cost has been allocated onto this item receipt. Void the landed cost allocation first.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Charge sources
// ---------------------------------------------------------------------------

export interface LandedCostSourceLine {
  billId: string;
  billNumber: string | null;
  billDate: Date;
  vendorName: string;
  billLineId: string;
  description: string | null;
  accountId: string;
  accountName: string;
  amount: string;
  allocated: string;
  remaining: string;
}

/**
 * Bill lines eligible as landed-cost charges: expense-account lines (no inventory item) on
 * non-void bills, with the amount still unallocated.
 */
export async function listLandedCostSources(
  ctx: ServiceContext,
  opts?: { billId?: string | null; includeFullyAllocated?: boolean },
): Promise<LandedCostSourceLine[]> {
  const conds = [eq(bills.companyId, ctx.companyId), sql`${bills.status} <> 'void'`, eq(accounts.type, 'expense')];
  if (opts?.billId) conds.push(eq(bills.id, opts.billId));
  const rows = await ctx.db
    .select({
      billId: bills.id,
      billNumber: bills.billNumber,
      billDate: bills.date,
      vendorName: vendors.displayName,
      billLineId: billLines.id,
      description: billLines.description,
      accountId: billLines.accountId,
      accountName: accounts.name,
      amount: billLines.amount,
      itemType: items.type,
    })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .innerJoin(accounts, eq(billLines.accountId, accounts.id))
    .leftJoin(items, eq(billLines.itemId, items.id))
    .where(and(...conds))
    .orderBy(desc(bills.date), asc(billLines.lineOrder));

  const eligible = rows.filter((r) => r.itemType !== 'inventory');
  const allocated = await allocatedByBillLine(ctx, eligible.map((r) => r.billLineId));
  return eligible
    .map((r) => {
      const done = allocated.get(r.billLineId) ?? Money.zero();
      const remaining = Money.of(r.amount).minus(done);
      return {
        billId: r.billId,
        billNumber: r.billNumber,
        billDate: r.billDate,
        vendorName: r.vendorName,
        billLineId: r.billLineId,
        description: r.description,
        accountId: r.accountId,
        accountName: r.accountName,
        amount: toAmountString(r.amount),
        allocated: toAmountString(done),
        remaining: toAmountString(remaining),
      };
    })
    .filter((r) => opts?.includeFullyAllocated || Money.of(r.remaining).greaterThan(0));
}

// ---------------------------------------------------------------------------
// Preview / allocate
// ---------------------------------------------------------------------------

interface TargetLine {
  receiptId: string;
  lineId: string;
  itemId: string;
  itemName: string;
  quantity: Dec;
  value: Dec;
  weight: Dec | null;
  assetAccountId: string | null;
  averageCost: string | null;
  quantityOnHand: string | null;
}

interface ComputedAllocation {
  bill: typeof bills.$inferSelect;
  billLine: typeof billLines.$inferSelect;
  amount: Dec;
  targets: TargetLine[];
  bases: Dec[];
  amounts: Dec[];
}

async function computeAllocation(ctx: ServiceContext, input: AllocateLandedCostInput): Promise<ComputedAllocation> {
  if (!['quantity', 'value', 'weight'].includes(input.method)) {
    throw validation('Allocation method must be quantity, value or weight.');
  }
  const [bill] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), eq(bills.id, input.billId)));
  if (!bill) throw notFound('Bill');
  if (bill.status === 'void') throw validation('Cannot allocate landed cost from a voided bill.');

  const [billLine] = await ctx.db
    .select()
    .from(billLines)
    .where(and(eq(billLines.billId, bill.id), eq(billLines.id, input.billLineId)));
  if (!billLine) throw notFound('Bill line');
  if (billLine.itemId) {
    const [it] = await ctx.db.select({ type: items.type }).from(items).where(eq(items.id, billLine.itemId));
    if (it?.type === 'inventory') {
      throw validation('Choose a charge line (freight, duty, …) — inventory item lines are already inventory cost.');
    }
  }
  const [acct] = await ctx.db
    .select({ type: accounts.type, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, billLine.accountId)));
  if (!acct || acct.type !== 'expense') {
    throw validation('Only charges posted to an expense account (e.g. Freight-In, Duty) can be allocated as landed cost.');
  }

  const already = (await allocatedByBillLine(ctx, [billLine.id])).get(billLine.id) ?? Money.zero();
  const remaining = Money.of(billLine.amount).minus(already);
  let amount = remaining;
  if (input.amount != null && input.amount !== '') {
    try {
      amount = Money.round2(input.amount);
    } catch {
      throw validation('Landed cost amount must be a number.');
    }
    if (!amount.isFinite()) throw validation('Landed cost amount must be a number.');
  }
  if (!amount.greaterThan(0)) throw validation('Nothing left to allocate on this bill line.');
  if (amount.greaterThan(remaining)) {
    throw validation(
      `Only ${toAmountString(remaining)} of this charge is still unallocated (requested ${toAmountString(amount)}).`,
    );
  }

  const receiptIds = [...new Set(input.itemReceiptIds ?? [])];
  if (receiptIds.length === 0) throw validation('Select at least one item receipt.');
  const receipts = await ctx.db
    .select()
    .from(itemReceipts)
    .where(and(eq(itemReceipts.companyId, ctx.companyId), inArray(itemReceipts.id, receiptIds)));
  for (const id of receiptIds) {
    const r = receipts.find((x) => x.id === id);
    if (!r) throw notFound(`Item receipt ${id}`);
    if (r.status === 'void') throw validation('Cannot allocate landed cost onto a voided item receipt.');
  }

  const lineRows = await ctx.db
    .select({
      receiptId: itemReceiptLines.itemReceiptId,
      lineId: itemReceiptLines.id,
      itemId: itemReceiptLines.itemId,
      quantity: itemReceiptLines.quantity,
      amount: itemReceiptLines.amount,
      lineOrder: itemReceiptLines.lineOrder,
      itemName: items.name,
      itemType: items.type,
      weight: items.weight,
      assetAccountId: items.assetAccountId,
      averageCost: items.averageCost,
      quantityOnHand: items.quantityOnHand,
    })
    .from(itemReceiptLines)
    .innerJoin(items, eq(itemReceiptLines.itemId, items.id))
    .where(inArray(itemReceiptLines.itemReceiptId, receiptIds))
    .orderBy(asc(itemReceiptLines.itemReceiptId), asc(itemReceiptLines.lineOrder));

  const targets: TargetLine[] = lineRows
    .filter((l) => l.itemType === 'inventory')
    .map((l) => ({
      receiptId: l.receiptId,
      lineId: l.lineId,
      itemId: l.itemId,
      itemName: l.itemName,
      quantity: Money.of(l.quantity),
      value: Money.of(l.amount),
      weight: l.weight != null ? Money.of(l.weight) : null,
      assetAccountId: l.assetAccountId,
      averageCost: l.averageCost,
      quantityOnHand: l.quantityOnHand,
    }));
  if (targets.length === 0) throw validation('The selected item receipts have no inventory lines.');

  const bases = targets.map((t) => {
    if (input.method === 'quantity') return t.quantity;
    if (input.method === 'value') return t.value;
    if (!t.weight || !t.weight.greaterThan(0)) {
      throw validation(`Item "${t.itemName}" has no weight. Set a unit weight on the item to allocate by weight.`);
    }
    return t.quantity.times(t.weight);
  });
  const totalBasis = bases.reduce((s, b) => s.plus(b), Money.zero());
  if (!totalBasis.greaterThan(0)) throw validation('The allocation basis of the selected lines is zero.');

  const amounts = allocate(amount, bases);
  return { bill, billLine, amount, targets, bases, amounts };
}

/**
 * On-hand share of each target line (0..1) as described in the module header. FIFO: the
 * receipt's tagged layers (pooled per receipt + item); average: min(QOH, received) / received
 * pooled per item across the allocation.
 */
async function onHandShares(ctx: ServiceContext, targets: TargetLine[]) {
  const fifoItems = new Set<string>();
  const itemIds = [...new Set(targets.map((t) => t.itemId))];
  if (itemIds.length > 0) {
    const rows = await ctx.db
      .select({ itemId: inventoryLayers.itemId })
      .from(inventoryLayers)
      .where(and(eq(inventoryLayers.companyId, ctx.companyId), inArray(inventoryLayers.itemId, itemIds)))
      .groupBy(inventoryLayers.itemId);
    for (const r of rows) fifoItems.add(r.itemId);
  }

  const receivedByReceiptItem = new Map<string, Dec>();
  const receivedByItem = new Map<string, Dec>();
  for (const t of targets) {
    const k = `${t.receiptId}|${t.itemId}`;
    receivedByReceiptItem.set(k, (receivedByReceiptItem.get(k) ?? Money.zero()).plus(t.quantity));
    receivedByItem.set(t.itemId, (receivedByItem.get(t.itemId) ?? Money.zero()).plus(t.quantity));
  }

  const shares: Array<{ fifo: boolean; share: Dec; layers: Array<typeof inventoryLayers.$inferSelect> }> = [];
  for (const t of targets) {
    if (fifoItems.has(t.itemId)) {
      let layers = await ctx.db
        .select()
        .from(inventoryLayers)
        .where(
          and(
            eq(inventoryLayers.companyId, ctx.companyId),
            eq(inventoryLayers.itemId, t.itemId),
            eq(inventoryLayers.sourceRef, `item_receipt:${t.receiptId}`),
          ),
        )
        .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));
      // Receipts recorded before layers were tagged: fall back to the item's open layers.
      if (layers.length === 0) {
        layers = await ctx.db
          .select()
          .from(inventoryLayers)
          .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, t.itemId)))
          .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));
      }
      const open = layers.filter((l) => Money.of(l.quantityRemaining).greaterThan(0));
      const remaining = open.reduce((s, l) => s.plus(Money.of(l.quantityRemaining)), Money.zero());
      const received = receivedByReceiptItem.get(`${t.receiptId}|${t.itemId}`)!;
      const share = received.isZero() ? Money.zero() : (remaining.lessThan(received) ? remaining : received).dividedBy(received);
      shares.push({ fifo: true, share, layers: open });
    } else {
      const received = receivedByItem.get(t.itemId)!;
      const onHand = Money.of(t.quantityOnHand ?? '0');
      const share = received.isZero() || !onHand.greaterThan(0)
        ? Money.zero()
        : (onHand.lessThan(received) ? onHand : received).dividedBy(received);
      shares.push({ fifo: false, share, layers: [] });
    }
  }
  return shares;
}

/** Compute the allocation without posting anything (UI preview). */
export async function previewLandedCost(
  ctx: ServiceContext,
  input: AllocateLandedCostInput,
): Promise<LandedCostPreview> {
  const c = await computeAllocation(ctx, input);
  const shares = await onHandShares(ctx, c.targets);
  return {
    billId: c.bill.id,
    billLineId: c.billLine.id,
    chargeAccountId: c.billLine.accountId,
    method: input.method,
    amount: toAmountString(c.amount),
    lines: c.targets.map((t, i) => {
      const inv = Money.round2(c.amounts[i].times(shares[i].share));
      return {
        itemReceiptId: t.receiptId,
        itemReceiptLineId: t.lineId,
        itemId: t.itemId,
        itemName: t.itemName,
        quantity: t.quantity.toFixed(4),
        lineValue: toAmountString(t.value),
        basis: c.bases[i].toFixed(4),
        amount: toAmountString(c.amounts[i]),
        inventoryAmount: toAmountString(inv),
        cogsAmount: toAmountString(c.amounts[i].minus(inv)),
      };
    }),
  };
}

/** Allocate a bill charge onto item receipts and post it (see module header). */
export async function allocateLandedCost(ctx: ServiceContext, input: AllocateLandedCostInput) {
  return inTransaction(ctx, async (tx) => {
    const c = await computeAllocation(tx, input);
    const date = input.date ?? c.bill.date;
    const cogsAccountId = await accountIdByCode(tx, '5000');
    let defaultInventoryId: string | null = null;

    const [allocation] = await tx.db
      .insert(landedCostAllocations)
      .values({
        companyId: tx.companyId,
        billId: c.bill.id,
        billLineId: c.billLine.id,
        chargeAccountId: c.billLine.accountId,
        method: input.method,
        amount: toAmountString(c.amount),
        date,
        status: 'posted',
        memo: input.memo ?? null,
      })
      .returning();

    const label = `Landed cost — bill ${c.bill.billNumber ?? c.bill.id.slice(0, 8)}`;
    const insertedLines = [];
    for (let i = 0; i < c.targets.length; i++) {
      const t = c.targets[i];
      const amount = c.amounts[i];
      if (!amount.greaterThan(0)) continue;

      // Shares are recomputed per line so earlier lines' layer revaluations are visible.
      const [share] = await onHandShares(tx, [t, ...c.targets.filter((o, j) => j !== i && o.itemId === t.itemId)]);
      const invPortion = Money.round2(amount.times(share.share));

      // --- Cost subledger ---
      const [item] = await tx.db.select().from(items).where(eq(items.id, t.itemId));
      const fifoTracked = share.fifo;
      const valueBefore = await itemBookValue(tx, t.itemId, fifoTracked);
      let quantityAtAllocation = Money.zero();
      let layerAdjustments: LayerAdjustment[] | null = null;
      if (invPortion.greaterThan(0)) {
        if (share.fifo) {
          const weights = share.layers.map((l) => Money.of(l.quantityRemaining));
          const parts = allocate(invPortion, weights);
          layerAdjustments = [];
          for (let k = 0; k < share.layers.length; k++) {
            const layer = share.layers[k];
            const qty = Money.of(layer.quantityRemaining);
            if (!parts[k].greaterThan(0) || !qty.greaterThan(0)) continue;
            layerAdjustments.push(...(await revalueLayer(tx, layer, parts[k])));
            quantityAtAllocation = quantityAtAllocation.plus(qty);
          }
        } else {
          const qoh = Money.of(item.quantityOnHand ?? '0');
          // Rounded DOWN to the stored 4dp so the pool never gains more than the charge; the
          // sub-cent remainder is expensed below.
          const newAvg = qoh
            .times(Money.of(item.averageCost ?? '0'))
            .plus(invPortion)
            .dividedBy(qoh)
            .toDecimalPlaces(4, Decimal.ROUND_DOWN);
          await tx.db
            .update(items)
            .set({
              averageCost: newAvg.toFixed(4),
              // The GL takes exactly the book-value change (below), so the item's value remainder
              // (0061) is unchanged — carry it over to the new average.
              ...valueRemainderAfter(item, qoh, qoh, newAvg, bookValueDelta(qoh, item.averageCost, newAvg)),
              updatedAt: new Date(),
            })
            .where(eq(items.id, t.itemId));
          quantityAtAllocation = qoh;
        }
      }
      // The GL follows the subledger to the cent: the inventory debit is the change in the item's
      // book value as inventoryValuation reports it, and any rounding remainder that the 4dp unit
      // cost could not hold goes to COGS — so inventory GL == valuation always holds.
      const capitalised = (await itemBookValue(tx, t.itemId, fifoTracked)).minus(valueBefore);
      const cogsPortion = amount.minus(capitalised);

      // --- GL ---
      let inventoryAccountId = item.assetAccountId;
      if (!inventoryAccountId) {
        defaultInventoryId ??= await accountIdByCode(tx, '1300');
        inventoryAccountId = defaultInventoryId;
      }
      const memo = `${label} — ${t.itemName}`;
      const postingLines = [];
      if (!capitalised.isZero()) {
        postingLines.push(signedLine(inventoryAccountId, capitalised, memo));
      }
      if (!cogsPortion.isZero()) {
        postingLines.push(signedLine(cogsAccountId, cogsPortion, `${memo} (units already sold / rounding)`));
      }
      postingLines.push({ accountId: c.billLine.accountId, credit: toAmountString(amount), memo });
      const entry = await postJournalEntry(tx, {
        date,
        description: memo,
        reference: `landed-cost:${allocation.id}`,
        sourceRef: `item:${t.itemId}`,
        lines: postingLines,
      });

      const [row] = await tx.db
        .insert(landedCostAllocationLines)
        .values({
          allocationId: allocation.id,
          itemReceiptId: t.receiptId,
          itemReceiptLineId: t.lineId,
          itemId: t.itemId,
          basis: c.bases[i].toFixed(4),
          amount: toAmountString(amount),
          inventoryAmount: toAmountString(capitalised),
          cogsAmount: toAmountString(cogsPortion),
          quantityAtAllocation: quantityAtAllocation.toFixed(4),
          layerAdjustments,
          entryId: entry.id,
          lineOrder: i,
        })
        .returning();
      insertedLines.push(row);
    }

    await writeAudit(tx, {
      action: 'create',
      entityType: 'landed_cost_allocation',
      entityId: allocation.id,
      newValues: {
        billId: c.bill.id,
        billLineId: c.billLine.id,
        method: input.method,
        amount: toAmountString(c.amount),
        lines: insertedLines.map((l) => ({
          itemReceiptLineId: l.itemReceiptLineId,
          amount: l.amount,
          inventoryAmount: l.inventoryAmount,
          cogsAmount: l.cogsAmount,
        })),
      },
    });

    return { ...allocation, lines: insertedLines };
  });
}

// ---------------------------------------------------------------------------
// List / get / void
// ---------------------------------------------------------------------------

export async function listLandedCostAllocations(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({
      allocation: landedCostAllocations,
      billNumber: bills.billNumber,
      vendorName: vendors.displayName,
      accountName: accounts.name,
    })
    .from(landedCostAllocations)
    .innerJoin(bills, eq(landedCostAllocations.billId, bills.id))
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .innerJoin(accounts, eq(landedCostAllocations.chargeAccountId, accounts.id))
    .where(eq(landedCostAllocations.companyId, ctx.companyId))
    .orderBy(desc(landedCostAllocations.date), desc(landedCostAllocations.createdAt));
  return rows.map((r) => ({
    ...r.allocation,
    billNumber: r.billNumber,
    vendorName: r.vendorName,
    chargeAccountName: r.accountName,
  }));
}

export async function getLandedCostAllocation(ctx: ServiceContext, id: string) {
  const [allocation] = await ctx.db
    .select()
    .from(landedCostAllocations)
    .where(and(eq(landedCostAllocations.companyId, ctx.companyId), eq(landedCostAllocations.id, id)));
  if (!allocation) throw notFound('Landed cost allocation');
  const lines = await ctx.db
    .select({
      line: landedCostAllocationLines,
      itemName: items.name,
      receiptReference: itemReceipts.reference,
      receiptDate: itemReceipts.date,
    })
    .from(landedCostAllocationLines)
    .innerJoin(items, eq(landedCostAllocationLines.itemId, items.id))
    .innerJoin(itemReceipts, eq(landedCostAllocationLines.itemReceiptId, itemReceipts.id))
    .where(eq(landedCostAllocationLines.allocationId, id))
    .orderBy(asc(landedCostAllocationLines.lineOrder));
  return {
    ...allocation,
    lines: lines.map((l) => ({
      ...l.line,
      itemName: l.itemName,
      receiptReference: l.receiptReference,
      receiptDate: l.receiptDate,
    })),
  };
}

/**
 * Layers split off (parent layer id -> split layer ids) by allocation lines on `itemId` recorded
 * after `lineId` of `allocation` — active or void, since a split is a physical fact either way.
 */
async function laterSplits(
  ctx: ServiceContext,
  allocation: { id: string; createdAt: Date },
  lineId: string,
  itemId: string,
): Promise<Map<string, string[]>> {
  const rows = await ctx.db
    .select({
      lineId: landedCostAllocationLines.id,
      allocationId: landedCostAllocations.id,
      createdAt: landedCostAllocations.createdAt,
      lineOrder: landedCostAllocationLines.lineOrder,
      layerAdjustments: landedCostAllocationLines.layerAdjustments,
    })
    .from(landedCostAllocationLines)
    .innerJoin(landedCostAllocations, eq(landedCostAllocationLines.allocationId, landedCostAllocations.id))
    .where(and(eq(landedCostAllocations.companyId, ctx.companyId), eq(landedCostAllocationLines.itemId, itemId)))
    .orderBy(
      asc(landedCostAllocations.createdAt),
      asc(landedCostAllocations.id),
      asc(landedCostAllocationLines.lineOrder),
    );
  const at = rows.findIndex((r) => r.lineId === lineId);
  const splits = new Map<string, string[]>();
  for (const r of rows.slice(at + 1)) {
    for (const adj of r.layerAdjustments ?? []) {
      if (!adj.splitFrom) continue;
      splits.set(adj.splitFrom, [...(splits.get(adj.splitFrom) ?? []), adj.layerId]);
    }
  }
  return splits;
}

/** Void an allocation: reverse its entries and back the cost out (see module header). */
export async function voidLandedCostAllocation(ctx: ServiceContext, id: string) {
  return inTransaction(ctx, async (tx) => {
    const allocation = await getLandedCostAllocation(tx, id);
    if (allocation.status === 'void') return allocation;

    let cogsAccountId: string | null = null;
    for (const line of allocation.lines) {
      const inv = Money.of(line.inventoryAmount);
      const fifoLine = Boolean(line.layerAdjustments && line.layerAdjustments.length > 0);
      let valueChange = Money.zero();
      const [item] = await tx.db.select().from(items).where(eq(items.id, line.itemId));
      if (inv.greaterThan(0)) {
        const moved = () =>
          new ServiceError(
            'CONFLICT',
            `Stock of "${line.itemName}" has moved since this landed cost was applied, so it cannot be ` +
              'reversed exactly. Record an inventory value adjustment instead.',
          );
        const valueBefore = await itemBookValue(tx, line.itemId, fifoLine);
        if (fifoLine) {
          // A later allocation may have split one unit off a layer this line raised; that unit
          // still carries this line's increment, so the layer and its later splits are restored
          // together and "stock moved" is judged on their combined quantity.
          const splits = await laterSplits(tx, allocation, line.id, line.itemId);
          for (const adj of line.layerAdjustments!) {
            const family: Array<typeof inventoryLayers.$inferSelect> = [];
            const queue = [adj.layerId];
            while (queue.length > 0) {
              const layerId = queue.shift()!;
              const [layer] = await tx.db.select().from(inventoryLayers).where(eq(inventoryLayers.id, layerId));
              if (layer) family.push(layer);
              else if (layerId === adj.layerId) throw moved();
              queue.push(...(splits.get(layerId) ?? []));
            }
            const familyQty = family.reduce((sum, l) => sum.plus(Money.of(l.quantityRemaining)), Money.zero());
            if (!familyQty.equals(Money.of(adj.quantity))) throw moved();
            for (const layer of family) {
              const restored = Money.of(layer.unitCost).minus(Money.of(adj.unitCostDelta));
              if (restored.isNegative()) throw moved();
              await tx.db
                .update(inventoryLayers)
                .set({ unitCost: restored.toFixed(4) })
                .where(eq(inventoryLayers.id, layer.id));
            }
          }
        } else {
          const qoh = Money.of(item.quantityOnHand ?? '0');
          if (!qoh.equals(Money.of(line.quantityAtAllocation)) || !qoh.greaterThan(0)) throw moved();
          const value = qoh.times(Money.of(item.averageCost ?? '0')).minus(inv);
          if (value.isNegative()) throw moved();
          const restoredAvg = value.dividedBy(qoh);
          await tx.db
            .update(items)
            .set({
              averageCost: restoredAvg.toFixed(4),
              // The void (with its rounding true-up below) moves the GL by exactly the book-value
              // change, so the value remainder (0061) is carried over to the restored average.
              ...valueRemainderAfter(item, qoh, qoh, restoredAvg, bookValueDelta(qoh, item.averageCost, restoredAvg)),
              updatedAt: new Date(),
            })
            .where(eq(items.id, item.id));
        }
        valueChange = (await itemBookValue(tx, line.itemId, fifoLine)).minus(valueBefore);
      }
      if (line.entryId) await voidJournalEntry(tx, line.entryId);

      // The reversal takes `inv` back out of the inventory GL. When restoring a 4dp average cost
      // does not move the book value by exactly that much, true up the difference against COGS
      // so inventory GL == valuation still holds.
      const residual = valueChange.plus(inv);
      if (!residual.isZero()) {
        cogsAccountId ??= await accountIdByCode(tx, '5000');
        const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));
        const memo = `Landed cost void rounding — ${line.itemName}`;
        await postJournalEntry(tx, {
          date: allocation.date,
          description: memo,
          reference: `landed-cost:${allocation.id}`,
          sourceRef: `item:${line.itemId}`,
          lines: [signedLine(inventoryAccountId, residual, memo), signedLine(cogsAccountId, residual.negated(), memo)],
        });
      }
    }

    const [updated] = await tx.db
      .update(landedCostAllocations)
      .set({ status: 'void', voidedAt: new Date() })
      .where(eq(landedCostAllocations.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'landed_cost_allocation',
      entityId: id,
      oldValues: { status: 'posted' },
      newValues: { status: 'void' },
    });
    return updated;
  });
}
