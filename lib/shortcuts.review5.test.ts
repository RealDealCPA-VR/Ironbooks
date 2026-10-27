/**
 * Review round 5 (team uib): QuickBooks keys and the shell.
 *
 *  - QuickMath (amount fields) evaluated and rounded with float math: "1234567.89/2" became
 *    617283.94 and "-5.11/2" became -2.55, where the books (lib/money Money.round2, half away from
 *    zero) say 617283.95 and -2.56. It now evaluates in exact decimals.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAmountDecimal, evaluateAmountExpression, formatAmountResult } from './shortcuts';
import { Money } from './money';

/** What an amount field shows after QuickMath commits (components/ui.tsx AmountInput). */
const quickMath = (raw: string) => {
  const v = evaluateAmountDecimal(raw);
  return v === null ? null : formatAmountResult(v);
};

describe('QuickMath rounds like the books', () => {
  it('a half cent rounds up, not down (float 50.024999…)', () => {
    expect(quickMath('100.05/2')).toBe('50.03');
    expect(quickMath('1.115+2.23')).toBe('3.35');
    expect(quickMath('0.285*100/100')).toBe('0.29');
  });

  it('negative half cents round away from zero, like Money.round2', () => {
    expect(quickMath('-5.11/2')).toBe(Money.round2('-2.555').toFixed(2));
    expect(quickMath('0-1.005')).toBe('-1.01');
  });

  it('agrees with Money.round2 on every split of a few awkward totals', () => {
    for (const total of ['100.05', '33.35', '0.05', '1234567.89', '10.01']) {
      for (const parts of [2, 3, 4, 6, 8]) {
        const exact = Money.round2(Money.div(total, parts));
        expect(quickMath(`${total}/${parts}`), `${total}/${parts}`).toBe(Number(exact.toFixed(2)) === 0 ? '0' : exact.toFixed(2).replace(/\.?0+$/, ''));
      }
    }
  });

  it('never shows -0 or exponent notation', () => {
    expect(quickMath('0*-1')).toBe('0');
    expect(quickMath('-0.001+0')).toBe('0');
    expect(quickMath('99999999999*100')).toBe('9999999999900');
    expect(quickMath('0.1+0.2')).toBe('0.3');
  });

  it('keeps the existing answers and refusals', () => {
    expect(quickMath('12.5*3+10')).toBe('47.5');
    expect(quickMath('10/3')).toBe('3.33');
    expect(evaluateAmountExpression('$1,200 + 300')).toBe(1500);
    expect(quickMath('1/0')).toBeNull();
    expect(quickMath('5+')).toBeNull();
    expect(quickMath('(2+3')).toBeNull();
    expect(quickMath('-(2')).toBeNull();
  });
});
