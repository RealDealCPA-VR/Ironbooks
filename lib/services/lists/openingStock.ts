/**
 * Opening quantity on hand when creating an inventory item (QB New Item: "On Hand", "Total
 * Value", "As of").
 *
 * In ONE transaction: create the item, post
 *     Dr Inventory Asset (item.assetAccountId ?? 1300)   value
 *     Cr Opening Balance Equity                          value
 * through postJournalEntry (period-closing rules apply) and set quantityOnHand / averageCost. The
 * stock's value (quantity × 4-dp unit cost) always equals the posted amount exactly — a total value
 * that cannot be expressed that way is refused with the nearest exact values, so inventory
 * valuation and the general ledger can never drift apart.
 *
 * Costing (`openingCosting`): an item is FIFO-tracked exactly when it has inventoryLayers rows,
 * and the average-cost operations (Build Assemblies, physical count, value adjustment) refuse
 * FIFO-tracked items. So by default ('average') NO layer is opened: the item stays average-cost,
 * exactly like the same stock received on a bill. 'fifo' opens a FIFO cost layer dated as-of,
 * making the item FIFO-tracked from the start.
 *
 * `{ postToLedger: false }` (IIF import only): the general ledger already carries the stock's
 * value because the same import brings in the Inventory Asset account's balance (QuickBooks
 * exports it as the account's OBAMOUNT). The item, quantityOnHand / averageCost (and the FIFO
 * layer when 'fifo') are created exactly the same way but NO journal entry is posted, which would count the value
 * twice. Matching the item values to that imported balance is then the file's responsibility.
 */
