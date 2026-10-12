/**
 * Opening quantity on hand when creating an inventory item (QB New Item: "On Hand", "Total
 * Value", "As of").
 *
 * In ONE transaction: create the item, post
 *     Dr Inventory Asset (item.assetAccountId ?? 1300)   value
 *     Cr Opening Balance Equity                          value
 * through postJournalEntry (period-closing rules apply), open a FIFO cost layer dated as-of, and
 * set quantityOnHand / averageCost. The layer's value (quantity × 4-dp unit cost) always equals
 * the posted amount exactly — a total value that cannot be expressed that way is refused with the
 * nearest exact values, so inventory valuation and the general ledger can never drift apart.
 */
import { and, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { accounts, inventoryLayers, items } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';
import { findOrCreateOpeningBalanceEquity } from '../accounts';
import { type CreateItemInput, createItem } from '../items';
import { postJournalEntry } from '../posting';

export interface OpeningStockInput {
  openingQuantity?: string | number | null;
  /** Total value of the opening quantity (preferred, as in QB)... */
  openingValue?: string | number | null;
  /** ...or a unit cost. */
  openingUnitCost?: string | number | null;
  /** As-of date (defaults to today). */
  openingAsOf?: Date | null;
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
  const asOf = input.openingAsOf ?? new Date();
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
export async function createItemWithOpeningStock(ctx: ServiceContext, input: CreateItemInput & OpeningStockInput) {
  const { openingQuantity, openingValue, openingUnitCost, openingAsOf, ...itemInput } = input;
  const plan = planOpeningStock(
    { openingQuantity, openingValue, openingUnitCost, openingAsOf },
    itemInput.type ?? 'service',
    itemInput.trackingMode,
  );
  if (!plan) return { item: await createItem(ctx, itemInput), opening: null };

  return inTransaction(ctx, async (tx) => {
    const item = await createItem(tx, itemInput);
    let entryId: string | null = null;
    if (plan.value.greaterThan(0)) {
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
    const [layer] = await tx.db
      .insert(inventoryLayers)
      .values({
        companyId: tx.companyId,
        itemId: item.id,
        date: plan.asOf,
        quantityRemaining: plan.qty.toFixed(4),
        unitCost: plan.unitCost.toFixed(4),
        sourceRef: `item_opening:${item.id}`,
      })
      .returning();
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
      layerId: layer.id,
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
