/**
 * QuickBooks Desktop key parity (lib/shortcuts.ts): the global keys (globalShortcutFor), + / - in
 * document number fields (stepDocNumber), the list keys and QB type-ahead behind useListKeys,
 * the row / form commands (pickCommandButton), Ctrl+L / Alt+Down and QuickReport links.
 */
import { describe, expect, it } from 'vitest';
import {
  DATE_KEY_HELP,
  FORM_ALT_KEYS,
  GLOBAL_SHORTCUTS,
  LIST_KEY_HELP,
  NUMBER_KEY_HELP,
  type KeyLike,
  altLetter,
  globalShortcutFor,
  isListRow,
  isOpenListKey,
  listKeyAction,
  nextListIndex,
  pickCommandButton,
  quickReportHref,
  stepDocNumber,
  typeAheadChar,
  typeAheadMatch,
} from './shortcuts';
import { paletteDestinations } from './nav';

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const ctrl = (key: string, mods: Partial<KeyLike> = {}) => k(key, { ctrlKey: true, ...mods });

describe('globalShortcutFor (QB global keys)', () => {
  it('Ctrl+W Write Checks, Ctrl+I Invoices, Ctrl+J Customer Center, Ctrl+A Chart of Accounts', () => {
    expect(globalShortcutFor(ctrl('w'), false)?.href).toBe('/expenses?new=1');
    expect(globalShortcutFor(ctrl('i'), false)?.href).toBe('/invoices?new=1');
    expect(globalShortcutFor(ctrl('j'), false)?.href).toBe('/customers');
    expect(globalShortcutFor(ctrl('a'), false)?.href).toBe('/accounts');
  });

  it('Ctrl+R Use Register, Ctrl+T Memorized Transactions, Ctrl+F Find', () => {
    expect(globalShortcutFor(ctrl('r'), false)?.href).toBe('/registers');
    expect(globalShortcutFor(ctrl('t'), false)?.href).toBe('/recurring');
    expect(globalShortcutFor(ctrl('f'), false)?.href).toBe('/find');
  });

  it('Ctrl+E / D / P / Y / H / Q / L / M / K and F1 are commands', () => {
    const cmd = (e: KeyLike) => globalShortcutFor(e, false)?.command;
    expect(cmd(ctrl('e'))).toBe('edit');
    expect(cmd(ctrl('d'))).toBe('delete');
    expect(cmd(ctrl('p'))).toBe('print');
    expect(cmd(ctrl('y'))).toBe('journal');
    expect(cmd(ctrl('h'))).toBe('history');
    expect(cmd(ctrl('q'))).toBe('quick-report');
    expect(cmd(ctrl('l'))).toBe('open-list');
    expect(cmd(ctrl('m'))).toBe('memorize');
    expect(cmd(ctrl('k'))).toBe('palette');
    expect(cmd(k('F1'))).toBe('help');
  });

  it('Cmd on a Mac and capital letters work; Shift / Alt combos and unknown keys do not', () => {
    expect(globalShortcutFor(k('w', { metaKey: true }), false)?.href).toBe('/expenses?new=1');
    expect(globalShortcutFor(ctrl('W'), false)?.href).toBe('/expenses?new=1');
    expect(globalShortcutFor(ctrl('w', { shiftKey: true }), false)).toBeNull();
    expect(globalShortcutFor(ctrl('w', { altKey: true }), false)).toBeNull();
    expect(globalShortcutFor(ctrl('b'), false)).toBeNull();
    expect(globalShortcutFor(ctrl('Enter'), false)).toBeNull();
    expect(globalShortcutFor(k('w'), false)).toBeNull(); // a plain letter is never global
    expect(globalShortcutFor(k('F1', { ctrlKey: true }), false)).toBeNull();
  });

  it('uses the physical key on non-Latin layouts (Ctrl+Ц is Ctrl+W)', () => {
    expect(globalShortcutFor(ctrl('ц', { code: 'KeyW' }), false)?.href).toBe('/expenses?new=1');
    // A Latin letter wins over its physical position (Dvorak / AZERTY users press the letter).
    expect(globalShortcutFor(ctrl('j', { code: 'KeyC' }), false)?.href).toBe('/customers');
  });

  it('Ctrl combos work from inside fields, like QB — except Ctrl+A (select all) and list-only keys', () => {
    expect(globalShortcutFor(ctrl('w'), true)?.href).toBe('/expenses?new=1');
    expect(globalShortcutFor(ctrl('i'), true)?.href).toBe('/invoices?new=1');
    expect(globalShortcutFor(ctrl('d'), true)?.command).toBe('delete');
    expect(globalShortcutFor(ctrl('l'), true)?.command).toBe('open-list');
    expect(globalShortcutFor(ctrl('a'), true)).toBeNull();
    expect(globalShortcutFor(ctrl('e'), true)).toBeNull();
    expect(globalShortcutFor(ctrl('q'), true)).toBeNull();
    expect(globalShortcutFor(k('F1'), true)?.command).toBe('help');
  });

  it('every navigation key opens a real page', () => {
    const paths = new Set(paletteDestinations.map((d) => d.href));
    for (const s of GLOBAL_SHORTCUTS.filter((d) => d.href)) {
      expect(paths.has(s.href!.split('?')[0]), s.keys).toBe(true);
    }
  });

  it('the help rows name each key once', () => {
    const keys = GLOBAL_SHORTCUTS.map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    const named = GLOBAL_SHORTCUTS.map((s) => s.key).filter(Boolean);
    expect(new Set(named).size).toBe(named.length);
  });
});

