import { describe, it, expect } from 'vitest';
import { filterTypeahead, moveHighlight, type TypeaheadOption } from './typeahead';

const accounts: TypeaheadOption[] = [
  { value: '6300 · Office Supplies', terms: ['6300', 'Office Supplies'] },
  { value: '6600 · Utilities', terms: ['6600', 'Utilities'] },
  { value: '1000 · Checking', terms: ['1000', 'Checking'] },
  { value: '6310 · Postage & Office', terms: ['6310', 'Postage & Office'] },
];

describe('filterTypeahead', () => {
  it('finds accounts by number and by name', () => {
    expect(filterTypeahead(accounts, '63').map((o) => o.value)).toEqual(['6300 · Office Supplies', '6310 · Postage & Office']);
    expect(filterTypeahead(accounts, 'util')[0].value).toBe('6600 · Utilities');
  });

  it('ranks a word start above a mid-word match, keeps list order for ties', () => {
    const r = filterTypeahead(accounts, 'office').map((o) => o.value);
    expect(r).toEqual(['6300 · Office Supplies', '6310 · Postage & Office']);
    const names: TypeaheadOption[] = [{ value: 'Bob Smith' }, { value: 'Smithers' }, { value: 'Ann Smith' }];
    expect(filterTypeahead(names, 'smith').map((o) => o.value)).toEqual(['Smithers', 'Bob Smith', 'Ann Smith']);
  });

  it('is case/space insensitive, honours max, and lists the first entries for an empty query', () => {
    expect(filterTypeahead(accounts, '  CHECK ').map((o) => o.value)).toEqual(['1000 · Checking']);
    expect(filterTypeahead(accounts, '', 2)).toHaveLength(2);
    expect(filterTypeahead(accounts, 'zzz')).toEqual([]);
  });
});

describe('moveHighlight', () => {
  it('wraps with Down / Up and jumps with Home / End', () => {
    expect(moveHighlight(-1, 3, 'ArrowDown')).toBe(0);
    expect(moveHighlight(2, 3, 'ArrowDown')).toBe(0);
    expect(moveHighlight(0, 3, 'ArrowUp')).toBe(2);
    expect(moveHighlight(1, 3, 'Home')).toBe(0);
    expect(moveHighlight(1, 3, 'End')).toBe(2);
    expect(moveHighlight(0, 0, 'ArrowDown')).toBe(-1);
  });
});
