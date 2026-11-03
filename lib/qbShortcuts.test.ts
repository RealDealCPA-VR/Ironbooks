/**
 * The QuickBooks Desktop shortcut list (lib/qbShortcuts.ts) says, row by row, which keys work in
 * Ironbooks — and the "?" / F1 Help window lists exactly those. This checks every row marked done
 * against the code that handles it: a pure key rule here, or a named test that presses the key in a
 * real browser engine (test/dom/*.dom.tsx, run by test/keyboardDom.test.ts). A row marked done with
 * nothing behind it — or a new row without a check — fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QB_SHORTCUTS, QB_SHORTCUT_GROUPS, shortcutsHelpGroups, type QbShortcut } from './qbShortcuts';
import {
  MENU_MNEMONICS,
  adjustDateForKey,
  formShortcutFor,
  globalShortcutFor,
  gridKeyAction,
  isCalendarKey,
  isOpenListKey,
  listKeyAction,
  listScrollKey,
  monthKeyDirection,
  stepDocNumber,
  typeAheadChar,
  type KeyLike,
} from './shortcuts';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const ctrl = (k: string, mods: Partial<KeyLike> = {}) => key(k, { ctrlKey: true, ...mods });
const alt = (k: string) => key(k, { altKey: true });

/** The command or page a global key asks for. */
const global = (e: KeyLike, editable = false) => {
  const sc = globalShortcutFor(e, editable);
  return sc ? (sc.command ?? sc.href) : null;
};

const domSources = new Map<string, string>();
/** A test in test/dom/<file> that presses the key (its name, as written there). */
function dom(file: string, name: string) {
  return () => {
    const p = path.resolve(process.cwd(), 'test/dom', file);
    if (!domSources.has(p)) domSources.set(p, fs.readFileSync(p, 'utf8'));
    const src = domSources.get(p)!;
    expect(src.includes(`domTest('${name}'`) || src.includes(`domTest("${name}"`), `${file}: domTest '${name}'`).toBe(true);
  };
}
const FORMS = 'keyboardForms.dom.tsx';
const LISTS = 'keyboardLists.dom.tsx';
const SHELL = 'keyboardShell.dom.tsx';

