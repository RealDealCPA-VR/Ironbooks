'use client';
/**
 * Field-level QuickBooks keys on every page (mounted once in app/layout.tsx, so the sign-in
 * screens and the setup interview have them too):
 *
 *  - the QB date keys (+ - T W K M H Y R [ ] ; ') and Alt+Down (open the calendar) in EVERY date
 *    field — the kit's <Input type="date"> handles its own; any other date field is handled here;
 *  - Tab / Shift+Tab on a transaction form marked data-qb-tab-order go in QuickBooks' order
 *    (lib/keyboardTargets.ts qbTabOrder: name → class → template → date → number → … → lines →
 *    memo → Save & Close → Save & New), wrapping inside a dialog; the browser's own Tab is left
 *    alone wherever it already goes to the same place;
 *  - Tab / Shift+Tab leave a date field for the next / previous field, as in QuickBooks: the
 *    browser's date box would otherwise stop on its month, day, year and calendar button first
 *    (four Tabs per date on every form). Typing a date still fills it in, and Left / Right move
 *    between its parts;
 *  - Ctrl+Z undoes a change the QuickBooks keys made (a date key, + / - on a number, QuickMath,
 *    a pasted line), which the field's own undo does not know about, and undoes typing in a date
 *    field (which has no undo of its own); typing elsewhere keeps the field's own undo;
 *  - Home Home / End End (twice quickly): the first / last field of the form;
 *  - the browser's own Ctrl keys never open its dialogs over the app: print (Ctrl+P), find
 *    (Ctrl+F / F3 / Ctrl+G), new window (Ctrl+N), reload (Ctrl+R / Ctrl+F5 / Shift+F5), open
 *    (Ctrl+O), save page (Ctrl+S), view source (Ctrl+U), history / downloads / bookmarks
 *    (Ctrl+H / J / D), its address and search bars (Ctrl+L / E / K) — whatever the page did not
 *    use itself is simply ignored; Alt+Left / Alt+Right go Back / Forward through the
 *    leave-this-form check instead of leaving at once.
 */
import * as React from 'react';
import { adjustDateForKey, historyGuarded, isCalendarKey } from '@/lib/shortcuts';
import { nextTabStop, qbTabStop } from '@/lib/keyboardTargets';

/** The browser keys (Ctrl + letter) the app takes away from the browser when it has no use for them. */
const BROWSER_CTRL_LETTERS = new Set(['d', 'e', 'f', 'g', 'h', 'j', 'k', 'l', 'n', 'o', 'p', 'r', 's', 'u']);

/** Undo history of the values the QuickBooks keys put in a field (newest last). */
const undoStack = new WeakMap<HTMLElement, string[]>();
/** The value a field had before its latest change, while it has focus. */
const lastValue = new WeakMap<HTMLElement, string>();
/** Fields whose latest change came from a QuickBooks key (an untrusted input event). */
const keyChanged = new WeakSet<HTMLElement>();
let restoring = false;

type ValueField = HTMLInputElement | HTMLTextAreaElement;

function isValueField(el: EventTarget | null): el is ValueField {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden', 'image', 'range', 'color'].includes(type);
}

function setValue(el: ValueField, value: string) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Ctrl+Z (no Shift / Alt) undoes the last change in `el`; true when it did. */
export function undoFieldChange(el: ValueField): boolean {
  const stack = undoStack.get(el);
  if (!stack?.length) return false;
  // Typing keeps the field's own undo — except in a date field, which has none.
  if (!keyChanged.has(el) && el.type !== 'date') return false;
  const previous = stack.pop()!;
  restoring = true;
  try {
    setValue(el, previous);
  } finally {
    restoring = false;
  }
  lastValue.set(el, el.value);
  if (!stack.length) keyChanged.delete(el);
  return true;
}

const FORM_SCOPE = '[role="dialog"][aria-modal="true"], form, [data-shortcut-scope]';
const SCOPE_FIELDS =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

function formFields(scope: Element): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(SCOPE_FIELDS)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[data-nav-ignore]'),
  );
}

