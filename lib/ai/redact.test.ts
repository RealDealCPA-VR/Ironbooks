/**
 * Redaction is the privacy boundary for every cloud model call — test it hard.
 */
import { describe, it, expect } from 'vitest';
import { Redactor, addressEntities } from './redact';

const ents = [
  { text: 'Acme Corporation', kind: 'CUSTOMER' as const },
  { text: 'Acme', kind: 'CUSTOMER' as const },
  { text: 'Bob’s Plumbing', kind: 'VENDOR' as const },
  { text: 'Jane Smith', kind: 'EMPLOYEE' as const },
  { text: 'Smith, Jane', kind: 'EMPLOYEE' as const },
  { text: 'Office Depot', kind: 'VENDOR' as const },
];

describe('Redactor — known entities', () => {
  it('replaces names with stable placeholders and restores them', () => {
    const r = new Redactor(ents);
    const red = r.redact('Acme Corporation owes $1,200.00; Jane Smith approved. acme corporation called again.');
    expect(red).not.toMatch(/acme/i);
    expect(red).not.toMatch(/Jane|Smith/);
    // Same entity (case-insensitive) → same placeholder.
    const placeholders = red.match(/\[CUSTOMER_\d+\]/g)!;
    expect(new Set(placeholders).size).toBe(1);
    expect(red).toContain('[EMPLOYEE_1]');
    expect(red).toContain('$1,200.00'); // money survives
    expect(r.restore(red)).toBe('Acme Corporation owes $1,200.00; Jane Smith approved. Acme Corporation called again.');
  });

  it('prefers the longest match (Acme Corporation over Acme)', () => {
    const r = new Redactor(ents);
    const red = r.redact('Acme Corporation and Acme');
    expect(red).toBe('[CUSTOMER_1] and [CUSTOMER_2]');
    expect(r.restore(red)).toBe('Acme Corporation and Acme');
  });

  it('respects word boundaries (no partial-word hits)', () => {
    const r = new Redactor(ents);
    expect(r.redact('Acmeville is a town')).toBe('Acmeville is a town');
  });

  it('matches across whitespace variations and special characters in names', () => {
    const r = new Redactor(ents);
    const red = r.redact('Paid Bob’s Plumbing and Office   Depot.');
    expect(red).toBe('Paid [VENDOR_1] and [VENDOR_2].');
  });

  it('stays stable across multiple calls (multi-turn conversations)', () => {
    const r = new Redactor(ents);
    const a = r.redact('Jane Smith');
    const b = r.redact('Later, Jane Smith again; Smith, Jane in last-first form');
    expect(a).toBe('[EMPLOYEE_1]');
    expect(b).toContain('[EMPLOYEE_1]');
    expect(b).toContain('[EMPLOYEE_2]');
  });

  it('ignores too-short or numeric "names" that would shred normal text', () => {
    const r = new Redactor([{ text: 'Al', kind: 'CUSTOMER' }, { text: '1000', kind: 'VENDOR' }]);
    expect(r.redact('All of account 1000 for Al')).toBe('All of account 1000 for Al');
  });

  it('collects street lines from address objects', () => {
    const list = addressEntities({ line1: '42 Wallaby Way', city: 'Sydney', zip: '2000' });
    expect(list).toEqual([{ text: '42 Wallaby Way', kind: 'ADDRESS' }]);
  });
});