import { and, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { accounts, inventoryLayers, items } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';
import { findOrCreateOpeningBalanceEquity } from '../accounts';
import { type CreateItemInput, createItem } from '../items';
import { postJournalEntry } from '../posting';
import { todayCalendarDay } from '../inventory';
import { assertAccountantMayEnterOpeningStock } from '../accountantCopy/guard';

export interface OpeningStockInput {
  openingQuantity?: string | number | null;
  /** Total value of the opening quantity (preferred, as in QB)... */
  openingValue?: string | number | null;
  /** ...or a unit cost. */
  openingUnitCost?: string | number | null;
  /** As-of date (defaults to today's calendar day). */
  openingAsOf?: Date | null;
  /** 'average' (default: no FIFO layer, the item stays average-cost) or 'fifo' (see module doc). */
  openingCosting?: 'average' | 'fifo' | null;
}

interface PlannedOpening {
  qty: Decimal;
  unitCost: Decimal;
  value: Decimal;
  asOf: Date;
}

/** Validate + compute the opening layer; null when no opening quantity was given. */
export function planOpeningStock(input: OpeningStockInput, itemType: string, trackingMode?: string | null): PlannedOpening | null {
  if (input.openingQuantity == null || input.openingQuantity === '' || Money.of(input.openingQuantity).isZero()) {
    if (input.openingValue != null && input.openingValue !== '' && !Money.of(input.openingValue).isZero()) {
      throw validation('Enter the quantity on hand along with its value.');
    }
    return null;
  }
  if (itemType !== 'inventory') throw validation('Only inventory items can start with a quantity on hand.');
  if (trackingMode && trackingMode !== 'none') {
    throw validation('Serial- or lot-tracked items need their serial/lot numbers: add their opening stock with an inventory adjustment instead.');
  }
  const qty = Money.of(input.openingQuantity);
  if (qty.lessThanOrEqualTo(0)) throw validation('The opening quantity must be greater than zero.');
  if (qty.decimalPlaces() > 4) throw validation('The opening quantity can have at most 4 decimal places.');
  let unitCost: Decimal;
  let value: Decimal;
  if (input.openingValue != null && input.openingValue !== '') {
    value = Money.of(input.openingValue);
    if (value.isNegative()) throw validation('The total value cannot be negative.');
    if (value.decimalPlaces() > 2) throw validation('The total value can have at most 2 decimal places.');
    unitCost = value.dividedBy(qty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const exact = Money.round2(qty.times(unitCost));
    if (!exact.eq(value)) {
      const lower = Money.round2(qty.times(value.dividedBy(qty).toDecimalPlaces(4, Decimal.ROUND_DOWN)));
      const upper = Money.round2(qty.times(value.dividedBy(qty).toDecimalPlaces(4, Decimal.ROUND_UP)));
      throw validation(
        `A value of ${toAmountString(value)} for ${qty.toString()} units cannot be split into an exact unit cost. ` +
          `Use ${toAmountString(lower)} or ${toAmountString(upper)}, or enter a unit cost instead.`,
      );
    }
  } else if (input.openingUnitCost != null && input.openingUnitCost !== '') {
    unitCost = Money.of(input.openingUnitCost);
    if (unitCost.isNegative()) throw validation('The unit cost cannot be negative.');
    if (unitCost.decimalPlaces() > 4) throw validation('The unit cost can have at most 4 decimal places.');
    value = Money.round2(qty.times(unitCost));
  } else {
    throw validation('Enter the total value (or unit cost) of the opening quantity.');
  }
  // No as-of date: today's calendar day (the stored-date convention), not the UTC instant, which
  // in the evening west of UTC is already tomorrow (on Dec 31, next year).
  const asOf = input.openingAsOf ?? todayCalendarDay();
  if (Number.isNaN(asOf.getTime())) throw validation('The as-of date is not a valid date.');
  return { qty, unitCost, value, asOf };
}

async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** Create an item, optionally with an opening quantity on hand (see module doc). */
export interface OpeningStockOptions {
  /** False = the ledger already carries the value (see module doc); default true. */
  postToLedger?: boolean;
}

export async function createItemWithOpeningStock(
  ctx: ServiceContext,
  input: CreateItemInput & OpeningStockInput,
  options: OpeningStockOptions = {},
) {
  const postToLedger = options.postToLedger ?? true;
  const { openingQuantity, openingValue, openingUnitCost, openingAsOf, openingCosting, ...itemInput } = input;
  const fifo = openingCosting === 'fifo';
  const plan = planOpeningStock(
    { openingQuantity, openingValue, openingUnitCost, openingAsOf },
    itemInput.type ?? 'service',
    itemInput.trackingMode,
  );
  if (!plan) return { item: await createItem(ctx, itemInput), opening: null };
  // Accountant's Copy: the opening entry and layer can't travel back to the client (PARITY I1).
  await assertAccountantMayEnterOpeningStock(ctx);

  return inTransaction(ctx, async (tx) => {
    const item = await createItem(tx, itemInput);
    let entryId: string | null = null;
    if (postToLedger && plan.value.greaterThan(0)) {
      const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));
      const obe = await findOrCreateOpeningBalanceEquity(tx);
      const amount = toAmountString(plan.value);
      const entry = await postJournalEntry(tx, {
        date: plan.asOf,
        description: `Opening quantity on hand — ${item.name}`,
        sourceRef: `item:${item.id}`,
        lines: [
          { accountId: inventoryAccountId, debit: amount, memo: `Opening stock: ${plan.qty.toString()} × ${plan.unitCost.toFixed(4)}` },
          { accountId: obe.id, credit: amount, memo: 'Opening balance offset' },
        ],
      });
      entryId = entry.id;
    }
    // Average cost (default): no layer — a layer would make the item FIFO-tracked, and Build
    // Assemblies / physical count / value adjustment would then refuse it.
    const [layer] = fifo
      ? await tx.db
          .insert(inventoryLayers)
          .values({
            companyId: tx.companyId,
            itemId: item.id,
            date: plan.asOf,
            quantityRemaining: plan.qty.toFixed(4),
            unitCost: plan.unitCost.toFixed(4),
            sourceRef: `item_opening:${item.id}`,
          })
          .returning()
      : [null];
    const [updated] = await tx.db
      .update(items)
      .set({ quantityOnHand: plan.qty.toFixed(4), averageCost: plan.unitCost.toFixed(4), updatedAt: new Date() })
      .where(eq(items.id, item.id))
      .returning();
    const opening = {
      quantity: plan.qty.toFixed(4),
      unitCost: plan.unitCost.toFixed(4),
      value: toAmountString(plan.value),
      asOf: plan.asOf,
      entryId,
      costing: fifo ? ('fifo' as const) : ('average' as const),
      layerId: layer?.id ?? null,
      ...(postToLedger ? {} : { ledgerCarried: true }),
    };
    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: item.id,
      oldValues: { quantityOnHand: '0' },
      newValues: { openingStock: opening },
    });
    return { item: updated, opening };
  });
}