describe('stepDocNumber (+ / - in check and invoice number fields)', () => {
  it('steps a plain number', () => {
    expect(stepDocNumber('+', '1001')).toBe('1002');
    expect(stepDocNumber('=', '1001')).toBe('1002'); // unshifted + key
    expect(stepDocNumber('-', '1001')).toBe('1000');
    expect(stepDocNumber('+', '999')).toBe('1000');
  });

  it('keeps a prefix and zero padding', () => {
    expect(stepDocNumber('+', 'INV-1001')).toBe('INV-1002');
    expect(stepDocNumber('+', 'INV-0099')).toBe('INV-0100');
    expect(stepDocNumber('-', 'INV-0100')).toBe('INV-0099');
    expect(stepDocNumber('-', '010')).toBe('009');
    expect(stepDocNumber('+', 'A9')).toBe('A10');
    expect(stepDocNumber('+', ' 42 ')).toBe('43');
  });

  it('never goes below zero', () => {
    expect(stepDocNumber('-', '0')).toBe('0');
    expect(stepDocNumber('-', 'CHK-000')).toBe('CHK-000');
  });

  it('lets the key type when the text does not end in digits, or for other keys', () => {
    expect(stepDocNumber('-', 'INV')).toBeNull(); // typing 'INV-'
    expect(stepDocNumber('+', '')).toBeNull();
    expect(stepDocNumber('-', '12A')).toBeNull();
    expect(stepDocNumber('5', '1001')).toBeNull();
    expect(stepDocNumber('ArrowUp', '1001')).toBeNull();
    expect(stepDocNumber('+', '1234567890123456')).toBeNull(); // too long to step safely
  });
});

