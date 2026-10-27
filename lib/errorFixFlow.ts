/**
 * Fix errors where they happen — the presenter's logic, kept free of React so it can be tested:
 *  - `reportMode`: how a failed save is shown. A form that renders the inline fix panel shows
 *    the error ONLY there (one alert, with the Fix buttons); a toast would repeat it and screen
 *    readers would announce it twice. Callers without a panel get a toast with the Fix buttons.
 *    Errors without fixes always toast.
 *  - `runFix`: what clicking a Fix button does (navigate, or patch the body, copy the change back
 *    to the form, save again, and on a new failure report it against the body actually sent).
 */
import { retryPayloads, type ErrorFix } from '@/lib/errorFixes';

export type ReportMode = 'toast' | 'panel' | 'toast-with-fixes';

export function reportMode(fixCount: number, hasPanel: boolean): ReportMode {
  if (fixCount === 0) return 'toast';
  return hasPanel ? 'panel' : 'toast-with-fixes';
}

export interface FixRunContext<P> {
  payload: P;
  resubmit: (patched: P) => Promise<unknown>;
  prepare?: (body: P) => P;
  applyToForm?: (patched: P, fix: ErrorFix) => void;
  /**
   * The form was changed after the error was shown. A fix re-sends the body that failed (patched),
   * so it would save the old form and drop the later changes; it is not run then.
   */
  isStale?: () => boolean;
}

export interface FixRunDeps<P> {
  navigate: (href: string) => void;
  setBusy: (id: string | null) => void;
  /** The retry saved: clear the panel. */
  onSaved: () => void;
  /** The retry failed: show the new error; `payload` is the body the server saw. */
  onError: (err: unknown, payload: P) => void;
  /** The form changed since the error (isStale): nothing was sent; ask for a fresh save. */
  onStale?: () => void;
}

export type FixRunOutcome = 'navigated' | 'saved' | 'failed' | 'ignored' | 'stale';

export async function runFix<P>(fix: ErrorFix, ctx: FixRunContext<P>, deps: FixRunDeps<P>): Promise<FixRunOutcome> {
  if (fix.kind === 'navigate') {
    if (!fix.href) return 'ignored';
    deps.navigate(fix.href);
    return 'navigated';
  }
  if (ctx.isStale?.()) {
    deps.onStale?.();
    return 'stale';
  }
  const { patched, sent } = retryPayloads(ctx.payload, fix.patch, ctx.prepare);
  ctx.applyToForm?.(patched, fix);
  deps.setBusy(fix.id);
  try {
    await ctx.resubmit(sent);
    deps.onSaved();
    return 'saved';
  } catch (err) {
    // Report against the body the server actually saw, so its patch indexes match.
    deps.onError(err, sent);
    return 'failed';
  } finally {
    deps.setBusy(null);
  }
}
