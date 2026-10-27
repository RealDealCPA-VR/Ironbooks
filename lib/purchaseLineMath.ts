/**
 * Live line amounts on the purchase forms (Enter Bills, Create Purchase Orders), exact and rounded
 * where the services round them, so the form shows what the document saves:
 *  - a bill item line: round2(quantity × unit cost) (lib/services/bills.ts), an expense line
 *    round2(amount);
 *  - a purchase order line: quantity and rate kept at 4 places (numeric(15,4)), then
 *    round2(qty × rate) (lib/services/purchaseOrders.ts);
 *  - the total: the sum of the rounded lines.
 * The float version showed 3 × 1.335 as $4.00 (4.00499…) while the bill saved $4.01, and two such
 * lines as $8.01 against $8.02 saved. Pure (no React), so the forms and tests share it.
 */
import Decimal from 'decimal.js';
import { Money } from '@/lib/money';
import { typedNumber } from '@/lib/invoiceLineMath';

/** Bill item line (Items tab): round2(qty × unit cost), exact. Blank / not a number counts as 0. */
export function billItemLineAmount(quantity: string, unitCost: string): Decimal {
  return Money.round2(typedNumber(quantity).times(typedNumber(unitCost)));
}

/** An amount typed on an expense line (or a stored line amount): round2(amount). */
export function typedLineAmount(amount: string | null | undefined): Decimal {
  return Money.round2(typedNumber(amount));
}

/** Purchase order line: round2(round4(qty) × round4(rate)). */
export function poLineAmount(quantity: string, rate: string): Decimal {
  return Money.round2(typedNumber(quantity).toDecimalPlaces(4).times(typedNumber(rate).toDecimalPlaces(4)));
}

/** Sum of already-rounded line amounts. */
export function sumLineAmounts(amounts: Decimal[]): Decimal {
  return amounts.reduce((s, a) => s.plus(a), Money.zero());
}
