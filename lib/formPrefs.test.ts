import { describe, expect, it } from 'vitest';
import { confirmUniqueNumber, findDuplicateNumber, stockShortfalls } from './formPrefs';

describe('findDuplicateNumber', () => {
  const bills = [
    { id: '1', vendorId: 'v1', billNumber: 'A-100', status: 'open' },
    { id: '2', vendorId: 'v2', billNumber: 'A-200', status: 'open' },
    { id: '3', vendorId: 'v1', billNumber: 'A-300', status: 'void' },
  ];
  const scope = (vendorId: string) => (b: (typeof bills)[number]) => b.vendorId === vendorId && b.status !== 'void';

  it('finds the same number (case/space-insensitive) within the scope', () => {
    expect(findDuplicateNumber(' a-100 ', bills, (b) => b.billNumber, { sameScope: scope('v1') })?.id).toBe('1');
  });
  it('ignores other scopes, voided rows, the document being edited and blanks', () => {
    expect(findDuplicateNumber('A-200', bills, (b) => b.billNumber, { sameScope: scope('v1') })).toBeUndefined();
    expect(findDuplicateNumber('A-300', bills, (b) => b.billNumber, { sameScope: scope('v1') })).toBeUndefined();
    expect(findDuplicateNumber('A-100', bills, (b) => b.billNumber, { excludeId: '1', sameScope: scope('v1') })).toBeUndefined();
    expect(findDuplicateNumber('', bills, (b) => b.billNumber)).toBeUndefined();
  });
  it('confirmUniqueNumber passes when the warning is off or there is no duplicate', () => {
    expect(confirmUniqueNumber(false, 'Bill number', bills[0], 'A-100')).toBe(true);
    expect(confirmUniqueNumber(true, 'Bill number', undefined, 'A-100')).toBe(true);
  });
});

describe('stockShortfalls', () => {
  it('sums lines per inventory item and credits what this document already took', () => {
    const items = [
      { id: 'i1', name: 'Widget', type: 'inventory', quantityOnHand: '5' },
      { id: 's1', name: 'Labor', type: 'service', quantityOnHand: null },
    ];
    const lines = [
      { itemId: 'i1', quantity: '4' },
      { itemId: 'i1', quantity: '3' },
      { itemId: 's1', quantity: '99' },
    ];
    expect(stockShortfalls(lines, items)).toEqual([{ name: 'Widget', need: 7, have: 5 }]);
    expect(stockShortfalls(lines, items, [{ itemId: 'i1', quantity: '2' }])).toEqual([]);
  });
});