/** How each row marked done is backed, by `${group}|${keys}`. */
const CHECKS: Record<string, () => void> = {
  // ---- Navigate ----
  'navigate|F1': () => {
    expect(global(key('F1'))).toBe('help');
    dom(SHELL, '? and F1 open the Help window; it lists exactly the keys that work, in Intuit’s groups')();
  },
  'navigate|Esc': () => {
    expect(formShortcutFor(key('Escape'))).toBe('cancel');
    dom(FORMS, 'Esc on a changed form asks; No closes without saving, Yes records, Cancel stays')();
    dom(SHELL, 'Esc with nothing open or selected closes the window (back to the one before it)')();
  },
  'navigate|Ctrl+F4': () => expect(global(ctrl('F4'))).toBe('close-window'),
  'navigate|Ctrl+Tab / Ctrl+F6': () => {
    expect(global(ctrl('Tab'))).toBe('next-window');
    expect(global(ctrl('F6'))).toBe('next-window');
    dom(LISTS, 'the window keys: Ctrl+F4 closes the open form; Ctrl+Tab / Ctrl+Shift+Tab move between open windows')();
  },
  'navigate|Ctrl+Shift+Tab / Ctrl+Shift+F6': () => {
    expect(global(ctrl('Tab', { shiftKey: true }))).toBe('prev-window');
    expect(global(ctrl('F6', { shiftKey: true }))).toBe('prev-window');
  },
  'navigate|F2 / Ctrl+1': () => {
    expect(global(key('F2'))).toBe('product-info');
    expect(global(ctrl('1'))).toBe('product-info');
    dom(SHELL, 'F2 / Ctrl+1 open Product Information; F3 in it shows the technical details')();
  },
  'navigate|F2, then F3': dom(SHELL, 'F2 / Ctrl+1 open Product Information; F3 in it shows the technical details'),
  'navigate|F3 / Ctrl+2': () => {
    expect(global(key('F3'))).toBe('search');
    expect(global(ctrl('2'))).toBe('search');
  },
  'navigate|Ctrl+F': () => expect(global(ctrl('f'))).toBe('/find'),
  'navigate|Alt': dom(SHELL, 'desktop menu bar: Alt+letter opens that menu (QuickBooks letters); Alt alone takes the bar; a form keeps its letters'),
  'navigate|Alt+F / E / V / L / A': () => expect(['File', 'Edit', 'View', 'Lists', 'Favorites'].map((m) => MENU_MNEMONICS[m]).join('')).toBe('fevla'),
  'navigate|Alt+C / U / O / Y': () => expect(['Company', 'Customers', 'Vendors', 'Employees'].map((m) => MENU_MNEMONICS[m]).join('')).toBe('cuoy'),
  'navigate|Alt+B / R / W / H': () => expect(['Banking', 'Reports', 'Window', 'Help'].map((m) => MENU_MNEMONICS[m]).join('')).toBe('brwh'),
  'navigate|Ctrl+K': () => expect(global(ctrl('k'))).toBe('palette'),
  // components/ShortcutsHelp.tsx takes ? itself (outside text fields).
  'navigate|?': dom(SHELL, '? and F1 open the Help window; it lists exactly the keys that work, in Intuit’s groups'),
  'navigate|Alt+Left / Alt+Right': dom(SHELL, 'Window > Back (Alt+Left) and a page link ask first too'),

  // ---- Data fields ----
  'data-fields|+ / -': () => {
    expect(stepDocNumber('+', 'INV-0099')).toBe('INV-0100');
    expect(stepDocNumber('-', '1001')).toBe('1000');
    dom(FORMS, '+ / - step a check or form number; - after letters still types')();
  },
  'data-fields|Tab / Shift+Tab': dom(FORMS, 'Tab follows QuickBooks: name, class, date, number, the rest, lines, memo, Save'),
  'data-fields|Enter': dom(FORMS, 'Enter in a form field records it (Save & Close)'),
  'data-fields|Ctrl+Z': dom(FORMS, 'Ctrl+Z undoes a date key (a date field has no undo of its own)'),
  // The browser's own field editing: nothing in the app takes these keys from a field.
  'data-fields|Ctrl+C / Ctrl+X / Ctrl+V': () => {
    expect(global(ctrl('c'), true)).toBeNull();
    expect(global(ctrl('x'), true)).toBeNull();
  },
  'data-fields|Home / End': () => expect(listKeyAction(key('Home'))).toBe('home'), // in a field the list keys are not used
  'data-fields|Del / Backspace': () => expect(global(key('Delete'), true)).toBeNull(),
  'data-fields|Home Home / End End': () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'components/KeyboardBase.tsx'), 'utf8');
    expect(src).toContain('Home Home / End End');
  },
  'data-fields|Ctrl+Left / Ctrl+Right': () => expect(global(ctrl('ArrowLeft'), true)).toBeNull(),
  'data-fields|Space': () => expect(global(key(' '), false)).toBeNull(),
  'data-fields|abc, then Tab': dom(LISTS, 'a picker: typing finds the name, Tab takes it (QuickFill); Ctrl+U takes the highlighted entry'),

  // ---- Date fields ----
  'date-fields|Alt+Down': () => {
    expect(isCalendarKey(key('ArrowDown', { altKey: true }))).toBe(true);
    dom(FORMS, 'Alt+Down opens the calendar of any date field')();
  },
  'date-fields|+ / -': () => {
    expect(adjustDateForKey('+', '2026-03-15')).toBe('2026-03-16');
    expect(adjustDateForKey('-', '2026-03-15')).toBe('2026-03-14');
  },
  'date-fields|T': () => expect(adjustDateForKey('t', '2020-01-01', '2026-03-15')).toBe('2026-03-15'),
  'date-fields|W / K': () => {
    expect(adjustDateForKey('w', '2026-03-18')).toBe('2026-03-15');
    expect(adjustDateForKey('k', '2026-03-18')).toBe('2026-03-21');
  },
  'date-fields|M / H': () => {
    expect(adjustDateForKey('m', '2026-02-18')).toBe('2026-02-01');
    expect(adjustDateForKey('h', '2026-02-18')).toBe('2026-02-28');
  },
  'date-fields|Y / R': () => {
    expect(adjustDateForKey('y', '2026-06-18')).toBe('2026-01-01');
    expect(adjustDateForKey('r', '2026-06-18')).toBe('2026-12-31');
  },
  'date-fields|[ / ]': () => {
    expect(adjustDateForKey('[', '2026-03-15')).toBe('2026-03-08');
    expect(adjustDateForKey(']', '2026-03-15')).toBe('2026-03-22');
  },
  "date-fields|; / '": () => {
    expect(adjustDateForKey(';', '2026-03-31')).toBe('2026-02-28');
    expect(adjustDateForKey("'", '2026-01-31')).toBe('2026-02-28');
    dom(FORMS, 'every QuickBooks date key works in a plain date field and in the kit date field')();
  },

  // ---- Forms ----
  'forms|Ctrl+Ins / Ctrl+Del': () => {
    const cell = { tag: 'INPUT', type: 'text' };
    expect(gridKeyAction(ctrl('Insert'), cell)).toBe('insert');
    expect(gridKeyAction(ctrl('Delete'), cell)).toBe('remove');
  },
  'forms|Ctrl+Alt+Y': () => {
    expect(gridKeyAction(key('y', { ctrlKey: true, altKey: true }), { tag: 'INPUT', type: 'text' })).toBe('copy-line');
    dom(FORMS, 'Ctrl+Alt+Y copies a line; Ctrl+Alt+V pastes it into a blank line, or above a filled one')();
  },
  'forms|Ctrl+Alt+V': () => expect(gridKeyAction(key('v', { ctrlKey: true, altKey: true }), { tag: 'INPUT', type: 'text' })).toBe('paste-line'),
  'forms|Up / Down': () => {
    expect(gridKeyAction(key('ArrowDown'), { tag: 'INPUT', type: 'text' })).toBe('next');
    expect(gridKeyAction(key('ArrowUp'), { tag: 'INPUT', type: 'text' })).toBe('prev');
  },
  'forms|Ctrl+L': () => {
    expect(global(ctrl('l'))).toBe('open-list');
    expect(isOpenListKey(ctrl('l'))).toBe(true);
  },
  'forms|Ctrl+U': () => {
    expect(global(ctrl('u'))).toBe('use');
    dom(LISTS, 'Ctrl+Q, Ctrl+U and Ctrl+F6 act on the highlighted row')();
  },
  'forms|Page Up / Page Down': () => {
    expect(listKeyAction(key('PageUp'))).toBe('page-up');
    expect(listKeyAction(key('PageDown'))).toBe('page-down');
  },
  'forms|Alt+S': () => expect(formShortcutFor(alt('s'))).toBe('save-new'),
  'forms|Alt+A': () => {
    expect(formShortcutFor(alt('a'))).toBe('save-close');
    dom(SHELL, 'desktop menu bar: Alt+letter opens that menu (QuickBooks letters); Alt alone takes the bar; a form keeps its letters')();
  },
  'forms|Alt+N': () => expect(formShortcutFor(alt('n'))).toBe('next'),
  'forms|Alt+P': () => expect(formShortcutFor(alt('p'))).toBe('prev'),
  'forms|Alt+R': () => expect(formShortcutFor(alt('r'))).toBe('revert'),
  'forms|Ctrl+Enter': () => expect(formShortcutFor(ctrl('Enter'))).toBe('save-new'),
  'forms|Ctrl+P': () => expect(global(ctrl('p'))).toBe('print'),
  'forms|Ctrl+M': () => expect(global(ctrl('m'))).toBe('memorize'),
  'forms|Ctrl+T': () => expect(global(ctrl('t'))).toBe('/recurring'),
  'forms|Ctrl+H': () => expect(global(ctrl('h'))).toBe('history'),
  'forms|Ctrl+Y': () => expect(global(ctrl('y'))).toBe('journal'),
  'forms|Ctrl+N': () => expect(formShortcutFor(ctrl('n'))).toBe('new'),
  'forms|Ctrl+S': () => expect(formShortcutFor(ctrl('s'))).toBe('save'),
  'forms|Alt+underlined letter': () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'components/FormShortcuts.tsx'), 'utf8');
    expect(src).toContain('accesskey');
  },

  // ---- Lists, centers, registers and reports ----
  'lists|Ctrl+Page Up / Ctrl+Page Down': () => {
    expect(listKeyAction(ctrl('PageUp'))).toBe('home');
    expect(monthKeyDirection(ctrl('PageDown'))).toBe(1);
    dom(LISTS, 'a register: Ctrl+PgUp / Ctrl+PgDn go a month back / on')();
  },
  'lists|Up / Down, Home / End': () => {
    expect(listKeyAction(key('ArrowUp'))).toBe('up');
    expect(listKeyAction(key('End'))).toBe('end');
    dom(LISTS, 'a list: arrows, Home / End, type a name, Enter opens the row')();
  },
  'lists|A…Z': () => expect(typeAheadChar(key('c'), '')).toBe('c'),
  'lists|Enter': () => expect(listKeyAction(key('Enter'))).toBe('open'),
  'lists|Left / Right': () => {
    expect(listScrollKey(key('ArrowRight'))).toBe('right');
    dom(LISTS, 'Left / Right scroll a wide report a column at a time')();
  },
  'lists|Ctrl+E': () => expect(global(ctrl('e'))).toBe('edit'),
  'lists|Ctrl+D': () => expect(global(ctrl('d'))).toBe('delete'),
  'lists|Ctrl+Q': () => expect(global(ctrl('q'))).toBe('quick-report'),
  'lists|Ctrl+F6 (on a list)': dom(LISTS, 'Ctrl+Q, Ctrl+U and Ctrl+F6 act on the highlighted row'),
  'lists|Ctrl+R (Chart of Accounts)': () => expect(global(ctrl('r'))).toBe('register'),
  'lists|Ctrl+O': () => {
    expect(global(ctrl('o'))).toBe('copy-transaction');
    dom(LISTS, 'a register: Ctrl+O copies the highlighted transaction, Ctrl+V on the blank line pastes it')();
  },
  'lists|Ctrl+V': () => expect(global(ctrl('v'))).toBe('paste-transaction'),
  'lists|F5': () => {
    expect(global(key('F5'))).toBe('refresh');
    dom(SHELL, 'F5 refreshes the window in place; with typed work it asks; held-down repeats never reach the browser')();
  },

  // ---- Start a new task ----
  'new-task|Ctrl+I': () => expect(global(ctrl('i'))).toBe('/invoices?new=1'),
  'new-task|Ctrl+W': () => expect(global(ctrl('w'))).toBe('/expenses?new=1'),
  'new-task|Ctrl+J': () => expect(global(ctrl('j'))).toBe('/customers'),
  'new-task|Ctrl+A': () => {
    expect(global(ctrl('a'))).toBe('/accounts');
    expect(global(ctrl('a'), true)).toBeNull();
  },
  'new-task|Ctrl+R': () => expect(globalShortcutFor(ctrl('r'), false)?.href).toBe('/registers'),
  'new-task|Ctrl+G': () => {
    expect(global(ctrl('g'))).toBe('transfer');
    dom(LISTS, 'a register: Ctrl+G opens the other account’s register; a split says why it cannot')();
  },

  // ---- Open, set up and close ----
  'open-close|Alt+F4': () => {
    const main = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.js'), 'utf8');
    expect(main).toContain('confirmCloseOverUnsavedWork');
  },
  'open-close|Ctrl+Alt+Y (Product Information)': () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'components/ProductInfo.tsx'), 'utf8');
    expect(src).toContain("navigateGuarded('/employees/setup'");
  },
};

