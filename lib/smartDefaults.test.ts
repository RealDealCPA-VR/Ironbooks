/**
 * Pure smart-default helpers: check-number parsing / sequencing and the per-form-type
 * "last date entered" memory behind My Preferences > General "Default date".
 */
import { describe, expect, it } from 'vitest';
import {
  FORM_HEADER_FIELDS,
  SMART_FORMS,
  defaultFormDate,
  formKeyForSave,
  nextCheckNumberFrom,
  parseCheckNumber,
  recallFormDate,
  rememberFormDate,
  salesRowsFromRecall,
} from './smartDefaults';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('check numbers', () => {
  it('parses plain and suffixed numbers; rejects everything else', () => {
    expect(parseCheckNumber('1001')).toEqual({ n: 1001, width: 4 });
    expect(parseCheckNumber(' 1001A ')).toEqual({ n: 1001, width: 4 });
    expect(parseCheckNumber('1001-b')).toEqual({ n: 1001, width: 4 });
    expect(parseCheckNumber('0099')).toEqual({ n: 99, width: 4 });
    for (const bad of ['', null, undefined, 'EFT', 'DEBIT', 'CHK12', '12.5', '-5', '1001ABCD', '1234567890']) {
      expect(parseCheckNumber(bad as string)).toBeNull();
    }
  });

  it('next = highest + 1, no gap filling, suffixes and zero padding respected', () => {
    expect(nextCheckNumberFrom([])).toBe('1001');
    expect(nextCheckNumberFrom(['EFT', null, 'DEBIT'])).toBe('1001');
    expect(nextCheckNumberFrom(['1001', '1002', '1005'])).toBe('1006');
    expect(nextCheckNumberFrom(['1005', '1001A'])).toBe('1006');
    expect(nextCheckNumberFrom(['1001', '1001A'])).toBe('1002');
    expect(nextCheckNumberFrom(['0099'])).toBe('0100');
    expect(nextCheckNumberFrom(['999'])).toBe('1000');
    expect(nextCheckNumberFrom(['12', '4455667788990'])).toBe('13');
    expect(nextCheckNumberFrom([], '501')).toBe('501');
  });
});

describe('default date (last date entered on this form type)', () => {
  it("'today' preference always gives today", () => {
    const s = memStore();
    rememberFormDate('invoice', '2026-01-31', s);
    expect(defaultFormDate('today', 'invoice', '2026-10-15', s)).toBe('2026-10-15');
  });

  it("'last' gives the last date entered on THAT form type, else today", () => {
    const s = memStore();
    rememberFormDate('invoice', '2026-01-31', s);
    rememberFormDate('check', '2026-02-28', s);
    expect(defaultFormDate('last', 'invoice', '2026-10-15', s)).toBe('2026-01-31');
    expect(defaultFormDate('last', 'check', '2026-10-15', s)).toBe('2026-02-28');
    expect(defaultFormDate('last', 'bill', '2026-10-15', s)).toBe('2026-10-15');
  });

  it('ignores malformed dates and missing / throwing storage', () => {
    const s = memStore();
    rememberFormDate('bill', 'garbage', s);
    expect(recallFormDate('bill', s)).toBeNull();
    s.setItem('bka:lastDate:bill', 'nope');
    expect(recallFormDate('bill', s)).toBeNull();
    expect(defaultFormDate('last', 'bill', '2026-10-15', null)).toBe('2026-10-15');
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => rememberFormDate('bill', '2026-01-01', throwing)).not.toThrow();
    expect(defaultFormDate('last', 'bill', '2026-10-15', throwing)).toBe('2026-10-15');
  });

  it('maps saves to form keys (Write Checks by payment method)', () => {
    expect(formKeyForSave('/api/invoices', {})).toBe('invoice');
    expect(formKeyForSave('/api/expenses', { method: 'check' })).toBe('check');
    expect(formKeyForSave('/api/expenses', { method: 'credit_card' })).toBe('credit_card');
    expect(formKeyForSave('/api/expenses', { method: 'credit_card', isRefund: true })).toBe('credit_card_credit');
    expect(formKeyForSave('/api/expenses', { method: 'cash' })).toBe('expense');
    expect(formKeyForSave('/api/journal-entries', {})).toBe('journal');
    expect(formKeyForSave('/api/unknown', {})).toBeNull();
  });
});

describe('form catalogue', () => {
  it('every form has its header fields; only invoices carry a sales rep', () => {
    for (const f of SMART_FORMS) expect(FORM_HEADER_FIELDS[f]).toContain('memo');
    expect(SMART_FORMS.filter((f) => FORM_HEADER_FIELDS[f].includes('salesRepId'))).toEqual(['invoice']);
    expect(SMART_FORMS.filter((f) => FORM_HEADER_FIELDS[f].includes('terms'))).toEqual(['bill', 'invoice']);
  });

  it('recalled sales lines keep their rates (rateManual)', () => {
    const rows = salesRowsFromRecall([
      { kind: 'item', itemId: 'i1', accountId: null, description: 'W', quantity: '2.0000', rate: '9.5000', amount: '19.00', taxable: false, classId: 'c1', customerId: null, jobId: null },
    ]);
    expect(rows).toEqual([{ itemId: 'i1', description: 'W', quantity: '2', rate: '9.5', taxable: false, rateManual: true, classId: 'c1' }]);
  });
});
