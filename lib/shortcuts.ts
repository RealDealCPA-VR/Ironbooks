/**
 * Desktop-ergonomics primitives shared by the UI kit and the app shell. The keys are QuickBooks
 * Desktop's, so 30 years of muscle memory carry over:
 *
 *  - evaluateAmountDecimal / evaluateAmountExpression / isMathExpression / formatAmountResult:
 *    the safe QuickMath parser behind <AmountInput> (components/ui.tsx). No eval — a tiny
 *    recursive-descent parser supporting + - * / and parentheses, in decimal arithmetic.
 *  - adjustDateForKey: QuickBooks date-entry keys (+ - T W K M H Y R [ ] ; ') for date inputs.
 *  - stepDocNumber: + / - in check and invoice number fields (<DocNumberInput>).
 *  - GLOBAL_SHORTCUTS / globalShortcutFor: the single source of truth for the global handlers
 *    (components/AppShell.tsx GlobalShortcuts, components/KeyboardCommands.tsx). The "?" help
 *    lists lib/qbShortcuts.ts: QuickBooks' complete list, each key marked done or why not.
 *  - isEditableTarget: shared guard so global shortcuts ignore keystrokes in fields.
 *  - formShortcutFor / pickShortcutButton / gridKeyAction: pure key logic behind Ctrl+N / Ctrl+S /
 *    Save & New / Alt+S / Alt+A / Esc (components/FormShortcuts.tsx) and the line-grid keys.
 *  - useGridKeys: keyboard row insert/delete + Enter/Down/Up between lines for line-item grids.
 *  - useListKeys / listKeyAction / typeAheadMatch / pickCommandButton: QB list keys (arrows,
 *    Home / End, PgUp / PgDn, Enter, type-ahead) for every list, center and register.
 */
import * as React from 'react';
import Decimal from 'decimal.js';
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  isValid,
  parseISO,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from 'date-fns';

// ---------------------------------------------------------------------------
// QuickMath: safe arithmetic for amount fields (NO eval)
// ---------------------------------------------------------------------------

/**
 * True when the raw field text looks like a math expression rather than a plain
 * number: contains * / ( ), or a + / - that is not just a leading sign.
 * Plain numbers (including "-12.50", "$1,200") return false and pass through untouched.
 */
export function isMathExpression(raw: string): boolean {
  const s = normalizeAmountText(raw);
  if (!s) return false;
  if (/[*/()]/.test(s)) return true;
  // A + or - anywhere after the first character means arithmetic, not a sign.
  return /[+\-]/.test(s.slice(1));
}

/** Strip currency adornments ($, commas, whitespace) before parsing. */
function normalizeAmountText(raw: string): string {
  return raw.replace(/[$,\s]/g, '');
}

/** QuickMath's own decimal context (not the app-wide one): exact enough for any amount. */
const QDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/**
 * Safely evaluate an arithmetic expression with + - * / and parentheses, in exact decimal
 * arithmetic (like lib/money — never JS floats, so "1234567.89/2" is exactly 617283.945).
 * Returns the result, or null when the expression is invalid (syntax error, division by zero,
 * empty input). Never uses eval.
 *
 *   evaluateAmountDecimal('12.5*3+10')?.toString() === '47.5'
 */
export function evaluateAmountDecimal(raw: string): Decimal | null {
  const s = normalizeAmountText(raw);
  if (!s) return null;
  const state = { src: s, pos: 0, failed: false };

  const value = parseExpr(state);
  if (state.failed || state.pos !== state.src.length || !value || !value.isFinite()) return null;
  return value;
}

/**
 * evaluateAmountDecimal as a plain number (for callers that only need the magnitude). Money
 * fields use evaluateAmountDecimal + formatAmountResult so the cents are rounded exactly.
 *
 *   evaluateAmountExpression('12.5*3+10') === 47.5
 */
export function evaluateAmountExpression(raw: string): number | null {
  const value = evaluateAmountDecimal(raw);
  return value === null ? null : value.toNumber();
}

interface ParseState {
  src: string;
  pos: number;
  failed: boolean;
}

function peek(st: ParseState): string {
  return st.src[st.pos] ?? '';
}

/** expr := term (('+' | '-') term)* */
function parseExpr(st: ParseState): Decimal | null {
  let left = parseTerm(st);
  while (!st.failed && left) {
    const op = peek(st);
    if (op !== '+' && op !== '-') break;
    st.pos++;
    const right = parseTerm(st);
    if (!right) return null;
    left = op === '+' ? left.plus(right) : left.minus(right);
  }
  return st.failed ? null : left;
}

/** term := factor (('*' | '/') factor)* */
function parseTerm(st: ParseState): Decimal | null {
  let left = parseFactor(st);
  while (!st.failed && left) {
    const op = peek(st);
    if (op !== '*' && op !== '/') break;
    st.pos++;
    const right = parseFactor(st);
    if (!right) return null;
    if (op === '*') left = left.times(right);
    else if (right.isZero()) {
      st.failed = true; // division by zero -> invalid expression
      return null;
    } else left = left.dividedBy(right);
  }
  return st.failed ? null : left;
}

/** factor := ('+' | '-') factor | '(' expr ')' | number */
function parseFactor(st: ParseState): Decimal | null {
  const c = peek(st);
  if (c === '+') {
    st.pos++;
    return parseFactor(st);
  }
  if (c === '-') {
    st.pos++;
    const v = parseFactor(st);
    return v ? v.negated() : null;
  }
  if (c === '(') {
    st.pos++;
    const v = parseExpr(st);
    if (!v || peek(st) !== ')') {
      st.failed = true;
      return null;
    }
    st.pos++;
    return v;
  }
  return parseNumber(st);
}

/** number := digits ['.' digits] | '.' digits */
function parseNumber(st: ParseState): Decimal | null {
  const start = st.pos;
  while (/[0-9]/.test(peek(st))) st.pos++;
  if (peek(st) === '.') {
    st.pos++;
    while (/[0-9]/.test(peek(st))) st.pos++;
  }
  const text = st.src.slice(start, st.pos);
  // Must contain at least one digit ('.', '' are invalid).
  if (!/[0-9]/.test(text)) {
    st.failed = true;
    return null;
  }
  return new QDecimal(text);
}

/**
 * Round an evaluated amount to cents for a money field the way the books round (lib/money
 * Money.round2: half away from zero), without trailing zeros, -0 or exponent notation:
 * 47.5 → '47.5', 617283.945 → '617283.95', -2.555 → '-2.56'.
 */
export function formatAmountResult(n: number | string | Decimal): string {
  const cents = new QDecimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return cents.isZero() ? '0' : cents.toFixed();
}

/** A plain amount once $ and spaces are gone: digits with real thousands groups ("1,250.50"). */
const GROUPED_AMOUNT_RE = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d*)?$/;

/**
 * What an amount field holds once the user commits it (blur, or Enter in the field):
 *  - QuickMath ("12.5*3+10") is worked out in exact decimals and rounded to cents half-up, as
 *    lib/money rounds on the server ("8.03*1.5" → "12.05"; the old float math kept 12.04);
 *  - a plain amount typed with a $ sign, spaces or thousands separators ("$1,250.50") becomes the
 *    bare number ("1250.50"). The forms add amounts with Number(), which reads "1,250.50" as NaN:
 *    a payment applied as "1,250.00" was silently dropped, and the API (zMoney) refuses commas.
 * Null when there is nothing to change (a plain number, or text that is not an amount — the
 * page's own validation reports that).
 */
export function committedAmountText(raw: string): string | null {
  if (isMathExpression(raw)) {
    const d = evaluateAmountDecimal(raw);
    if (d === null) return null;
    const next = formatAmountResult(d);
    return next === raw ? null : next;
  }
  const s = normalizeAmountText(raw);
  if (!s || s === raw) return null;
  // Only real thousands groups: a decimal comma ("12,50") is left as typed for validation to flag.
  if (!GROUPED_AMOUNT_RE.test(raw.replace(/[\s$]/g, ''))) return null;
  return s;
}

// ---------------------------------------------------------------------------
// QuickBooks date-entry keys
// ---------------------------------------------------------------------------

