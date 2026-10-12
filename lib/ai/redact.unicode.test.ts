/**
 * Integration fix for the round-4 findings: labeled SSN/TIN captures try the valid 9-digit form
 * first, and the detection copy normalizes every Unicode separator (not just a few spaces).
 */
import { describe, it, expect } from 'vitest';
import { Redactor } from './redact';

const SEPARATORS: Array<[string, string]> = [
  ['punctuation space U+2008', ' '],
  ['ideographic space U+3000', '　'],
  ['six-per-em space U+2006', ' '],
  ['hair space U+200A', ' '],
  ['medium math space U+205F', ' '],
  ['ogham space mark U+1680', ' '],
  ['zero-width space U+200B', '​'],
];

describe('labeled SSN / TIN: valid 9-digit form first', () => {
  it.each([
    ['SSN 123 45 6789 2 dependents', '2 dependents'],
    ['SSN: 123-45-6789 12 hours', '12 hours'],
    ['TIN 123.45.6789 3', ' 3'],
    ['EIN 12-3456789 4 owners', '4 owners'],
    ['Tax ID 12 3456789 5 kids', '5 kids'],
  ])('%s', (src, keep) => {
    const r = new Redactor();
    const out = r.redact(src);
    expect(out).not.toMatch(/6789/);
    expect(out).toContain(keep);
    expect(r.restore(out)).toBe(src);
  });

  it('a labeled 10-digit number is still not redacted as a tax id', () => {
    expect(new Redactor().redact('EIN 1234567890 x')).not.toContain('[TAXID_');
  });

  it('a labeled money amount with cents is still left alone', () => {
    expect(new Redactor().redact('Tax ID 123456789.50 due')).toBe('Tax ID 123456789.50 due');
  });
});

describe('every Unicode separator is normalized in the detection copy', () => {
  it.each(SEPARATORS)('labeled SSN joined by %s', (_label, sep) => {
    const src = `SSN 123${sep}45${sep}6789 then 2 more`;
    const r = new Redactor();
    const out = r.redact(src);
    expect(out).not.toContain('6789');
    expect(r.restore(out)).toBe(src); // original characters survive the round trip
  });

  it.each(SEPARATORS)('unlabeled SSN joined by %s', (_label, sep) => {
    expect(new Redactor().redact(`ref 123${sep}45${sep}6789.`)).not.toContain('6789');
  });

  it('line / paragraph separators act as field boundaries, not spaces inside a number', () => {
    const out = new Redactor().redact('qty 123 45 6789');
    // Not an SSN: the groups sit on separate lines, like '\n'.
    expect(out).toBe('qty 123 45 6789');
  });
});
