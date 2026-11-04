/**
 * Bank reconciliation rules shared by the Reconcile window (app/reconcile/page.tsx) and the
 * service (lib/services/reconcile.ts). Pure, so the page enables "Finish Reconciliation" on
 * exactly the condition the server completes on.
 */
import { Money } from '@/lib/money';

/**
 * QB: a reconciliation finishes only when the difference is 0.00. (The page used to enable the
 * button at a 1-cent difference, which the server then refused.)
 */
export function canFinishReconciliation(difference: string | null | undefined): boolean {
  if (difference == null || String(difference).trim() === '') return false;
  try {
    return Money.round2(difference).isZero();
  } catch {
    return false;
  }
}

/**
 * Whether the Reconcile window reads statement amounts with a liability's sign (what you owe goes
 * up): EVERY liability account — a credit card, a loan, a line of credit — as the server's cleared
 * balance does (glType 'liability'), not only the Credit Card subtype. `isCreditCard` decides only
 * the "Credit Card" badge and the "Write a check for the balance" offer.
 */
export function reconcilesAsLiability(
  info: { isLiability?: boolean | null; glType?: string | null; isCreditCard?: boolean | null } | null | undefined,
): boolean {
  if (!info) return false;
  if (typeof info.isLiability === 'boolean') return info.isLiability;
  return info.glType === 'liability';
}

/**
 * A clearable line's amount in STATEMENT terms — what ticking it adds to the cleared balance — as
 * the Reconcile window lists it. A bank account: deposits +, checks and payments −. A credit card
 * or other liability (loan, line of credit), whose statement balance is what you owe: charges /
 * borrowings + and payments / credits −. The window used to show every card charge as a negative
 * amount, although ticking it RAISED the cleared balance.
 */
export function statementLineAmount(
  line: { debit: string | null; credit: string | null },
  isLiability: boolean,
): string {
  const debit = line.debit && Money.gt(line.debit, 0) ? Money.round2(line.debit) : null;
  const credit = line.credit && Money.gt(line.credit, 0) ? Money.round2(line.credit) : null;
  const up = isLiability ? credit : debit;
  const down = isLiability ? debit : credit;
  if (up) return up.toFixed(2);
  if (down) return down.negated().toFixed(2);
  return '0.00';
}
