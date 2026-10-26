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
 * A clearable line's amount in STATEMENT terms — what ticking it adds to the cleared balance — as
 * the Reconcile window lists it. A bank account: deposits +, checks and payments −. A credit card,
 * whose statement balance is what you owe: charges + and payments / credits −. The window used to
 * show every card charge as a negative amount, although ticking it RAISED the cleared balance.
 */
export function statementLineAmount(
  line: { debit: string | null; credit: string | null },
  isCreditCard: boolean,
): string {
  const debit = line.debit && Money.gt(line.debit, 0) ? Money.round2(line.debit) : null;
  const credit = line.credit && Money.gt(line.credit, 0) ? Money.round2(line.credit) : null;
  const up = isCreditCard ? credit : debit;
  const down = isCreditCard ? debit : credit;
  if (up) return up.toFixed(2);
  if (down) return down.negated().toFixed(2);
  return '0.00';
}
