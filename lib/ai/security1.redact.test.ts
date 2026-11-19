/**
 * Security 1.4 / 4.10 — the cloud-AI redactor (lib/ai/redact.ts).
 *
 * 1. Time: "SSN" followed by a few thousand spaces froze the server (three adjacent \s* split the
 *    run every possible way: 2,000 spaces took 1.9 s, 4,000 took 23 s), and the e-mail pattern
 *    was retried from every position of a long word (20,000 letters: 0.5 s, growing 4x per
 *    doubling). Every input below is 100,000 characters and must take well under a second.
 * 2. An SSN written with an en dash, a non-breaking hyphen, a figure dash, '/' or '_' between
 *    the groups went to the cloud as is.
 * 3. A remembered "123 Main St" turned "123 Main Stanton Blvd" into "[ADDRESS_1]anton Blvd".
 * 4. A customer named like a word of the app's own protocol ("action", "tool", "amount") was
 *    replaced inside the instructions and JSON keys, so every cloud AI call failed.
 */
import { describe, it, expect } from 'vitest';
import { Redactor, type KnownEntity } from './redact';

const N = 100_000;
const fill = (unit: string, n = N) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

describe('redaction runs in linear time on hostile input', () => {
  const units = [
    ' ', '\t', '\n', '\r\n', ' ', '1', '-', '.', '#', '_', '/', '"', ':', 'a', 'A', '1 ', '1-', '1.', '1\t',
    ' \t-.#1\n', 'a@', 'a.', 'x@x.', '+12 ', '"a": ', '"a" ', 'SSN ', 'acct 1 ', '1 Main ', 'social security ',
    'tax id ', '# ', 'no ', 'P.O. ', 'GB82 ', 'action ', '123-45-6789 ', '123–45–6789 ', '1,234.56 ',
  ];
  const prefixes = ['', 'SSN', 'SSN #', 'EIN:', 'tax id', 'social security no', 'account', 'acct no', 'a/c', '1 ', 'P O Box', '+1', 'x@'];
  const entities: KnownEntity[] = [
    { text: 'Acme Corp East', kind: 'CUSTOMER' },
    { text: 'Action', kind: 'CUSTOMER' },
    { text: '555-0100-77', kind: 'PHONE' },
    { text: '123 Main St', kind: 'ADDRESS' },
  ];

  it('every pattern stays fast on 100,000-character runs (with and without known names)', () => {
    let worst = 0;
    let worstCase = '';
    for (const unit of units) {
      for (const prefix of prefixes) {
        const input = prefix + fill(unit) + 'x';
        for (const withEntities of [false, true]) {
          const r = new Redactor(withEntities ? entities : []);
          // Remembered values add their own patterns on the next call.
          if (withEntities) r.redact('acct 123456789, 123 Main St, SSN 123-45-6789, a@b.com');
          const t0 = performance.now();
          r.redact(input);
          const ms = performance.now() - t0;
          if (ms > worst) {
            worst = ms;
            worstCase = `${JSON.stringify(prefix)} + ${JSON.stringify(unit)} x ${N}`;
          }
        }
      }
    }
    // About 20 ms on a desktop; the bound is generous so a slow CI machine does not flake.
    expect(worst, worstCase).toBeLessThan(1000);
  });

  it('the two reported cases: "SSN" / "account" + 100,000 spaces', () => {
    for (const label of ['SSN', 'account', 'social security number #']) {
      const t0 = performance.now();
      expect(new Redactor([]).redact(label + ' '.repeat(N))).toBe(label + ' '.repeat(N));
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });

  it('restore() is fast on hostile model output', () => {
    const r = new Redactor([{ text: 'Acme Corp', kind: 'CUSTOMER' }]);
    r.redact('Acme Corp');
    for (const unit of ['A', 'A_', 'A_1', '[A', '[CUSTOMER_1', 'CUSTOMER_', '_1']) {
      const t0 = performance.now();
      r.restore(fill(unit));
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });

  it('every form found before is still found (labels with long or odd spacing, numbers after newlines)', () => {
    const r = new Redactor([]);
    expect(r.redact(`SSN${' '.repeat(40)}123456789`)).toBe(`SSN${' '.repeat(40)}[TAXID_1]`);
    expect(r.redact('Tax ID #  :  987-65-4321')).toBe('Tax ID #  :  [TAXID_2]');
    expect(r.redact('social security no.\n111 22 3333')).toBe('social security no.\n[TAXID_3]');
    expect(r.redact('Acct No.: 12345678')).toBe('Acct No.: [ACCOUNT_1]');
    expect(r.redact('routing #\t021000021')).toBe('routing #\t[ACCOUNT_2]');
    expect(r.redact('a/c no 0012-3456-78')).toBe('a/c no [ACCOUNT_3]');
    expect(r.redact('write to jane.doe@example.com, or bob@mail.co.uk.')).toBe('write to [EMAIL_1], or [EMAIL_2].');
  });
});

describe('SSNs with other separators are redacted, and the right characters are replaced', () => {
  it.each([
    ['en dash', '123–45–6789'],
    ['non-breaking hyphen', '123‑45‑6789'],
    ['figure dash', '123‒45‒6789'],
    ['em dash', '123—45—6789'],
    ['minus sign', '123−45−6789'],
    ['slash', '123/45/6789'],
    ['underscore', '123_45_6789'],
  ])('%s', (_label, ssn) => {
    const r = new Redactor([]);
    const out = r.redact(`Employee ${ssn} started.`);
    expect(out).toBe('Employee [SSN_1] started.');
    // The original (with its own separators) comes back.
    expect(r.restore(out)).toBe(`Employee ${ssn} started.`);
    // Labeled: the tax id detector reads the same separators.
    expect(new Redactor([]).redact(`SSN: ${ssn}`)).toBe('SSN: [TAXID_1]');
  });

  it('offsets still line up after a two-unit dash character earlier in the text', () => {
    // U+10EAD (Yezidi hyphenation mark) is dash punctuation stored as two UTF-16 units.
    const r = new Redactor([]);
    expect(r.redact('a\u{10EAD}b 123–45–6789 c')).toBe('a\u{10EAD}b [SSN_1] c');
  });

  it('phones and card numbers with en dashes too; dates with slashes are left alone', () => {
    const r = new Redactor([]);
    expect(r.redact('call 555–123–4567')).toBe('call [PHONE_1]');
    expect(r.redact('card 4111–1111–1111–1111')).toBe('card [CARD_1]');
    expect(r.redact('due 01/02/2024 and 12/31/2025, $1,234.56')).toBe('due 01/02/2024 and 12/31/2025, $1,234.56');
  });

  it('a remembered SSN is found again whatever separators it comes back with', () => {
    const r = new Redactor([]);
    expect(r.redact('SSN 123-45-6789')).toBe('SSN [TAXID_1]');
    expect(r.redact('it was 123/45/6789, or 123–45–6789')).toBe('it was [TAXID_1], or [TAXID_1]');
  });
});

describe('remembered values end on the right boundary', () => {
  it('"123 Main St" is not the start of "123 Main Stanton Blvd"', () => {
    const r = new Redactor([]);
    expect(r.redact('Ship to 123 Main St')).toBe('Ship to [ADDRESS_1]');
    expect(r.redact('Bill to 123 Main Stanton Blvd')).not.toContain(']anton');
    expect(r.redact('again: 123 Main St. and 123 main st, Apt 4')).toBe('again: [ADDRESS_1]. and [ADDRESS_1], Apt 4');
  });

  it('a remembered number still does not match inside a longer number or a money amount', () => {
    const r = new Redactor([]);
    expect(r.redact('acct # 123456')).toBe('acct # [ACCOUNT_1]');
    expect(r.redact('123456 and 1234567 and 123456.78')).toBe('[ACCOUNT_1] and 1234567 and 123456.78');
  });
});

describe('a customer named like a protocol word does not break the instructions', () => {
  const protocol =
    'Protocol — every reply is ONE JSON object, nothing else:\n' +
    '  To call a tool:  {"action":"tool","tool":"<name>","args":{...}}\n' +
    '  To answer:       {"action":"answer","answer":"<plain-language answer>"}\n' +
    'Cite the tool in brackets, e.g. [profit_and_loss]. Amounts as "amount":"450.00" with "rows":[…].\n' +
    '{"kind":"action","action":"pay_bills|reconcile","target":"account or customer"}';
  const names: KnownEntity[] = ['Action', 'Tool', 'Answer', 'Amount', 'Rows', 'Loss', 'Target', 'Reconcile', 'Kind'].map((text) => ({
    text,
    kind: 'CUSTOMER' as const,
  }));

  it('the protocol text goes out unchanged', () => {
    expect(new Redactor(names).redact(protocol)).toBe(protocol);
  });

  it('the same names written as names are still replaced, and stay replaced in later turns', () => {
    const r = new Redactor(names);
    const data = 'TOOL_RESULT ar_aging: {"customers":[{"customer":"Action","total":"10.00"},{"customer":"AMOUNT","total":"5.00"}]}';
    const out = r.redact(data);
    expect(out).not.toMatch(/Action|AMOUNT/);
    expect(out).toContain('"customers":[{"customer":"[CUSTOMER_');
    expect(out.startsWith('TOOL_RESULT ar_aging: ')).toBe(true);
    // "Action" is now a remembered value (matched without regard to case), but the protocol
    // words in the next message are still left alone.
    expect(r.redact(protocol)).toBe(protocol);
    expect(r.redact('Ask Action about it')).toBe(`Ask ${r.redact('Action')} about it`);
  });

  it('a name used as a JSON key is left alone only when the key is a lower-case identifier', () => {
    const r = new Redactor([{ text: 'Acme Corp', kind: 'CUSTOMER' }, { text: 'memo', kind: 'VENDOR' }, { text: 'zeta', kind: 'VENDOR' }]);
    expect(r.redact('{"zeta": 1, "memo" : "paid zeta", "Acme Corp": 2}')).toBe('{"zeta": 1, "memo" : "paid [VENDOR_1]", "[CUSTOMER_1]": 2}');
  });

  it('restoreDeep() restores keys as well as values', () => {
    const r = new Redactor([{ text: 'Acme Corp', kind: 'CUSTOMER' }]);
    r.redact('Acme Corp');
    expect(r.restoreDeep({ '[CUSTOMER_1]': { name: 'CUSTOMER_1' }, list: ['[CUSTOMER_1]'] })).toEqual({
      'Acme Corp': { name: 'Acme Corp' },
      list: ['Acme Corp'],
    });
    // A "__proto__" key stays a plain key.
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    const back = r.restoreDeep(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.keys(back)).toEqual(['__proto__', 'a']);
  });
});
