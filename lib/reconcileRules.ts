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