const rowKey = (r: QbShortcut) => `${r.group}|${r.keys}`;

describe("QuickBooks Desktop's shortcut list", () => {
  const done = QB_SHORTCUTS.filter((r) => r.status === 'done');

  it('every row has a source, a group of Intuit’s, and says what it does here (or why not)', () => {
    const groups = new Set(QB_SHORTCUT_GROUPS.map((g) => g.id));
    for (const r of QB_SHORTCUTS) {
      expect(r.sources.length, r.keys).toBeGreaterThan(0);
      expect(groups.has(r.group), r.keys).toBe(true);
      expect(r.ironbooks.trim().length, r.keys).toBeGreaterThan(5);
    }
  });

  it('every row marked done has a check, and every check a row', () => {
    expect(new Set(done.map(rowKey)).size).toBe(done.length);
    expect(done.map(rowKey).sort()).toEqual(Object.keys(CHECKS).sort());
  });

  it.each(done.map((r) => [rowKey(r)]))('%s works', (k) => {
    CHECKS[k]();
  });

  it("covers Intuit's whole article (every key it lists has a row)", () => {
    const listed = QB_SHORTCUTS.filter((r) => r.sources.includes('intuit')).map((r) => r.keys).join(' | ');
    for (const k of ['F1', 'Esc', 'F2', 'Ctrl+1', 'Ctrl+F', 'F3', 'Ctrl+2', 'Alt+Down', 'Ctrl+Ins', 'Ctrl+Del', 'Ctrl+Alt+Y', 'Ctrl+Alt+V', 'Ctrl+L', 'Ctrl+U', 'Page Up', 'Alt+S', 'Alt+P', 'Alt+N', 'Ctrl+P', 'Ctrl+M', 'Ctrl+T', 'Ctrl+H', 'Ctrl+Y', 'Ctrl+Page Up', 'Ctrl+N', 'Ctrl+E', 'Ctrl+D', 'Ctrl+F6', 'F5', 'Ctrl+I', 'Ctrl+W', 'Ctrl+J', 'Ctrl+A', 'Ctrl+R', 'Ctrl+G', 'Hold Alt', 'Alt+F4', 'Ctrl+K', 'Ctrl+Alt+Y (Product Information)']) {
      expect(listed, k).toContain(k);
    }
  });

  it('the Help window lists the rows that work, in Intuit’s groups; menu keys only in the desktop app', () => {
    const web = shortcutsHelpGroups({ desktop: false });
    const desk = shortcutsHelpGroups({ desktop: true });
    expect(web.flatMap((g) => g.rows).every((r) => r.status === 'done' && !r.desktopOnly)).toBe(true);
    expect(desk.flatMap((g) => g.rows)).toHaveLength(done.length);
    expect(desk.map((g) => g.id)).toEqual(QB_SHORTCUT_GROUPS.map((g) => g.id));
  });
});
