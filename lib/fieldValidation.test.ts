/** Inline field validation messages (lib/fieldValidation.ts). */
import { describe, expect, it } from 'vitest';
import {
  amountMessage,
  collectErrors,
  dateMessage,
  errorSummary,
  fieldErrorId,
  hasErrors,
  parseTypedAmount,
  requiredMessage,
} from './fieldValidation';

describe('fieldValidation', () => {
  it('required', () => {
    expect(requiredMessage('', 'Choose a customer.')).toBe('Choose a customer.');
    expect(requiredMessage('   ', 'x')).toBe('x');
    expect(requiredMessage(null, 'x')).toBe('x');
    expect(requiredMessage('abc', 'x')).toBeNull();
  });

  it('parses typed amounts with Decimal (thousands commas, 2 decimals)', () => {
    expect(parseTypedAmount('1,250.50')?.toString()).toBe('1250.5');
    expect(parseTypedAmount(' 12.3 ')?.toString()).toBe('12.3');
    expect(parseTypedAmount('12,50')).toBe('invalid');
    expect(parseTypedAmount('1.234')).toBe('invalid');
    expect(parseTypedAmount('')).toBeNull();
  });

  it('amount messages are plain language', () => {
    expect(amountMessage('', { label: 'Amount', required: true })).toBe('Enter the amount.');
    expect(amountMessage('', { label: 'Amount' })).toBeNull();
    expect(amountMessage('abc', { label: 'Line 2 amount' })).toBe('Line 2 amount must be a number like 1250.50 (two decimals at most).');
    expect(amountMessage('-5', { label: 'Amount' })).toBe("Amount can't be negative.");
    expect(amountMessage('0', { label: 'Amount' })).toBe('Amount must be more than zero.');
    expect(amountMessage('0', { label: 'Amount', allowZero: true })).toBeNull();
    expect(amountMessage('100.01', { label: 'Payment', max: { value: '100.00', what: 'the balance due' } })).toBe(
      'Payment is more than the balance due.',
    );
    expect(amountMessage('10000000000000', { label: 'Amount' })).toBe('Amount is too large.');
    expect(amountMessage('1,000.00', { label: 'Amount', required: true })).toBeNull();
  });

  it('date messages', () => {
    expect(dateMessage('', 'Invoice date')).toBe('Enter the invoice date.');
    expect(dateMessage('', 'Due date', { required: false })).toBeNull();
    expect(dateMessage('2026-02-30', 'Date')).toBe("Date isn't a real date. Pick one from the calendar.");
    expect(dateMessage('20260101', 'Date')).toBe("Date isn't a real date. Pick one from the calendar.");
    expect(dateMessage('1800-01-01', 'Date')).toBe('Date looks wrong (year 1800).');
    expect(dateMessage('2026-01-01', 'Due date', { notBefore: { value: '2026-01-05', what: 'the invoice date' } })).toBe(
      "Due date can't be before the invoice date.",
    );
    expect(dateMessage('2026-01-05', 'Date')).toBeNull();
  });

  it('collect / summary / ids', () => {
    const errs = collectErrors({ a: 'A is wrong.', b: null, c: undefined, d: 'D too.' });
    expect(errs).toEqual({ a: 'A is wrong.', d: 'D too.' });
    expect(hasErrors(errs)).toBe(true);
    expect(hasErrors({})).toBe(false);
    expect(errorSummary(errs)).toBe('2 fields need fixing. First: A is wrong.');
    expect(errorSummary({ a: 'Only.' })).toBe('Only.');
    expect(errorSummary({})).toBeNull();
    expect(fieldErrorId('inv', 'line-2-qty')).toBe('inv-line-2-qty-error');
  });
});
