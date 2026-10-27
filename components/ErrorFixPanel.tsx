'use client';
/**
 * Fix errors where they happen — the shared error presenter.
 *
 * `ErrorFixPanel` shows a failed save in plain language (headline, what happened, what to do
 * next — lib/friendlyErrors.ts) with one button per fix suggestion (lib/errorFixes.ts):
 *   - patch:    change the form ("Add $40.00 to line 3's credit") and save again;
 *   - retry:    save again, optionally with a flag ("Save anyway") or after the closing-date
 *               password prompt (the api client asks for it — lib/client.ts);
 *   - navigate: open the screen where the problem is fixed.
 *
 * `useErrorFixes` wires it into a form:
 *
 *   const fixer = useErrorFixes<Payload>();
 *   async function send(payload) { ...api.post(...)... }            // throws on failure
 *   try { await send(payload) } catch (err) {
 *     fixer.report(err, { payload, resubmit: send, applyToForm, fallback: 'Failed to save.' });
 *   }
 *   ...
 *   {fixer.panel}
 *
 * `applyToForm(patched, fix)` copies the changed request-body paths back into the form's state
 * so what the user sees matches what was saved. Errors without fixes just toast as before.
 * An error WITH fixes is shown once: in the inline panel (no toast repeating it, so screen readers
 * announce it once). A form that does not render `fixer.panel` passes `{ panel: false }` and gets
 * the Fix buttons on the toast instead (lib/errorFixFlow.ts).
 * `offer` shows fixes the form computed itself (checks run before saving, e.g. a payment applied
 * beyond an invoice's balance).
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Wrench, X } from 'lucide-react';
import { Button, toast, toastError } from '@/components/ui';
import { fieldSnapshot } from '@/components/TransactionNav';
import { errorFixes } from '@/lib/client';
import { type ErrorFix } from '@/lib/errorFixes';
import { reportMode, runFix } from '@/lib/errorFixFlow';
import { describeError, type FriendlyError } from '@/lib/friendlyErrors';

export interface ErrorFixPanelProps {
  /** Receives the panel's element (the form it sits in is the one the fixes apply to). */
  panelRef?: React.Ref<HTMLDivElement>;
  /** Plain-language description of the problem. */
  problem: Pick<FriendlyError, 'title' | 'message' | 'nextStep'>;
  fixes: ErrorFix[];
  /** Id of the fix being applied (its button shows a spinner; the others are disabled). */
  busyId?: string | null;
  onFix: (fix: ErrorFix) => void;
  onDismiss?: () => void;
  className?: string;
}

