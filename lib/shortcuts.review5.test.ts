/**
 * Review round 5 (team uib): QuickBooks keys and the shell.
 *
 *  - QuickMath (amount fields) evaluated and rounded with float math: "1234567.89/2" became
 *    617283.94 and "-5.11/2" became -2.55, where the books (lib/money Money.round2, half away from
 *    zero) say 617283.95 and -2.56. It now evaluates in exact decimals.
 *  - Choosing a page from the desktop menu bar or the command bar discarded an open form without
 *    the "Leave this form?" question the QuickBooks keys ask (navigateGuarded).
 *  - Ctrl+PgUp / Ctrl+PgDn (first / last entry of a QB list or register) did nothing.
 *  - F5 (QB: refresh) reloaded the desktop window and silently discarded an open form.
 */
import { describe, expect, it } from 'vitest';
import {
  NAVIGATE_REQUEST_EVENT,
  type KeyLike,
  evaluateAmountDecimal,
  evaluateAmountExpression,
  formatAmountResult,
  isReloadKey,
  leaveRisk,
  listKeyAction,
  mightLoseWork,
  navigateGuarded,
  nextListIndex,
} from './shortcuts';
import { shortcutsHelpGroups } from './qbShortcuts';
import { Money } from './money';

/** What an amount field shows after QuickMath commits (components/ui.tsx AmountInput). */
const quickMath = (raw: string) => {
  const v = evaluateAmountDecimal(raw);
  return v === null ? null : formatAmountResult(v);
};

