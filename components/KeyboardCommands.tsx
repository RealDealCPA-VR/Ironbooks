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
 *   F1       help for this page (the "What is this page?" bubble), else Help in a new window
 *
 * The selected row is the highlighted row (useListKeys) of the list that has focus, or of the
 * page's first list while nothing has focus. With nothing focused, the list keys themselves —
 * arrows, Home / End, PgUp / PgDn, Enter and type-ahead letters — go to the page's first list
 * too, so a center opened with Ctrl+J can be driven at once, as in QB.
 */
import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import EntryDetailModal from '@/components/EntryDetailModal';
import { openDialog } from '@/components/FormShortcuts';
import { SHOW_JOURNAL_EVENT } from '@/components/TransactionNav';
import { toast } from '@/components/ui';
import {
  activeListRow,
  commandButton,
  globalShortcutFor,
  isEditableTarget,
  listKeyAction,
  listRows,
  openListRow,
  typeAheadChar,
} from '@/lib/shortcuts';

/** Focus is on the page itself (nothing focused), not on a control. */
function onPage(target: HTMLElement | null): boolean {
  return !target || target === document.body || target === document.documentElement || target.tagName === 'MAIN';
}

/** The page's first list that has rows (outside dialogs). */
function firstList(): HTMLElement | null {
  const main = document.querySelector('main') ?? document.body;
  return (
    Array.from(main.querySelectorAll<HTMLElement>('[data-list]')).find(
      (l) => !l.closest('[role="dialog"]') && listRows(l).length > 0,
    ) ?? null
  );
}

/** The list a command acts on: the one holding focus, else (nothing focused, no dialog) the page's first. */
function currentList(target: HTMLElement | null, dialog: HTMLElement | null): HTMLElement | null {
  const own = target?.closest?.('[data-list]') as HTMLElement | null;
  // A dialog drawn inside a list (a report's QuickZoom window) is not part of that list.
  const box = target?.closest?.('[role="dialog"]');
  if (own && (!box || box.contains(own))) return own;
  return !dialog && onPage(target) ? firstList() : null;
}

/** The selected row: the row holding focus (a button in it), else the list's highlighted row. */
function selectedRow(target: HTMLElement | null, dialog: HTMLElement | null): HTMLElement | null {
  const list = currentList(target, dialog);
  if (!list) return null;
  const own = target?.closest?.('tr') as HTMLElement | null;
  if (own && listRows(list).includes(own)) return own;
  return activeListRow(list);
}

/** The open form: the top dialog, else the form / data-shortcut-scope holding focus. */
function formScope(target: HTMLElement | null, dialog: HTMLElement | null): HTMLElement | null {
  return dialog ?? (target?.closest?.('form, [data-shortcut-scope]') as HTMLElement | null);
}

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
  if (dialog || !onPage(target)) return;
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
            router.push(href);
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
        case 'help': {
          e.preventDefault();
          const pageHelp = dialog ? null : document.querySelector<HTMLElement>('[data-page-help] button');
          if (pageHelp) pageHelp.click();
          // A new window, so an open form is never left behind.
          else window.open('/help', '_blank', 'noopener');
          return;
        }
        default:
          return; // memorize / palette: MemorizeButton and CommandPalette listen themselves
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router]);

  return <EntryDetailModal entryId={entry?.id ?? null} focus={entry?.focus} onClose={() => setEntry(null)} />;
}
