/**
 * Keyboard-first data entry (team keyboard): pure logic behind the form shortcuts
 * (components/FormShortcuts.tsx), the line-grid keys (useGridKeys), text date cells and
 * access-key labels.
 */
import { describe, it, expect } from 'vitest';
import {
  FORM_KEY_HELP,
  GRID_KEY_HELP,
  type KeyLike,
  accessKeyParts,
  dateKeyForTextField,
  formShortcutFor,
  gridKeyAction,
  pickShortcutButton,
  shouldRunFormShortcut,
} from './shortcuts';
import { normalizeDate } from './services/accountant/batchEnterParse';

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('formShortcutFor', () => {
  it('maps the QB form keys', () => {
    expect(formShortcutFor(k('n', { ctrlKey: true }))).toBe('new');
    expect(formShortcutFor(k('N', { ctrlKey: true }))).toBe('new');
    expect(formShortcutFor(k('s', { ctrlKey: true }))).toBe('save');
    expect(formShortcutFor(k('s', { metaKey: true }))).toBe('save'); // Cmd on a Mac
    expect(formShortcutFor(k('s', { ctrlKey: true, altKey: true }))).toBe('save-new');
    expect(formShortcutFor(k('Enter', { ctrlKey: true }))).toBe('save-new');
    expect(formShortcutFor(k('Escape'))).toBe('cancel');
  });

  it('uses the physical key when Ctrl+Alt turns S into another character (AltGr layouts)', () => {
    expect(formShortcutFor(k('ś', { ctrlKey: true, altKey: true, code: 'KeyS' }))).toBe('save-new');
  });

  it('leaves everything else alone', () => {
    expect(formShortcutFor(k('s'))).toBeNull();
    expect(formShortcutFor(k('n'))).toBeNull();
    expect(formShortcutFor(k('Enter'))).toBeNull(); // plain Enter belongs to "Enter moves between fields"
    expect(formShortcutFor(k('s', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(formShortcutFor(k('Escape', { shiftKey: true }))).toBeNull();
    expect(formShortcutFor(k('i', { ctrlKey: true }))).toBeNull(); // navigation shortcut, not a form one
  });
});

describe('shouldRunFormShortcut', () => {
  const base = { dialogOpen: false, pickerOpen: false };
  it('New only from a list page (no dialog open)', () => {
    expect(shouldRunFormShortcut('new', base)).toBe(true);
    expect(shouldRunFormShortcut('new', { ...base, dialogOpen: true })).toBe(false);
  });
  it('Save works inside fields and dialogs but not while a picker list is open', () => {
    expect(shouldRunFormShortcut('save', { ...base, dialogOpen: true })).toBe(true);
    expect(shouldRunFormShortcut('save-new', { ...base, dialogOpen: true })).toBe(true);
    expect(shouldRunFormShortcut('save', { ...base, pickerOpen: true })).toBe(false);
  });
  it('Esc is left to an open dialog or picker', () => {
    expect(shouldRunFormShortcut('cancel', base)).toBe(true);
    expect(shouldRunFormShortcut('cancel', { ...base, dialogOpen: true })).toBe(false);
    expect(shouldRunFormShortcut('cancel', { ...base, pickerOpen: true })).toBe(false);
  });
  it('never during IME composition', () => {
    expect(shouldRunFormShortcut('save', { ...base, composing: true })).toBe(false);
  });
});

describe('pickShortcutButton', () => {
  const bill = [{ label: 'Memorize' }, { label: 'Cancel' }, { label: 'Save Bill' }];

  it('finds Save / Cancel by label in a form footer', () => {
    expect(pickShortcutButton(bill, 'save')).toBe(2);
    expect(pickShortcutButton(bill, 'cancel')).toBe(1);
    expect(pickShortcutButton(bill, 'save-new')).toBe(-1); // → save, then open a new form
  });

  it('prefers a real Save over Save & New for Ctrl+S, and Save & New for Ctrl+Alt+S', () => {
    const b = [{ label: 'Save & New' }, { label: 'Save & Close' }];
    expect(pickShortcutButton(b, 'save')).toBe(1);
    expect(pickShortcutButton(b, 'save-new')).toBe(0);
    expect(pickShortcutButton([{ label: 'Save and new' }], 'save')).toBe(0); // only choice
  });

  it('accepts Record / Create style labels, skips disabled buttons', () => {
    expect(pickShortcutButton([{ label: 'Record Deposit' }], 'save')).toBe(0);
    expect(pickShortcutButton([{ label: 'Save', disabled: true }, { label: 'Create invoice' }], 'save')).toBe(1);
  });

  it('New: "New …" beats "Add …"; first in page order wins', () => {
    const b = [{ label: 'Pay Bills' }, { label: 'Add note' }, { label: 'New Bill' }, { label: 'New Bill' }];
    expect(pickShortcutButton(b, 'new')).toBe(2);
    expect(pickShortcutButton([{ label: '+ New' }], 'new')).toBe(0);
  });

  it('an explicit data-shortcut wins over any label', () => {
    const b = [{ label: 'Save' }, { label: 'Post all rows', shortcut: 'save' }];
    expect(pickShortcutButton(b, 'save')).toBe(1);
    expect(pickShortcutButton([{ label: 'Save', shortcut: 'cancel' }], 'save')).toBe(-1);
  });

  it('unique: does nothing when several unrelated Save buttons tie', () => {
    const b = [{ label: 'Save Company Info' }, { label: 'Save Accounting' }];
    expect(pickShortcutButton(b, 'save', { unique: true })).toBe(-1);
    expect(pickShortcutButton([b[0]], 'save', { unique: true })).toBe(0);
  });
});

describe('gridKeyAction (line grids)', () => {
  const text = { tag: 'INPUT', type: 'text' };
  it('Ctrl+Insert inserts; Ctrl+D and Ctrl+Delete delete the line', () => {
    expect(gridKeyAction(k('Insert', { ctrlKey: true }), text)).toBe('insert');
    expect(gridKeyAction(k('d', { ctrlKey: true }), text)).toBe('remove');
    expect(gridKeyAction(k('Delete', { ctrlKey: true }), { tag: 'SELECT' })).toBe('remove');
  });

  it('Enter and Down go to the next line; Up to the previous one', () => {
    expect(gridKeyAction(k('Enter'), text)).toBe('next');
    expect(gridKeyAction(k('Enter'), { tag: 'SELECT' })).toBe('next');
    expect(gridKeyAction(k('ArrowDown'), text)).toBe('next');
    expect(gridKeyAction(k('ArrowUp'), text)).toBe('prev');
  });

  it('leaves keys to controls that own them', () => {
    expect(gridKeyAction(k('Enter'), { tag: 'TEXTAREA' })).toBeNull();
    expect(gridKeyAction(k('Enter'), { tag: 'BUTTON' })).toBeNull();
    expect(gridKeyAction(k('Enter'), { ...text, expanded: true })).toBeNull(); // open picker list
    expect(gridKeyAction(k('ArrowDown'), { ...text, expanded: true })).toBeNull();
    expect(gridKeyAction(k('ArrowDown'), { tag: 'SELECT' })).toBeNull(); // changes the choice
    expect(gridKeyAction(k('ArrowDown'), { tag: 'INPUT', type: 'date' })).toBeNull();
    expect(gridKeyAction(k('ArrowDown'), { tag: 'INPUT', type: 'number' })).toBeNull();
    expect(gridKeyAction(k('ArrowDown'), { ...text, hasList: true })).toBeNull(); // datalist
    expect(gridKeyAction(k('Enter', { shiftKey: true }), text)).toBeNull();
    expect(gridKeyAction(k('Tab'), text)).toBeNull(); // browser default: next cell
    expect(gridKeyAction(k('s', { ctrlKey: true }), text)).toBeNull(); // form save, not a grid key
  });
});

describe('dateKeyForTextField (+ / - / T in typed date cells)', () => {
  it('moves a complete date a day at a time', () => {
    expect(dateKeyForTextField('+', '2026-03-05', normalizeDate)).toBe('2026-03-06');
    expect(dateKeyForTextField('-', '3/1/2026', normalizeDate)).toBe('2026-02-28');
    expect(dateKeyForTextField('=', '12/31/26', normalizeDate)).toBe('2027-01-01');
  });
  it('T is today, also in an empty cell', () => {
    expect(dateKeyForTextField('t', '', normalizeDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dateKeyForTextField('T', '2026-03-05', normalizeDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('never hijacks a date being typed', () => {
    expect(dateKeyForTextField('-', '2026', normalizeDate)).toBeNull();
    expect(dateKeyForTextField('-', '2026-03', normalizeDate)).toBeNull();
    expect(dateKeyForTextField('5', '2026-03-0', normalizeDate)).toBeNull();
    expect(dateKeyForTextField('Backspace', '2026-03-05', normalizeDate)).toBeNull();
  });
});

describe('accessKeyParts', () => {
  it('underlines the first word-initial match, else any match', () => {
    expect(accessKeyParts('Save transactions', 's')).toEqual({ before: '', letter: 'S', after: 'ave transactions' });
    expect(accessKeyParts('Paste from Excel', 'e')).toEqual({ before: 'Paste from ', letter: 'E', after: 'xcel' });
    expect(accessKeyParts('Check rows', 'k')).toEqual({ before: 'Chec', letter: 'k', after: ' rows' });
    expect(accessKeyParts('Save', 'z')).toBeNull();
  });
});

describe('help tables', () => {
  it('list the form and grid keys shown in the "?" overlay', () => {
    const form = FORM_KEY_HELP.map((r) => r.keys).join(' | ');
    for (const s of ['Ctrl+N', 'Ctrl+S', 'Ctrl+Alt+S / Ctrl+Enter', 'Esc']) expect(form).toContain(s);
    const grid = GRID_KEY_HELP.map((r) => r.keys).join(' | ');
    for (const s of ['Ctrl+Insert', 'Ctrl+D', 'Enter / Down', 'Tab']) expect(grid).toContain(s);
  });
});
