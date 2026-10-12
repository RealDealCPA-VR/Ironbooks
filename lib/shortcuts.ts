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
 *  - useGridKeys: keyboard row add/delete + Enter-moves-down for line-item grids.
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
  { keys: 'Ctrl+D', ctrlKey: 'd', href: '/deposits', description: 'Make deposits' },
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

/** Display-only rows for the help modal: line-grid keys (where adopted). */
export const GRID_KEY_HELP: { keys: string; description: string }[] = [
  { keys: 'Ctrl+Insert', description: 'Add a line' },
  { keys: 'Ctrl+Delete', description: 'Delete the current line' },
  { keys: 'Enter', description: 'Move down a line (adds one on the last line)' },
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
// useGridKeys: keyboard ergonomics for line-item grids
// ---------------------------------------------------------------------------

export interface GridKeysOptions {
  /** Append a new (blank) line. Called for Ctrl+Insert and Enter on the last row. */
  addRow: () => void;
  /** Remove the line at `index` (the row containing the focused cell). */
  removeRow: (index: number) => void;
  /**
   * CSS selector marking one grid row inside the container.
   * Default: '[data-grid-row]'.
   */
  rowSelector?: string;
  /** Disable all handling (e.g. while saving). */
  disabled?: boolean;
}

const GRID_FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])';

/**
 * Keyboard handling for line-item grids (QB ergonomics):
 *
 *   Ctrl+Insert  add a row
 *   Ctrl+Delete  remove the row containing the focused cell
 *   Enter        move focus down to the same cell on the next row
 *                (on the last row: adds a row, focus lands there after re-render)
 *
 * Usage (pages adopt later; nothing is wired yet):
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
 * <tr data-grid-row> table rows and div-based grids alike. Enter inside a <textarea>,
 * <button>, or a row-less element is left alone.
 */
export function useGridKeys(options: GridKeysOptions): {
  onKeyDown: React.KeyboardEventHandler<HTMLElement>;
} {
  const { addRow, removeRow, rowSelector = '[data-grid-row]', disabled = false } = options;
  const addRowRef = React.useRef(addRow);
  const removeRowRef = React.useRef(removeRow);
  addRowRef.current = addRow;
  removeRowRef.current = removeRow;

  const onKeyDown = React.useCallback<React.KeyboardEventHandler<HTMLElement>>(
    (e) => {
      if (disabled || e.defaultPrevented) return;
      const container = e.currentTarget;
      const target = e.target as HTMLElement | null;

      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === 'Insert') {
          e.preventDefault();
          addRowRef.current();
          return;
        }
        if (e.key === 'Delete') {
          const rows = Array.from(container.querySelectorAll<HTMLElement>(rowSelector));
          const idx = rows.findIndex((r) => target && r.contains(target));
          if (idx >= 0) {
            e.preventDefault();
            removeRowRef.current(idx);
          }
          return;
        }
        return;
      }

      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey) return;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'TEXTAREA' || tag === 'BUTTON') return; // Enter has meaning there

      const rows = Array.from(container.querySelectorAll<HTMLElement>(rowSelector));
      const rowIdx = rows.findIndex((r) => r.contains(target));
      if (rowIdx < 0) return;
      e.preventDefault();

      const cells = Array.from(rows[rowIdx].querySelectorAll<HTMLElement>(GRID_FOCUSABLE));
      const cellIdx = cells.indexOf(target);

      const nextRow = rows[rowIdx + 1];
      if (nextRow) {
        const nextCells = Array.from(nextRow.querySelectorAll<HTMLElement>(GRID_FOCUSABLE));
        const dest = nextCells[Math.max(cellIdx, 0)] ?? nextCells[0];
        dest?.focus();
        if (dest instanceof HTMLInputElement) dest.select?.();
      } else {
        // Last row: QB behavior, Enter rolls into a fresh line.
        addRowRef.current();
      }
    },
    [disabled, rowSelector],
  );

  return { onKeyDown };
}
