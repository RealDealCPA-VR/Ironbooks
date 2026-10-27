'use client';
/**
 * Form keyboard shortcuts (QB parity), mounted once by components/AppShell:
 *
 *   Ctrl+N                          New — presses the page's "New …" button (list pages)
 *   Ctrl+S                          Save — presses the open form's Save / Record button
 *   Alt+S, Ctrl+Alt+S, Ctrl+Enter   Save & New — presses "Save & New" when the form has one;
 *                                   otherwise saves, and once the form closes successfully
 *                                   opens a new one
 *   Alt+A                           Save & Close — "Save & Close", else Save (forms close on save)
 *   Alt+R                           Revert — the form's Revert / Clear button
 *   Alt+P / Alt+N                   Previous / Next — the form's Previous / Next buttons
 *   Esc                             Cancel — on a page form with a Cancel button (dialogs and
 *                                   pickers handle their own Esc). A changed form first asks
 *                                   QuickBooks' "Do you want to record your changes?" (Yes saves,
 *                                   No cancels, Cancel stays), as dialogs do (components/ui.tsx)
 *
 * Buttons are found by an explicit data-shortcut="new|save|save-new|save-close|cancel|revert|
 * prev|next" attribute, else by their label (pure rules in lib/shortcuts.ts: formShortcutFor /
 * pickShortcutButton), inside the top-most open dialog or the focused form. The Alt+letter keys
 * (QB's underlined button letters) only act inside a form or dialog that has the button, and
 * never over an element with that accesskey; otherwise Alt+letter is left to the menus
 * (components/WindowTitleBar.tsx asks formShortcutTarget first). Save works from inside fields
 * (that is where people finish a form); the field is blurred first so QuickMath amounts and
 * pickers commit.
 *
 *   Enter (in a field)              Records the transaction, as in QuickBooks: the form's Save &
 *                                   Close (lib/shortcuts.ts enterRecordsForm says where). With
 *                                   "Pressing Enter moves between fields" on, the preference takes
 *                                   Enter first (components/PreferenceBehaviors.tsx) and Ctrl+Enter
 *                                   records. An open picker, a line grid, a register's blank line
 *                                   and QuickMath keep their own Enter.
 */
import * as React from 'react';
import {
  type FormShortcutAction,
  altLetter,
  buttonsIn,
  describeButton,
  enterRecordsForm,
  formShortcutFor,
  pickShortcutButton,
  shouldRunFormShortcut,
} from '@/lib/shortcuts';
import { openDialog } from '@/lib/keyboardTargets';
import { RecordChangesPrompt, formWasChanged, recordChangesButton } from '@/components/ui';

/** The open modal dialog in use (lib/keyboardTargets.ts). */
export { openDialog };

function find(scope: ParentNode, action: FormShortcutAction, unique = false): HTMLElement | null {
  const els = buttonsIn(scope);
  const i = pickShortcutButton(els.map(describeButton), action, { unique });
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

/** What a form shortcut would press here. */
export interface FormShortcutTarget {
  action: FormShortcutAction;
  button: HTMLElement;
  /** The open dialog the form lives in, if any. */
  dialog: HTMLElement | null;
  /** The button is a plain Save: open a new form once it has saved (Save & New). */
  thenNew: boolean;
}

/**
 * The button a form shortcut would press for this key press, or null when the key is not a form
 * shortcut here (so other handlers — the menus for Alt+letter — may have it).
 */
export function formShortcutTarget(e: KeyboardEvent): FormShortcutTarget | null {
  const action = formShortcutFor(e);
  if (!action) return null;
  const target = e.target as HTMLElement | null;
  const dialog = openDialog();
  const pickerOpen = target?.getAttribute?.('aria-expanded') === 'true';
  if (!shouldRunFormShortcut(action, { dialogOpen: !!dialog, pickerOpen, composing: e.isComposing })) return null;

  // Scope: the open dialog, else the focused form / data-shortcut-scope, else the page.
  const local = target?.closest?.('form, [data-shortcut-scope]') as HTMLElement | null;
  const main = document.querySelector('main') ?? document.body;

  const letter = altLetter(e);
  if (letter) {
    // A button or field on the page with this accesskey owns Alt+<letter> (the browser presses it).
    if (document.querySelector(`[accesskey="${letter}" i]`)) return null;
    // QB's form-button letters belong to forms; on a bare page Alt+letter opens the menus.
    if (!dialog && !local) return null;
  }

  const at = (button: HTMLElement | null, thenNew = false): FormShortcutTarget | null =>
    button ? { action, button, dialog, thenNew } : null;

  if (action === 'new') return at(find(main, 'new'));
  if (action === 'cancel') return local ? at(find(local, 'cancel')) : null;
  const scope = dialog ?? local ?? main;
  // On a bare page with several unrelated Save buttons, only act when the choice is clear.
  const unique = !dialog && !local;
  if (action === 'save-new') {
    const direct = find(scope, 'save-new', unique);
    if (direct) return at(direct);
    return at(find(scope, 'save', unique), true);
  }
  return at(find(scope, action, unique));
}

export default function FormShortcuts() {
  /** Esc on a changed page form: its Cancel button and its Save button, while the question is up. */
  const [asking, setAsking] = React.useState<{ cancel: HTMLElement; record: HTMLElement; what: string } | null>(null);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat) return;
      // QuickBooks: Enter in a form field records the transaction (Save & Close).
      const field = e.target as HTMLInputElement | null;
      if (
        field?.tagName &&
        !e.isComposing &&
        enterRecordsForm(e, {
          tag: field.tagName,
          type: field.type,
          expanded: field.getAttribute('aria-expanded') === 'true',
          inGrid: !!field.closest('[data-grid-row]'),
          inList: !!field.closest('[data-list]'),
          inNativeForm: !!field.form,
        })
      ) {
        const scope = openDialog() ?? (field.closest('[data-shortcut-scope]') as HTMLElement | null);
        const record = scope && scope.contains(field) ? recordChangesButton(scope) : null;
        if (record) {
          e.preventDefault();
          pressSoon(record);
        }
        return;
      }
      const action = formShortcutFor(e);
      if (!action) return;
      const t = formShortcutTarget(e);
      if (!t) {
        // Nothing to save here: still keep the browser's "Save page as" dialog away.
        if (action === 'save') e.preventDefault();
        return;
      }
      e.preventDefault();
      if (t.action === 'new') {
        t.button.click();
      } else if (t.action === 'cancel') {
        const scope = (e.target as HTMLElement | null)?.closest?.('form, [data-shortcut-scope]') as HTMLElement | null;
        const record = scope && formWasChanged(scope) ? recordChangesButton(scope) : null;
        if (scope && record) {
          const what = scope.querySelector('h1, h2, legend')?.textContent?.trim() || document.title.split(' — ')[1] || '';
          setAsking({ cancel: t.button, record, what });
        } else pressSoon(t.button);
      } else if (t.thenNew) {
        saveThenNew(t.button, t.dialog);
      } else {
        pressSoon(t.button);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <RecordChangesPrompt
      open={asking !== null}
      what={asking?.what ?? ''}
      onYes={() => {
        const btn = asking?.record;
        setAsking(null);
        if (btn) window.setTimeout(() => pressSoon(btn), 0);
      }}
      onNo={() => {
        const btn = asking?.cancel;
        setAsking(null);
        if (btn) window.setTimeout(() => btn.click(), 0);
      }}
      onCancel={() => setAsking(null)}
    />
  );
}
