import { describe, expect, it } from 'vitest';
import { appliedExceedsReceived, autoApplyPayment, cashApplied, moneyDec, sumApplied, sumMoney } from './paymentApply';

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

describe('appliedExceedsReceived (Receive Payments over-application, exact Decimal)', () => {
  const body = (apps: string[], journal: string[] = []) => ({
    applications: apps.map((amountApplied) => ({ amountApplied })),
    journalItems: journal.map((amount) => ({ amount })),
  });

  it('flags a one-cent excess that a float tolerance of 0.005 would also catch', () => {
    expect(appliedExceedsReceived(body(['60.00'], ['40.01']), '100.00')).toBe(true);
  });

  it('does not flag an exact match even where float addition drifts (0.1 + 0.2)', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in floats; Decimal says exactly 0.3.
    expect(0.1 + 0.2 > 0.3).toBe(true);
    expect(appliedExceedsReceived(body(['0.1'], ['0.2']), '0.3')).toBe(false);
  });

  it('flags sub-cent excesses the old float tolerance let through', () => {
    // Old check: 100.004 > 100 + 0.005 → false. The server compares exactly.
    expect(appliedExceedsReceived(body(['100.004']), '100')).toBe(true);
  });

  it('counts General Journal items and treats blank / junk as zero', () => {
    expect(cashApplied(body(['10.00', ''], ['abc', '5.50'])).toFixed(2)).toBe('15.50');
    expect(appliedExceedsReceived(body(['10.00'], ['5.50']), '')).toBe(true);
    expect(appliedExceedsReceived(body([], []), '0')).toBe(false);
  });

  it('sumMoney / moneyDec are exact', () => {
    expect(sumMoney(['x', '0.10', null, undefined, 0.2]).toFixed(2)).toBe('0.30');
    expect(moneyDec('12.345').toFixed(3)).toBe('12.345');
  });
});