export default function KeyboardBase() {
  React.useEffect(() => {
    let lastHome = { at: 0, key: '' };

    /** The field the cursor is in. A date field moves the focus among its own parts (a second
     * focusin, with no focusout, when a QuickBooks key rewrites it): that is not a new visit. */
    let current: EventTarget | null = null;
    function onFocusIn(e: FocusEvent) {
      if (e.target === current) return;
      current = e.target;
      if (isValueField(e.target)) lastValue.set(e.target, e.target.value);
    }
    function onFocusOut(e: FocusEvent) {
      if (e.target === current && e.relatedTarget !== e.target) current = null;
    }

    function onInput(e: Event) {
      const el = e.target;
      if (restoring || !isValueField(el)) return;
      const before = lastValue.get(el);
      if (before !== undefined && before !== el.value) {
        const stack = undoStack.get(el) ?? [];
        stack.push(before);
        if (stack.length > 50) stack.shift();
        undoStack.set(el, stack);
      }
      lastValue.set(el, el.value);
      if (e.isTrusted) keyChanged.delete(el);
      else keyChanged.add(el);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const ctrl = e.ctrlKey || e.metaKey;

      // ---- Tab: QuickBooks' order on transaction forms; one Tab stop per date field ----
      if (e.key === 'Tab' && !ctrl && !e.altKey && !e.defaultPrevented && target instanceof HTMLElement && target !== document.body) {
        const dir = e.shiftKey ? -1 : 1;
        const isDate = target instanceof HTMLInputElement && target.type === 'date';
        const natural = nextTabStop(target, dir);
        const qb = qbTabStop(target, dir);
        const to = qb ? qb : isDate ? natural : null;
        // Only step in where the browser would go somewhere else (or stop inside a date field).
        if (to && (to !== natural || isDate)) {
          e.preventDefault();
          to.focus();
          if (to instanceof HTMLInputElement && /^(text|search|tel|url|email|number|)$/.test(to.type)) to.select?.();
        }
        return;
      }

      // ---- date fields not drawn by the kit's <Input> ----
      if (target instanceof HTMLInputElement && target.type === 'date' && !e.defaultPrevented && !target.readOnly && !target.disabled) {
        if (isCalendarKey(e)) {
          e.preventDefault();
          try {
            target.showPicker?.();
          } catch {
            /* not allowed right now: the field keeps the focus */
          }
          return;
        }
        if (!ctrl && !e.altKey) {
          const next = adjustDateForKey(e.key, target.value || undefined);
          if (next !== null) {
            e.preventDefault();
            setValue(target, next);
            return;
          }
        }
      }

      // ---- Ctrl+Z after a QuickBooks key ----
      if (ctrl && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ') && isValueField(target)) {
        if (!e.defaultPrevented && undoFieldChange(target)) e.preventDefault();
        return;
      }

      // ---- Home Home / End End: first / last field of the form ----
      if ((e.key === 'Home' || e.key === 'End') && !ctrl && !e.altKey && !e.shiftKey && !e.defaultPrevented) {
        const scope = target?.closest?.(FORM_SCOPE);
        if (scope && target && target.getAttribute('aria-expanded') !== 'true' && !target.closest('[data-list]')) {
          const now = Date.now();
          if (lastHome.key === e.key && now - lastHome.at < 600) {
            const fields = formFields(scope);
            const to = e.key === 'Home' ? fields[0] : fields[fields.length - 1];
            if (to && to !== target) {
              e.preventDefault();
              to.focus();
              lastHome = { at: 0, key: '' };
              return;
            }
          }
          lastHome = { at: now, key: e.key };
        }
        return;
      }
    }

    // Last in line: only what nothing on the page used. Re-added at the start of every key press
    // (capture phase), it is always the window's LAST listener — even behind handlers that pages
    // and dialogs register later.
    function lastInLine() {
      window.removeEventListener('keydown', onKeyDownLate);
      window.addEventListener('keydown', onKeyDownLate);
    }
    function onKeyDownLate(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.altKey && !ctrl && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        historyGuarded(e.key === 'ArrowLeft' ? 'back' : 'forward');
        return;
      }
      if (ctrl && !e.altKey) {
        const letter = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? e.key.toLowerCase();
        if (BROWSER_CTRL_LETTERS.has(letter) || e.key === 'F5') e.preventDefault();
        return;
      }
      if (!ctrl && !e.altKey && (e.key === 'F3' || e.key === 'F7' || (e.key === 'F5' && e.shiftKey))) e.preventDefault();
    }

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('input', onInput, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', lastInLine, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('input', onInput, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', lastInLine, true);
      window.removeEventListener('keydown', onKeyDownLate);
    };
  }, []);
  return null;
}
