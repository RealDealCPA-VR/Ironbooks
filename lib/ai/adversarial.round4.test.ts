/**
 * Independent QA (tester) — re-test round 3. Probes the round-3 fixes in lib/ai/redact.ts:
 * '.' back in the numeric-entity separator class (guarded by the decimal-fraction post-check),
 * '.' in the labeled TAXID capture, the unlabeled dotted-SSN detector and the NBSP-to-space
 * detection copy. Pure unit tests, no network.
 */
import { describe, it, expect } from 'vitest';
import { Redactor } from './redact';

describe('round-3 fixes: dotted / NBSP SSNs and amount safety', () => {
  it('a dotted SSN followed by a sentence period is redacted and restored', () => {
    const r = new Redactor();
    const out = r.redact('SSN: 123.45.6789.');
    expect(out).not.toContain('6789');
    expect(out.endsWith('.')).toBe(true);
    expect(r.restore(out)).toBe('SSN: 123.45.6789.');
  });

  it('an unlabeled dotted SSN next to a small number is redacted', () => {
    const out = new Redactor().redact('Ref 123.45.6789 3 kids');
    expect(out).not.toContain('6789');
    expect(out).toContain('3 kids');
  });

  it('a known 9-digit account never swallows an amount written with dots or commas', () => {
    const r = new Redactor([{ text: '123456789', kind: 'ACCOUNT' }]);
    expect(r.redact('Paid 1234567.89 to vendor')).toBe('Paid 1234567.89 to vendor');
    expect(r.redact('Paid $1,234,567.89')).toBe('Paid $1,234,567.89');
  });

  it('a labeled tax id that is really an amount with cents is left alone', () => {
    expect(new Redactor().redact('Tax ID 1234567.89 paid')).toBe('Tax ID 1234567.89 paid');
  });

  it('a dotted 9-digit inventory count is not called an SSN', () => {
    expect(new Redactor().redact('Items 123.456.789 shipped')).toBe('Items 123.456.789 shipped');
  });

  it('NBSP normalization keeps the original characters in untouched text and on restore', () => {
    const src = 'SSN 123-45-6789 and call 555 123 4567  today';
    const r = new Redactor();
    const out = r.redact(src);
    expect(out).not.toMatch(/6789|4567/);
    expect(out).toContain(' and call ');
    expect(out).toContain('  today');
    expect(r.restore(out)).toBe(src);
  });

  it('a lowercase NBSP-joined label and SSN is redacted', () => {
    expect(new Redactor().redact('ssn 123 45 6789')).not.toContain('6789');
  });
});

describe('remaining SSN leaks', () => {
  // The labeled TAXID capture is greedy: "123 45 6789 2" (10 digits) fails the 9-digit check and
  // there is no retry at a shorter length. The unlabeled spaced-SSN detector refuses because a
  // digit follows after a space. Nothing else catches 9 spaced digits, so the SSN leaks even
  // though it sits right after the "SSN" label.
  it('a LABELED spaced SSN followed by another number is redacted', () => {
    const out = new Redactor().redact('Employee SSN 123 45 6789 2 dependents');
    expect(out).not.toContain('6789');
    expect(out).toContain('2 dependents');
  });

  it('a LABELED NBSP-spaced SSN followed by another number is redacted', () => {
    const out = new Redactor().redact('SSN 123 45 6789 2 dependents');
    expect(out).not.toContain('6789');
  });

  // The NBSP fix covers U+00A0/2007/2009/202F only. Word and PDF exports also produce the other
  // Unicode space separators (en space U+2002, em space U+2003, punctuation space U+2008).
  it('a labeled SSN joined by EN SPACES (U+2002) is redacted', () => {
    expect(new Redactor().redact('SSN 123 45 6789')).not.toContain('6789');
  });

  it('a labeled SSN joined by EM SPACES (U+2003) is redacted', () => {
    expect(new Redactor().redact('SSN 123 45 6789')).not.toContain('6789');
  });
});