describe('listKeyAction / nextListIndex (lists, centers, registers)', () => {
  it('maps the arrows, Home / End, PgUp / PgDn and Enter', () => {
    expect(listKeyAction(k('ArrowUp'))).toBe('up');
    expect(listKeyAction(k('ArrowDown'))).toBe('down');
    expect(listKeyAction(k('Home'))).toBe('home');
    expect(listKeyAction(k('End'))).toBe('end');
    expect(listKeyAction(k('PageUp'))).toBe('page-up');
    expect(listKeyAction(k('PageDown'))).toBe('page-down');
    expect(listKeyAction(k('Enter'))).toBe('open');
  });

  it('leaves modified keys and everything else alone', () => {
    expect(listKeyAction(k('ArrowDown', { altKey: true }))).toBeNull(); // Alt+Down opens pickers
    expect(listKeyAction(k('Enter', { ctrlKey: true }))).toBeNull(); // Ctrl+Enter is Save & New
    expect(listKeyAction(k('ArrowUp', { shiftKey: true }))).toBeNull();
    expect(listKeyAction(k('Tab'))).toBeNull();
    expect(listKeyAction(k('a'))).toBeNull();
  });

  it('moves one row, a page, or to either end, staying inside the list', () => {
    expect(nextListIndex('down', 2, 10)).toBe(3);
    expect(nextListIndex('down', 9, 10)).toBe(9);
    expect(nextListIndex('up', 2, 10)).toBe(1);
    expect(nextListIndex('up', 0, 10)).toBe(0);
    expect(nextListIndex('home', 5, 10)).toBe(0);
    expect(nextListIndex('end', 5, 10)).toBe(9);
    expect(nextListIndex('page-down', 2, 10, 4)).toBe(6);
    expect(nextListIndex('page-down', 8, 10, 4)).toBe(9);
    expect(nextListIndex('page-up', 6, 10, 4)).toBe(2);
    expect(nextListIndex('page-up', 1, 10, 4)).toBe(0);
  });

  it('with nothing highlighted, starts at the top (Down) or the bottom (Up: newest register line)', () => {
    expect(nextListIndex('down', -1, 5)).toBe(0);
    expect(nextListIndex('home', -1, 5)).toBe(0);
    expect(nextListIndex('page-down', -1, 5)).toBe(0);
    expect(nextListIndex('up', -1, 5)).toBe(4);
    expect(nextListIndex('end', -1, 5)).toBe(4);
    expect(nextListIndex('page-up', -1, 5)).toBe(4);
    expect(nextListIndex('down', 7, 5)).toBe(0); // a stale index after rows went away
    expect(nextListIndex('down', -1, 0)).toBe(-1);
  });
});

describe('QB type-ahead', () => {
  const names = [['Acme Corp'], ['Baker & Sons'], ['Bayside Cafe'], ['Brown, Joe'], ['#1001', 'Smith Co'], ["Joe's Diner"]];

  it('a word starts with a letter or digit; then spaces and punctuation continue it', () => {
    expect(typeAheadChar(k('b'), '')).toBe('b');
    expect(typeAheadChar(k('7'), '')).toBe('7');
    expect(typeAheadChar(k('É'), '')).toBe('É');
    expect(typeAheadChar(k('?'), '')).toBeNull(); // '?' still opens the shortcuts help
    expect(typeAheadChar(k(' '), '')).toBeNull(); // Space still scrolls
    expect(typeAheadChar(k(' '), 'joe')).toBe(' ');
    expect(typeAheadChar(k("'"), 'joe')).toBe("'");
    expect(typeAheadChar(k('a', { ctrlKey: true }), '')).toBeNull();
    expect(typeAheadChar(k('a', { altKey: true }), '')).toBeNull();
    expect(typeAheadChar(k('Enter'), 'jo')).toBeNull();
  });

  it('jumps to the first row starting with the typed word, ignoring case', () => {
    expect(typeAheadMatch(names, 'b', -1)).toBe(1);
    expect(typeAheadMatch(names, 'bay', -1)).toBe(2);
    expect(typeAheadMatch(names, 'BR', -1)).toBe(3);
    expect(typeAheadMatch(names, "joe's", -1)).toBe(5);
    expect(typeAheadMatch(names, 'zz', -1)).toBe(-1);
    expect(typeAheadMatch(names, '', -1)).toBe(-1);
    expect(typeAheadMatch([], 'a', -1)).toBe(-1);
  });

  it('matches any label of a row (number or name) and ignores a leading #', () => {
    expect(typeAheadMatch(names, '100', -1)).toBe(4);
    expect(typeAheadMatch(names, 'smi', -1)).toBe(4);
  });

  it('the same letter again walks the rows with that letter, wrapping around', () => {
    expect(typeAheadMatch(names, 'b', 1)).toBe(2);
    expect(typeAheadMatch(names, 'b', 3)).toBe(1);
    expect(typeAheadMatch(names, 'bb', 1)).toBe(2); // "bb" matches nothing: walk the B's
    expect(typeAheadMatch(names, 'bbb', 2)).toBe(3);
  });

  it('a longer word keeps the current row while it still matches', () => {
    expect(typeAheadMatch(names, 'ba', 1)).toBe(1);
    expect(typeAheadMatch(names, 'bay', 1)).toBe(2);
  });
});

