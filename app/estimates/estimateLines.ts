/**
 * Estimate line quantities and rates as saved (pure, unit-tested in lib/ui.review5.test.ts).
 */
import Decimal from 'decimal.js';

const NUMBER_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** A typed number in the plain form the API's zDecimal accepts (".5" → "0.5", "2." → "2"). */
const plain = (s: string) => new Decimal(s).toFixed();

/**
 * The quantity and rate an estimate line is saved with, exactly as typed. A blank quantity is 1
 * (QB); a blank rate on an item line is left to the server's pricing. Anything else must be a
 * number: the form used parseFloat(qty) || 1, so a quantity of 0 (or "abc") was saved as 1 — a
 * line the preview showed at $0.00 went into the estimate at its full rate — and "12abc" as 12.
 */
export function estimateLineNumbers(
  l: { quantity: string; rate: string; itemId: string },
  lineNo: number,
): { quantity: string; rate: string | number | null } | { error: string } {
  const q = l.quantity.trim();
  const quantity = q === '' ? '1' : q;
  if (!NUMBER_RE.test(quantity) || !(Number(quantity) > 0)) {
    return { error: `Line ${lineNo}: the quantity must be a number more than zero.` };
  }
  const r = l.rate.trim();
  if (r === '') return { quantity: plain(quantity), rate: l.itemId ? null : 0 };
  if (!NUMBER_RE.test(r)) return { error: `Line ${lineNo}: the rate must be a number like 125.00.` };
  return { quantity: plain(quantity), rate: plain(r) };
}