/**
 * Where "today" comes from for the T key and for an empty date field: the company's calendar
 * (Company Preferences > time zone), registered by components/PreferenceBehaviors.tsx. Until a
 * company is open (sign-in, setup interview) it is this computer's own day — never the UTC day.
 */
let companyToday: (() => string | null) | null = null;

/** Register (or clear, with null) the company's "today" for the QuickBooks date keys. */
export function setDateKeyToday(fn: (() => string | null) | null) {
  companyToday = fn;
}

function todayDate(today?: string): Date {
  const iso = today ?? companyToday?.() ?? null;
  const d = iso ? parseISO(iso) : null;
  return d && isValid(d) ? d : new Date();
}

/**
 * Apply a QB date-entry key to a yyyy-MM-dd value:
 *   + / =  next day                -      previous day
 *   t      today
 *   w / k  first / last day of the week (Sunday – Saturday, as in QB)
 *   m / h  first / last day of month
 *   y / r  first / last day of year
 *   [ / ]  same day previous / next week
 *   ; / '  same day previous / next month (Jan 31 → Feb 28)
 * Returns the new yyyy-MM-dd string, or null when the key is not a date key
 * (so the caller lets the event through untouched). Empty/invalid `current`
 * falls back to today: `today` when given, else the company's (setDateKeyToday).
 *
 * ; and ': QuickBooks' own Help and the long-standing lists (QBK Accounting, Axpert Advisors)
 * give ; = last month and ' = next month — left / right on the keyboard, like [ ] and - +.
 * Intuit's current web article lists them the other way round; the keyboard layout and the
 * in-product Help win (lib/qbShortcuts.ts).
 */
export function adjustDateForKey(key: string, current?: string, today?: string): string | null {
  if (key.length > 1) return null; // named keys (ArrowUp, Tab, ...) pass through
  const parsed = current ? parseISO(current) : todayDate(today);
  const base = isValid(parsed) ? parsed : todayDate(today);
  let next: Date;
  switch (key.toLowerCase()) {
    case '+':
    case '=': // unshifted "+" key
      next = addDays(base, 1);
      break;
    case '-':
      next = addDays(base, -1);
      break;
    case 't':
      next = todayDate(today);
      break;
    case 'w':
      next = startOfWeek(base);
      break;
    case 'k':
      next = endOfWeek(base);
      break;
    case 'm':
      next = startOfMonth(base);
      break;
    case 'h':
      next = endOfMonth(base);
      break;
    case 'y':
      next = startOfYear(base);
      break;
    case 'r':
      next = endOfYear(base);
      break;
    case '[':
      next = addWeeks(base, -1);
      break;
    case ']':
      next = addWeeks(base, 1);
      break;
    case ';':
      next = addMonths(base, -1);
      break;
    case "'":
      next = addMonths(base, 1);
      break;
    default:
      return null;
  }
  return format(next, 'yyyy-MM-dd');
}

/** Alt+Down in a date field: open its calendar (QB "Open calendar to select a date"). */
export function isCalendarKey(e: KeyLike): boolean {
  return e.key === 'ArrowDown' && e.altKey && !ctrlOrCmd(e) && !e.shiftKey;
}

// ---------------------------------------------------------------------------
// Document numbers (+ / - in check and invoice number fields)
// ---------------------------------------------------------------------------

/**
 * QB "+ / -" in a check / invoice / document number field: step the number at the end of the
 * text, keeping its prefix and zero padding ('INV-0099' + → 'INV-0100', '1001' - → '1000').
 * Returns the new text, the same text when it would go below zero, or null when the key is not
 * + / - or the text does not end in digits — so '-' still types after letters ('INV-').
 */
export function stepDocNumber(key: string, value: string): string | null {
  const delta = key === '+' || key === '=' ? 1 : key === '-' ? -1 : 0;
  if (!delta) return null;
  const m = /^(.*?)(\d+)$/.exec(value.trim());
  if (!m || m[2].length > 15) return null;
  const [, prefix, digits] = m;
  const next = Number(digits) + delta;
  if (next < 0) return value;
  const text = String(next);
  // Keep a zero-padded width ('0099' → '0100'); unpadded numbers just grow or shrink.
  const padded = digits.length > 1 && digits.startsWith('0') ? text.padStart(digits.length, '0') : text;
  return prefix + padded;
}

// ---------------------------------------------------------------------------
// Global shortcuts (navigation: GlobalShortcuts in components/AppShell.tsx, which also renders
// the "?" help; commands: components/KeyboardCommands.tsx)
// ---------------------------------------------------------------------------

/**
 * What a non-navigation shortcut does. Handled by components/KeyboardCommands.tsx, except
 * 'memorize' (components/MemorizeButton.tsx), 'palette' / 'search' (components/CommandPalette.tsx),
 * the window keys (components/WindowList.tsx), 'refresh' (components/LeaveGuard.tsx) and
 * 'shortcuts' (components/AppShell.tsx).
 */
export type GlobalCommand =
  | 'edit'
  | 'delete'
  | 'print'
  | 'journal'
  | 'history'
  | 'quick-report'
  | 'open-list'
  | 'help'
  | 'memorize'
  | 'palette'
  /** Ctrl+R: the highlighted account's register, else the register list. */
  | 'register'
  /** Ctrl+G: the register of the other account of the highlighted register transaction. */
  | 'transfer'
  /** Ctrl+O: copy the highlighted register transaction (Ctrl+V pastes it on the blank line). */
  | 'copy-transaction'
  /** Ctrl+U: use the list item — take the picker's highlighted entry, or "use" a list row. */
  | 'use'
  /** F2 / Ctrl+1: Product Information. */
  | 'product-info'
  /** F3 / Ctrl+2: Search. */
  | 'search'
  /** Ctrl+F4: close the open form, else the page (back to the window before it). */
  | 'close-window'
  /** Ctrl+Tab / Ctrl+F6, and with Shift the other way: the next / previous open window. */
  | 'next-window'
  | 'prev-window'
  /** F5: refresh the window's data. */
  | 'refresh'
  /** ?: the keyboard shortcuts list. */
  | 'shortcuts';

export interface ShortcutDef {
  /** Human-readable combo for the help modal, e.g. 'Ctrl+I'. */
  keys: string;
  /** Lowercase letter (or digit) matched with ctrl/cmd held. */
  ctrlKey?: string;
  /** Named key matched with no modifier held (F1). */
  key?: string;
  /** Named key matched with ctrl/cmd held (Ctrl+F4, Ctrl+Tab). */
  ctrlNamed?: string;
  /** Named key matched with ctrl/cmd and Shift held (Ctrl+Shift+Tab). */
  ctrlShiftNamed?: string;
  /**
   * Destination for navigation shortcuts (components/AppShell.tsx GlobalShortcuts). With a
   * `command` too, the command decides from what is selected and falls back to the page.
   */
  href?: string;
  /** Action for the other shortcuts. */
  command?: GlobalCommand;
  /**
   * Whether the shortcut also fires while the cursor is in a text field. Default true: QB opens
   * its windows from inside a form. False where the key means something while typing (Ctrl+A
   * selects all) or only makes sense on a list row.
   */
  inFields?: boolean;
  description: string;
}

