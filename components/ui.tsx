'use client';
/**
 * Shared UI kit for Ironbooks. Lightweight Tailwind primitives in a clean, Apple-like style:
 * hairline borders, soft shadows, the accent color for actions. Every color is a theme variable
 * (app/globals.css), so these follow light / dark / auto and the accent color. Import from
 * '@/components/ui'.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  adjustDateForKey,
  committedAmountText,
  stepDocNumber,
  useListKeys,
} from '@/lib/shortcuts';
import { describeError } from '@/lib/friendlyErrors';
import type { ErrorFix } from '@/lib/errorFixes';

// Re-export the line-grid and list keyboard hooks so pages can import them from the kit.
export { useGridKeys, useListKeys, type GridKeysOptions } from '@/lib/shortcuts';

// ---- Spinner ----
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-5 w-5 animate-spin text-current', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  );
}

// ---- Button ----
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  /** Shows a spinner and disables the button while a request is in flight. */
  loading?: boolean;
};
export function Button({
  className,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const variants = {
    primary: 'bg-electric text-white shadow-sm hover:brightness-110 active:brightness-95',
    secondary: 'bg-white text-navy border border-slate-200 shadow-sm hover:bg-slate-50 active:bg-slate-100',
    ghost: 'text-navy hover:bg-navy/[.06] active:bg-navy/10',
    danger: 'bg-red-500 text-white shadow-sm hover:brightness-110 active:brightness-95',
  };
  const sizes = { sm: 'px-3 py-1.5 text-[13px]', md: 'px-4 py-2 text-sm' };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-50 disabled:pointer-events-none outline-none focus-visible:ring-4 focus-visible:ring-electric/25',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

// ---- Card ----
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-2xl bg-white shadow-xl border border-slate-200/70', className)}
      {...props}
    />
  );
}

// ---- Inputs ----

/**
 * Set an input's value through the native setter and fire a bubbling 'input' event so
 * React's synthetic onChange fires even for controlled inputs. Used by the QB date keys
 * and AmountInput so programmatic edits flow through the page's normal state updates.
 */
function setNativeInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Standard text input. Date inputs (type="date") additionally get the QuickBooks
 * date-entry keys: + / - next/previous day, T today, W / K first/last of week,
 * M / H first/last of month, Y / R first/last of year, [ / ] same day last/next week,
 * ; / ' same day last/next month. All other keys (and any key with a modifier held)
 * behave exactly as before.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type, onKeyDown, ...props }, ref) {
    const handleDateKeys = React.useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        const next = adjustDateForKey(e.key, e.currentTarget.value || undefined);
        if (next !== null) {
          e.preventDefault();
          setNativeInputValue(e.currentTarget, next);
        }
      },
      [onKeyDown],
    );
    return (
      <input
        ref={ref}
        type={type}
        onKeyDown={type === 'date' ? handleDateKeys : onKeyDown}
        className={cn(
          'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy outline-none transition-shadow focus:border-electric focus:ring-4 focus:ring-electric/20 placeholder:text-navy/35 disabled:bg-slate-50 disabled:text-navy/50',
          className,
        )}
        {...props}
      />
    );
  },
);

/** Alias for an Input pre-set to type="date" (QB date keys included). */
export const DateInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>
>(function DateInput(props, ref) {
  return <Input ref={ref} type="date" {...props} />;
});

/**
 * Input for a typed document number (check no., invoice #, estimate no., …): QB's + / - step
 * the number at the end of the text, keeping its prefix and padding (stepDocNumber in
 * lib/shortcuts.ts). '-' after letters still types ('INV-'). Marked data-doc-number.
 */
export const DocNumberInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function DocNumberInput({ onKeyDown, ...props }, ref) {
    return (
      <Input
        ref={ref}
        data-doc-number=""
        {...props}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          const el = e.currentTarget;
          if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || el.readOnly || el.disabled) return;
          const next = stepDocNumber(e.key, el.value);
          if (next === null) return;
          e.preventDefault();
          if (next !== el.value) setNativeInputValue(el, next);
        }}
      />
    );
  },
);

// ---- AmountInput (QuickMath calculator in amount fields) ----

export type AmountInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /**
   * Called with the committed amount string after a math expression is worked out, or an
   * amount typed as "$1,250.50" is made a bare number (blur or Enter). Plain numbers never
   * trigger it — they pass through untouched.
   * Regular onChange also fires (via a native input event), so controlled
   * value/onChange usage works without this.
   */
  onValueCommit?: (value: string) => void;
};

