/**
 * Review round 2 (UI) regression tests.
 */
import { describe, it, expect } from 'vitest';
import { liveLineTotals, type LiveLineInput } from '@/lib/invoiceLineMath';
import { Money } from '@/lib/money';
import { formatShortDate } from '@/lib/format';

const income = (rate: string, taxable = true): LiveLineInput => ({ kind: 'income', quantity: '1', rate, taxable });
const subtotal: LiveLineInput = { kind: 'subtotal', quantity: '', rate: '', taxable: false };
const pct = (rate: string, taxable = true): LiveLineInput => ({
  kind: 'discount',
  quantity: '1',
  rate,
  taxable,
  discountPercent: true,
});

describe('invoice %-discount under a Subtotal item', () => {
  it('discounts the subtotal directly above it', () => {
    const t = liveLineTotals([income('100'), income('50'), subtotal, pct('10')]);
    expect(t.amounts.map((a) => a.toFixed(2))).toEqual(['100.00', '50.00', '150.00', '-15.00']);
    expect(t.subtotal.toFixed(2)).toBe('135.00');
    expect(t.taxableSubtotal.toFixed(2)).toBe('135.00');
  });

  it('without a subtotal, still discounts the body lines above it', () => {
    const t = liveLineTotals([income('10.10'), pct('15')]);
    expect(t.amounts[1].toFixed(2)).toBe('-1.52');
  });

  it('only the line right after the subtotal uses it; later groups start fresh', () => {
    const t = liveLineTotals([income('100'), subtotal, pct('10'), income('40'), pct('50')]);
    // group after the subtotal: -10 (10% of 100), then 40 → running 30, 50% of 30 = -15
    expect(t.amounts.map((a) => a.toFixed(2))).toEqual(['100.00', '100.00', '-10.00', '40.00', '-15.00']);
    expect(t.subtotal.toFixed(2)).toBe('115.00');
  });

  it('a % discount with nothing above it computes to zero (the form refuses to save it)', () => {
    const t = liveLineTotals([pct('10'), income('100')]);
    expect(t.amounts[0].isZero()).toBe(true);
  });
});

describe('Decimal rounding of client-computed amounts', () => {
  it('price-level bulk %: $1.15 + 10% = 1.27 (half-up), not the float 1.26', () => {
    const bulk = (price: string, n: number) => Money.round2(Money.div(Money.mul(price, 100 + n), 100)).toFixed(2);
    expect(bulk('1.15', 10)).toBe('1.27');
    expect(bulk('2.05', 10)).toBe('2.26');
    expect(bulk('100.00', -15)).toBe('85.00');
  });

  it('vendor-credit item line: 1 × 1.005 = 1.01, like the server round2(qty × cost)', () => {
    const amount = (q: number, c: number) => Money.round2(Money.mul(q, c)).toFixed(2);
    expect(amount(1, 1.005)).toBe('1.01');
    expect(amount(3, 1.115)).toBe('3.35');
  });
});

describe('note dates', () => {
  it('a note dated a calendar day (saved as UTC midnight) shows that day', () => {
    expect(formatShortDate('2026-10-16T00:00:00.000Z')).toBe('10/16/2026');
  });
});