describe('isListRow', () => {
  it('records are list rows; empty-state messages, hidden rows and entry rows are not', () => {
    expect(isListRow({ cells: 5 })).toBe(true);
    expect(isListRow({ cells: 1 })).toBe(true); // a one-column list
    expect(isListRow({ cells: 1, spansAll: true })).toBe(false); // "No customers yet"
    expect(isListRow({ cells: 5, hidden: true })).toBe(false);
    expect(isListRow({ cells: 8, editable: true })).toBe(false); // line grid / register entry row
    expect(isListRow({ cells: 0 })).toBe(false);
  });
});

describe('pickCommandButton (Enter / Ctrl+E / Ctrl+D / Ctrl+P)', () => {
  const customerRow = [{ label: 'Edit' }, { label: 'Deactivate' }];
  const invoiceRow = [{ label: 'PDF' }, { label: 'Packing Slip' }, { label: 'Edit' }, { label: 'Email' }, { label: 'Void' }];
  const listRow = [{ label: 'Edit Net 30' }, { label: 'Make inactive' }, { label: 'Delete Net 30' }];

  it('Ctrl+E presses Edit; Enter prefers Open / View, then Edit', () => {
    expect(pickCommandButton(customerRow, 'edit')).toBe(0);
    expect(pickCommandButton(invoiceRow, 'edit')).toBe(2);
    expect(pickCommandButton([{ label: 'Edit' }, { label: 'View' }], 'open')).toBe(1);
    expect(pickCommandButton(customerRow, 'open')).toBe(0);
    expect(pickCommandButton([{ label: 'Void' }], 'open')).toBe(-1);
  });

  it('Ctrl+D presses Delete, else Void / Discard, else Remove, else Make inactive / Deactivate', () => {
    expect(pickCommandButton(listRow, 'delete')).toBe(2);
    expect(pickCommandButton(invoiceRow, 'delete')).toBe(4);
    expect(pickCommandButton([{ label: 'Discard' }], 'delete')).toBe(0);
    expect(pickCommandButton([{ label: 'Remove' }, { label: 'Edit' }], 'delete')).toBe(0);
    expect(pickCommandButton(customerRow, 'delete')).toBe(1);
    expect(pickCommandButton([{ label: 'Edit' }], 'delete')).toBe(-1);
  });

  it("in a form, Ctrl+D is only the transaction's Delete / Void — never a line's Remove", () => {
    expect(pickCommandButton([{ label: 'Remove line 2' }, { label: 'Delete' }], 'delete', { scope: 'form' })).toBe(1);
    expect(pickCommandButton([{ label: 'Remove line 2' }], 'delete', { scope: 'form' })).toBe(-1);
    expect(pickCommandButton([{ label: 'Deactivate' }], 'delete', { scope: 'form' })).toBe(-1);
    expect(pickCommandButton([{ label: 'Void' }, { label: 'Void' }], 'delete', { scope: 'form', unique: true })).toBe(-1);
  });

  it('Ctrl+P presses Print, else a PDF button', () => {
    expect(pickCommandButton(invoiceRow, 'print')).toBe(0);
    expect(pickCommandButton([{ label: 'PDF' }, { label: 'Print' }], 'print')).toBe(1);
    expect(pickCommandButton([{ label: 'Print / send forms' }], 'print')).toBe(0);
    expect(pickCommandButton(customerRow, 'print')).toBe(-1);
  });

  it('skips disabled buttons; an explicit data-shortcut wins', () => {
    expect(pickCommandButton([{ label: 'Delete', disabled: true }, { label: 'Void' }], 'delete')).toBe(1);
    expect(pickCommandButton([{ label: 'Delete' }, { label: 'Trash', shortcut: 'delete' }], 'delete')).toBe(1);
    expect(pickCommandButton([{ label: 'Edit', shortcut: 'print' }], 'edit')).toBe(-1);
  });
});