/** QuickBooks Desktop's global keys (the full QuickBooks list, with sources: lib/qbShortcuts.ts). */
export const GLOBAL_SHORTCUTS: ShortcutDef[] = [
  { keys: 'Ctrl+W', ctrlKey: 'w', href: '/expenses?new=1', description: 'Write Checks' },
  { keys: 'Ctrl+I', ctrlKey: 'i', href: '/invoices?new=1', description: 'Create Invoices' },
  { keys: 'Ctrl+J', ctrlKey: 'j', href: '/customers', description: 'Customer Center' },
  {
    keys: 'Ctrl+A',
    ctrlKey: 'a',
    href: '/accounts',
    inFields: false,
    description: 'Chart of Accounts (in a text field Ctrl+A still selects the text)',
  },
  {
    keys: 'Ctrl+R',
    ctrlKey: 'r',
    href: '/registers',
    command: 'register',
    description: "Use Register: the highlighted account's register, else choose an account",
  },
  { keys: 'Ctrl+T', ctrlKey: 't', href: '/recurring', description: 'Memorized Transaction List' },
  { keys: 'Ctrl+F', ctrlKey: 'f', href: '/find', description: 'Find transactions' },
  { keys: 'Ctrl+E', ctrlKey: 'e', command: 'edit', inFields: false, description: 'Edit the selected row of a list or register' },
  {
    keys: 'Ctrl+D',
    ctrlKey: 'd',
    command: 'delete',
    description: 'Delete the selected row or the open transaction (in a line grid: the line)',
  },
  { keys: 'Ctrl+P', ctrlKey: 'p', command: 'print', description: 'Print the open form, report or selected row' },
  { keys: 'Ctrl+Y', ctrlKey: 'y', command: 'journal', description: 'Transaction Journal of the selected transaction' },
  { keys: 'Ctrl+H', ctrlKey: 'h', command: 'history', description: 'Transaction History of the selected transaction' },
  {
    keys: 'Ctrl+Q',
    ctrlKey: 'q',
    command: 'quick-report',
    inFields: false,
    description: 'QuickReport for the selected customer, vendor, employee or account',
  },
  { keys: 'Ctrl+M', ctrlKey: 'm', command: 'memorize', description: 'Memorize the open transaction' },
  { keys: 'Ctrl+L', ctrlKey: 'l', command: 'open-list', description: 'Open the drop-down list of the field you are in' },
  { keys: 'Ctrl+K', ctrlKey: 'k', command: 'palette', description: 'Search & command palette' },
  {
    keys: 'Ctrl+G',
    ctrlKey: 'g',
    command: 'transfer',
    inFields: false,
    description: "In a register: go to the other account's register for the highlighted transaction",
  },
  {
    keys: 'Ctrl+O',
    ctrlKey: 'o',
    command: 'copy-transaction',
    inFields: false,
    description: 'In a register: copy the highlighted transaction (Ctrl+V on the blank line pastes it)',
  },
  { keys: 'Ctrl+U', ctrlKey: 'u', command: 'use', description: 'Use the highlighted list item' },
  { keys: 'Ctrl+1', ctrlKey: '1', command: 'product-info', description: 'Product Information' },
  { keys: 'Ctrl+2', ctrlKey: '2', command: 'search', description: 'Search' },
  { keys: 'F1', key: 'F1', command: 'help', description: 'Help for this page' },
  { keys: 'F2', key: 'F2', command: 'product-info', description: 'Product Information' },
  { keys: 'F3', key: 'F3', command: 'search', description: 'Search' },
  { keys: 'F5', key: 'F5', command: 'refresh', description: "Refresh the window's lists and totals" },
  { keys: 'Ctrl+F4', ctrlNamed: 'F4', command: 'close-window', description: 'Close the open form or window' },
  { keys: 'Ctrl+Tab', ctrlNamed: 'Tab', command: 'next-window', description: 'Next open window' },
  { keys: 'Ctrl+F6', ctrlNamed: 'F6', command: 'next-window', description: 'Next open window' },
  { keys: 'Ctrl+Shift+Tab', ctrlShiftNamed: 'Tab', command: 'prev-window', description: 'Previous open window' },
  { keys: 'Ctrl+Shift+F6', ctrlShiftNamed: 'F6', command: 'prev-window', description: 'Previous open window' },
  { keys: '?', command: 'shortcuts', inFields: false, description: 'Show this shortcuts help' },
];

/** The a-z letter or 0-9 digit of a Ctrl+key press (physical key on other layouts: Ctrl+1 on AZERTY). */
function ctrlCharOf(e: KeyLike): string | null {
  const letter = letterOf(e);
  if (letter) return letter;
  if (/^[0-9]$/.test(e.key)) return e.key;
  const m = /^Digit([0-9])$/.exec(e.code ?? '');
  return m ? m[1] : null;
}

/**
 * The global shortcut a key press asks for, or null. `editable`: the key was typed in a text
 * field (isEditableTarget), where shortcuts marked inFields: false stay with the field. Uses the
 * physical key as a fallback so Ctrl+letter works on non-Latin keyboard layouts.
 */
export function globalShortcutFor(e: KeyLike, editable: boolean): ShortcutDef | null {
  if (e.altKey) return null;
  let def: ShortcutDef | undefined;
  if (ctrlOrCmd(e) && e.shiftKey) {
    def = GLOBAL_SHORTCUTS.find((s) => s.ctrlShiftNamed && s.ctrlShiftNamed === e.key);
  } else if (ctrlOrCmd(e)) {
    if (e.key.length > 1) def = GLOBAL_SHORTCUTS.find((s) => s.ctrlNamed && s.ctrlNamed === e.key);
    if (!def) {
      const c = ctrlCharOf(e);
      if (!c) return null;
      def = GLOBAL_SHORTCUTS.find((s) => s.ctrlKey === c);
    }
  } else if (!e.shiftKey) {
    def = GLOBAL_SHORTCUTS.find((s) => s.key && s.key === e.key);
  }
  if (!def || (editable && def.inFields === false)) return null;
  return def;
}

/** Lowercase key for QB "Memorize Transaction" (Ctrl+M) — listened for by MemorizeButton. */
export const MEMORIZE_SHORTCUT = 'm';

/** Input types that hold a choice, not typed text (a checkbox's Ctrl+E is still Edit). */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color']);

/**
 * True when the keyboard event originates inside a control you type into (a text input,
 * textarea, select or contentEditable), so global single-key shortcuts must not fire and keys
 * like Ctrl+A / Ctrl+E stay with the field. Checkboxes, radios and buttons are not: the QB keys
 * (Ctrl+E, Ctrl+Q, ?, …) work there as on the page.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String((el as HTMLInputElement).type ?? 'text').toLowerCase());
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * True for any field that holds part of a form's work: what isEditableTarget covers plus
 * checkboxes and radios (the bills ticked in Pay Bills, the payments in Make Deposits).
 */
export function isFormField(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  if (el.tagName === 'INPUT') {
    const type = String((el as HTMLInputElement).type ?? 'text').toLowerCase();
    return type !== 'hidden' && type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'image';
  }
  return isEditableTarget(el);
}

// ---------------------------------------------------------------------------
// Leaving a form: the app shows one page at a time where QB would open a second window
// ---------------------------------------------------------------------------

/**
 * Marks a page with answers that live only on screen until a last step saves them (the setup
 * interview): `<div data-unsaved-work>`. Leaving or reloading asks first while it is there.
 */
export const UNSAVED_WORK_ATTR = 'data-unsaved-work';

/**
 * Leaving the page now could drop typed work: a form dialog (with fields) is open, a page says
 * it holds unsaved answers (data-unsaved-work), or the cursor is in a field on the page (not a
 * search box). `root` is the document (a stand-in in tests).
 */
export function mightLoseWork(target: EventTarget | null, root: Pick<ParentNode, 'querySelectorAll'> = document): boolean {
  const dialogs = Array.from(root.querySelectorAll<HTMLElement>('[role="dialog"][data-modal]'));
  if (dialogs.some((d) => d.querySelector('input:not([type="hidden"]), select, textarea'))) return true;
  if (root.querySelectorAll(`[${UNSAVED_WORK_ATTR}]`).length > 0) return true;
  const el = target as HTMLElement | null;
  return isFormField(el) && !!el?.closest?.('main') && (el as HTMLInputElement).type !== 'search';
}

/**
 * Whether leaving could lose work, judged from where the cursor is — or, when the command bar or
 * the title-bar menu has taken the focus (they live outside the page), from the field the cursor
 * was in just before (`remembered`, kept by components/LeaveGuard.tsx). So choosing a page from
 * the command bar, or with the mouse from the menu bar, asks exactly when Ctrl+W from that field
 * would.
 */
export function leaveRisk(
  active: Element | null,
  remembered: Element | null,
  root: Pick<ParentNode, 'querySelectorAll'> = document,
): boolean {
  if (mightLoseWork(active, root)) return true;
  const onPage = !!active?.closest?.('main, [role="dialog"]') && !active?.closest?.('[data-shell-chrome]');
  if (onPage || !remembered) return false;
  return (remembered as Element & { isConnected?: boolean }).isConnected !== false && mightLoseWork(remembered, root);
}

/**
 * F5 (no modifiers): QB's "Refresh list". Here the window's data is fetched again
 * (components/LeaveGuard.tsx); with typed work on screen it asks first.
 */