/**
 * Drop-in Input for money fields with a built-in calculator: type math
 * (e.g. `12.5*3+10`, with + - * / and parentheses) and it evaluates on blur or
 * Enter via a safe parser (no eval, exact decimals), rounded to cents half-up like the server.
 * An amount typed with a $ sign or thousands separators ("$1,250.50") becomes "1250.50" the
 * same way. Plain numbers are passed through untouched; invalid expressions are left as typed
 * for the page's own validation to flag.
 */
export const AmountInput = React.forwardRef<HTMLInputElement, AmountInputProps>(
  function AmountInput({ onValueCommit, onBlur, onKeyDown, ...props }, ref) {
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);

    const commit = React.useCallback((): boolean => {
      const el = innerRef.current;
      if (!el) return false;
      const raw = el.value;
      // QuickMath worked out (exact decimals, cents half-up), or "$1,250.50" made a bare
      // "1250.50" so the page's sums and the API read it. Plain numbers are left untouched;
      // text that is not an amount stays as typed for the page's validation.
      const next = committedAmountText(raw);
      if (next === null) return false;
      setNativeInputValue(el, next);
      onValueCommit?.(next);
      return true;
    }, [onValueCommit]);

    return (
      <Input
        {...props}
        ref={innerRef}
        type="text"
        inputMode="decimal"
        onBlur={(e) => {
          commit();
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Enter') {
            // Only swallow Enter when it actually calculated something, so plain
            // values still submit forms / move down grids as usual.
            if (commit()) e.preventDefault();
          }
        }}
      />
    );
  },
);

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy bg-white outline-none transition-shadow focus:border-electric focus:ring-4 focus:ring-electric/20 disabled:bg-slate-50 disabled:text-navy/50',
        className,
      )}
      {...props}
    />
  );
});

export function Label({
  className,
  required,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & {
  /** Shows a visible red asterisk (announced as "required") after the label text. */
  required?: boolean;
}) {
  return (
    <label className={cn('block text-[13px] font-medium text-navy/70 mb-1', className)} {...props}>
      {children}
      {required && (
        <>
          <span aria-hidden="true" className="ml-0.5 text-red-500">*</span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </label>
  );
}

// ---- Badge ----
export type BadgeTone =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  // Document-status aliases so pages can pass a status string directly:
  | 'open'
  | 'partial'
  | 'paid'
  | 'void'
  | 'overdue';
export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: 'bg-slate-100 text-slate-600',
    success: 'bg-emerald/15 text-emerald',
    warning: 'bg-gold/20 text-yellow-800',
    danger: 'bg-red-100 text-red-600',
    info: 'bg-electric/10 text-electric',
    // Status aliases
    open: 'bg-electric/10 text-electric',
    partial: 'bg-gold/20 text-yellow-800',
    paid: 'bg-emerald/15 text-emerald',
    void: 'bg-slate-100 text-slate-500 line-through decoration-slate-400',
    overdue: 'bg-red-100 text-red-600',
  };
  return (
    <span
      className={cn('px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap', tones[tone], className)}
    >
      {children}
    </span>
  );
}

// ---- Table primitives ----
/**
 * A table of records with QB list keys (useListKeys, lib/shortcuts.ts): arrows / Home / End /
 * PgUp / PgDn move the highlighted row, Enter opens it, typing a name jumps to it, and
 * Ctrl+E / Ctrl+D / Ctrl+Q act on it (components/KeyboardCommands.tsx). Rows can refine this
 * with data-list-label (type-ahead text), data-row-open (Enter clicks the row),
 * data-quick-report (Ctrl+Q target), data-journal-entry (Ctrl+Y / Ctrl+H) and data-list-skip.
 */
export function Table({ children }: { children: React.ReactNode }) {
  const list = useListKeys<HTMLDivElement>();
  return (
    <div className="overflow-x-auto" {...list}>
      <table className="w-full border-collapse">{children}</table>
    </div>
  );
}
export function Th({
  className,
  numeric,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      className={cn(
        'py-2.5 px-4 text-left text-xs font-semibold text-navy/55 border-b border-slate-200',
        numeric && 'text-right tabular-nums',
        className,
      )}
      {...props}
    />
  );
}
export function Td({
  className,
  numeric,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        'py-2.5 px-4 text-navy border-b border-slate-100',
        numeric && 'text-right tabular-nums',
        className,
      )}
      {...props}
    />
  );
}
export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-electric/[.04]', className)} {...props} />;
}

// ---- Modal ----
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const MODAL_SIZES = {
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
} as const;

/** The form fields a dialog's first-field focus may land on. */
const FIRST_FIELD =
  'input:not([disabled]):not([readonly]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]):not([readonly])';