describe('altLetter / FORM_ALT_KEYS / isOpenListKey', () => {
  it('altLetter reads Alt+letter only', () => {
    expect(altLetter(k('s', { altKey: true }))).toBe('s');
    expect(altLetter(k('S', { altKey: true }))).toBe('s');
    expect(altLetter(k('ß', { altKey: true, code: 'KeyS' }))).toBe('s');
    expect(altLetter(k('s', { altKey: true, ctrlKey: true }))).toBeNull();
    expect(altLetter(k('s'))).toBeNull();
    expect(altLetter(k('ArrowDown', { altKey: true }))).toBeNull();
  });

  it("QB's form letters: S Save & New, A Save & Close, R Revert, P / N Previous / Next", () => {
    expect(FORM_ALT_KEYS).toEqual({ s: 'save-new', a: 'save-close', r: 'revert', p: 'prev', n: 'next' });
  });

  it('Ctrl+L and Alt+Down open a picker list', () => {
    expect(isOpenListKey(ctrl('l'))).toBe(true);
    expect(isOpenListKey(ctrl('L'))).toBe(true);
    expect(isOpenListKey(k('l', { metaKey: true }))).toBe(true);
    expect(isOpenListKey(k('ArrowDown', { altKey: true }))).toBe(true);
    expect(isOpenListKey(k('ArrowDown'))).toBe(false);
    expect(isOpenListKey(k('l'))).toBe(false);
    expect(isOpenListKey(ctrl('l', { shiftKey: true }))).toBe(false);
    expect(isOpenListKey(ctrl('k'))).toBe(false);
  });
});

describe('quickReportHref (Ctrl+Q)', () => {
  it('opens Transaction Detail by Account for the name or account, all dates', () => {
    expect(quickReportHref('customer', 'c1')).toBe('/reports/std/transaction-detail-by-account?dates=all&customerId=c1');
    expect(quickReportHref('vendor', 'v 1')).toBe('/reports/std/transaction-detail-by-account?dates=all&vendorId=v%201');
    expect(quickReportHref('employee', 'e1')).toContain('employeeId=e1');
    expect(quickReportHref('account', 'a1')).toContain('accountId=a1');
  });
});

describe('help tables for the new keys', () => {
  it('document every date key', () => {
    const keys = DATE_KEY_HELP.map((r) => r.keys).join(' | ');
    for (const s of ['+ / -', 'T', 'W / K', 'M / H', 'Y / R', '[ / ]', "; / '"]) expect(keys).toContain(s);
  });

  it('document the list and number-field keys', () => {
    const list = LIST_KEY_HELP.map((r) => r.keys).join(' | ');
    for (const s of ['Up / Down', 'Home / End', 'PgUp / PgDn', 'Enter', 'Ctrl+E / Ctrl+D']) expect(list).toContain(s);
    expect(NUMBER_KEY_HELP.map((r) => r.keys)).toContain('+ / -');
  });
});
