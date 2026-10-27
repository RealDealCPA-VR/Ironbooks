'use client';
/**
 * QuickBooks selection commands (GLOBAL_SHORTCUTS in lib/shortcuts.ts), mounted once by
 * components/AppShell:
 *
 *   Ctrl+E   edit the selected row of a list or register (its Edit button, else opens it)
 *   Ctrl+D   delete the selected row: its Delete / Void / Make inactive button, so the page's
 *            usual confirmation follows. In an open form: its Delete / Void button. Line grids
 *            take Ctrl+D first (delete the line: useGridKeys).
 *   Ctrl+P   print: the selected row's Print button, else the open form's or page's Print
 *            button, else the browser's print
 *   Ctrl+Y   Transaction Journal, Ctrl+H Transaction History (EntryDetailModal) of the selected
 *            row — register, journal, Find and report rows carry data-journal-entry — or of an
 *            open form: one that names its journal entry the same way, or a saved invoice / bill /
 *            check whose toolbar (components/TransactionNav.tsx) names the document
 *            (data-source-ref="invoice:<id>", looked up via /api/journal-entries/for-source)
 *   Ctrl+Q   QuickReport of the selected customer / vendor / employee / account (data-quick-report)
 *   Ctrl+L   open the list of the focused <select> (<Typeahead> pickers handle it themselves)
 *   Ctrl+U   use the list item: in an open list, take the highlighted entry; on a list row, use it
 *            (data-use-prefill: a new form for the customer / vendor / item; data-use-href: an
 *            account's register, a memorized transaction entered; or the row's data-shortcut="use")
 *   Ctrl+G   in a register: the register of the selected transaction's other account
 *            (data-transfer-href), at that transaction
 *   Ctrl+O   in a register: copy the selected transaction (data-copy-transaction); Ctrl+V on the
 *            blank line (or on the register) pastes it there, ready to record with Enter
 *
 * F1 / ? are components/ShortcutsHelp.tsx, F2 / Ctrl+1 components/ProductInfo.tsx, F3 / Ctrl+2 and
 * Ctrl+K components/CommandPalette.tsx, the window keys components/WindowList.tsx, F5
 * components/LeaveGuard.tsx, Ctrl+M components/MemorizeButton.tsx.
 *
 * The selected row is the highlighted row (useListKeys) of the list that has focus, or of the
 * page's first list while nothing has focus. With nothing focused, the list keys themselves —
 * arrows, Home / End, PgUp / PgDn, Enter and type-ahead letters — go to the page's first list
 * too, so a center opened with Ctrl+J can be driven at once, as in QB.
 */
import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import EntryDetailModal from '@/components/EntryDetailModal';
import { SHOW_JOURNAL_EVENT } from '@/components/TransactionNav';
import { toast } from '@/components/ui';
import {
  commandButton,
  globalShortcutFor,
  isEditableTarget,
  listKeyAction,
  navigateGuarded,
  openListRow,
  typeAheadChar,
} from '@/lib/shortcuts';
import {
  PASTE_TRANSACTION_EVENT,
  firstList,
  formScope,
  getCopiedTransaction,
  onPageBody,
  openDialog,
  parseCopiedTransaction,
  pasteTransactionTarget,
  selectedRow,
  setCopiedTransaction,
} from '@/lib/keyboardTargets';
import { PREFILL_EVENT, PREFILL_PATHS, formPrefillSchema, stashPrefill } from '@/lib/commands/prefill';

/** Buttons on a line of the form's grid or a row of a list in it act on that line, not the form. */
const onLineOrRow = (el: HTMLElement) => !!el.closest('[data-grid-row], [data-list] tbody tr');

/** The journal entry Ctrl+Y / Ctrl+H show: the focused or selected row's, else the open form's. */
function journalEntryOf(target: HTMLElement | null, dialog: HTMLElement | null): string | null {
  const own = target?.closest?.('[data-journal-entry]')?.getAttribute('data-journal-entry');
  if (own) return own;
  const fromRow = selectedRow(target, dialog)?.getAttribute('data-journal-entry');
  if (fromRow) return fromRow;
  const form = formScope(target, dialog);
  const marked = form?.matches('[data-journal-entry]') ? form : form?.querySelector('[data-journal-entry]:not(tr)');
  return marked?.getAttribute('data-journal-entry') || null;
}