export function isReloadKey(e: KeyLike): boolean {
  return e.key === 'F5' && !ctrlOrCmd(e) && !e.altKey && !e.shiftKey;
}

/**
 * Asks the leave-this-form guard (components/LeaveGuard.tsx, on every page) to open a page: it
 * asks "Leave this form?" first when typed work could be lost, exactly like the QuickBooks keys
 * (Ctrl+W, …). detail: { href, go? } — `go` runs instead of a plain router push once leaving is
 * decided (the command bar hands a pre-filled form over that way); or { history: 'back' | 'forward' }.
 */
export const NAVIGATE_REQUEST_EVENT = 'ironbooks:navigate';

export interface NavigateRequest {
  href?: string;
  history?: 'back' | 'forward';
  go?: (href: string) => void;
}

/**
 * Open `href` the way the QuickBooks keys do — through the leave-this-form check — for the
 * desktop menus, the command bar and the keys. Falls back to `push` when no guard is listening
 * (only in tests: components/LeaveGuard.tsx is mounted on every page). Returns whether the guard
 * took it.
 */
export function navigateGuarded(
  href: string,
  push: (href: string) => void,
  target: EventTarget = window,
  options: { go?: (href: string) => void } = {},
): boolean {
  const detail: NavigateRequest = { href, go: options.go };
  const ev = new CustomEvent(NAVIGATE_REQUEST_EVENT, { detail, cancelable: true });
  target.dispatchEvent(ev);
  if (ev.defaultPrevented) return true;
  (options.go ?? push)(href);
  return false;
}

/** Window > Back / Forward (Alt+Left / Alt+Right) through the same check. */
export function historyGuarded(direction: 'back' | 'forward', target: EventTarget = window): boolean {
  const detail: NavigateRequest = { history: direction };
  const ev = new CustomEvent(NAVIGATE_REQUEST_EVENT, { detail, cancelable: true });
  target.dispatchEvent(ev);
  if (ev.defaultPrevented) return true;
  if (typeof window !== 'undefined') {
    if (direction === 'back') window.history.back();
    else window.history.forward();
  }
  return false;
}

/**
 * F5 / View > Refresh: asks components/LeaveGuard.tsx to refresh the window (fetch its data
 * again), asking first when typed work could be lost.
 */
export const REFRESH_REQUEST_EVENT = 'ironbooks:refresh-request';

/**
 * Sent once a refresh is decided. The page area (components/PageRefresh.tsx) starts the page
 * over in place and marks the event handled; on screens without it the window reloads.
 */
export const PAGE_REFRESH_EVENT = 'ironbooks:refresh-page';

// ---------------------------------------------------------------------------
// Pure key classification (unit-tested; the DOM wiring lives in useGridKeys, useListKeys,
// components/FormShortcuts.tsx and components/KeyboardCommands.tsx)
// ---------------------------------------------------------------------------

/** The parts of a KeyboardEvent the shortcut logic looks at. */
export interface KeyLike {
  key: string;
  /** Physical key ('KeyS'); used when a layout turns Ctrl+Alt+S into another character. */
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const ctrlOrCmd = (e: KeyLike) => e.ctrlKey || e.metaKey;

/** The a-z letter of a key press: the typed letter, else the physical key (AltGr / non-Latin layouts). */
function letterOf(e: KeyLike): string | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : '';
  if (/^[a-z]$/.test(key)) return key;
  const m = /^Key([A-Z])$/.exec(e.code ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** The letter of an Alt+letter press (no Ctrl / Cmd / Shift), or null. */
export function altLetter(e: KeyLike): string | null {
  if (!e.altKey || ctrlOrCmd(e) || e.shiftKey) return null;
  return letterOf(e);
}

/** Form-level actions QuickBooks users expect on every list / form page. */
export type FormShortcutAction =
  | 'new'
  | 'save'
  | 'save-new'
  | 'save-close'
  | 'cancel'
  | 'revert'
  | 'prev'
  | 'next';

/**
 * QB's underlined form-button letters. They only act inside a form or dialog that has the
 * button (components/FormShortcuts.tsx); elsewhere Alt+letter opens the menus.
 */
export const FORM_ALT_KEYS: Readonly<Record<string, FormShortcutAction>> = {
  s: 'save-new',
  a: 'save-close',
  r: 'revert',
  p: 'prev',
  n: 'next',
};

/**
 * Which form action a key combination asks for:
 *   Ctrl+N new · Ctrl+S save · Alt+S, Ctrl+Alt+S or Ctrl+Enter save & new · Alt+A save & close ·
 *   Alt+R revert · Alt+P / Alt+N previous / next · Esc cancel.
 * Returns null for everything else (the key is left alone).
 */
export function formShortcutFor(e: KeyLike): FormShortcutAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const isS = key === 's' || e.code === 'KeyS';
  if (ctrlOrCmd(e) && e.altKey && !e.shiftKey && isS) return 'save-new';
  if (ctrlOrCmd(e) && !e.altKey && !e.shiftKey) {
    if (key === 'Enter') return 'save-new';
    if (isS) return 'save';
    if (key === 'n' || e.code === 'KeyN') return 'new';
    return null;
  }
  const letter = altLetter(e);
  if (letter) return FORM_ALT_KEYS[letter] ?? null;
  if (key === 'Escape' && !ctrlOrCmd(e) && !e.altKey && !e.shiftKey) return 'cancel';
  return null;
}

export interface FormShortcutEnv {
  /** A modal dialog is open (it owns Esc and is the scope for Save). */
  dialogOpen: boolean;
  /** Focus is in an open picker list (combobox with aria-expanded=true). */
  pickerOpen: boolean;
  /** IME composition in progress. */
  composing?: boolean;
}

/**
 * Whether a form shortcut should run here. Save / Save & New work from inside fields (that is
 * where people are when they finish a form); New is for list pages, so not while a dialog is
 * open; Esc belongs to the open dialog or picker when there is one.
 */
export function shouldRunFormShortcut(action: FormShortcutAction, env: FormShortcutEnv): boolean {
  if (env.composing) return false;
  switch (action) {
    case 'new':
      return !env.dialogOpen;
    case 'save':
    case 'save-new':
    case 'save-close':
    case 'revert':
    case 'prev':
    case 'next':
      return !env.pickerOpen;
    case 'cancel':
      return !env.dialogOpen && !env.pickerOpen;
  }
}

/** A clickable button as seen by the shortcut handler. */
export interface ShortcutButton {
  /** Visible text (or aria-label / title). */
  label: string;
  /** Explicit data-shortcut="new|save|save-new|save-close|cancel|revert|prev|next|open|edit|delete|print". */
  shortcut?: string | null;
  disabled?: boolean;
}

const SAVE_NEW_RE = /^save\s*(&|and|\+)\s*new\b/i;
const SAVE_CLOSE_RE = /^save\s*(&|and|\+)\s*close\b/i;
const SAVE_RE = /^(save|record|post|create|ok|done)\b/i;
const NEW_RE = /^(\+\s*)?new\b/i;
const ADD_RE = /^(\+\s*)?add\b/i;
const CANCEL_RE = /^(cancel|close)$/i;
const PREV_RE = /^([<\u2039\u2190]\s*)?prev(ious)?\b/i;
const NEXT_RE = /^next\b/i;

const normLabel = (label: string) => label.replace(/\s+/g, ' ').trim();

/** 0 = not a match; higher = better match for the action. */
function buttonRank(b: ShortcutButton, action: FormShortcutAction): number {
  if (b.disabled) return 0;
  if (b.shortcut) return b.shortcut === action ? 10 : 0;
  const label = normLabel(b.label);
  switch (action) {
    case 'save-new':
      return SAVE_NEW_RE.test(label) ? 5 : 0;
    case 'save-close':
      // Our forms close when they save, so a plain Save is Save & Close.
      if (SAVE_CLOSE_RE.test(label)) return 5;
      if (SAVE_NEW_RE.test(label)) return 1;
      if (/^save\b/i.test(label)) return 4;
      return SAVE_RE.test(label) ? 3 : 0;
    case 'save':
      if (SAVE_NEW_RE.test(label)) return 1;
      if (/^save\b/i.test(label)) return 4;
      return SAVE_RE.test(label) ? 3 : 0;
    case 'new':
      if (NEW_RE.test(label)) return 4;
      return ADD_RE.test(label) ? 2 : 0;
    case 'cancel':
      return CANCEL_RE.test(label) ? 4 : 0;
    case 'revert':
      if (/^revert\b/i.test(label)) return 5;
      if (/^clear\b/i.test(label)) return 4;
      return /^reset\b/i.test(label) ? 3 : 0;
    case 'prev':
      return PREV_RE.test(label) ? 5 : 0;
    case 'next':
      return NEXT_RE.test(label) ? 5 : 0;
  }
}

/** Index of the best-ranked button (first in page order); -1 when none, or when `unique` and the best ties. */
function pickBest(count: number, rank: (i: number) => number, unique: boolean | undefined): number {
  let best = 0;
  let idx = -1;
  let ties = 0;
  for (let i = 0; i < count; i++) {
    const r = rank(i);
    if (r > best) {
      best = r;
      idx = i;
      ties = 1;
    } else if (r === best && r > 0) ties++;
  }
  if (idx >= 0 && unique && ties > 1 && best < 10) return -1;
  return idx;
}

/**
 * Pick the button a shortcut should press: an explicit data-shortcut wins, then the best label
 * match, first in page order. With `unique`, only press when exactly one button has the best
 * rank (so Ctrl+S on a page full of unrelated Save buttons does nothing rather than guess).
 * Returns the index, or -1.
 */
export function pickShortcutButton(
  buttons: ShortcutButton[],
  action: FormShortcutAction,
  options: { unique?: boolean } = {},
): number {
  return pickBest(buttons.length, (i) => buttonRank(buttons[i], action), options.unique);
}

/** What Enter / Ctrl+E / Ctrl+D / Ctrl+P do to a list row or an open form. */
export type RowCommand = 'open' | 'edit' | 'delete' | 'print';

const EDIT_RE = /^edit\b/i;
const OPEN_RE = /^(open|view|details?|show)\b/i;
const DELETE_RE = /^delete\b/i;
const VOID_RE = /^(void|discard)\b/i;
const REMOVE_RE = /^remove\b/i;
const INACTIVE_RE = /^(deactivate|inactivate|make inactive|mark inactive)\b/i;
const PRINT_RE = /^print\b/i;
const PDF_RE = /^(view )?pdf\b/i;

/** 0 = not a match; higher = better match for the command. */
function commandRank(b: ShortcutButton, cmd: RowCommand, scope: 'row' | 'form'): number {
  if (b.disabled) return 0;
  if (b.shortcut) return b.shortcut === cmd ? 10 : 0;
  const label = normLabel(b.label);
  switch (cmd) {
    case 'edit':
      return EDIT_RE.test(label) ? 5 : OPEN_RE.test(label) ? 3 : 0;
    case 'open':
      return OPEN_RE.test(label) ? 5 : EDIT_RE.test(label) ? 4 : 0;
    case 'delete':
      if (DELETE_RE.test(label)) return 5;
      if (VOID_RE.test(label)) return 4;
      // In a form, Remove / Deactivate act on a line or a field, not on the transaction.
      if (scope === 'form') return 0;
      if (REMOVE_RE.test(label)) return 3;
      return INACTIVE_RE.test(label) ? 2 : 0;
    case 'print':
      return PRINT_RE.test(label) ? 5 : PDF_RE.test(label) ? 3 : 0;
  }
}

/**
 * The button a row / form command presses (QB: Enter open, Ctrl+E edit, Ctrl+D delete — or void,
 * or make inactive when that is what the list offers — Ctrl+P print), by data-shortcut or label.
 * `scope: 'form'` keeps Ctrl+D to Delete / Void (never a line's Remove). Returns the index, or -1.
 */
export function pickCommandButton(
  buttons: ShortcutButton[],
  cmd: RowCommand,
  options: { scope?: 'row' | 'form'; unique?: boolean } = {},
): number {
  const scope = options.scope ?? 'row';
  return pickBest(buttons.length, (i) => commandRank(buttons[i], cmd, scope), options.unique);
}

/** Alt+Down or Ctrl+L: open the drop-down list of the picker the cursor is in (QB Ctrl+L). */
export function isOpenListKey(e: KeyLike): boolean {
  if (e.key === 'ArrowDown') return e.altKey && !ctrlOrCmd(e) && !e.shiftKey;
  return ctrlOrCmd(e) && !e.altKey && !e.shiftKey && letterOf(e) === 'l';
}

/** What a key does inside a line grid. 'next' on the last line adds a line. */
export type GridKeyAction = 'insert' | 'remove' | 'next' | 'prev' | 'copy-line' | 'paste-line' | null;

/** The focused cell, as the grid key logic needs it. */
export interface GridCell {
  tag: string;
  /** input type (text, date, number, checkbox...). */
  type?: string;
  /** aria-expanded="true": an open picker list owns the arrow / Enter keys. */
  expanded?: boolean;
  /** The input has a native suggestion list (list= / datalist), which uses the arrows. */
  hasList?: boolean;
}

const ARROW_SKIP_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'number', 'range', 'checkbox', 'radio']);

