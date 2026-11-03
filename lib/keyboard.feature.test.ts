/**
 * QuickBooks keyboard parity (feature round, team keyboard): the pure rules behind the keys.
 * The same keys pressed in a real browser engine: test/keyboardDom.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  accountRegisterHref,
  enterRecordsForm,
  globalShortcutFor,
  isEditableTarget,
  isFormField,
  leaveRisk,
  listScrollKey,
  menuForKey,
  menuForLetter,
  mightLoseWork,
  monthKeyDirection,
  nextColumnScroll,
  registerMonthIndex,
  type KeyLike,
} from './shortcuts';
import { listItemPrefill, normalizeFieldLabel, parseCopiedTransaction, qbFieldRole } from './keyboardTargets';
import { pickerKeyMove } from './menuKeys';
import { closeWindow, cycleWindow, parseWindowList, reopenHref, visitWindow, MAX_OPEN_WINDOWS } from './windowList';
import { companyRenameFrom } from './companyRename';
import { MAX_FAVORITES, resolveMyPreferences } from './preferences';
import { myPreferencesSchema } from './validation/prefs';
import { copyOfRow, registerAmount, transferHref } from '@/app/registers/[accountId]/registerView';
import { formatBytes } from '@/components/ProductInfo';
import { filterShortcutRows } from '@/components/ShortcutsHelp';
import { QB_SHORTCUTS } from './qbShortcuts';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const ctrl = (k: string, mods: Partial<KeyLike> = {}) => key(k, { ctrlKey: true, ...mods });

describe('the QuickBooks keys the app shell maps', () => {
  it.each([
    ['g', 'transfer'],
    ['o', 'copy-transaction'],
    ['v', 'paste-transaction'],
    ['u', 'use'],
    ['1', 'product-info'],
    ['2', 'search'],
  ])('Ctrl+%s → %s', (k, command) => {
    expect(globalShortcutFor(ctrl(k), false)?.command).toBe(command);
  });

  it('Ctrl+1 / Ctrl+2 by the physical key (AZERTY types & and é there)', () => {
    expect(globalShortcutFor(ctrl('&', { code: 'Digit1' }), false)?.command).toBe('product-info');
    expect(globalShortcutFor(ctrl('é', { code: 'Digit2' }), false)?.command).toBe('search');
  });

  it('the window keys: Ctrl+Tab / Ctrl+F6 next, with Shift previous, Ctrl+F4 close; F2, F3, F5', () => {
    expect(globalShortcutFor(ctrl('Tab'), false)?.command).toBe('next-window');
    expect(globalShortcutFor(ctrl('F6'), false)?.command).toBe('next-window');
    expect(globalShortcutFor(ctrl('Tab', { shiftKey: true }), false)?.command).toBe('prev-window');
    expect(globalShortcutFor(ctrl('F6', { shiftKey: true }), false)?.command).toBe('prev-window');
    expect(globalShortcutFor(ctrl('F4'), false)?.command).toBe('close-window');
    expect(globalShortcutFor(key('F2'), false)?.command).toBe('product-info');
    expect(globalShortcutFor(key('F3'), false)?.command).toBe('search');
    expect(globalShortcutFor(key('F5'), false)?.command).toBe('refresh');
  });

  it('Ctrl+R is Use Register (the highlighted account first) and never a reload', () => {
    const sc = globalShortcutFor(ctrl('r'), true);
    expect(sc?.command).toBe('register');
    expect(sc?.href).toBe('/registers');
  });

  it('in a text field Ctrl+G / Ctrl+O / ? stay with the field; Ctrl+V pastes text unless a register line takes it', () => {
    expect(globalShortcutFor(ctrl('g'), true)).toBeNull();
    expect(globalShortcutFor(ctrl('o'), true)).toBeNull();
    expect(globalShortcutFor(key('?'), true)).toBeNull();
    expect(globalShortcutFor(ctrl('v'), true)?.command).toBe('paste-transaction');
  });

  it('Alt+anything is never a global key (Alt is the menus and the form buttons)', () => {
    expect(globalShortcutFor(key('g', { altKey: true, ctrlKey: true }), false)).toBeNull();
  });

  it('Ctrl+R / Ctrl+U on the Chart of Accounts: a balance-sheet account opens its register, income and expense their QuickReport', () => {
    expect(accountRegisterHref('a1', 'asset')).toBe('/registers/a1');
    expect(accountRegisterHref('l1', 'liability')).toBe('/registers/l1');
    expect(accountRegisterHref('e1', 'equity')).toBe('/registers/e1');
    expect(accountRegisterHref('x1', 'expense')).toMatch(/^\/reports\/std\/transaction-detail-by-account\?dates=all&accountId=x1$/);
  });
});

describe('desktop menu letters (QuickBooks: Alt+F E V L A C U O Y B R W H)', () => {
  const menus = ['File', 'Edit', 'View', 'Lists', 'Favorites', 'Company', 'Customers', 'Vendors', 'Employees', 'Banking', 'Reports', 'Window', 'Help'];

  it('each Alt+letter opens its menu', () => {
    const letters = 'fevlacuoybrwh'.split('');
    expect(letters.map((l) => menus[menuForKey(key(l, { altKey: true }), menus)])).toEqual(menus);
  });

  it('a non-Latin layout opens them by the physical key (Alt+О on a Cyrillic keyboard is Alt+O)', () => {
    expect(menus[menuForKey(key('щ', { altKey: true, code: 'KeyO' }), menus)]).toBe('Vendors');
  });

  it('after Alt alone a plain letter opens the menu; with Ctrl or Alt held it does not', () => {
    expect(menus[menuForLetter(key('y'), menus)]).toBe('Employees');
    expect(menuForLetter(ctrl('y'), menus)).toBe(-1);
    expect(menuForKey(key('o', { altKey: true, ctrlKey: true }), menus)).toBe(-1);
  });
});

describe('fields: what is typed into, and what holds work', () => {
  const el = (tagName: string, type?: string) => ({ tagName, type }) as unknown as EventTarget;

  it('a checkbox or radio is not a text field: Ctrl+E, Ctrl+Q, ? and Ctrl+Z work there', () => {
    expect(isEditableTarget(el('INPUT', 'checkbox'))).toBe(false);
    expect(isEditableTarget(el('INPUT', 'radio'))).toBe(false);
    expect(isEditableTarget(el('INPUT', 'text'))).toBe(true);
    expect(isEditableTarget(el('SELECT'))).toBe(true);
    expect(isEditableTarget(el('TEXTAREA'))).toBe(true);
  });

  it('…but a ticked checkbox still holds work (Pay Bills, Make Deposits)', () => {
    expect(isFormField(el('INPUT', 'checkbox'))).toBe(true);
    expect(isFormField(el('INPUT', 'radio'))).toBe(true);
    expect(isFormField(el('INPUT', 'button'))).toBe(false);
    expect(isFormField(el('INPUT', 'hidden'))).toBe(false);
  });
});

describe('Enter records the form (QuickBooks), except where Enter means something else', () => {
  const enter = key('Enter');
  it('in a text field or a drop-down: records', () => {
    expect(enterRecordsForm(enter, { tag: 'INPUT', type: 'text' })).toBe(true);
    expect(enterRecordsForm(enter, { tag: 'SELECT' })).toBe(true);
  });
  it('not in a text area, an open list, a line grid, a register, a search box, a checkbox or a real <form>', () => {
    expect(enterRecordsForm(enter, { tag: 'TEXTAREA' })).toBe(false);
    expect(enterRecordsForm(enter, { tag: 'INPUT', type: 'text', expanded: true })).toBe(false);
    expect(enterRecordsForm(enter, { tag: 'INPUT', type: 'text', inGrid: true })).toBe(false);
    expect(enterRecordsForm(enter, { tag: 'INPUT', type: 'text', inList: true })).toBe(false);
    expect(enterRecordsForm(enter, { tag: 'INPUT', type: 'search' })).toBe(false);
    expect(enterRecordsForm(enter, { tag: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(enterRecordsForm(enter, { tag: 'INPUT', type: 'text', inNativeForm: true })).toBe(false);
  });
  it('Ctrl+Enter / Shift+Enter are not this rule (Ctrl+Enter is Save & New)', () => {
    expect(enterRecordsForm(ctrl('Enter'), { tag: 'INPUT', type: 'text' })).toBe(false);
    expect(enterRecordsForm(key('Enter', { shiftKey: true }), { tag: 'INPUT', type: 'text' })).toBe(false);
  });
});

describe('leaving a page: is typed work at risk?', () => {
  const root = (opts: { dialogWithField?: boolean; unsaved?: boolean } = {}) =>
    ({
      querySelectorAll: (sel: string) => {
        if (sel.startsWith('[role="dialog"]')) return opts.dialogWithField ? [{ querySelector: () => ({}) }] : [];
        if (sel === '[data-unsaved-work]') return opts.unsaved ? [{}] : [];
        return [];
      },
    }) as unknown as ParentNode;
  const field = (inMain: boolean, type = 'text', chrome = false) =>
    ({
      tagName: 'INPUT',
      type,
      isConnected: true,
      closest: (sel: string) => {
        if (sel === 'main') return inMain ? {} : null;
        if (sel.includes('data-shell-chrome')) return chrome ? {} : null;
        if (sel.includes('main')) return inMain ? {} : null;
        return null;
      },
    }) as unknown as Element;

  it('a field on the page, an open form dialog, or a page holding unsaved answers', () => {
    expect(mightLoseWork(field(true), root())).toBe(true);
    expect(mightLoseWork(null, root({ dialogWithField: true }))).toBe(true);
    expect(mightLoseWork(null, root({ unsaved: true }))).toBe(true);
    expect(mightLoseWork(field(true, 'search'), root())).toBe(false);
    expect(mightLoseWork(null, root())).toBe(false);
  });

  it('focus in the command bar (shell chrome): judged by the field the cursor was in before', () => {
    const bar = field(false, 'search', true);
    expect(leaveRisk(bar, field(true), root())).toBe(true);
    expect(leaveRisk(bar, null, root())).toBe(false);
  });
});

describe('list and register keys', () => {
  it('Left / Right scroll a column; with a modifier they are not ours', () => {
    expect(listScrollKey(key('ArrowLeft'))).toBe('left');
    expect(listScrollKey(key('ArrowRight'))).toBe('right');
    expect(listScrollKey(key('ArrowRight', { shiftKey: true }))).toBeNull();
    expect(listScrollKey(ctrl('ArrowRight'))).toBeNull();
  });

  it('the next column edge, clamped to the scroll range; null at either end', () => {
    const edges = [0, 120, 240, 400, 520];
    expect(nextColumnScroll(edges, 0, 300, 'right')).toBe(120);
    expect(nextColumnScroll(edges, 120, 300, 'right')).toBe(240);
    expect(nextColumnScroll(edges, 240, 300, 'right')).toBe(300);
    expect(nextColumnScroll(edges, 300, 300, 'right')).toBeNull();
    expect(nextColumnScroll(edges, 300, 300, 'left')).toBe(240);
    expect(nextColumnScroll(edges, 0, 300, 'left')).toBeNull();
    expect(nextColumnScroll(edges, 0, 0, 'right')).toBeNull();
  });

  it('Ctrl+PgUp / Ctrl+PgDn: a register month back / on', () => {
    expect(monthKeyDirection(ctrl('PageUp'))).toBe(-1);
    expect(monthKeyDirection(ctrl('PageDown'))).toBe(1);
    expect(monthKeyDirection(key('PageDown'))).toBeNull();
    const dates = ['2026-01-05', '2026-01-20', '2026-02-03', '2026-02-17', '2026-04-09'];
    expect(registerMonthIndex(dates, 4, -1)).toBe(2); // April → February (March is empty)
    expect(registerMonthIndex(dates, 3, -1)).toBe(0); // February → January
    expect(registerMonthIndex(dates, 0, -1)).toBe(0); // nothing earlier
    expect(registerMonthIndex(dates, 0, 1)).toBe(2); // January → February
    expect(registerMonthIndex(dates, 2, 1)).toBe(4); // February → April
    expect(registerMonthIndex(dates, 4, 1)).toBe(4); // nothing later
    expect(registerMonthIndex(dates, -1, -1)).toBe(4);
    expect(registerMonthIndex(dates, -1, 1)).toBe(0);
    expect(registerMonthIndex([], 0, 1)).toBe(-1);
  });
});

describe('Ctrl+G and Ctrl+O in a register', () => {
  const row = {
    journalEntryId: 'je1',
    description: 'Rent',
    memo: 'October',
    debit: null,
    credit: '1200.00',
    otherAccount: { id: 'rent', label: '6100 Rent' },
  };

  it('Ctrl+G opens the other account’s register at the same transaction; a split has none', () => {
    expect(transferHref(row)).toBe('/registers/rent?entry=je1');
    expect(transferHref({ ...row, otherAccount: { id: null, label: '-split-' } })).toBeNull();
  });

  it('the Increase / Decrease columns follow the account’s normal side', () => {
    expect(registerAmount(row, 'asset', 'decrease')).toBe('1200.00');
    expect(registerAmount(row, 'liability', 'increase')).toBe('1200.00');
    expect(registerAmount({ ...row, foreignCredit: '1000.00' }, 'asset', 'decrease', true)).toBe('1000.00');
  });

  it('Ctrl+O copies payee, the other account, memo, column and amount; never a split', () => {
    expect(copyOfRow(row, 'asset', false)).toEqual({ payee: 'Rent', accountId: 'rent', accountLabel: '6100 Rent', memo: 'October', side: 'decrease', amount: '1200.00' });
    expect(copyOfRow({ ...row, otherAccount: { id: null, label: '-split-' } }, 'asset', false)).toBeNull();
    expect(copyOfRow({ ...row, credit: '0.00' }, 'asset', false)).toBeNull();
  });

  it('Ctrl+V reads only a well-formed copy', () => {
    const good = JSON.stringify({ payee: 'Rent', accountId: 'rent', accountLabel: 'Rent', memo: '', side: 'decrease', amount: '1200.00' });
    expect(parseCopiedTransaction(good)?.amount).toBe('1200.00');
    expect(parseCopiedTransaction(null)).toBeNull();
    expect(parseCopiedTransaction('{')).toBeNull();
    expect(parseCopiedTransaction(JSON.stringify({ accountId: 'x', side: 'sideways', amount: '1' }))).toBeNull();
    expect(parseCopiedTransaction(JSON.stringify({ accountId: 'x', side: 'increase', amount: '-5' }))).toBeNull();
  });
});

describe('Ctrl+U on a list row: a new form for the name or item', () => {
  it('a customer opens a new invoice for them; a vendor a new bill; an item an invoice with its line', () => {
    expect(JSON.parse(listItemPrefill({ customerId: 'c1' }))).toEqual({ kind: 'invoice', customerId: 'c1', lines: [] });
    expect(JSON.parse(listItemPrefill({ vendorId: 'v1' }))).toEqual({ kind: 'bill', vendorId: 'v1', lines: [] });
    expect(JSON.parse(listItemPrefill({ item: { id: 'i1', name: 'Labor', description: 'Hourly', salesPrice: '85.00' } }))).toEqual({
      kind: 'invoice',
      lines: [{ itemId: 'i1', itemName: 'Labor', quantity: '1', description: 'Hourly', rate: '85.00' }],
    });
  });
  it('a price that is not an amount is left off', () => {
    expect(JSON.parse(listItemPrefill({ item: { id: 'i1', name: 'Labor', salesPrice: 'call us' } })).lines[0].rate).toBeUndefined();
  });
});

describe("QuickBooks' Tab order: which field is which", () => {
  it('labels are read without asterisks, (optional) or a trailing colon', () => {
    expect(normalizeFieldLabel('Class (optional)')).toBe('Class');
    expect(normalizeFieldLabel('Customer *')).toBe('Customer');
    expect(normalizeFieldLabel('Memo:')).toBe('Memo');
  });

  it.each([
    [{ label: 'Customer' }, 'name'],
    [{ label: 'Customer:Job' }, 'name'],
    [{ label: 'Vendor *' }, 'name'],
    [{ label: 'Pay to the Order of' }, 'name'],
    [{ label: 'Received From' }, 'name'],
    [{ label: 'Class (optional)' }, 'class'],
    [{ label: 'Template' }, 'template'],
    [{ label: 'Invoice Date', type: 'date' }, 'date'],
    [{ label: 'Bill Date', type: 'date' }, 'date'],
    [{ label: 'Date', type: 'date' }, 'date'],
    [{ label: 'Due Date', type: 'date' }, null],
    [{ label: 'Expiration Date', type: 'date' }, null],
    [{ label: 'Ship Date', type: 'date' }, null],
    [{ label: 'Invoice #' }, 'number'],
    [{ label: 'Check No.' }, 'number'],
    [{ label: 'Ref. No.' }, 'number'],
    [{ label: 'Anything', docNumber: true }, 'number'],
    [{ label: 'Memo' }, 'memo'],
    [{ label: 'Memo / Note' }, 'memo'],
    [{ label: 'Terms' }, null],
    [{ label: 'Sales Tax' }, null],
  ])('%j → %s', (field, role) => {
    expect(qbFieldRole(field)).toBe(role);
  });
});

describe('first-letter type-ahead in pickers and menus', () => {
  const labels = ['Write Checks', 'Make Deposits', 'Transfer Funds', 'Enter Credit Card Charges'];
  it('a letter jumps to the next item starting with it; more letters typed quickly spell a name', () => {
    expect(pickerKeyMove(key('t'), 0, labels)).toEqual({ index: 2, typed: 't' });
    expect(pickerKeyMove(key('r'), 2, labels, 't')).toEqual({ index: 2, typed: 'tr' });
    expect(pickerKeyMove(key('x'), 1, labels)).toEqual({ index: 1, typed: 'x' });
  });
  it('arrows wrap; Ctrl / Alt keys are not the picker’s', () => {
    expect(pickerKeyMove(key('ArrowDown'), 3, labels)).toEqual({ index: 0, typed: '' });
    expect(pickerKeyMove(ctrl('t'), 0, labels)).toBeNull();
    expect(pickerKeyMove(key('t', { altKey: true }), 0, labels)).toBeNull();
  });
});

describe('the open windows (Window > Open Window List, Ctrl+Tab, Ctrl+F4)', () => {
  const list = [
    { path: '/customers', href: '/customers', label: 'Customer Center' },
    { path: '/invoices', href: '/invoices', label: 'Create Invoices' },
    { path: '/accounts', href: '/accounts', label: 'Chart of Accounts' },
  ];

  it('a visited page is added once, without one-shot query keys (?new=1)', () => {
    const next = visitWindow(list, '/invoices?new=1&customer=c1', 'Create Invoices');
    expect(next).toHaveLength(3);
    expect(next[1].href).toBe('/invoices?customer=c1');
    expect(visitWindow(list, '/vendors', 'Vendor Center').map((w) => w.path)).toEqual(['/customers', '/invoices', '/accounts', '/vendors']);
    expect(reopenHref('/reports/builder?mem=r1#top')).toBe('/reports/builder#top');
  });

  it('the list keeps the latest pages only', () => {
    let l: typeof list = [];
    for (let i = 0; i < MAX_OPEN_WINDOWS + 5; i++) l = visitWindow(l, `/p${i}`, `P${i}`);
    expect(l).toHaveLength(MAX_OPEN_WINDOWS);
    expect(l[0].path).toBe('/p5');
  });

  it('Ctrl+Tab / Ctrl+Shift+Tab wrap around; one window goes nowhere', () => {
    expect(cycleWindow(list, '/accounts', 1)?.path).toBe('/customers');
    expect(cycleWindow(list, '/customers', -1)?.path).toBe('/accounts');
    expect(cycleWindow(list.slice(0, 1), '/customers', 1)).toBeNull();
  });

  it('Ctrl+F4 shows the window before it, else the next, else Home', () => {
    expect(closeWindow(list, '/invoices')).toEqual({ list: [list[0], list[2]], show: '/customers' });
    expect(closeWindow(list, '/customers').show).toBe('/invoices');
    expect(closeWindow(list.slice(0, 1), '/customers')).toEqual({ list: [], show: '/dashboard' });
  });

  it('a stored list from elsewhere is checked (no other sites, nothing malformed)', () => {
    expect(parseWindowList('not json')).toEqual([]);
    expect(parseWindowList(JSON.stringify([{ path: '/x', href: '//evil.example' }, { path: '/y', href: '/y', label: 'Y' }, 5]))).toEqual([
      { path: '/y', href: '/y', label: 'Y' },
    ]);
  });
});

describe('a renamed company updates the header and the window title at once', () => {
  it('a save of the open company, or of one in Manage companies, with a name', () => {
    expect(companyRenameFrom({ method: 'PATCH', path: '/api/company', body: { name: ' New Co ' } }, { name: 'New Co' })).toEqual({ id: null, name: 'New Co' });
    expect(companyRenameFrom({ method: 'PUT', path: '/api/companies/abc', body: { name: 'B' } }, null)).toEqual({ id: 'abc', name: 'B' });
  });
  it('not a save without a name, a GET, or another kind of record', () => {
    expect(companyRenameFrom({ method: 'PATCH', path: '/api/company', body: { settings: {} } }, {})).toBeNull();
    expect(companyRenameFrom({ method: 'GET', path: '/api/company', body: { name: 'x' } }, {})).toBeNull();
    expect(companyRenameFrom({ method: 'PATCH', path: '/api/customers/1', body: { name: 'x' } }, {})).toBeNull();
  });
});

describe('the Favorites menu (Alt+A in the desktop app)', () => {
  it('keeps in-app pages only, once each, at most 30', () => {
    const many = Array.from({ length: MAX_FAVORITES + 5 }, (_, i) => `/p${i}`);
    const my = resolveMyPreferences({ favorites: ['/invoices', '/invoices', 'https://evil.example', '//x', '/reports/profit-loss', 7, ...many] });
    expect(my.favorites.slice(0, 2)).toEqual(['/invoices', '/reports/profit-loss']);
    expect(my.favorites).toHaveLength(MAX_FAVORITES);
    expect(resolveMyPreferences({}).favorites).toEqual([]);
  });
  it('a save is checked the same way', () => {
    expect(myPreferencesSchema.safeParse({ favorites: ['/invoices'] }).success).toBe(true);
    expect(myPreferencesSchema.safeParse({ favorites: ['https://evil.example'] }).success).toBe(false);
    expect(myPreferencesSchema.safeParse({ favorites: Array.from({ length: 31 }, (_, i) => `/p${i}`) }).success).toBe(false);
  });
});

describe('Product Information and the Help window', () => {
  it('sizes read like Windows', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5_400_000)).toBe('5.1 MB');
    expect(formatBytes(null)).toBe('Unknown');
  });
  it('Find a key matches every word in the key, the QuickBooks name or what it does', () => {
    const rows = filterShortcutRows(QB_SHORTCUTS, 'ctrl+g');
    expect(rows.some((r) => r.keys === 'Ctrl+G')).toBe(true);
    expect(filterShortcutRows(QB_SHORTCUTS, 'transfer register').every((r) => /transfer/i.test(`${r.keys} ${r.qb} ${r.ironbooks}`))).toBe(true);
    expect(filterShortcutRows(QB_SHORTCUTS, '')).toHaveLength(QB_SHORTCUTS.length);
  });
});