/** The saved document an open form shows ("invoice:<id>"), when its toolbar names it. */
function sourceRefOf(target: HTMLElement | null, dialog: HTMLElement | null): string | null {
  const form = formScope(target, dialog);
  return form?.querySelector('[data-source-ref]')?.getAttribute('data-source-ref') || null;
}

/** The journal entry a document posted, or null (with a note) when it has not posted. */
async function entryForSource(ref: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/journal-entries/for-source?ref=${encodeURIComponent(ref)}`, { cache: 'no-store' });
    const d = (await r.json().catch(() => null)) as { entryId?: string; error?: string } | null;
    if (r.ok && d?.entryId) return d.entryId;
    toast(d?.error || 'There is no journal entry for this transaction.', 'info');
  } catch {
    toast('The journal entry could not be loaded.', 'danger');
  }
  return null;
}

/**
 * Nothing focused: send a list key (arrows, Home / End, PgUp / PgDn, Enter, a type-ahead letter)
 * to the page's first list, focusing it, the way a QB center's list has focus when it opens.
 */
function forwardToList(e: KeyboardEvent, target: HTMLElement | null, dialog: HTMLElement | null) {
  if (dialog || !onPageBody(target)) return;
  if (!listKeyAction(e) && typeAheadChar(e, '') === null) return;
  const list = firstList();
  if (!list) return;
  e.preventDefault();
  list.focus({ preventScroll: true });
  // Same modifiers as the key pressed (Ctrl+PgDn is "last row", plain PgDn "a page down").
  list.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: e.key,
      code: e.code,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * Ctrl+U on a list row: a new form for the row (data-use-prefill, through the command bar's
 * prefill hand-off), a page (data-use-href), or the row's own "use" button. True when it acted.
 */
export function useListRow(row: HTMLElement, go: (href: string) => void): boolean {
  const prefillRaw = row.getAttribute('data-use-prefill');
  if (prefillRaw) {
    try {
      const prefill = formPrefillSchema.parse(JSON.parse(prefillRaw));
      if (stashPrefill(window.sessionStorage, prefill)) {
        go(PREFILL_PATHS[prefill.kind]);
        // A page that is already open picks the prefill up from this event.
        window.setTimeout(() => window.dispatchEvent(new Event(PREFILL_EVENT)), 0);
        return true;
      }
    } catch {
      /* a malformed row: fall through to its other uses */
    }
  }
  const href = row.getAttribute('data-use-href') || row.getAttribute('data-register');
  if (href) {
    go(href);
    return true;
  }
  const btn = row.querySelector<HTMLElement>('[data-shortcut="use"]:not([disabled])');
  if (btn) {
    btn.click();
    return true;
  }
  return false;
}

export default function KeyboardCommands() {
  const router = useRouter();
  const pathname = usePathname();
  const [entry, setEntry] = React.useState<{ id: string; focus: 'journal' | 'history' } | null>(null);

  // The journal window belongs to the page it was opened from.
  React.useEffect(() => setEntry(null), [pathname]);

  // The toolbar's Journal button (components/TransactionNav.tsx).
  React.useEffect(() => {
    function onShow(e: Event) {
      const detail = (e as CustomEvent<{ sourceRef?: string; focus?: 'journal' | 'history' }>).detail;
      if (!detail?.sourceRef) return;
      void entryForSource(detail.sourceRef).then((id) => id && setEntry({ id, focus: detail.focus ?? 'journal' }));
    }
    window.addEventListener(SHOW_JOURNAL_EVENT, onShow);
    return () => window.removeEventListener(SHOW_JOURNAL_EVENT, onShow);
  }, []);

  React.useEffect(() => {
    const go = (href: string) => navigateGuarded(href, (h) => router.push(h));
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const editable = isEditableTarget(target);
      const dialog = openDialog();
      const command = globalShortcutFor(e, editable)?.command;
      if (!command) {
        forwardToList(e, target, dialog);
        return;
      }
      switch (command) {
        case 'edit': {
          const row = selectedRow(target, dialog);
          if (row && openListRow(row, 'edit')) e.preventDefault();
          return;
        }
        case 'delete': {
          const row = editable ? null : selectedRow(target, dialog);
          const form = row ? null : formScope(target, dialog);
          const btn = row
            ? commandButton(row, 'delete')
            : form && commandButton(form, 'delete', { scope: 'form', unique: true, exclude: onLineOrRow });
          if (btn) {
            e.preventDefault();
            btn.click();
          }
          return;
        }
        case 'print': {
          const row = editable ? null : selectedRow(target, dialog);
          const scope = formScope(target, dialog) ?? (dialog ? null : document.querySelector('main'));
          const btn =
            (row && commandButton(row, 'print')) ||
            (scope && commandButton(scope, 'print', { scope: 'form', unique: true, exclude: onLineOrRow }));
          if (btn) {
            e.preventDefault();
            btn.click();
          } else if (!dialog) {
            e.preventDefault();
            window.print();
          }
          return;
        }
        case 'journal':
        case 'history': {
          const id = journalEntryOf(target, dialog);
          if (id) {
            e.preventDefault();
            setEntry({ id, focus: command });
            return;
          }
          // An open saved document: look up the entry it posted.
          const ref = sourceRefOf(target, dialog);
          if (!ref) return; // nothing to show: Ctrl+Y stays Redo in a text field
          e.preventDefault();
          void entryForSource(ref).then((found) => found && setEntry({ id: found, focus: command }));
          return;
        }
        case 'quick-report': {
          const href = selectedRow(target, dialog)?.getAttribute('data-quick-report');
          if (href) {
            e.preventDefault();
            go(href);
          }
          return;
        }
        case 'open-list': {
          const select = target as (HTMLSelectElement & { showPicker?: () => void }) | null;
          if (select?.tagName === 'SELECT' && !select.disabled) {
            e.preventDefault();
            try {
              select.showPicker?.();
            } catch {
              /* not allowed right now: the field keeps focus, Alt+Down still opens it */
            }
          }
          return;
        }
        case 'use': {
          // An open picker list: take its highlighted entry (as Enter does).
          if (target?.getAttribute('aria-expanded') === 'true') {
            e.preventDefault();
            target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
            return;
          }
          const row = editable ? null : selectedRow(target, dialog);
          if (row && useListRow(row, go)) e.preventDefault();
          return;
        }
        case 'transfer': {
          const row = selectedRow(target, dialog);
          if (!row) return;
          const href = row.getAttribute('data-transfer-href');
          e.preventDefault();
          if (href) go(href);
          else if (row.hasAttribute('data-split'))
            toast('This transaction uses several accounts (-split-). Open it (Enter) to see each account.', 'info');
          else toast('This transaction has no other account to go to.', 'info');
          return;
        }
        case 'copy-transaction': {
          const row = selectedRow(target, dialog);
          if (!row || !row.closest('[data-list]')?.querySelector('[data-register-entry]')) return;
          e.preventDefault();
          const copied = parseCopiedTransaction(row.getAttribute('data-copy-transaction'));
          if (!copied) {
            toast(
              row.hasAttribute('data-split')
                ? 'A transaction with several accounts (-split-) cannot be copied to the blank line. Open it and use Memorize (Ctrl+M) to repeat it.'
                : 'This transaction cannot be copied.',
              'info',
            );
            return;
          }
          setCopiedTransaction(copied);
          toast('Transaction copied. Press Ctrl+V on the blank line at the bottom to paste it.', 'success');
          return;
        }
        case 'paste-transaction': {
          const copied = getCopiedTransaction();
          const line = copied ? pasteTransactionTarget(target) : null;
          if (!copied || !line) return; // Ctrl+V pastes text as usual
          e.preventDefault();
          window.dispatchEvent(new CustomEvent(PASTE_TRANSACTION_EVENT, { detail: copied }));
          return;
        }
        default:
          return; // the other commands have their own components (see the header comment)
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router]);

  return <EntryDetailModal entryId={entry?.id ?? null} focus={entry?.focus} onClose={() => setEntry(null)} />;
}