/**
 * Line-grid keys (QB ergonomics):
 *   Ctrl+Insert insert a line · Ctrl+Delete or Ctrl+D delete the line ·
 *   Ctrl+Alt+Y copy the line · Ctrl+Alt+V paste it into a blank line (QB 2018 and later) ·
 *   Enter / Down next line (adds one on the last line) · Up previous line.
 * Tab / Shift+Tab are left to the browser (cell to cell across the row, then the next row).
 */
export function gridKeyAction(e: KeyLike, cell: GridCell): GridKeyAction {
  const tag = cell.tag.toUpperCase();
  if (ctrlOrCmd(e) && e.altKey && !e.shiftKey) {
    const letter = letterOf(e);
    if (letter === 'y') return 'copy-line';
    if (letter === 'v') return 'paste-line';
    return null;
  }
  if (ctrlOrCmd(e) && !e.altKey && !e.shiftKey) {
    if (e.key === 'Insert') return 'insert';
    if (e.key === 'Delete' || e.key === 'd' || e.key === 'D' || e.code === 'KeyD') return 'remove';
    return null;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (cell.expanded) return null;
  if (e.key === 'Enter') {
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return null;
    return 'next';
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (tag !== 'INPUT' || cell.hasList || ARROW_SKIP_TYPES.has((cell.type ?? 'text').toLowerCase())) return null;
    return e.key === 'ArrowDown' ? 'next' : 'prev';
  }
  return null;
}

/**
 * QB date keys for a TEXT date cell (grids that accept typed or pasted dates such as "3/5/26"):
 * the key only acts when the cell is empty or already holds a complete date, so typing "2026-"
 * is never hijacked. Returns the new 'YYYY-MM-DD' value or null to let the key through.
 */
export function dateKeyForTextField(key: string, value: string, parse: (s: string) => string | null): string | null {
  if (key.length !== 1) return null;
  const v = value.trim();
  if (v === '') return adjustDateForKey(key, undefined);
  const iso = parse(v);
  if (!iso) return null;
  return adjustDateForKey(key, iso);
}

// ---------------------------------------------------------------------------
// useGridKeys: keyboard ergonomics for line-item grids
// ---------------------------------------------------------------------------

export interface GridKeysOptions {
  /** Append a new (blank) line. Called for Enter / Down on the last row (and Ctrl+Insert when no insertRow). */
  addRow: () => void;
  /** Remove the line at `index` (the row containing the focused cell). */
  removeRow: (index: number) => void;
  /** Optional: insert a blank line above `index` (Ctrl+Insert). Without it Ctrl+Insert appends. */
  insertRow?: (index: number) => void;
  /**
   * CSS selector marking one grid row inside the container.
   * Default: '[data-grid-row]'.
   */
  rowSelector?: string;
  /** Disable all handling (e.g. while saving). */
  disabled?: boolean;
}

const GRID_FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])';

function cellsOf(row: Element | undefined): HTMLElement[] {
  return row ? Array.from(row.querySelectorAll<HTMLElement>(GRID_FOCUSABLE)) : [];
}

