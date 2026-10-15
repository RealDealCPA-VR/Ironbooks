/**
 * Pure smart-default helpers: check-number parsing / sequencing and the per-form-type
 * "last date entered" memory behind My Preferences > General "Default date".
 */
import { describe, expect, it } from 'vitest';
import {
  FORM_HEADER_FIELDS,
  MAX_CHECK_DIGITS,
  SMART_FORMS,
  type SmartLine,
  billRowFromRecall,
  defaultFormDate,
  fillRecalledItems,
  invoiceFieldsFromRecall,
  lineClassOverride,
  formKeyForSave,
  nextCheckNumberFrom,
  parseCheckNumber,
  recallFormDate,
  recallNumber,
  recallQuantity,
  rememberFormDate,
  salesRowsFromRecall,
} from './smartDefaults';

function line(over: Partial<SmartLine>): SmartLine {
  return {
    kind: 'item',
    accountId: null,
    itemId: null,
    description: null,
    quantity: null,
    rate: null,
    amount: '0.00',
    taxable: null,
    classId: null,
    customerId: null,
    jobId: null,
    ...over,
  };
}

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
    for (const bad of ['', null, undefined, 'EFT', 'DEBIT', 'CHK12', '12.5', '-5', '1001ABCD', '12345678901']) {
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

  it('survives the 999999999 -> 1000000000 rollover (10-digit checks still count)', () => {
    expect(MAX_CHECK_DIGITS).toBe(10);
    expect(parseCheckNumber('1000000000')).toEqual({ n: 1000000000, width: 10 });
    expect(nextCheckNumberFrom(['999999998', '999999999'])).toBe('1000000000');
    // Once 1000000000 is used, the next suggestion goes up, not back down to a lower number.
    expect(nextCheckNumberFrom(['999999999', '1000000000'])).toBe('1000000001');
    expect(nextCheckNumberFrom(['1000000000', '1000000001', '12'])).toBe('1000000002');
    // Longer runs are still confirmation numbers, not checks.
    expect(parseCheckNumber('10000000000')).toBeNull();
    expect(nextCheckNumberFrom(['1000000000', '98765432101'])).toBe('1000000001');
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

describe('recalled numbers are Decimal text, never JS floats', () => {
  it('drops trailing zeros without float rounding or exponent notation', () => {
    expect(recallNumber('9.5000')).toBe('9.5');
    expect(recallNumber('100.0000')).toBe('100');
    // Past float precision: String(Number(x)) would give "1234567890123.457".
    expect(recallNumber('1234567890123.4567')).toBe('1234567890123.4567');
    expect(String(Number('1234567890123.4567'))).not.toBe('1234567890123.4567');
    // Tiny values stay in plain notation (Number -> "1e-7").
    expect(recallNumber('0.0000001')).toBe('0.0000001');
    expect(recallNumber('0.10000000000000000001')).toBe('0.10000000000000000001');
    expect(recallNumber(null)).toBe('');
    expect(recallNumber('  ')).toBe('');
    expect(recallNumber('abc')).toBe('');
    expect(recallQuantity(null)).toBe('1');
    expect(recallQuantity('3.2500')).toBe('3.25');
  });

  it('salesRowsFromRecall uses them', () => {
    const [row] = salesRowsFromRecall([line({ itemId: 'i', quantity: '0.0000001', rate: '1234567890123.4567' })]);
    expect(row.quantity).toBe('0.0000001');
    expect(row.rate).toBe('1234567890123.4567');
  });
});

describe('recalled invoice lines', () => {
  const items = [{ id: 'i1', name: 'Widget', type: 'inventory', unitOfMeasure: 'ea' }];

  it('keeps the item id when the item list has not loaded yet, then fills the name in', () => {
    const r = invoiceFieldsFromRecall(line({ itemId: 'i1', quantity: '2.0000', rate: '9.5000' }), [], null);
    expect(r).toMatchObject({ itemId: 'i1', itemName: '', itemType: null, quantity: '2', rate: '9.5', rateManual: true });
    const rows = [{ ...r, unitOfMeasure: r.unitOfMeasure }];
    const filled = fillRecalledItems(rows, items);
    expect(filled[0]).toMatchObject({ itemId: 'i1', itemName: 'Widget', itemType: 'inventory', unitOfMeasure: 'ea', rate: '9.5' });
    // Nothing to fill: same array (no re-render loop).
    expect(fillRecalledItems(filled, items)).toBe(filled);
    expect(fillRecalledItems(rows, [])).toBe(rows);
  });

  it('resolves the item at once when the list is there; description lines stay item-less', () => {
    expect(invoiceFieldsFromRecall(line({ itemId: 'i1' }), items, null)).toMatchObject({
      itemId: 'i1',
      itemName: 'Widget',
      itemType: 'inventory',
      unitOfMeasure: 'ea',
      quantity: '1',
    });
    expect(invoiceFieldsFromRecall(line({ description: 'Note' }), items, null)).toMatchObject({ itemId: null, itemName: '' });
  });

  it("carries a line class that differs from the invoice's; an inherited one stays blank", () => {
    expect(invoiceFieldsFromRecall(line({ itemId: 'i1', classId: 'east' }), items, 'west').classId).toBe('east');
    expect(invoiceFieldsFromRecall(line({ itemId: 'i1', classId: 'west' }), items, 'west').classId).toBe('');
    expect(invoiceFieldsFromRecall(line({ itemId: 'i1', classId: 'east' }), items, null).classId).toBe('east');
    expect(lineClassOverride(null, 'west')).toBe('');
    expect(lineClassOverride(undefined, undefined)).toBe('');
  });
});

describe('recalled bill lines', () => {
  it('item line: qty / cost as Decimal text, own class and billable customer:job kept', () => {
    expect(
      billRowFromRecall(
        line({ itemId: 'i1', quantity: '3.0000', rate: '12.5000', description: 'Bolts', classId: 'east', customerId: 'c1', jobId: 'j1' }),
        'west',
      ),
    ).toEqual({
      mode: 'item',
      accountId: '',
      amount: '',
      itemId: 'i1',
      quantity: '3',
      unitCost: '12.5',
      description: 'Bolts',
      classId: 'east',
      customerId: 'c1',
      jobId: 'j1',
    });
  });

  it('account line: amount kept; a class equal to the bill class is left to inherit it', () => {
    expect(
      billRowFromRecall(
        line({ kind: 'account', accountId: 'a1', amount: '40.00', classId: 'west', customerId: 'c2', jobId: null }),
        'west',
      ),
    ).toEqual({
      mode: 'expense',
      accountId: 'a1',
      amount: '40.00',
      itemId: '',
      quantity: '',
      unitCost: '',
      description: '',
      classId: '',
      customerId: 'c2',
      jobId: '',
    });
  });

  it('a job without a customer is dropped', () => {
    expect(billRowFromRecall(line({ kind: 'account', accountId: 'a1', jobId: 'j1' }), null).jobId).toBe('');
  });
});
