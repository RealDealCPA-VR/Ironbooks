/**
 * Accountant's Copy (PARITY I1): the inventory cost the ACCOUNTANT's file used.
 *
 * A sale, a credit-memo restock or a negative quantity adjustment the accountant enters in the copy
 * is costed there at the copy's average cost on that date. Re-applied on the client through the
 * normal services it would be costed at the client's CURRENT average cost, which includes stock the
 * client bought after the dividing date — changing COGS and inventory in the period the accountant
 * just closed. So the changes file carries the cost of each such line, and the import re-applies the
 * form with those costs queued here (one queue per item, in line order). The average-cost services
 * (recordCOGS, adjustInventory's removal, credit memo restock) take the next queued cost for the item
 * instead of qty × average cost, and re-derive the item's average cost from what is left
 * (value − cost) / quantity, so the client's inventory value stays equal to its ledger.
 *
 * Only the client's import of the accountant's changes sets a queue (withAccountantCosts); outside
 * it every take returns null and the services behave as usual. FIFO-tracked consumption is not
 * overridden: it takes the oldest layers, which are the pre-dividing-date ones unless the client
 * has already consumed them (the review flags any difference).
 *
 * Dependency-light on purpose: imported by inventory.ts, invoices.ts and creditMemos.ts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import Decimal from 'decimal.js';
import { ServiceError } from '../errors';

const scope = new AsyncLocalStorage<{ queues: Map<string, string[]> }>();

/** Run `fn` with the accountant's costs queued per item (amounts in line order). */
export function withAccountantCosts<T>(costs: Array<{ itemId: string; amount: string }>, fn: () => Promise<T>): Promise<T> {
  if (!costs.length) return fn();
  const queues = new Map<string, string[]>();
  for (const c of costs) {
    if (!queues.has(c.itemId)) queues.set(c.itemId, []);
    queues.get(c.itemId)!.push(c.amount);
  }
  return scope.run({ queues }, fn);
}

/** True when an accountant's cost is waiting for this item. */
export function hasAccountantCost(itemId: string): boolean {
  return (scope.getStore()?.queues.get(itemId)?.length ?? 0) > 0;
}

/** The next accountant's cost for this item (total for the line), or null outside an import. */
export function takeAccountantCost(itemId: string): Decimal | null {
  const q = scope.getStore()?.queues.get(itemId);
  if (!q || !q.length) return null;
  const cost = new Decimal(q.shift()!);
  // parseChangesFile already refuses these; kept here so no caller can value stock below zero.
  if (cost.isNegative()) throw new ServiceError('VALIDATION', "The accountant's inventory cost for this line is negative.");
  return cost;
}

/** Half a cent: what rounding the value to cents can leave below zero. */
const ROUNDING = new Decimal('0.005');

/**
 * Average cost after taking `cost` out of (qty, avg) stock and leaving `newQty` (removal), or after
 * adding `cost` for `newQty - qty` units (restock). Unchanged when nothing is left.
 *
 * Refuses (instead of clamping the average to 0) when the accountant's cost would leave the item's
 * inventory value below zero: the item's value would no longer tie to the inventory account.
 */
export function averageAfter(qty: Decimal, avg: Decimal, newQty: Decimal, valueChange: Decimal): Decimal {
  const value = qty.times(avg).plus(valueChange);
  if (value.lessThan(ROUNDING.negated())) {
    throw new ServiceError(
      'VALIDATION',
      `The accountant's inventory cost (${valueChange.abs().toFixed(2)}) is more than the value of the item's stock in your file (${qty.times(avg).toFixed(2)}), so it would leave the item's inventory value below zero.`,
    );
  }
  if (newQty.lessThanOrEqualTo(0)) return avg;
  return value.isNegative() ? new Decimal(0) : value.dividedBy(newQty);
}
