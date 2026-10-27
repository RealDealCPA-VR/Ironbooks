'use client';
/**
 * QuickBooks' transaction-window toolbar for a form (Create Invoices, Enter Bills, Write Checks):
 *
 *   ◄ Previous  Next ►   Revert / Clear   Journal
 *
 *  - Previous / Next (Alt+P / Alt+N): the saved transaction before / after this one; from a new,
 *    blank form, Previous opens the latest one, as in QB.
 *  - Revert (Alt+R) puts a saved transaction back as it was saved; Clear empties a new one.
 *  - Journal (Ctrl+Y; Ctrl+H for its history) shows the journal entry the transaction posted.
 *
 * Moving away from changes you have not saved asks first ("Discard your changes?"). Changes are
 * noticed by comparing the form's fields with how they were once the transaction had loaded, so
 * every form gets this without tracking its own state.
 *
 * The buttons carry data-shortcut="prev|next|revert" (components/FormShortcuts.tsx presses them);
 * the toolbar carries data-source-ref, which Ctrl+Y / Ctrl+H use (components/KeyboardCommands.tsx).
 */
import * as React from 'react';
import { BookOpen, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { Button, ConfirmDialog } from '@/components/ui';
import { AccessKeyText } from '@/components/AccessKey';

/** Window event asking components/KeyboardCommands.tsx to show a transaction's journal entry. */
export const SHOW_JOURNAL_EVENT = 'ib:show-journal';

export interface TransactionNavProps {
  /** "invoice:<id>" of the saved transaction in the form; null on a new one. */
  sourceRef: string | null;
  /** Open the previous / next saved transaction; null when there is none. */
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  /** Put the form back (saved transaction) or empty it (new one). */
  onRevert: () => void;
  /** Changes when a different transaction (or a fresh blank form) is loaded: re-reads the fields. */
  loadKey: string;
}

const FIELDS = 'input:not([type="hidden"]):not([type="file"]), select, textarea';

/** The form's field values, in page order, as one string. */
function fieldSnapshot(scope: HTMLElement | null): string {
  if (!scope) return '';
  return Array.from(scope.querySelectorAll<HTMLInputElement>(FIELDS))
    .filter((el) => !el.closest('[data-nav-ignore]'))
    .map((el) => (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value))
    .join('\u0001');
}

export function TransactionNav({ sourceRef, onPrevious, onNext, onRevert, loadKey }: TransactionNavProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const baseline = React.useRef<string | null>(null);
  const [pending, setPending] = React.useState<(() => void) | null>(null);

  const scope = () => (ref.current?.closest('[role="dialog"], form, [data-shortcut-scope]') as HTMLElement | null) ?? null;

  // Once the transaction has loaded (its fields fill in over a moment), remember how it looks.
  React.useEffect(() => {
    baseline.current = null;
    const t = setTimeout(() => {
      baseline.current = fieldSnapshot(scope());
    }, 900);
    return () => clearTimeout(t);
  }, [loadKey]);

  const changed = () => baseline.current !== null && fieldSnapshot(scope()) !== baseline.current;
  const guard = (fn: (() => void) | null) => () => {
    if (!fn) return;
    if (changed()) setPending(() => fn);
    else fn();
  };

  const editing = Boolean(sourceRef);
  return (
    <div ref={ref} data-source-ref={sourceRef ?? undefined} data-nav-ignore className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-shortcut="prev"
        aria-keyshortcuts="Alt+P"
        disabled={!onPrevious}
        onClick={guard(onPrevious)}
        title="Previous transaction (Alt+P)"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden /> <AccessKeyText text="Previous" accessKey="p" />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-shortcut="next"
        aria-keyshortcuts="Alt+N"
        disabled={!onNext}
        onClick={guard(onNext)}
        title="Next transaction (Alt+N)"
      >
        <AccessKeyText text="Next" accessKey="n" /> <ChevronRight className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-shortcut="revert"
        aria-keyshortcuts="Alt+R"
        onClick={guard(onRevert)}
        title={editing ? 'Put this transaction back as it was saved (Alt+R)' : 'Clear the form (Alt+R)'}
      >
        <RotateCcw className="h-4 w-4" aria-hidden /> <AccessKeyText text={editing ? 'Revert' : 'Clear'} accessKey="r" />
      </Button>
      {editing && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-keyshortcuts="Control+Y"
          onClick={() => window.dispatchEvent(new CustomEvent(SHOW_JOURNAL_EVENT, { detail: { sourceRef, focus: 'journal' } }))}
          title="Transaction Journal: the journal entry this transaction posted (Ctrl+Y)"
        >
          <BookOpen className="h-4 w-4" aria-hidden /> Journal
        </Button>
      )}
      <ConfirmDialog
        open={pending !== null}
        title="Discard your changes?"
        message="You have changed this transaction and not saved it. Leave it without saving the changes?"
        confirmLabel="Discard changes"
        tone="danger"
        onConfirm={() => {
          const fn = pending;
          setPending(null);
          fn?.();
        }}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

export default TransactionNav;

/**
 * Order of two document numbers as people read them: "999" before "1000", "INV-99" before
 * "INV-100" (plain text order put check 1000 before 999, so Previous / Next on a day's checks
 * jumped around). Blank numbers come first.
 */
export function compareDocNumbers(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * The saved transactions before / after `currentId` in date order (then `tieBreak`), for
 * TransactionNav's Previous / Next. With no current one (a new, blank form) Previous is the latest.
 */
export function useAdjacentTransactions<T extends { id: string }>(
  items: T[],
  currentId: string | null,
  date: (t: T) => string,
  tieBreak: (t: T) => string | number = () => 0,
): { prev: T | null; next: T | null } {
  return React.useMemo(() => {
    const ordered = [...items].sort((a, b) => {
      const d = date(a).localeCompare(date(b));
      if (d) return d;
      return compareDocNumbers(tieBreak(a), tieBreak(b));
    });
    if (!currentId) return { prev: ordered[ordered.length - 1] ?? null, next: null };
    const i = ordered.findIndex((t) => t.id === currentId);
    return { prev: i > 0 ? ordered[i - 1] : null, next: i >= 0 && i < ordered.length - 1 ? ordered[i + 1] : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, currentId]);
}
