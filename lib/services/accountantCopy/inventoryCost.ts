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
/** Editing a posted sale: the cost each kept line was sold at (see keptSaleCosts). */
const keptScope = new AsyncLocalStorage<{ queues: Map<string, string[]> }>();

function queuesOf(costs: Array<{ itemId: string; amount: string }>): Map<string, string[]> {
  const queues = new Map<string, string[]>();
  for (const c of costs) {
    if (!queues.has(c.itemId)) queues.set(c.itemId, []);
    queues.get(c.itemId)!.push(c.amount);
  }
  return queues;
}

/**
 * Run `fn` (a sale edit's COGS re-post) with each kept line's original cost queued per item. Unlike
 * the accountant's costs the item's average is not re-derived: the caller puts the item's cost
 * fields back as they were before the edit (restoreItemCosts), since a kept line sells exactly what
 * the reversal put back.
 */
export function withKeptSaleCostQueue<T>(costs: Array<{ itemId: string; amount: string }>, fn: () => Promise<T>): Promise<T> {
  if (!costs.length) return fn();
  return keptScope.run({ queues: queuesOf(costs) }, fn);
}

/** The next kept sale cost for this item (the line's total), or null outside a sale edit. */
export function takeKeptSaleCost(itemId: string): Decimal | null {
  const q = keptScope.getStore()?.queues.get(itemId);
  if (!q || !q.length) return null;
  return new Decimal(q.shift()!);
}

/** Run `fn` with the accountant's costs queued per item (amounts in line order). */
export function withAccountantCosts<T>(costs: Array<{ itemId: string; amount: string }>, fn: () => Promise<T>): Promise<T> {
  if (!costs.length) return fn();
  return scope.run({ queues: queuesOf(costs) }, fn);
}

/**
 * Editing a posted sale (invoice, sales receipt) voids its COGS and sells the lines again. At
 * today's average cost that re-costed a past sale with stock bought since — a memo-only edit moved
 * an earlier period's COGS. `soldAt` is what each average-cost line was sold at (before the edit);
 * this returns the costs to queue (withKeptSaleCostQueue) so each kept line (same item, same
 * quantity) is sold again at that cost, in the order `newLines` are sold. An item is only queued when EVERY line of it in the
 * edit is a kept one (the queue is taken per line of an item, in order). Null when nothing is kept
 * or an Accountant's Copy import already queued its own costs (those stand).
 */
export function keptSaleCosts(
  soldAt: Array<{ itemId: string; quantity: string; cost: string }>,
  newLines: Array<{ itemId: string; quantity: string }>,
): Array<{ itemId: string; amount: string }> | null {
  if (!soldAt.length || scope.getStore()) return null;
  const pool = [...soldAt];
  const costs: Array<{ itemId: string; amount: string }> = [];
  const lineCount = new Map<string, number>();
  for (const l of newLines) {
    lineCount.set(l.itemId, (lineCount.get(l.itemId) ?? 0) + 1);
    const qty = new Decimal(l.quantity).toFixed(4);
    const i = pool.findIndex((p) => p.itemId === l.itemId && p.quantity === qty);
    if (i < 0) continue;
    costs.push({ itemId: l.itemId, amount: pool[i].cost });
    pool.splice(i, 1);
  }
  const queued = new Map<string, number>();
  for (const c of costs) queued.set(c.itemId, (queued.get(c.itemId) ?? 0) + 1);
  const usable = costs.filter((c) => queued.get(c.itemId) === lineCount.get(c.itemId));
  return usable.length ? usable : null;
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
