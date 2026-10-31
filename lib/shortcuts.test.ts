/**
 * Tests for lib/shortcuts.ts (QuickMath parser, QB date keys, shortcut tables)
 * and lib/nav-actions.ts (command-palette quick actions).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateAmountExpression,
  isMathExpression,
  formatAmountResult,
  adjustDateForKey,
  GLOBAL_SHORTCUTS,
  isEditableTarget,
} from './shortcuts';
import { navActions, filterNavActions } from './nav-actions';
import { paletteDestinations } from './nav';

describe('evaluateAmountExpression (safe QuickMath parser)', () => {
  it('evaluates the canonical example 12.5*3+10', () => {
    expect(evaluateAmountExpression('12.5*3+10')).toBe(47.5);
  });

  it('handles the four operators with precedence', () => {
    expect(evaluateAmountExpression('2+3*4')).toBe(14);
    expect(evaluateAmountExpression('10-4/2')).toBe(8);
    expect(evaluateAmountExpression('100/4')).toBe(25);
    expect(evaluateAmountExpression('7*8')).toBe(56);
  });

  it('handles parentheses and nesting', () => {
    expect(evaluateAmountExpression('(2+3)*4')).toBe(20);
    expect(evaluateAmountExpression('((1+2)*(3+4))')).toBe(21);
  });

  it('handles unary signs', () => {
    expect(evaluateAmountExpression('-5+2')).toBe(-3);
    expect(evaluateAmountExpression('5*-2')).toBe(-10);
    expect(evaluateAmountExpression('+3')).toBe(3);
  });

  it('parses plain numbers and decimals', () => {
    expect(evaluateAmountExpression('42')).toBe(42);
    expect(evaluateAmountExpression('0.5')).toBe(0.5);
    expect(evaluateAmountExpression('.75')).toBe(0.75);
  });

  it('ignores currency adornments ($, commas, whitespace)', () => {
    expect(evaluateAmountExpression('$1,200 + 300')).toBe(1500);
    expect(evaluateAmountExpression(' 12.5 * 3 + 10 ')).toBe(47.5);
  });

  it('rejects invalid expressions with null (never throws)', () => {
    expect(evaluateAmountExpression('')).toBeNull();
    expect(evaluateAmountExpression('abc')).toBeNull();
    expect(evaluateAmountExpression('12..5')).toBeNull();
    expect(evaluateAmountExpression('5+')).toBeNull();
    expect(evaluateAmountExpression('(2+3')).toBeNull();
    expect(evaluateAmountExpression('2+3)')).toBeNull();
    expect(evaluateAmountExpression('2**3')).toBeNull();
    expect(evaluateAmountExpression('.')).toBeNull();
  });

  it('rejects division by zero', () => {
    expect(evaluateAmountExpression('1/0')).toBeNull();
    expect(evaluateAmountExpression('10/(5-5)')).toBeNull();
  });

  it('cannot execute code (no eval): function-call-shaped input is invalid', () => {
    expect(evaluateAmountExpression('alert(1)')).toBeNull();
    expect(evaluateAmountExpression('process.exit(1)')).toBeNull();
    expect(evaluateAmountExpression('1;2')).toBeNull();
  });
});

describe('isMathExpression', () => {
  it('detects operators and parens', () => {
    expect(isMathExpression('12.5*3+10')).toBe(true);
    expect(isMathExpression('(2+3)')).toBe(true);
    expect(isMathExpression('10/2')).toBe(true);
    expect(isMathExpression('5+5')).toBe(true);
    expect(isMathExpression('100-1')).toBe(true);
  });

  it('passes plain numbers through untouched (including signed and formatted)', () => {
    expect(isMathExpression('42')).toBe(false);
    expect(isMathExpression('12.50')).toBe(false);
    expect(isMathExpression('-12.50')).toBe(false);
    expect(isMathExpression('$1,200.00')).toBe(false);
    expect(isMathExpression('')).toBe(false);
  });
});

describe('formatAmountResult', () => {
  it('rounds to cents', () => {
    expect(formatAmountResult(47.5)).toBe('47.5');
    expect(formatAmountResult(10 / 3)).toBe('3.33');
    expect(formatAmountResult(1.005)).toBe('1.01');
    expect(formatAmountResult(-2.555)).toBe('-2.56'); // half away from zero, like Money.round2
  });
});

describe('adjustDateForKey (QB date-entry keys)', () => {
  const base = '2026-06-09';

  it('+ / = advance a day, - goes back a day', () => {
    expect(adjustDateForKey('+', base)).toBe('2026-06-10');
    expect(adjustDateForKey('=', base)).toBe('2026-06-10');
    expect(adjustDateForKey('-', base)).toBe('2026-06-08');
  });

  it('crosses month/year boundaries', () => {
    expect(adjustDateForKey('+', '2026-06-30')).toBe('2026-07-01');
    expect(adjustDateForKey('-', '2026-01-01')).toBe('2025-12-31');
  });

  it('m / h jump to first / last of month (case-insensitive)', () => {
    expect(adjustDateForKey('m', base)).toBe('2026-06-01');
    expect(adjustDateForKey('M', base)).toBe('2026-06-01');
    expect(adjustDateForKey('h', base)).toBe('2026-06-30');
    expect(adjustDateForKey('H', '2026-02-10')).toBe('2026-02-28');
  });

  it('y / r jump to first / last of year', () => {
    expect(adjustDateForKey('y', base)).toBe('2026-01-01');
    expect(adjustDateForKey('r', base)).toBe('2026-12-31');
  });

  it('w / k jump to the first / last day of the week (Sunday – Saturday, as QB)', () => {
    // 2026-06-09 is a Tuesday.
    expect(adjustDateForKey('w', base)).toBe('2026-06-07');
    expect(adjustDateForKey('W', base)).toBe('2026-06-07');
    expect(adjustDateForKey('k', base)).toBe('2026-06-13');
    expect(adjustDateForKey('K', '2026-12-30')).toBe('2027-01-02'); // the week runs into next year
    expect(adjustDateForKey('w', '2026-06-07')).toBe('2026-06-07'); // already Sunday
  });

  it('[ / ] move a week back / forward, keeping the weekday', () => {
    expect(adjustDateForKey('[', base)).toBe('2026-06-02');
    expect(adjustDateForKey(']', base)).toBe('2026-06-16');
    expect(adjustDateForKey(']', '2026-12-29')).toBe('2027-01-05');
  });

  it("; / ' move a month back / forward, clamping to the month's last day", () => {
    expect(adjustDateForKey(';', base)).toBe('2026-05-09');
    expect(adjustDateForKey("'", base)).toBe('2026-07-09');
    expect(adjustDateForKey("'", '2026-01-31')).toBe('2026-02-28');
    expect(adjustDateForKey(';', '2026-03-31')).toBe('2026-02-28');
    expect(adjustDateForKey("'", '2026-12-15')).toBe('2027-01-15');
  });

  it('t returns today', () => {
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    expect(adjustDateForKey('t', base)).toBe(expected);
  });

  it('falls back to today when the field is empty or invalid', () => {
    const plus = adjustDateForKey('+', undefined);
    expect(plus).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(adjustDateForKey('m', 'not-a-date')).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('returns null for non-date keys so events pass through', () => {
    expect(adjustDateForKey('a', base)).toBeNull();
    expect(adjustDateForKey('5', base)).toBeNull();
    expect(adjustDateForKey('/', base)).toBeNull(); // typed dates use '/'
    expect(adjustDateForKey('{', base)).toBeNull();
    expect(adjustDateForKey('Tab', base)).toBeNull();
    expect(adjustDateForKey('ArrowUp', base)).toBeNull();
    expect(adjustDateForKey('Enter', base)).toBeNull();
  });
});

describe('GLOBAL_SHORTCUTS table', () => {
  it('uses the QuickBooks Desktop navigation keys and destinations', () => {
    const byKey = Object.fromEntries(
      GLOBAL_SHORTCUTS.filter((s) => s.ctrlKey && s.href).map((s) => [s.ctrlKey, s.href]),
    );
    expect(byKey).toEqual({
      w: '/expenses?new=1', // Write Checks
      i: '/invoices?new=1', // Create Invoices
      j: '/customers', // Customer Center
      a: '/accounts', // Chart of Accounts
      r: '/registers', // Use Register
      t: '/recurring', // Memorized Transaction List
      f: '/find', // Find
    });
  });

  it('maps the QB command keys to their commands', () => {
    const byKey = Object.fromEntries(GLOBAL_SHORTCUTS.filter((s) => s.command).map((s) => [s.keys, s.command]));
    expect(byKey).toEqual({
      'Ctrl+E': 'edit',
      'Ctrl+D': 'delete',
      'Ctrl+P': 'print',
      'Ctrl+Y': 'journal',
      'Ctrl+H': 'history',
      'Ctrl+Q': 'quick-report',
      'Ctrl+M': 'memorize',
      'Ctrl+L': 'open-list',
      'Ctrl+K': 'palette',
      // Ctrl+R opens the highlighted account's register, else the list of registers (its href).
      'Ctrl+R': 'register',
      'Ctrl+G': 'transfer',
      'Ctrl+O': 'copy-transaction',
      'Ctrl+V': 'paste-transaction',
      'Ctrl+U': 'use',
      'Ctrl+1': 'product-info',
      'Ctrl+2': 'search',
      F1: 'help',
      F2: 'product-info',
      F3: 'search',
      F5: 'refresh',
      'Ctrl+F4': 'close-window',
      'Ctrl+Tab': 'next-window',
      'Ctrl+F6': 'next-window',
      'Ctrl+Shift+Tab': 'prev-window',
      'Ctrl+Shift+F6': 'prev-window',
      '?': 'shortcuts',
    });
  });

  it('no longer uses the old non-QB meanings (Ctrl+E check, Ctrl+J journal, Ctrl+D deposits)', () => {
    const find = (k: string) => GLOBAL_SHORTCUTS.find((s) => s.ctrlKey === k);
    expect(find('e')?.href).toBeUndefined();
    expect(find('j')?.href).not.toBe('/journal');
    expect(find('d')?.href).toBeUndefined();
    // Make Deposits stays reachable from the menus and the command bar, on no shortcut.
    expect(GLOBAL_SHORTCUTS.some((s) => s.href?.startsWith('/deposits'))).toBe(false);
    expect(navActions.some((a) => a.href.startsWith('/deposits'))).toBe(true);
  });

  it('every row has a description and a display combo', () => {
    for (const s of GLOBAL_SHORTCUTS) {
      expect(s.keys, JSON.stringify(s)).toBeTruthy();
      expect(s.description, s.keys).toBeTruthy();
      if (s.ctrlKey) expect(s.keys).toBe(`Ctrl+${s.ctrlKey.toUpperCase()}`);
    }
  });

  it('navigation shortcuts point at real sidebar destinations', () => {
    const paths = new Set(paletteDestinations.map((d) => d.href));
    for (const s of GLOBAL_SHORTCUTS) {
      if (!s.href) continue;
      const pathOnly = s.href.split('?')[0];
      expect(paths.has(pathOnly), `${s.keys} -> ${pathOnly}`).toBe(true);
    }
  });

  it('ctrl keys are unique', () => {
    const keys = GLOBAL_SHORTCUTS.filter((s) => s.ctrlKey).map((s) => s.ctrlKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('isEditableTarget', () => {
  function fakeEl(tagName: string, contentEditable = false) {
    return { tagName, isContentEditable: contentEditable } as unknown as EventTarget;
  }

  it('flags form fields and contentEditable', () => {
    expect(isEditableTarget(fakeEl('INPUT'))).toBe(true);
    expect(isEditableTarget(fakeEl('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(fakeEl('SELECT'))).toBe(true);
    expect(isEditableTarget(fakeEl('DIV', true))).toBe(true);
  });

  it('passes ordinary elements and null', () => {
    expect(isEditableTarget(fakeEl('DIV'))).toBe(false);
    expect(isEditableTarget(fakeEl('BUTTON'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('nav-actions (command palette quick actions)', () => {
  it('exposes the seven QB quick actions', () => {
    expect(navActions.map((a) => a.label)).toEqual([
      'New Invoice',
      'Write Check',
      'Receive Payment',
      'Make Deposit',
      'New Journal Entry',
      'Reconcile',
      'Run Payroll',
    ]);
  });

  it('every action lands on a real page (path exists in nav)', () => {
    const paths = new Set(paletteDestinations.map((d) => d.href));
    for (const a of navActions) {
      const pathOnly = a.href.split('?')[0];
      expect(paths.has(pathOnly), `${a.label} -> ${pathOnly}`).toBe(true);
    }
  });

  it('create actions carry ?new=1 so pages can open their create modal', () => {
    const creators = navActions.filter((a) => a.label !== 'Reconcile');
    for (const a of creators) {
      expect(a.href, a.label).toContain('?new=1');
    }
  });

  it('filterNavActions matches labels and keywords, returns all on empty query', () => {
    expect(filterNavActions('')).toHaveLength(navActions.length);
    expect(filterNavActions('invoice').map((a) => a.label)).toContain('New Invoice');
    expect(filterNavActions('check').map((a) => a.label)).toContain('Write Check');
    expect(filterNavActions('paycheck').map((a) => a.label)).toContain('Run Payroll');
    expect(filterNavActions('zzz-no-match')).toHaveLength(0);
  });
});
