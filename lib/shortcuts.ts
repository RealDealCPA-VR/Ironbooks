/**
 * Desktop-ergonomics primitives shared by the UI kit and the app shell:
 *
 *  - evaluateAmountExpression / isMathExpression: the safe QuickMath parser behind
 *    <AmountInput> (components/ui.tsx). No eval — a tiny recursive-descent parser
 *    supporting + - * / and parentheses.
 *  - adjustDateForKey: QuickBooks date-entry keys (+ - T M H Y R) for date inputs.
 *  - GLOBAL_SHORTCUTS / DATE_KEY_HELP / GRID_KEY_HELP: the single source of truth for
 *    the global shortcut handler and the "?" help modal in components/AppShell.tsx.
 *  - isEditableTarget: shared guard so global shortcuts ignore keystrokes in fields.
 *  - formShortcutFor / pickShortcutButton / gridKeyAction: pure key logic behind Ctrl+N / Ctrl+S /
 *    Save & New / Esc (components/FormShortcuts.tsx) and the line-grid keys.
 *  - useGridKeys: keyboard row insert/delete + Enter/Down/Up between lines for line-item grids.
 */
import * as React from 'react';
import {
  addDays,
  endOfMonth,
  endOfYear,
  format,
  isValid,
  parseISO,
  startOfMonth,
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

/**
 * Safely evaluate an arithmetic expression with + - * / and parentheses.
 * Returns the numeric result, or null when the expression is invalid
 * (syntax error, division by zero, empty input). Never uses eval.
 *
 *   evaluateAmountExpression('12.5*3+10') === 47.5
 */
export function evaluateAmountExpression(raw: string): number | null {
  const s = normalizeAmountText(raw);
  if (!s) return null;
  const state = { src: s, pos: 0, failed: false };

  const value = parseExpr(state);
  if (state.failed || state.pos !== state.src.length) return null;
  if (!Number.isFinite(value)) return null;
  return value;
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
function parseExpr(st: ParseState): number {
  let left = parseTerm(st);
  while (!st.failed) {
    const op = peek(st);
    if (op !== '+' && op !== '-') break;
    st.pos++;
    const right = parseTerm(st);
    left = op === '+' ? left + right : left - right;
  }
  return left;
}

/** term := factor (('*' | '/') factor)* */
function parseTerm(st: ParseState): number {
  let left = parseFactor(st);
  while (!st.failed) {
    const op = peek(st);
    if (op !== '*' && op !== '/') break;
    st.pos++;
    const right = parseFactor(st);
    if (op === '*') left = left * right;
    else if (right === 0) {
      st.failed = true; // division by zero -> invalid expression
    } else left = left / right;
  }
  return left;
}

/** factor := ('+' | '-') factor | '(' expr ')' | number */
function parseFactor(st: ParseState): number {
  const c = peek(st);
  if (c === '+') {
    st.pos++;
    return parseFactor(st);
  }
  if (c === '-') {
    st.pos++;
    return -parseFactor(st);
  }
  if (c === '(') {
    st.pos++;
    const v = parseExpr(st);
    if (peek(st) !== ')') {
      st.failed = true;
      return NaN;
    }
    st.pos++;
    return v;
  }
  return parseNumber(st);
}

/** number := digits ['.' digits] | '.' digits */
function parseNumber(st: ParseState): number {
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
    return NaN;
  }
  return Number(text);
}

/** Round an evaluated amount to cents for display in money fields. */
export function formatAmountResult(n: number): string {
  return String(Math.round((n + Number.EPSILON) * 100) / 100);
}

// ---------------------------------------------------------------------------
// QuickBooks date-entry keys
// ---------------------------------------------------------------------------

/**
 * Apply a QB date-entry key to a yyyy-MM-dd value:
 *   + / =  next day        -      previous day
 *   t      today           m / h  first / last day of month
 *   y / r  first / last day of year
 * Returns the new yyyy-MM-dd string, or null when the key is not a date key
 * (so the caller lets the event through untouched). Empty/invalid `current`
 * falls back to today.
 */
export function adjustDateForKey(key: string, current?: string): string | null {
  if (key.length > 1) return null; // named keys (ArrowUp, Tab, ...) pass through
  const parsed = current ? parseISO(current) : new Date();
  const base = isValid(parsed) ? parsed : new Date();
  let next: Date;
  switch (key === '+' || key === '-' || key === '=' ? key : key.toLowerCase()) {
    case '+':
    case '=': // unshifted "+" key
      next = addDays(base, 1);
      break;
    case '-':
      next = addDays(base, -1);
      break;
    case 't':
      next = new Date();
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
    default:
      return null;
  }
  return format(next, 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// Global shortcuts (rendered by GlobalShortcuts in components/AppShell.tsx)
// ---------------------------------------------------------------------------

export interface ShortcutDef {
  /** Human-readable combo for the help modal, e.g. 'Ctrl+I'. */
  keys: string;
  /** Lowercase key matched with ctrl/cmd held; absent for display-only rows. */
  ctrlKey?: string;
  /** Destination for navigation shortcuts. */
  href?: string;
  description: string;
}

export const GLOBAL_SHORTCUTS: ShortcutDef[] = [
  { keys: 'Ctrl+I', ctrlKey: 'i', href: '/invoices?new=1', description: 'New invoice' },
  { keys: 'Ctrl+E', ctrlKey: 'e', href: '/expenses?new=1', description: 'Write check' },
  { keys: 'Ctrl+R', ctrlKey: 'r', href: '/registers', description: 'Account registers' },
  { keys: 'Ctrl+J', ctrlKey: 'j', href: '/journal', description: 'Journal entries' },
  { keys: 'Ctrl+D', ctrlKey: 'd', href: '/deposits', description: 'Make deposits (in a line grid: delete the line)' },
  // Handled by the open form's <MemorizeButton> (components/MemorizeButton.tsx), not navigation.
  { keys: 'Ctrl+M', description: 'Memorize the open transaction' },
  { keys: 'Ctrl+K / Ctrl+F', description: 'Search & command palette' },
  { keys: '?', description: 'Show this shortcuts help' },
];

/** Lowercase key for QB "Memorize Transaction" (Ctrl+M) — listened for by MemorizeButton. */
export const MEMORIZE_SHORTCUT = 'm';

/** Display-only rows for the help modal: QB date keys (live in any date field). */
export const DATE_KEY_HELP: { keys: string; description: string }[] = [
  { keys: '+ / -', description: 'Next / previous day' },
  { keys: 'T', description: 'Today' },
  { keys: 'M / H', description: 'First / last day of the month' },
  { keys: 'Y / R', description: 'First / last day of the year' },
];

/** Display-only rows for the help modal: line-grid keys (every transaction form's lines). */
export const GRID_KEY_HELP: { keys: string; description: string }[] = [
  { keys: 'Tab / Shift+Tab', description: 'Next / previous cell' },
  { keys: 'Enter / Down', description: 'Next line (adds one on the last line)' },
  { keys: 'Up', description: 'Previous line' },
  { keys: 'Ctrl+Insert', description: 'Insert a line' },
  { keys: 'Ctrl+D / Ctrl+Delete', description: 'Delete the current line' },
  { keys: 'Alt+Down', description: 'Open a picker list; arrows + Enter choose' },
];

/** Display-only rows for the help modal: amount-field QuickMath. */
export const AMOUNT_KEY_HELP: { keys: string; description: string }[] = [
  { keys: '+ - * / ( )', description: 'Type math in amount fields; Enter or Tab calculates' },
];

/**
 * True when the keyboard event originates inside a text-editing control
 * (input/textarea/select or contentEditable) so global single-key shortcuts
 * must not fire.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

// ---------------------------------------------------------------------------
// Pure key classification (unit-tested; the DOM wiring lives in useGridKeys and
// components/FormShortcuts.tsx)
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

/** Form-level actions QuickBooks users expect on every list / form page. */
export type FormShortcutAction = 'new' | 'save' | 'save-new' | 'cancel';

/**
 * Which form action a key combination asks for:
 *   Ctrl+N new · Ctrl+S save · Ctrl+Alt+S or Ctrl+Enter save & new · Esc cancel.
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
      return !env.pickerOpen;
    case 'cancel':
      return !env.dialogOpen && !env.pickerOpen;
  }
}

/** A clickable button as seen by the shortcut handler. */
export interface ShortcutButton {
  /** Visible text (or aria-label). */
  label: string;
  /** Explicit data-shortcut="new|save|save-new|cancel" on the button, when present. */
  shortcut?: string | null;
  disabled?: boolean;
}

const SAVE_NEW_RE = /^save\s*(&|and|\+)\s*new\b/i;
const SAVE_RE = /^(save|record|post|create|ok|done)\b/i;
const NEW_RE = /^(\+\s*)?new\b/i;
const ADD_RE = /^(\+\s*)?add\b/i;
const CANCEL_RE = /^(cancel|close)$/i;

/** 0 = not a match; higher = better match for the action. */
function buttonRank(b: ShortcutButton, action: FormShortcutAction): number {
  if (b.disabled) return 0;
  if (b.shortcut) return b.shortcut === action ? 10 : 0;
  const label = b.label.replace(/\s+/g, ' ').trim();
  switch (action) {
    case 'save-new':
      return SAVE_NEW_RE.test(label) ? 5 : 0;
    case 'save':
      if (SAVE_NEW_RE.test(label)) return 1;
      if (/^save\b/i.test(label)) return 4;
      return SAVE_RE.test(label) ? 3 : 0;
    case 'new':
      if (NEW_RE.test(label)) return 4;
      return ADD_RE.test(label) ? 2 : 0;
    case 'cancel':
      return CANCEL_RE.test(label) ? 4 : 0;
  }
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
  let best = 0;
  let idx = -1;
  let ties = 0;
  buttons.forEach((b, i) => {
    const r = buttonRank(b, action);
    if (r > best) {
      best = r;
      idx = i;
      ties = 1;
    } else if (r === best && r > 0) ties++;
  });
  if (idx >= 0 && options.unique && ties > 1 && best < 10) return -1;
  return idx;
}

/** What a key does inside a line grid. 'next' on the last line adds a line. */
export type GridKeyAction = 'insert' | 'remove' | 'next' | 'prev' | null;

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
 *   Enter / Down next line (adds one on the last line) · Up previous line.
 * Tab / Shift+Tab are left to the browser (cell to cell across the row, then the next row).
 */
export function gridKeyAction(e: KeyLike, cell: GridCell): GridKeyAction {
  const tag = cell.tag.toUpperCase();
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

/** Display-only rows for the help modal: form keys (components/FormShortcuts.tsx). */
export const FORM_KEY_HELP: { keys: string; description: string }[] = [
  { keys: 'Ctrl+N', description: 'New (on a list page: opens a new form)' },
  { keys: 'Ctrl+S', description: 'Save the open form' },
  { keys: 'Ctrl+Alt+S / Ctrl+Enter', description: 'Save & New' },
  { keys: 'Esc', description: 'Close the dialog / cancel' },
  { keys: 'Tab / Shift+Tab', description: 'Next / previous field' },
  { keys: 'Alt+underlined letter', description: 'Press that button' },
];

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

/**
 * Keyboard handling for line-item grids (QB ergonomics):
 *
 *   Ctrl+Insert          insert a line (above the current one when `insertRow` is given)
 *   Ctrl+Delete / Ctrl+D delete the line containing the focused cell
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
