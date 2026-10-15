import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  choicesToOptions,
  comboboxAria,
  filterTypeahead,
  initialHighlight,
  isExactTypeaheadMatch,
  labelForId,
  moveHighlight,
  resolveTypedChoice,
  type TypeaheadChoice,
  type TypeaheadOption,
} from './typeahead';

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

describe('free-text fields keep what was typed (review P2)', () => {
  const vendors: TypeaheadOption[] = [{ value: 'Office Depot' }, { value: 'City Power' }];

  it('pick-from-list fields highlight the best match so Enter takes it', () => {
    expect(initialHighlight(filterTypeahead(vendors, 'Office'), 'Office')).toBe(0);
    expect(initialHighlight(filterTypeahead(vendors, ''), '')).toBe(-1);
    expect(initialHighlight([], 'zz')).toBe(-1);
  });

  it('allowFreeText: a prefix of a longer name is not pre-highlighted, so Enter keeps "Office"', () => {
    const results = filterTypeahead(vendors, 'Office');
    expect(results[0].value).toBe('Office Depot');
    expect(initialHighlight(results, 'Office', true)).toBe(-1);
    // Down still picks the first entry.
    expect(moveHighlight(-1, results.length, 'ArrowDown')).toBe(0);
  });

  it('allowFreeText: an exact match (any case / spacing) is still highlighted', () => {
    expect(initialHighlight(filterTypeahead(vendors, 'office  depot'), 'office  depot', true)).toBe(0);
    const accts: TypeaheadOption[] = [{ value: '6300 · Office Supplies', terms: ['6300', 'Office Supplies'] }];
    expect(isExactTypeaheadMatch(accts[0], '6300')).toBe(true);
    expect(isExactTypeaheadMatch(accts[0], '630')).toBe(false);
  });
});

describe('combobox ARIA (review P2)', () => {
  it('aria-controls / aria-activedescendant only while the list is rendered', () => {
    expect(comboboxAria(false, 'lb', 'lb-opt-0')).toEqual({ 'aria-expanded': false });
    expect(comboboxAria(true, 'lb', null)).toEqual({ 'aria-expanded': true, 'aria-controls': 'lb' });
    expect(comboboxAria(true, 'lb', 'lb-opt-2')).toEqual({ 'aria-expanded': true, 'aria-controls': 'lb', 'aria-activedescendant': 'lb-opt-2' });
  });
});

describe('TypeaheadSelect id resolution (review P2)', () => {
  const choices: TypeaheadChoice[] = [
    { id: 'a6300', label: '6300 – Office Supplies', terms: ['6300', 'Office Supplies'] },
    { id: 'a6600', label: '6600 – Utilities', terms: ['6600', 'Utilities'] },
    { id: 'c2', label: 'Twin Name' },
    { id: 'c3', label: 'Twin Name' },
  ];

  it('maps choices to options that carry the id and finds the label of an id', () => {
    expect(choicesToOptions(choices)[0]).toMatchObject({ id: 'a6300', value: '6300 – Office Supplies', terms: ['6300', 'Office Supplies'] });
    expect(labelForId(choices, 'a6600')).toBe('6600 – Utilities');
    expect(labelForId(choices, '')).toBe('');
    expect(labelForId(choices, 'gone')).toBe('');
  });

  it('typing an account number or a full name and leaving the field picks it', () => {
    expect(resolveTypedChoice(choices, '6600', '')).toBe('a6600');
    expect(resolveTypedChoice(choices, ' office supplies ', 'a6600')).toBe('a6300');
  });

  it('erasing the text clears the choice; partial or unknown text keeps the current one', () => {
    expect(resolveTypedChoice(choices, '   ', 'a6300')).toBe('');
    expect(resolveTypedChoice(choices, 'Offi', 'a6300')).toBe('a6300');
    expect(resolveTypedChoice(choices, 'nope', '')).toBe('');
  });

  it('a label shared by two records keeps the current one and never guesses', () => {
    expect(resolveTypedChoice(choices, 'Twin Name', 'c3')).toBe('c3');
    expect(resolveTypedChoice(choices, 'Twin Name', '')).toBe('');
  });
});

describe('transaction line grids use the find-as-you-type picker (review P2)', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  it.each([
    ['app/bills/page.tsx', ['item', 'account']],
    ['app/expenses/page.tsx', ['item', 'account', 'class', 'customer']],
    ['app/journal/page.tsx', ['account', 'name', 'class']],
    ['components/PricedLinesEditor.tsx', ['item', 'class']],
  ])('%s line pickers are TypeaheadSelect', (file, cols) => {
    const src = read(...file.split('/'));
    for (const c of cols) {
      const opener = '<TypeaheadSelect';
      const label = 'aria-label={`Line ${idx + 1} ' + c + '`}';
      const at = src.indexOf(label);
      expect(at, `${file}: ${c} picker`).toBeGreaterThan(0);
      // The aria-label belongs to a TypeaheadSelect (it is the first prop after the tag).
      expect(src.slice(src.lastIndexOf('<', at), at).trim()).toBe(opener);
    }
  });

  it('Typeahead keeps aria-expanded (grid / form shortcuts rely on it) and uses comboboxAria + initialHighlight', () => {
    const src = read('components', 'Typeahead.tsx');
    expect(src).toMatch(/\{\.\.\.comboboxAria\(expanded, listId/);
    expect(src).not.toMatch(/aria-controls=\{listId\}/);
    expect(src).toMatch(/initialHighlight\(filterTypeahead\(options, text, maxResults\), text, allowFreeText\)/);
  });

  it('Batch Enter Name column is free text for checks, card charges / credits and deposits', () => {
    const src = read('app', 'accountant', 'batch-enter', 'page.tsx');
    expect(src).toMatch(/FREE_TEXT_NAME_TYPES: BatchEnterType\[\] = \['check', 'cc_charge', 'cc_credit', 'deposit'\]/);
    expect(src).toMatch(/allowFreeText=\{c === 'name' && FREE_TEXT_NAME_TYPES\.includes\(type\)\}/);
  });
});