function focusCell(el: HTMLElement | undefined) {
  if (!el) return;
  el.focus();
  if (el instanceof HTMLInputElement) el.select?.();
}

/**
 * Focus a cell on row `rowIdx` once the grid has re-rendered (after a line was added or removed):
 * retries for a few animation frames until the row exists and the row count changed.
 */
function focusAfterRender(container: HTMLElement, rowSelector: string, rowIdx: number, cellIdx: number, fromCount: number) {
  let tries = 0;
  const attempt = () => {
    const rows = Array.from(container.querySelectorAll<HTMLElement>(rowSelector));
    if (rows.length !== fromCount && rows.length > 0) {
      const row = rows[Math.min(rowIdx, rows.length - 1)];
      const cells = cellsOf(row);
      focusCell(cells[Math.max(0, Math.min(cellIdx, cells.length - 1))]);
      return;
    }
    if (++tries < 10) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** One cell of a copied line (Ctrl+Alt+Y), by what kind of field it is. */
export interface CopiedCell {
  kind: 'text' | 'select' | 'check' | 'combo';
  value: string;
  checked?: boolean;
}

/** The copied line, for Ctrl+Alt+V (QB keeps one line on its clipboard, for this session). */
let lineClipboard: CopiedCell[] | null = null;

/** The value-holding cells of a grid row (buttons left out), in Tab order. */
function lineFields(row: Element | undefined): HTMLElement[] {
  return cellsOf(row).filter((el) => el.tagName !== 'BUTTON' && !(el as HTMLInputElement).readOnly);
}

function cellKind(el: HTMLElement): CopiedCell['kind'] {
  if (el.tagName === 'SELECT') return 'select';
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
  if (type === 'checkbox' || type === 'radio') return 'check';
  return el.getAttribute('role') === 'combobox' ? 'combo' : 'text';
}

/** What Ctrl+Alt+Y copies from a line: each field's value (a picker's shown name). */
export function copyLineCells(row: Element): CopiedCell[] {
  return lineFields(row).map((el) => {
    const kind = cellKind(el);
    const input = el as HTMLInputElement;
    return kind === 'check' ? { kind, value: input.value, checked: input.checked } : { kind, value: input.value };
  });
}

/** A line with nothing typed in it yet (selects and checkboxes keep their defaults on a new line). */
export function isBlankLine(cells: CopiedCell[]): boolean {
  return cells.every((c) => c.kind === 'select' || c.kind === 'check' || c.value.trim() === '');
}

export function setLineClipboard(cells: CopiedCell[] | null) {
  lineClipboard = cells;
}
export function getLineClipboard(): CopiedCell[] | null {
  return lineClipboard;
}

const nextFrame = () => new Promise<void>((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

function setFieldValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

/**
 * Ctrl+Alt+V: fill a line's fields from the copied line, in order, the way typing would — so a
 * picked item still fills its rate and description first, and the copied ones then win. Pickers
 * (comboboxes) get the shown name typed and are left, which chooses the entry by its exact name.
 * Returns how many fields were filled.
 */
export async function pasteLineCells(row: Element, cells: CopiedCell[]): Promise<number> {
  let filled = 0;
  for (let i = 0; i < cells.length; i++) {
    const el = lineFields(row)[i] as HTMLInputElement | undefined;
    const c = cells[i];
    if (!el || cellKind(el) !== c.kind) continue;
    if (c.kind === 'check') {
      if (el.checked !== Boolean(c.checked)) el.click();
    } else if (c.kind === 'combo') {
      el.focus();
      setFieldValue(el, c.value);
      await nextFrame();
      el.blur();
    } else {
      setFieldValue(el, c.value);
    }
    filled++;
    await nextFrame();
  }
  return filled;
}

/** Run `fn` on row `rowIdx` once the grid has re-rendered with a different number of rows. */
function afterRowsChange(container: HTMLElement, rowSelector: string, fromCount: number, rowIdx: number, fn: (row: HTMLElement) => void) {
  let tries = 0;
  const attempt = () => {
    const rows = Array.from(container.querySelectorAll<HTMLElement>(rowSelector));
    if (rows.length !== fromCount && rows.length > 0) {
      fn(rows[Math.min(rowIdx, rows.length - 1)]);
      return;
    }
    if (++tries < 10) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/**
 * Keyboard handling for line-item grids (QB ergonomics):
 *
 *   Ctrl+Insert          insert a line (above the current one when `insertRow` is given)
 *   Ctrl+Delete / Ctrl+D delete the line containing the focused cell
 *   Ctrl+Alt+Y           copy the line (QB 2018+)
 *   Ctrl+Alt+V           paste the copied line into this line when it is blank, else into a new
 *                        blank line above it (below the last one when the grid can only append)
 *   Enter / Down         same cell on the next line; on the last line adds a line and moves there
 *   Up                   same cell on the previous line
 *   Tab / Shift+Tab      browser default: across the cells of a row, then on to the next row
 *
 * Open pickers (aria-expanded="true") and native suggestion lists keep their own arrow keys.
 *
 * ```tsx
 * const grid = useGridKeys({ addRow, removeRow: (i) => removeLine(i) });
 * <div onKeyDown={grid.onKeyDown}>
 *   {lines.map((line, i) => (
 *     <div key={i} data-grid-row>
 *       ...cells (inputs/selects)...
 *     </div>
 *   ))}
 * </div>
 * ```
 *
 * Rows are located via `rowSelector` (default '[data-grid-row]') so the hook works with
 * <tr data-grid-row> table rows and div-based grids alike.
 */
export function useGridKeys(options: GridKeysOptions): {
  onKeyDown: React.KeyboardEventHandler<HTMLElement>;
} {
  const { addRow, removeRow, insertRow, rowSelector = '[data-grid-row]', disabled = false } = options;
  const addRowRef = React.useRef(addRow);
  const removeRowRef = React.useRef(removeRow);
  const insertRowRef = React.useRef(insertRow);
  addRowRef.current = addRow;
  removeRowRef.current = removeRow;
  insertRowRef.current = insertRow;

  const onKeyDown = React.useCallback<React.KeyboardEventHandler<HTMLElement>>(
    (e) => {
      if (disabled || e.defaultPrevented) return;
      const container = e.currentTarget;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const action = gridKeyAction(e, {
        tag: target.tagName,
        type: (target as HTMLInputElement).type,
        expanded: target.getAttribute('aria-expanded') === 'true',
        hasList: target.hasAttribute('list'),
      });
      if (!action) return;

      const rows = Array.from(container.querySelectorAll<HTMLElement>(rowSelector));
      const rowIdx = rows.findIndex((r) => r.contains(target));
      const cellIdx = Math.max(0, cellsOf(rows[rowIdx]).indexOf(target));

      if (action === 'insert') {
        e.preventDefault();
        if (insertRowRef.current && rowIdx >= 0) {
          insertRowRef.current(rowIdx);
          focusAfterRender(container, rowSelector, rowIdx, 0, rows.length);
        } else {
          addRowRef.current();
          focusAfterRender(container, rowSelector, rows.length, 0, rows.length);
        }
        return;
      }
      if (rowIdx < 0) return;
      if (action === 'copy-line') {
        e.preventDefault();
        setLineClipboard(copyLineCells(rows[rowIdx]));
        return;
      }
      if (action === 'paste-line') {
        const copied = getLineClipboard();
        if (!copied) return;
        e.preventDefault();
        if (isBlankLine(copyLineCells(rows[rowIdx]))) {
          void pasteLineCells(rows[rowIdx], copied).then(() => focusCell(cellsOf(rows[rowIdx])[0]));
        } else if (insertRowRef.current) {
          insertRowRef.current(rowIdx);
          afterRowsChange(container, rowSelector, rows.length, rowIdx, (row) => void pasteLineCells(row, copied).then(() => focusCell(cellsOf(row)[0])));
        } else {
          addRowRef.current();
          afterRowsChange(container, rowSelector, rows.length, rows.length, (row) => void pasteLineCells(row, copied).then(() => focusCell(cellsOf(row)[0])));
        }
        return;
      }
      if (action === 'remove') {
        e.preventDefault();
        removeRowRef.current(rowIdx);
        focusAfterRender(container, rowSelector, Math.max(0, rowIdx - (rowIdx >= rows.length - 1 ? 1 : 0)), cellIdx, rows.length);
        return;
      }
      if (action === 'prev') {
        if (rowIdx === 0) return;
        e.preventDefault();
        focusCell(cellsOf(rows[rowIdx - 1])[cellIdx]);
        return;
      }
      // 'next'
      e.preventDefault();
      const nextRow = rows[rowIdx + 1];
      if (nextRow) {
        const nextCells = cellsOf(nextRow);
        focusCell(nextCells[cellIdx] ?? nextCells[0]);
      } else {
        // Last row: QB behavior, Enter / Down rolls into a fresh line (focus follows).
        addRowRef.current();
        focusAfterRender(container, rowSelector, rows.length, cellIdx, rows.length);
      }
    },
    [disabled, rowSelector],
  );

  return { onKeyDown };
}

// ---------------------------------------------------------------------------
// QB list keys: lists, centers, registers and reports
// ---------------------------------------------------------------------------

/** What a key does in a list: move the highlighted row, or open it. */
export type ListKeyAction = 'up' | 'down' | 'home' | 'end' | 'page-up' | 'page-down' | 'open';

const LIST_KEYS: Readonly<Record<string, ListKeyAction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'page-up',
  PageDown: 'page-down',
  Enter: 'open',
};

/**
 * Up / Down / Home / End / PgUp / PgDn move the highlight, Enter opens the row (no modifiers);
 * Ctrl+PgUp / Ctrl+PgDn go to the first / last row, as in QB's lists and registers.
 */
export function listKeyAction(e: KeyLike): ListKeyAction | null {
  if (e.altKey || e.shiftKey) return null;
  if (ctrlOrCmd(e)) return e.key === 'PageUp' ? 'home' : e.key === 'PageDown' ? 'end' : null;
  return LIST_KEYS[e.key] ?? null;
}

/**
 * The row to highlight after a move key. With nothing highlighted yet, Down / Home / PgDn start
 * at the top and Up / End / PgUp at the bottom (registers keep their newest entry last).
 */
export function nextListIndex(
  action: Exclude<ListKeyAction, 'open'>,
  current: number,
  count: number,
  pageSize = 10,
): number {
  if (count <= 0) return -1;
  const last = count - 1;
  if (current < 0 || current > last) return action === 'up' || action === 'end' || action === 'page-up' ? last : 0;
  const page = Math.max(1, pageSize);
  switch (action) {
    case 'up':
      return Math.max(0, current - 1);
    case 'down':
      return Math.min(last, current + 1);
    case 'home':
      return 0;
    case 'end':
      return last;
    case 'page-up':
      return Math.max(0, current - page);
    case 'page-down':
      return Math.min(last, current + page);
  }
}

/** A pause this long (ms) starts a new type-ahead word, as in QB / Windows lists. */
export const TYPE_AHEAD_MS = 1000;

/** A letter (any alphabet: it has an upper and a lower case) or a digit. */
const isWordChar = (c: string) => /[0-9]/.test(c) || c.toLowerCase() !== c.toUpperCase();

/**
 * The character a key adds to a list's type-ahead word, or null. A word must start with a
 * letter or digit (so '?' still opens the shortcuts help and Space still scrolls); once started,
 * spaces and punctuation continue it ("Joe's", "A & B").
 */
export function typeAheadChar(e: KeyLike, typed: string): string | null {
  if (ctrlOrCmd(e) || e.altKey || e.key.length !== 1) return null;
  if (!typed && !isWordChar(e.key)) return null;
  return e.key;
}

/** Lowercase, single spaces, without leading marks ('#1001' → '1001', '  Acme ' → 'acme'). */
function typeAheadLabel(s: string): string {
  const t = s.toLowerCase().replace(/\s+/g, ' ').trim();
  let i = 0;
  while (i < t.length && !isWordChar(t[i])) i++;
  return t.slice(i);
}

/**
 * QB type-ahead: the row to jump to for the typed word, or -1. A row matches when one of its
 * labels (its name / number columns) starts with the word, ignoring case and a leading '#'.
 * Typing one letter again moves on to the next row with that letter ("s", "s" walks the S's);
 * a longer word keeps the current row while it still matches.
 */
export function typeAheadMatch(labels: string[][], typed: string, current: number): number {
  const word = typed.toLowerCase().replace(/\s+/g, ' ');
  const n = labels.length;
  if (!word.trim() || n === 0) return -1;
  const rows = labels.map((ls) => ls.map(typeAheadLabel));
  const scan = (text: string, from: number) => {
    for (let k = 0; k < n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (rows[i].some((l) => l.startsWith(text))) return i;
    }
    return -1;
  };
  if (word.length === 1) return scan(word, current + 1);
  const hit = scan(word, Math.max(0, current));
  // "sss" with no row starting "sss": the same letter again, so walk the S's.
  if (hit < 0 && [...word].every((c) => c === word[0])) return scan(word[0], current + 1);
  return hit;
}

/** A table row as the list keys see it. */
export interface ListRowInfo {
  cells: number;
  /** One cell spanning the table: an empty-state message, not a record. */
  spansAll?: boolean;
  /** Holds a text field (a line grid, a register's entry row): its keys belong to the fields. */
  editable?: boolean;
  hidden?: boolean;
}

/** Whether the list keys move onto this row. */
export function isListRow(r: ListRowInfo): boolean {
  return r.cells > 0 && !r.hidden && !r.editable && !(r.cells === 1 && r.spansAll);
}

/** Marks the highlighted row of a list (styled in app/globals.css). */
export const LIST_ACTIVE_ATTR = 'data-list-active';

const LIST_TEXT_FIELDS =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="hidden"]), select, textarea, [contenteditable="true"]';

function listRowInfo(r: HTMLTableRowElement): ListRowInfo {
  return {
    cells: r.cells.length,
    spansAll: r.cells.length === 1 && r.cells[0].colSpan > 1,
    editable: !!r.querySelector(LIST_TEXT_FIELDS),
    hidden: r.getAttribute('aria-hidden') === 'true' || r.hasAttribute('data-list-skip') || r.getClientRects().length === 0,
  };
}

/** The table rows that belong to this list (not to a list or dialog nested in it). */
function ownRows(container: HTMLElement): HTMLTableRowElement[] {
  const dialog = container.closest('[role="dialog"]');
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody > tr')).filter(
    (r) => r.closest('[data-list]') === container && r.closest('[role="dialog"]') === dialog,
  );
}

/** The rows of a list container that the list keys move through. */
export function listRows(container: HTMLElement): HTMLElement[] {
  return ownRows(container).filter((r) => isListRow(listRowInfo(r)));
}

function hasListRow(container: HTMLElement): boolean {
  return ownRows(container).some((r) => isListRow(listRowInfo(r)));
}

/** The highlighted row of a list, or null. */
export function activeListRow(container: HTMLElement): HTMLElement | null {
  const row = container.querySelector<HTMLElement>(`[${LIST_ACTIVE_ATTR}]`);
  return row && row.closest('[data-list]') === container ? row : null;
}

/** Highlight `row` (null clears the highlight), scrolling it into view unless `scroll` is false. */
export function setActiveListRow(container: HTMLElement, row: HTMLElement | null, scroll = true) {
  container.querySelectorAll<HTMLElement>(`[${LIST_ACTIVE_ATTR}]`).forEach((r) => {
    if (r !== row && r.closest('[data-list]') === container) r.removeAttribute(LIST_ACTIVE_ATTR);
  });
  if (!row) return;
  row.setAttribute(LIST_ACTIVE_ATTR, '');
  if (scroll) row.scrollIntoView?.({ block: 'nearest' });
}

/** The words type-ahead matches on: data-list-label when the row has one, else its first two cells. */
function rowLabels(row: HTMLElement): string[] {
  const own = row.getAttribute('data-list-label');
  if (own) return [own];
  return Array.from((row as HTMLTableRowElement).cells ?? [])
    .slice(0, 2)
    .map((c) => c.textContent ?? '');
}

/** Rows per PgUp / PgDn: what fits in the list's own scroll area, else in the window. */
function pageSizeOf(container: HTMLElement, rows: HTMLElement[]): number {
  const rowHeight = rows[0]?.getBoundingClientRect().height || 32;
  const scrolls = container.scrollHeight > container.clientHeight + 1;
  const view = scrolls ? container.clientHeight : window.innerHeight;
  return Math.max(1, Math.floor(view / rowHeight) - 1);
}

const BUTTON_SELECTOR = 'button, [role="button"], a[data-shortcut], input[type="submit"]';

function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

/** The visible buttons inside `scope`, in page order. */
export function buttonsIn(scope: ParentNode): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(BUTTON_SELECTOR)).filter(isVisible);
}

