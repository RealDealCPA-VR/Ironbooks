/**
 * Review round 5 (team banking) — the Finish Reconciliation rule the page and the server share.
 */
import { describe, it, expect } from 'vitest';
import { canFinishReconciliation } from './reconcileRules';

describe('canFinishReconciliation', () => {
  it('is true only at a 0.00 difference (QB), never at a cent', () => {
    expect(canFinishReconciliation('0.00')).toBe(true);
    expect(canFinishReconciliation('-0.00')).toBe(true);
    expect(canFinishReconciliation('0.01')).toBe(false);
    expect(canFinishReconciliation('-0.01')).toBe(false);
    expect(canFinishReconciliation(null)).toBe(false);
    expect(canFinishReconciliation('abc')).toBe(false);
  });
});