/** Presentational: the message plus one button per fix. Accessible (role="alert", labelled buttons). */
export function ErrorFixPanel({ panelRef, problem, fixes, busyId, onFix, onDismiss, className }: ErrorFixPanelProps) {
  const titleId = React.useId();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(panelRef, () => ref.current as HTMLDivElement);
  React.useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [problem.message]);
  return (
    <div
      ref={ref}
      role="alert"
      aria-labelledby={titleId}
      className={`relative rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-navy ${className ?? ''}`}
    >
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this message"
          className="absolute right-2 top-2 rounded p-1 text-navy/40 hover:text-navy"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
      <div id={titleId} className="pr-6 font-semibold text-red-700">
        {problem.title}
      </div>
      <p className="mt-0.5 text-navy/80">{problem.message}</p>
      {problem.nextStep && fixes.length === 0 && <p className="mt-1 text-navy/60">{problem.nextStep}</p>}
      {fixes.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-navy/50">
            <Wrench className="h-3.5 w-3.5" aria-hidden /> Fix it
          </div>
          <ul className="flex flex-wrap gap-2" aria-label="Ways to fix this">
            {fixes.map((fix) => (
              <li key={fix.id}>
                <Button
                  type="button"
                  size="sm"
                  variant={fix.kind === 'navigate' ? 'secondary' : 'primary'}
                  loading={busyId === fix.id}
                  disabled={!!busyId && busyId !== fix.id}
                  onClick={() => onFix(fix)}
                  title={fix.hint}
                >
                  {fix.label}
                </Button>
                {fix.hint && <span className="sr-only"> — {fix.hint}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The form a fix panel belongs to: its dialog, form or shortcut scope, else the page. */
function fixScope(el: HTMLElement): HTMLElement | null {
  return (el.closest('[role="dialog"], form, [data-shortcut-scope]') as HTMLElement | null) ?? el.closest('main');
}

export interface FixContext<P> {
  /** The request body that failed. Fix patches apply to it. */
  payload: P;
  /** Save again with the (patched, prepared) body. Must throw on failure. */
  resubmit: (patched: P) => Promise<unknown>;
  /**
   * Turn a patched body into exactly what `resubmit` sends (e.g. drop zero applications). The
   * retried body is then the payload of any further error, so the server's patch paths line up.
   * `payload` itself must already be in this sent shape.
   */
  prepare?: (body: P) => P;
  /** Copy the patched values back into the form state. */
  applyToForm?: (patched: P, fix: ErrorFix) => void;
  /** Action-specific fallback message ("Failed to save invoice."). */
  fallback?: string;
}

interface FixState<P> {
  problem: Pick<FriendlyError, 'title' | 'message' | 'nextStep'>;
  fixes: ErrorFix[];
  ctx: FixContext<P>;
}

export function useErrorFixes<P>(opts: { panel?: boolean } = {}) {
  const hasPanel = opts.panel !== false;
  const router = useRouter();
  const [state, setState] = React.useState<FixState<P> | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const stateRef = React.useRef<FixState<P> | null>(null);
  stateRef.current = state;
  // The form's fields when the error was shown (components/TransactionNav.tsx fieldSnapshot): a Fix
  // re-sends the body that failed, so after the user changed the form it would save the OLD
  // form — the later changes silently dropped while the form closed as saved.
  const panelEl = React.useRef<HTMLDivElement | null>(null);
  const shownWith = React.useRef<string | null>(null);
  React.useEffect(() => {
    shownWith.current = state && panelEl.current ? fieldSnapshot(fixScope(panelEl.current)) : null;
  }, [state]);
  const isStale = React.useCallback(
    () => shownWith.current !== null && !!panelEl.current && fieldSnapshot(fixScope(panelEl.current)) !== shownWith.current,
    [],
  );

  const clear = React.useCallback(() => {
    setState(null);
    setBusyId(null);
  }, []);

  // Declared before `apply` uses it; `apply` is referenced through a ref to avoid a cycle.
  const applyRef = React.useRef<(fix: ErrorFix) => void>(() => {});

  /** Show an error from a save. Returns true when it carried fixes (panel shown). */
  const report = React.useCallback((err: unknown, ctx: FixContext<P>): boolean => {
    const fixes = errorFixes(err);
    if (fixes.length === 0) {
      setState(null);
      toastError(err, ctx.fallback);
      return false;
    }
    const f = describeError(err, ctx.fallback);
    setState({ problem: { title: f.title, message: f.message, nextStep: f.nextStep }, fixes, ctx });
    // Shown once: the inline panel is the alert; only forms without one toast the Fix buttons.
    if (reportMode(fixes.length, hasPanel) === 'toast-with-fixes') {
      toastError(err, ctx.fallback, { onFix: (fix) => applyRef.current(fix) });
    }
    return true;
  }, [hasPanel]);

  /** Show fixes the form computed itself (a check that runs before saving). */
  const offer = React.useCallback(
    (problem: { title: string; message: string; nextStep?: string }, fixes: ErrorFix[], ctx: FixContext<P>) => {
      setState({ problem: { nextStep: '', ...problem }, fixes, ctx });
      if (reportMode(fixes.length, hasPanel) === 'toast-with-fixes') {
        // No inline panel on this form: the toast carries the Fix buttons.
        toastError(Object.assign(new Error(problem.message), { fixes }), problem.message, {
          onFix: (fix) => applyRef.current(fix),
        });
      }
    },
    [hasPanel],
  );

  const apply = React.useCallback(
    async (fix: ErrorFix) => {
      const cur = stateRef.current;
      if (!cur) return;
      await runFix(fix, { ...cur.ctx, isStale }, {
        navigate: (href) => router.push(href),
        setBusy: setBusyId,
        onSaved: () => setState(null),
        onStale: () => {
          setState(null);
          toast('You changed the form after this message, so nothing was saved yet. Save again — the message comes back if it still applies.', 'info');
        },
        // Report against the body the server actually saw, so its patch indexes match.
        onError: (err, sent) => report(err, { ...cur.ctx, payload: sent }),
      });
    },
    [router, report, isStale],
  );
  applyRef.current = (fix) => void apply(fix);

  const panel = state && hasPanel ? (
    <ErrorFixPanel
      panelRef={panelEl}
      className="mb-4"
      problem={state.problem}
      fixes={state.fixes}
      busyId={busyId}
      onFix={(fix) => void apply(fix)}
      onDismiss={clear}
    />
  ) : null;

  return { report, offer, clear, apply, panel, active: state !== null, busy: busyId !== null };
}