const trimmed = (s: string | null | undefined) => (s ?? '').trim();

/** A button as the shortcut logic sees it: aria-label, else its text, value or title. */
export function describeButton(el: HTMLElement): ShortcutButton {
  return {
    label:
      trimmed(el.getAttribute('aria-label')) ||
      trimmed(el.textContent) ||
      trimmed((el as HTMLInputElement).value) ||
      trimmed(el.getAttribute('title')),
    shortcut: el.getAttribute('data-shortcut'),
    disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
  };
}

/**
 * The button inside `scope` (a list row, an open form) that a command presses, or null.
 * `exclude` drops buttons that belong to something else (a line of the form's grid).
 */
export function commandButton(
  scope: ParentNode,
  cmd: RowCommand,
  options: { scope?: 'row' | 'form'; unique?: boolean; exclude?: (el: HTMLElement) => boolean } = {},
): HTMLElement | null {
  const els = buttonsIn(scope).filter((el) => !options.exclude?.(el));
  const i = pickCommandButton(els.map(describeButton), cmd, options);
  return i >= 0 ? els[i] : null;
}

/** Rows that open on click (registers, the journal, report transactions): class or data-row-open. */
const opensOnClick = (row: HTMLElement) => row.hasAttribute('data-row-open') || row.classList.contains('cursor-pointer');

