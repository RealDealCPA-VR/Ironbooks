import { describe, expect, it } from 'vitest';
import { autoApplyPayment, sumApplied } from './paymentApply';

const docs = [
  { id: 'b', date: '2026-02-01', dueDate: '2026-03-03', balanceDue: '200.00' },
  { id: 'a', date: '2026-01-01', dueDate: '2026-01-31', balanceDue: '100.10' },
  { id: 'c', date: '2026-04-01', dueDate: null, balanceDue: '50.00' },
];

describe('autoApplyPayment', () => {
  it('applies oldest due first, never past a balance or the amount', () => {
    expect(autoApplyPayment('250.10', docs)).toEqual({ a: '100.10', b: '150.00' });
  });
  it('prefers an exact-balance match', () => {
    expect(autoApplyPayment('50', docs)).toEqual({ c: '50.00' });
  });
  it('overpayment applies everything and leaves the rest unapplied', () => {
    const out = autoApplyPayment('1000', docs);
    expect(out).toEqual({ a: '100.10', b: '200.00', c: '50.00' });
    expect(sumApplied(out)).toBe('350.10');
  });
  it('ignores blank, zero, negative or invalid amounts', () => {
    expect(autoApplyPayment('', docs)).toEqual({});
    expect(autoApplyPayment('0', docs)).toEqual({});
    expect(autoApplyPayment('-5', docs)).toEqual({});
    expect(autoApplyPayment('abc', docs)).toEqual({});
  });
  it('sumApplied is decimal-exact and ignores partial input', () => {
    expect(sumApplied({ x: '0.10', y: '0.20', z: '', w: '1.' })).toBe('1.30');
    expect(sumApplied({ x: '0.1', y: '0.2' })).toBe('0.30');
  });
});
