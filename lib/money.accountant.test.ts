/**
 * Feature round (accountant team) — leftover from review round 5 (imports -> core / money):
 * toDecimal accepted 'NaN' and 'Infinity' (decimal.js parses them) and Postgres numeric stores
 * NaN, so any service that passed user text through Money.of / toAmountString without its own
 * check could persist a NaN amount. Every parse of a non-finite value is now a MoneyParseError
 * (a 400 with a plain message), never a NaN that the ledger triggers count as balanced.
 */
import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { Money, MoneyParseError, toAmountString, toDecimal } from './money';

describe('toDecimal refuses values that are not finite numbers', () => {
  for (const bad of ['NaN', 'nan', 'Infinity', '-Infinity', '+Infinity', ' Infinity ']) {
    it(`"${bad}" is not an amount`, () => {
      expect(() => toDecimal(bad)).toThrow(MoneyParseError);
      expect(() => toAmountString(bad)).toThrow(MoneyParseError);
      expect(() => Money.of(bad)).toThrow(MoneyParseError);
    });
  }
  it('non-finite numbers are refused too', () => {
    expect(() => toDecimal(Number.NaN)).toThrow(MoneyParseError);
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(MoneyParseError);
    expect(() => toDecimal(Number('abc'))).toThrow(MoneyParseError);
  });
  it('a non-finite Decimal is refused', () => {
    expect(() => toDecimal(new Decimal(Number.NaN))).toThrow(MoneyParseError);
  });
  it('ordinary amounts still parse', () => {
    expect(toAmountString('12.5')).toBe('12.50');
    expect(toAmountString(' -3 ')).toBe('-3.00');
    expect(toAmountString(7)).toBe('7.00');
    expect(toAmountString('')).toBe('0.00');
    expect(toAmountString(null)).toBe('0.00');
    expect(toDecimal(new Decimal('1.25')).toFixed(2)).toBe('1.25');
  });
});
