/**
 * Review round 5 (team banking) — the Finish Reconciliation rule the page and the server share.
 */
import { describe, it, expect } from 'vitest';
import { canFinishReconciliation, statementLineAmount } from './reconcileRules';

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

describe('statementLineAmount', () => {
  it('bank: deposits are +, checks are −', () => {
    expect(statementLineAmount({ debit: '100.00', credit: null }, false)).toBe('100.00');
    expect(statementLineAmount({ debit: null, credit: '45.5' }, false)).toBe('-45.50');
  });
  it('credit card: a charge is + (it raises the balance owed, as ticking it raises the cleared balance), a payment −', () => {
    expect(statementLineAmount({ debit: null, credit: '80.00' }, true)).toBe('80.00');
    expect(statementLineAmount({ debit: '200.00', credit: null }, true)).toBe('-200.00');
    expect(statementLineAmount({ debit: null, credit: null }, true)).toBe('0.00');
  });
});