/**
 * Recently focused elements (newest last; null = focus went back to the page), so a dialog whose
 * first field took focus on mount (autoFocus runs before the dialog's effect) still knows which
 * element opened it and can hand focus back when it closes.
 */
const focusHistory: Array<HTMLElement | null> = [];
if (typeof document !== 'undefined') {
  const remember = (el: HTMLElement | null) => {
    focusHistory.push(el);
    if (focusHistory.length > 20) focusHistory.shift();
  };
  document.addEventListener('focusin', (e) => remember(e.target instanceof HTMLElement ? e.target : null), true);
  document.addEventListener('focusout', (e) => {
    if (!e.relatedTarget) remember(null);
  }, true);
}

/** Open <Modal> dialogs, oldest first (the last one owns Esc and the Tab trap). */
const openModals: HTMLElement[] = [];

/** The element that had focus before focus moved into `dialog`, or null. */
function openerOf(dialog: HTMLElement): HTMLElement | null {
  for (let i = focusHistory.length - 1; i >= 0; i--) {
    const el = focusHistory[i];
    if (el && dialog.contains(el)) continue;
    return el && el.isConnected ? el : null;
  }
  return null;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** md = forms (default), lg = transaction modals with line grids, xl = wide editors. */
  size?: 'md' | 'lg' | 'xl';
}) {
  const titleId = React.useId();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);
  // Callers pass inline onClose arrows: read the latest through a ref so a re-render while the
  // dialog is open (every keystroke in its fields) doesn't re-run the focus effect below.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  // Escape-to-close + focus management (first field, trap inside the dialog, restore on close).
  React.useEffect(() => {
    if (!open) return;
    const dialogEl = dialogRef.current;
    const active = document.activeElement as HTMLElement | null;
    // QB: a form opens with the cursor in its first field (Customer / Vendor / Payee). A field
    // with autoFocus already has it; otherwise take the first field, else the dialog itself.
    if (dialogEl && active && dialogEl.contains(active)) {
      restoreRef.current = openerOf(dialogEl);
    } else {
      restoreRef.current = active;
      const first = Array.from(dialogEl?.querySelectorAll<HTMLElement>(FIRST_FIELD) ?? []).find(
        (el) => el.getClientRects().length > 0,
      );
      (first ?? dialogEl)?.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      // Only the most recently opened dialog takes Esc / Tab (a confirm over a form closes
      // alone, like QB's windows).
      if (openModals[openModals.length - 1] !== dialogRef.current) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return; // a picker inside used it to close its list
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    if (dialogEl) openModals.push(dialogEl);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const i = dialogEl ? openModals.lastIndexOf(dialogEl) : -1;
      if (i >= 0) openModals.splice(i, 1);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--titlebar-h)] z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px] animate-in fade-in duration-150" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-modal=""
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full p-6 max-h-full overflow-y-auto rounded-2xl bg-white shadow-2xl border border-slate-200/70 outline-none animate-in fade-in zoom-in-95 duration-150',
          MODAL_SIZES[size],
        )}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id={titleId} className="text-lg font-semibold text-navy">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-lg leading-none text-navy/50 transition-colors hover:bg-slate-200 hover:text-navy"
          >
            &times;
          </button>
        </div>
        {children}
        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

// ---- ConfirmDialog (replaces window.confirm) ----
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  tone,
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  /** 'danger' renders a red confirm button for destructive actions (delete/void). */
  tone?: 'danger';
  /** Optional: show a spinner on the confirm button while the action runs. */
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message ? <p className="text-sm text-navy/70">{message}</p> : null}
    </Modal>
  );
}

