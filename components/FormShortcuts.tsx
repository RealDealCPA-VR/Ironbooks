'use client';
/**
 * Form keyboard shortcuts (QB parity), mounted once by components/AppShell:
 *
 *   Ctrl+N                   New — presses the page's "New …" button (list pages)
 *   Ctrl+S                   Save — presses the open form's Save / Record button
 *   Ctrl+Alt+S, Ctrl+Enter   Save & New — presses "Save & New" when the form has one; otherwise
 *                            saves, and once the form closes successfully opens a new one
 *   Esc                      Cancel — on a page form with a Cancel button (dialogs and pickers
 *                            handle their own Esc)
 *
 * Buttons are found by an explicit data-shortcut="new|save|save-new|cancel" attribute, else by
 * their label (pure rules in lib/shortcuts.ts: formShortcutFor / pickShortcutButton), inside the
 * top-most open dialog or the focused form. Save works from inside fields (that is where people
 * finish a form); the field is blurred first so QuickMath amounts and pickers commit. Plain Enter
 * is never touched here — the "Pressing Enter moves between fields" preference keeps owning it.
 */
import * as React from 'react';
import {
  type FormShortcutAction,
  type ShortcutButton,
  formShortcutFor,
  pickShortcutButton,
  shouldRunFormShortcut,
} from '@/lib/shortcuts';

function openDialog(): HTMLElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"]'));
  return dialogs.length ? dialogs[dialogs.length - 1] : null;
}

function visible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

function buttonsIn(scope: ParentNode): HTMLElement[] {
  return Array.from(
    scope.querySelectorAll<HTMLElement>('button, [role="button"], a[data-shortcut], input[type="submit"]'),
  ).filter(visible);
}

function describe(el: HTMLElement): ShortcutButton {
  const label = (el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).value || '').trim();
  return {
    label,
    shortcut: el.getAttribute('data-shortcut'),
    disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
  };
}

function find(scope: ParentNode, action: FormShortcutAction, unique = false): HTMLElement | null {
  const els = buttonsIn(scope);
  const i = pickShortcutButton(els.map(describe), action, { unique });
  return i >= 0 ? els[i] : null;
}

/** Commit the focused field (QuickMath, pickers, auto-decimal) before a shortcut presses a button. */
function commitActiveField(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && typeof active.blur === 'function') active.blur();
  return active;
}

/** Press a button on the next tick, after React has applied the blurred field's last change. */
function pressSoon(btn: HTMLElement, then?: () => void) {
  commitActiveField();
  window.setTimeout(() => {
    btn.click();
    then?.();
  }, 0);
}

function pressNew(): boolean {
  const main = document.querySelector('main') ?? document.body;
  const btn = find(main, 'new');
  if (!btn) return false;
  btn.click();
  return true;
}

/**
 * Save, then — when the dialog it lives in closes (the save worked) — open a new form with the
 * page's New button. If the save fails the dialog stays open and nothing else happens.
 */
function saveThenNew(saveBtn: HTMLElement, dialog: HTMLElement | null) {
  pressSoon(saveBtn, () => {
    if (!dialog) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (!dialog.isConnected) {
        window.clearInterval(timer);
        window.setTimeout(pressNew, 50);
      } else if (Date.now() - started > 15_000) {
        window.clearInterval(timer);
      }
    }, 100);
  });
}

export default function FormShortcuts() {
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat) return;
      const action = formShortcutFor(e);
      if (!action) return;
      const target = e.target as HTMLElement | null;
      const dialog = openDialog();
      const pickerOpen = target?.getAttribute?.('aria-expanded') === 'true';
      if (!shouldRunFormShortcut(action, { dialogOpen: !!dialog, pickerOpen, composing: e.isComposing })) return;

      // Scope: the open dialog, else the focused form / data-shortcut-scope, else the page.
      const local = target?.closest?.('form, [data-shortcut-scope]') as HTMLElement | null;
      const main = document.querySelector('main') ?? document.body;

      if (action === 'new') {
        if (pressNew()) e.preventDefault();
        return;
      }
      if (action === 'cancel') {
        if (!local) return;
        const btn = find(local, 'cancel');
        if (btn) {
          e.preventDefault();
          pressSoon(btn);
        }
        return;
      }
      const scope = dialog ?? local ?? main;
      // On a bare page with several unrelated Save buttons, only act when the choice is clear.
      const unique = !dialog && !local;
      if (action === 'save-new') {
        const direct = find(scope, 'save-new', unique);
        if (direct) {
          e.preventDefault();
          pressSoon(direct);
          return;
        }
      }
      const save = find(scope, 'save', unique);
      if (save) {
        e.preventDefault();
        if (action === 'save-new') saveThenNew(save, dialog);
        else pressSoon(save);
      } else if (action === 'save') {
        // Nothing to save here: still keep the browser's "Save page as" dialog away.
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return null;
}