describe('Redactor — pattern detectors', () => {
  const r = () => new Redactor();

  it('emails', () => {
    const x = r();
    const red = x.redact('Send to jane.doe+ap@example.co.uk please');
    expect(red).toBe('Send to [EMAIL_1] please');
    expect(x.restore(red)).toBe('Send to jane.doe+ap@example.co.uk please');
  });

  it('SSN, EIN and labeled TINs', () => {
    expect(r().redact('SSN 123-45-6789')).not.toContain('6789');
    expect(r().redact('EIN 12-3456789 on file')).toBe('EIN [TAXID_1] on file');
    expect(r().redact('employer no. 12-3456789 on file')).toBe('employer no. [EIN_1] on file');
    expect(r().redact('Tax ID: 987654321')).toBe('Tax ID: [TAXID_1]');
    expect(r().redact('ssn#123456789')).not.toContain('123456789');
  });

  it('card numbers (Luhn-valid) but not random digit runs as cards', () => {
    expect(r().redact('card 4111 1111 1111 1111 exp')).toBe('card [CARD_1] exp');
    expect(r().redact('4111-1111-1111-1111')).toBe('[CARD_1]');
    // Not Luhn-valid → still caught as a long account number, never left in clear.
    expect(r().redact('ref 4111111111111112')).toBe('ref [ACCOUNT_1]');
  });

  it('bank account / routing numbers', () => {
    expect(r().redact('Routing 021000021 acct 000123456789')).toBe('Routing [ACCOUNT_1] acct [ACCOUNT_2]');
    expect(r().redact('account #: 1234567')).toBe('account #: [ACCOUNT_1]');
    expect(r().redact('IBAN DE89 3704 0044 0532 0130 00')).toContain('[IBAN_1]');
  });

  it('phone numbers in common formats', () => {
    for (const p of ['(555) 123-4567', '555-123-4567', '555.123.4567', '+1 555 123 4567', '+44 20 7946 0958']) {
      const red = r().redact(`call ${p} today`);
      expect(red, p).toBe('call [PHONE_1] today');
    }
  });

  it('street addresses and PO boxes', () => {
    expect(r().redact('Ship to 1600 Pennsylvania Avenue NW, Washington')).toContain('[ADDRESS_1]');
    expect(r().redact('Ship to 1600 Pennsylvania Avenue NW, Washington')).not.toContain('1600');
    expect(r().redact('Mail: 221B Baker St, Apt 2')).toBe('Mail: 221B Baker St, Apt 2'); // "221B" isn't a pure number
    expect(r().redact('Mail: 221 Baker St., Suite 400')).toBe('Mail: [ADDRESS_1]');
    expect(r().redact('PO Box 1234, Springfield')).toBe('[ADDRESS_1], Springfield');
  });

  it('does NOT touch money, dates, uuids, short account codes or entry numbers', () => {
    const text =
      'Net income $12,345,678.90 vs 12345678.90 on 2026-10-10 for entry #1042, account 6000 Office Supplies, id 123e4567-e89b-12d3-a456-426614174000, 45 invoices.';
    expect(r().redact(text)).toBe(text);
  });

  it('restores placeholders even if the model drops the brackets', () => {
    const x = new Redactor([{ text: 'Acme Corporation', kind: 'CUSTOMER' }]);
    x.redact('Acme Corporation');
    expect(x.restore('Customer CUSTOMER_1 is late')).toBe('Customer Acme Corporation is late');
    expect(x.restore('Unknown [CUSTOMER_9] stays')).toBe('Unknown [CUSTOMER_9] stays');
    expect(x.restore('FOO_1 is not ours')).toBe('FOO_1 is not ours');
  });

  it('restoreDeep restores strings inside parsed JSON', () => {
    const x = new Redactor([{ text: 'Jane Smith', kind: 'EMPLOYEE' }]);
    const red = x.redact('Jane Smith');
    const out = x.restoreDeep({ a: red, b: [red, 5], c: { d: `${red}!` } });
    expect(out).toEqual({ a: 'Jane Smith', b: ['Jane Smith', 5], c: { d: 'Jane Smith!' } });
  });

  it('never double-redacts placeholder text already present', () => {
    const x = new Redactor([{ text: 'Acme', kind: 'CUSTOMER' }]);
    const once = x.redact('Acme 555-123-4567');
    expect(x.redact(once)).toBe(once);
  });

  it('a mixed realistic memo leaks nothing sensitive', () => {
    const x = new Redactor(ents);
    const memo =
      'Refund to Jane Smith (jane@smith.io, 415-555-0199) at 77 Sunset Blvd, card 5555 5555 5555 4444, SSN 078-05-1120, acct 9876543210 — $250.00 on 2026-03-01';
    const red = x.redact(memo);
    for (const leak of ['Jane', 'Smith', 'jane@smith.io', '415', 'Sunset', '4444', '078-05-1120', '9876543210']) {
      expect(red, leak).not.toContain(leak);
    }
    expect(red).toContain('$250.00');
    expect(red).toContain('2026-03-01');
    expect(x.restore(red)).toBe(memo);
  });
});