describe('QuickMath rounds like the books', () => {
  it('a half cent rounds up, not down (float 50.024999…)', () => {
    expect(quickMath('100.05/2')).toBe('50.03');
    expect(quickMath('1.115+2.23')).toBe('3.35');
    expect(quickMath('0.285*100/100')).toBe('0.29');
  });

  it('negative half cents round away from zero, like Money.round2', () => {
    expect(quickMath('-5.11/2')).toBe(Money.round2('-2.555').toFixed(2));
    expect(quickMath('0-1.005')).toBe('-1.01');
  });

  it('agrees with Money.round2 on every split of a few awkward totals', () => {
    for (const total of ['100.05', '33.35', '0.05', '1234567.89', '10.01']) {
      for (const parts of [2, 3, 4, 6, 8]) {
        const exact = Money.round2(Money.div(total, parts));
        expect(quickMath(`${total}/${parts}`), `${total}/${parts}`).toBe(Number(exact.toFixed(2)) === 0 ? '0' : exact.toFixed(2).replace(/\.?0+$/, ''));
      }
    }
  });

  it('never shows -0 or exponent notation', () => {
    expect(quickMath('0*-1')).toBe('0');
    expect(quickMath('-0.001+0')).toBe('0');
    expect(quickMath('99999999999*100')).toBe('9999999999900');
    expect(quickMath('0.1+0.2')).toBe('0.3');
  });

  it('keeps the existing answers and refusals', () => {
    expect(quickMath('12.5*3+10')).toBe('47.5');
    expect(quickMath('10/3')).toBe('3.33');
    expect(evaluateAmountExpression('$1,200 + 300')).toBe(1500);
    expect(quickMath('1/0')).toBeNull();
    expect(quickMath('5+')).toBeNull();
    expect(quickMath('(2+3')).toBeNull();
    expect(quickMath('-(2')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Leaving an open form from the desktop menus or the command bar
// ---------------------------------------------------------------------------
//
// Ctrl+W / Ctrl+I / … asked "Leave this form?" before discarding typed work, but choosing the same
// item from the desktop menu bar (Banking > Write Checks, File > Back Up…) or a page from the
// command bar (Ctrl+K) pushed the new page straight away: the open invoice was silently lost.

/**
 * A stand-in for the document: its form dialogs ('[role="dialog"][data-modal]') and whether a page
 * says it holds unsaved answers ('[data-unsaved-work]', the setup interview).
 */
const docWith = (dialogs: Array<{ hasField: boolean }>, unsavedPage = false) => ({
  querySelectorAll: (sel: string) =>
    (sel.includes('data-unsaved-work')
      ? unsavedPage
        ? [{}]
        : []
      : dialogs.map((d) => ({ querySelector: () => (d.hasField ? {} : null) }))) as unknown as NodeListOf<HTMLElement>,
});
/** A stand-in for a focused element ('main' / '[data-shell-chrome]' ancestors as asked). */
const el = (tagName: string, opts: { inMain?: boolean; type?: string; chrome?: boolean; connected?: boolean } = {}) =>
  ({
    tagName,
    type: opts.type ?? 'text',
    isContentEditable: false,
    isConnected: opts.connected ?? true,
    closest: (sel: string) => {
      if (sel.includes('data-shell-chrome')) return opts.chrome ? {} : null;
      return sel.includes('main') && opts.inMain ? {} : null;
    },
  }) as unknown as Element;

describe('mightLoseWork', () => {
  it('an open form dialog with fields could lose work, wherever the focus is', () => {
    expect(mightLoseWork(null, docWith([{ hasField: true }]))).toBe(true);
    expect(mightLoseWork(el('BUTTON'), docWith([{ hasField: false }, { hasField: true }]))).toBe(true);
  });

  it('a field on the page could; a search box, a button or nothing focused could not', () => {
    expect(mightLoseWork(el('INPUT', { inMain: true }), docWith([]))).toBe(true);
    expect(mightLoseWork(el('TEXTAREA', { inMain: true }), docWith([]))).toBe(true);
    expect(mightLoseWork(el('INPUT', { inMain: true, type: 'search' }), docWith([]))).toBe(false);
    expect(mightLoseWork(el('INPUT', { inMain: false }), docWith([]))).toBe(false); // the command bar's own box
    expect(mightLoseWork(el('BUTTON', { inMain: true }), docWith([{ hasField: false }]))).toBe(false);
    expect(mightLoseWork(null, docWith([]))).toBe(false);
  });

  it('a ticked checkbox on the page counts as work (Pay Bills, Make Deposits)', () => {
    expect(mightLoseWork(el('INPUT', { inMain: true, type: 'checkbox' }), docWith([]))).toBe(true);
    expect(mightLoseWork(el('INPUT', { inMain: true, type: 'radio' }), docWith([]))).toBe(true);
    expect(mightLoseWork(el('INPUT', { inMain: true, type: 'submit' }), docWith([]))).toBe(false);
  });

  it('a page that says it holds unsaved answers (the setup interview) could lose work', () => {
    expect(mightLoseWork(null, docWith([], true))).toBe(true);
    expect(mightLoseWork(el('BUTTON', { inMain: true }), docWith([], true))).toBe(true);
  });
});

describe('leaveRisk: the command bar and the title-bar menus judge by the field the cursor was in', () => {
  const field = el('INPUT', { inMain: true });
  it('focus in the command bar (shell chrome) with a field typed in just before: at risk', () => {
    expect(leaveRisk(el('INPUT', { inMain: false, chrome: true }), field, docWith([]))).toBe(true);
    // A title-bar menu button (outside main), as after a mouse click on the menu bar.
    expect(leaveRisk(el('BUTTON', { inMain: false }), field, docWith([]))).toBe(true);
  });

  it('focus back on the page (a button, nothing typed) or no field remembered: not at risk', () => {
    expect(leaveRisk(el('BUTTON', { inMain: true }), field, docWith([]))).toBe(false);
    expect(leaveRisk(el('INPUT', { inMain: false, chrome: true }), null, docWith([]))).toBe(false);
  });

  it('a remembered field that has left the page (another page is showing) does not count', () => {
    expect(leaveRisk(el('BUTTON', { inMain: false }), el('INPUT', { inMain: true, connected: false }), docWith([]))).toBe(false);
  });
});

describe('navigateGuarded (desktop menus, command bar)', () => {
  // The leave / stay decision itself is tested with the real guard in a browser engine:
  // test/dom/leaveGuard.dom.tsx (test/leaveGuardDom.test.ts).
  it('hands the page to the leave-this-form guard, which decides', () => {
    const shell = new EventTarget();
    const asked: string[] = [];
    shell.addEventListener(NAVIGATE_REQUEST_EVENT, (e) => {
      e.preventDefault();
      asked.push((e as CustomEvent<{ href: string }>).detail.href);
    });
    const pushed: string[] = [];
    expect(navigateGuarded('/expenses?new=1', (h) => pushed.push(h), shell)).toBe(true);
    expect(asked).toEqual(['/expenses?new=1']);
    expect(pushed).toEqual([]);
  });

  it('with no guard listening (unit tests only: it is on every page) it goes straight there, through `go` when given', () => {
    const pushed: string[] = [];
    expect(navigateGuarded('/backup', (h) => pushed.push(h), new EventTarget())).toBe(false);
    const went: string[] = [];
    navigateGuarded('/invoices', (h) => pushed.push(h), new EventTarget(), { go: (h) => went.push(h) });
    expect(pushed).toEqual(['/backup']);
    expect(went).toEqual(['/invoices']);
  });
});

// ---------------------------------------------------------------------------
// QB list keys: Ctrl+PgUp / Ctrl+PgDn
// ---------------------------------------------------------------------------
//
// QuickBooks' lists and registers go to the first / last entry with Ctrl+Page Up / Ctrl+Page Down
// (Intuit's keyboard-shortcut list); the app only knew Home / End, and the Ctrl combinations did
// nothing.

describe('Ctrl+PgUp / Ctrl+PgDn in a list', () => {
  const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('go to the first / last row', () => {
    expect(listKeyAction(key('PageUp', { ctrlKey: true }))).toBe('home');
    expect(listKeyAction(key('PageDown', { ctrlKey: true }))).toBe('end');
    expect(listKeyAction(key('PageDown', { metaKey: true }))).toBe('end');
    expect(nextListIndex('end', 2, 40, 10)).toBe(39);
  });

  it('plain PgUp / PgDn still move a page; other Ctrl keys are left alone', () => {
    expect(listKeyAction(key('PageDown'))).toBe('page-down');
    expect(listKeyAction(key('PageUp'))).toBe('page-up');
    expect(listKeyAction(key('Enter', { ctrlKey: true }))).toBeNull(); // Save & New
    expect(listKeyAction(key('ArrowDown', { ctrlKey: true }))).toBeNull();
    expect(listKeyAction(key('PageDown', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('the shortcuts help lists them', () => {
    const lists = shortcutsHelpGroups({ desktop: false }).find((g) => g.id === 'lists');
    expect(lists?.rows.map((r) => r.keys)).toContain('Ctrl+Page Up / Ctrl+Page Down');
  });
});

// ---------------------------------------------------------------------------
// F5
// ---------------------------------------------------------------------------
//
// QuickBooks users press F5 to refresh a list (multi-user mode). In the desktop app F5 is View >
// Reload, which restarted the page and silently threw away an invoice being typed. The shell now
// asks first when work could be lost (the same check as the QuickBooks navigation keys).

describe('F5 with typed work on screen', () => {
  const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('is recognised as the reload key (plain F5 only)', () => {
    expect(isReloadKey(key('F5'))).toBe(true);
    expect(isReloadKey(key('F5', { ctrlKey: true }))).toBe(false);
    expect(isReloadKey(key('F5', { shiftKey: true }))).toBe(false);
    expect(isReloadKey(key('F1'))).toBe(false);
  });

  // What F5 does — asks over typed work, refreshes the page in place, and never lets a held-down
  // F5 through to the window's reload — is tested by pressing F5 on the real guard in a browser
  // engine: test/dom/leaveGuard.dom.tsx (test/leaveGuardDom.test.ts).
});