// ---- EmptyState ----
export function EmptyState({
  icon: Icon,
  title,
  message,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      {Icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-electric/10 text-electric">
          <Icon className="h-6 w-6" />
        </div>
      )}
      <h3 className="text-base font-semibold text-navy">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-sm text-navy/50">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---- PageSkeleton (loading placeholder for full pages) ----
export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="p-8 animate-pulse" role="status" aria-label="Loading">
      <div className="mb-6 h-8 w-64 rounded-lg bg-navy/10" />
      <div className="space-y-4 rounded-2xl border border-slate-200/70 bg-white p-6 shadow-xl">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 rounded bg-navy/5" style={{ width: `${85 - (i % 3) * 15}%` }} />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

// ---- Page header ----
export function PageHeader({
  title,
  icon: Icon,
  iconNode,
  action,
}: {
  title: string;
  /** Icon component — client components only (a function can't cross the RSC boundary). */
  icon?: React.ComponentType<{ className?: string }>;
  /** Pre-rendered icon element — use this from server components. */
  iconNode?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-6">
      <h1 className="text-[28px] font-bold tracking-tight text-navy flex items-center gap-3">
        {Icon ? <Icon className="text-electric h-7 w-7" /> : iconNode}
        {title}
      </h1>
      {action}
    </div>
  );
}

// ---- Toast (minimal, event-based) ----
type Toast = {
  id: number;
  message: string;
  tone: 'success' | 'danger' | 'info';
  /** Optional bold headline (friendly errors). */
  title?: string;
  /** Optional "what to do next" line (friendly errors). */
  nextStep?: string;
  /** Optional Fix buttons (server fix suggestions, lib/errorFixes.ts). */
  actions?: { label: string; onClick: () => void }[];
};
let pushToastFn: ((t: Omit<Toast, 'id'>) => void) | null = null;
export function toast(message: string, tone: Toast['tone'] = 'info') {
  pushToastFn?.({ message, tone });
}

/**
 * Show a failure in plain language: headline, what happened, and what to do next.
 * Maps ServiceError codes (UNBALANCED, PERIOD_CLOSED, FORBIDDEN, CONFLICT, VALIDATION,
 * NOT_FOUND, …) via lib/friendlyErrors.ts. `fallback` is the action-specific message used
 * when the error carries no useful text (e.g. "Failed to save invoice.").
 */
export function toastError(
  err: unknown,
  fallback?: string,
  /**
   * Fix errors where they happen: when the error carries fix suggestions (ApiError.fixes),
   * `onFix` turns them into buttons on the toast. Without it, "go to" (navigate) fixes are still
   * offered as buttons that open the page.
   */
  opts?: { onFix?: (fix: ErrorFix) => void },
) {
  const f = describeError(err, fallback);
  // A save the user cancelled at a Preferences prompt is not an error.
  if ((err as { code?: string } | null)?.code === 'CANCELLED') {
    pushToastFn?.({ tone: 'info', message: (err as Error).message });
    return;
  }
  const fixes = (err as { fixes?: unknown } | null)?.fixes;
  const list = Array.isArray(fixes) ? (fixes as ErrorFix[]) : [];
  const actions = list
    .filter((fix) => opts?.onFix || (fix.kind === 'navigate' && fix.href))
    .slice(0, 3)
    .map((fix) => ({
      label: fix.label,
      onClick: () => {
        if (opts?.onFix) opts.onFix(fix);
        else if (fix.href && typeof window !== 'undefined') window.location.assign(fix.href);
      },
    }));
  pushToastFn?.({
    tone: 'danger',
    title: f.title,
    message: f.message,
    nextStep: f.nextStep,
    ...(actions.length ? { actions } : {}),
  });
}

export function Toaster() {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const dismiss = React.useCallback(
    (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id)),
    [],
  );
  React.useEffect(() => {
    let n = 0;
    pushToastFn = (t) => {
      const id = ++n;
      setToasts((prev) => [...prev, { ...t, id }]);
      // Guidance needs reading time: errors with a next step stay up longer (with Fix buttons longer still).
      setTimeout(
        () => setToasts((prev) => prev.filter((x) => x.id !== id)),
        t.actions?.length ? 15000 : t.nextStep ? 9000 : 4000,
      );
    };
    return () => {
      pushToastFn = null;
    };
  }, []);
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-[calc(100vw-2rem)] w-96" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'danger' ? 'alert' : 'status'}
          data-tone={t.tone}
          className="relative flex gap-3 rounded-2xl border border-slate-200/70 bg-white/95 px-4 py-3 pr-9 text-sm text-navy shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white',
              t.tone === 'success' ? 'bg-emerald' : t.tone === 'danger' ? 'bg-red-500' : 'bg-electric',
            )}
          >
            {t.tone === 'success' ? '✓' : t.tone === 'danger' ? '!' : 'i'}
          </span>
          <div className="min-w-0 flex-1">
          {t.title && <div className="font-semibold">{t.title}</div>}
          <div className={t.title ? 'text-navy/80' : 'font-medium'}>{t.message}</div>
          {t.nextStep && <div className="mt-1 text-navy/60">{t.nextStep}</div>}
          {t.actions && t.actions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {t.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => {
                    dismiss(t.id);
                    a.onClick();
                  }}
                  className="rounded-md bg-electric px-2.5 py-1 text-xs font-semibold text-white hover:brightness-110 focus:outline-none focus-visible:ring-4 focus-visible:ring-electric/25"
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
          </div>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
            className="absolute right-2 top-2 rounded px-1 text-navy/35 hover:text-navy leading-none text-lg"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