/** What a double-click on the row does: click it (rows that open on click) and double-click it (report rows). */
function activateRow(row: HTMLElement) {
  row.click();
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
}

/**
 * Open (Enter) or edit (Ctrl+E) a list row: a row that opens on click opens (Enter), else its
 * Edit / Open / View button, else the row itself, else its first link (QuickZoom). Returns
 * whether anything was opened.
 */
export function openListRow(row: HTMLElement, mode: 'open' | 'edit'): boolean {
  if (mode === 'open' && opensOnClick(row)) {
    activateRow(row);
    return true;
  }
  const btn = commandButton(row, mode);
  if (btn) {
    btn.click();
    return true;
  }
  if (opensOnClick(row)) {
    activateRow(row);
    return true;
  }
  const link = row.querySelector<HTMLElement>('a[href]:not([href^="mailto:"]):not([href^="tel:"])');
  if (link) {
    link.click();
    return true;
  }
  return false;
}

/** What a QuickReport (Ctrl+Q) can be run for. */
export type QuickReportKind = 'customer' | 'vendor' | 'employee' | 'account';

const QUICK_REPORT_PARAM: Readonly<Record<QuickReportKind, string>> = {
  customer: 'customerId',
  vendor: 'vendorId',
  employee: 'employeeId',
  account: 'accountId',
};

/**
 * QB QuickReport (Ctrl+Q) for a list entry: every transaction for the name or account, all dates
 * (Transaction Detail by Account, filtered). List rows carry it as data-quick-report.
 */
export function quickReportHref(kind: QuickReportKind, id: string): string {
  return `/reports/std/transaction-detail-by-account?dates=all&${QUICK_REPORT_PARAM[kind]}=${encodeURIComponent(id)}`;
}

export interface ListKeysOptions<T extends HTMLElement> {
  /** The container's ref, when the page already holds one (e.g. to scroll it). */
  ref?: React.RefObject<T | null>;
  /** Turn the keys off (the container stays a plain element). */
  disabled?: boolean;
}

/** Props to spread on a list's container element. */
export interface ListKeysProps<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  tabIndex: number;
  onKeyDown: React.KeyboardEventHandler<T>;
  onMouseDown: React.MouseEventHandler<T>;
  'data-list': string;
}

/**
 * QB list keys for a table of records. components/ui.tsx <Table> uses it, so every list, center
 * and table gets them; registers and report tables spread it on their own wrapper:
 *
 *   Up / Down       move the highlighted row        Home / End   first / last row
 *   PgUp / PgDn     a page at a time                Enter        open the row (openListRow)
 *   typing a name   jump to the first row that starts with it (QB type-ahead)
 *   click           highlights the row
 *
 * Ctrl+E / Ctrl+D / Ctrl+P / Ctrl+Y / Ctrl+H / Ctrl+Q act on the highlighted row
 * (components/KeyboardCommands.tsx). Rows holding text fields (line grids, a register's entry
 * row) are not list rows, and keys pressed on fields or buttons inside the list are left alone.
 * The container is a Tab stop only while it has rows to move through.
 *
 * ```tsx
 * const list = useListKeys<HTMLDivElement>();
 * <div {...list}><table>…</table></div>
 * ```
 */
export function useListKeys<T extends HTMLElement = HTMLDivElement>(options: ListKeysOptions<T> = {}): ListKeysProps<T> {
  const ownRef = React.useRef<T | null>(null);
  const ref = options.ref ?? ownRef;
  const disabled = options.disabled ?? false;
  const [tabStop, setTabStop] = React.useState(false);
  const typed = React.useRef({ text: '', at: 0 });

  // After every render (rows come and go with the data): a Tab stop only while there are rows.
  React.useEffect(() => {
    const has = !disabled && !!ref.current && hasListRow(ref.current);
    setTabStop((prev) => (prev === has ? prev : has));
  });

  const onKeyDown = React.useCallback<React.KeyboardEventHandler<T>>(
    (e) => {
      if (disabled || e.defaultPrevented || e.target !== e.currentTarget) return;
      const container = e.currentTarget;
      const rows = listRows(container);
      if (!rows.length) return;
      const active = activeListRow(container);
      const current = active ? rows.indexOf(active) : -1;
      const action = listKeyAction(e);
      if (action === 'open') {
        if (current >= 0 && openListRow(rows[current], 'open')) e.preventDefault();
        return;
      }
      if (action) {
        e.preventDefault();
        setActiveListRow(container, rows[nextListIndex(action, current, rows.length, pageSizeOf(container, rows))]);
        return;
      }
      const now = Date.now();
      const sofar = now - typed.current.at > TYPE_AHEAD_MS ? '' : typed.current.text;
      const ch = typeAheadChar(e, sofar);
      if (ch === null) return;
      e.preventDefault();
      typed.current = { text: sofar + ch, at: now };
      const hit = typeAheadMatch(rows.map(rowLabels), sofar + ch, current);
      if (hit >= 0) setActiveListRow(container, rows[hit]);
    },
    [disabled],
  );

  const onMouseDown = React.useCallback<React.MouseEventHandler<T>>(
    (e) => {
      if (disabled) return;
      const container = e.currentTarget;
      const row = (e.target as HTMLElement).closest?.('tr');
      if (row && listRows(container).includes(row)) setActiveListRow(container, row, false);
    },
    [disabled],
  );

  return { ref, tabIndex: tabStop ? 0 : -1, onKeyDown, onMouseDown, 'data-list': '' };
}

// ---------------------------------------------------------------------------
// Access keys (Alt + underlined letter)
// ---------------------------------------------------------------------------

/**
 * Split a button label around its access-key letter so it can be underlined:
 * accessKeyParts('Save transactions', 's') → { before: '', letter: 'S', after: 'ave transactions' }.
 * Prefers the first letter of a word, then any occurrence. Null when the letter is not in the label.
 */
export function accessKeyParts(label: string, key: string): { before: string; letter: string; after: string } | null {
  if (!key || key.length !== 1) return null;
  const k = key.toLowerCase();
  let at = -1;
  for (let i = 0; i < label.length; i++) {
    if (label[i].toLowerCase() === k && (i === 0 || /\s/.test(label[i - 1]))) {
      at = i;
      break;
    }
  }
  if (at < 0) at = label.toLowerCase().indexOf(k);
  if (at < 0) return null;
  return { before: label.slice(0, at), letter: label[at], after: label.slice(at + 1) };
}
