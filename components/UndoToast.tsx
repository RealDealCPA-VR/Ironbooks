'use client';
/**
 * Undo toast (ux/undo). Mounted once by components/AppShell.
 *
 * Registers the API client's undo tracker (lib/undoClient.ts), so EVERY save, void or delete of
 * an invoice, bill, check, deposit, payment, bill payment, journal entry, estimate, sales receipt,
 * credit memo, purchase order, transfer, vendor credit, customer, vendor, item or account made
 * anywhere in the app shows a toast with an "Undo" button and a 30-second countdown. Pages need
 * no code.
 *
 * Undo calls POST /api/undo/:token through lib/client.ts, so a change dated in a closed period
 * gets the usual closing-date password prompt. The server does the real checks (same user,
 * 30 seconds, once, record unchanged since) and answers in plain language.
 * While an Undo toast is showing, Ctrl+Z (Cmd+Z) outside a text field does the same.
 */
import * as React from 'react';
import { RotateCcw, X } from 'lucide-react';
import { api, setUndoTracker } from '@/lib/client';
import { afterFailedUndo, createUndoTracker, onUndoArmed, type ArmedUndo } from '@/lib/undoClient';
import { isEditableTarget } from '@/lib/shortcuts';
import { toastError } from '@/components/ui';

interface Shown extends ArmedUndo {
  /** Local deadline (the server's expiresAt mapped onto this clock). */
  deadline: number;
  busy: boolean;
}

/** Most Undo toasts on screen at once (older ones drop off). */
const MAX_SHOWN = 3;
const DATA_CHANGED_KEY = 'bka:dataChangedAt';

interface UndoResponse {
  message: string;
  copy?: boolean;
}

export default function UndoToast() {
  const [shown, setShown] = React.useState<Shown[]>([]);
  const [now, setNow] = React.useState(() => Date.now());
  const [done, setDone] = React.useState<{ message: string; copy: boolean } | null>(null);

  React.useEffect(() => {
    setUndoTracker(createUndoTracker());
    const off = onUndoArmed((u) => {
      // 30 s from now on this clock (never longer than the server allows).
      const serverLeft = new Date(u.expiresAt).getTime() - Date.now();
      const left = Math.max(0, Math.min(30_000, Number.isFinite(serverLeft) ? serverLeft : 30_000));
      setShown((prev) => [...prev.filter((p) => p.token !== u.token), { ...u, deadline: Date.now() + left, busy: false }].slice(-MAX_SHOWN));
    });
    return () => {
      off();
      setUndoTracker(null);
    };
  }, []);

  // Countdown tick; drops toasts whose time is up.
  React.useEffect(() => {
    if (shown.length === 0) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      setShown((prev) => prev.filter((p) => p.deadline > n || p.busy));
    }, 500);
    return () => clearInterval(t);
  }, [shown.length]);

  const dismiss = React.useCallback((token: string) => setShown((prev) => prev.filter((p) => p.token !== token)), []);

  const undo = React.useCallback(async (u: Shown) => {
    setShown((prev) => prev.map((p) => (p.token === u.token ? { ...p, busy: true } : p)));
    try {
      const res = await api.post<UndoResponse>(`/api/undo/${u.token}`, undefined, { noUndo: true });
      setShown((prev) => prev.filter((p) => p.token !== u.token));
      setDone({ message: res.message, copy: Boolean(res.copy) });
      try {
        window.localStorage.setItem(DATA_CHANGED_KEY, String(Date.now()));
      } catch {
        /* storage blocked: open reports just won't auto-refresh */
      }
    } catch (err) {
      // The token is still usable after most failures (e.g. the closing-date password prompt
      // was cancelled), so keep the toast and its Undo button while time is left.
      setShown((prev) => afterFailedUndo(prev, u.token, err));
      toastError(err, 'Could not undo that change.');
    }
  }, []);

  // Ctrl+Z / Cmd+Z undoes the newest change while its toast is showing (not inside text fields,
  // where the browser's own text undo applies).
  const latest = shown[shown.length - 1];
  React.useEffect(() => {
    if (!latest || latest.busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      void undo(latest);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [latest, undo]);

  // The result stays until dismissed or the page is reloaded (it may describe a new copy).
  React.useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), done.copy ? 15_000 : 8_000);
    return () => clearTimeout(t);
  }, [done]);

  if (shown.length === 0 && !done) return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-[100] flex flex-col gap-2 w-96 max-w-[calc(100vw-2rem)] print-hidden"
      aria-live="polite"
    >
      {shown.map((u) => {
        const secs = Math.max(0, Math.ceil((u.deadline - now) / 1000));
        return (
          <div
            key={u.token}
            role="status"
            className="flex items-center gap-3 rounded-xl bg-contrast px-4 py-3 text-sm text-white shadow-lg"
          >
            <span className="flex-1 min-w-0 truncate" title={u.message}>
              {u.message}
            </span>
            <button
              type="button"
              onClick={() => void undo(u)}
              disabled={u.busy}
              aria-label={`Undo: ${u.message} (${secs} seconds left)`}
              className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-2.5 py-1 font-semibold hover:bg-white/25 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {u.busy ? 'Undoing…' : 'Undo'}
              {!u.busy && <span className="tabular-nums text-white/70 font-normal">{secs}s</span>}
            </button>
            <button
              type="button"
              onClick={() => dismiss(u.token)}
              aria-label="Dismiss"
              className="rounded p-0.5 text-white/60 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {done && (
        <div role="status" className="rounded-lg bg-emerald px-4 py-3 text-sm text-white shadow-lg">
          <div className="flex items-start gap-3">
            <p className="flex-1">{done.message}</p>
            <button
              type="button"
              onClick={() => setDone(null)}
              aria-label="Dismiss"
              className="rounded p-0.5 text-white/70 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 rounded-md bg-white/20 px-2.5 py-1 font-semibold hover:bg-white/30 outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Reload page to see the change
          </button>
        </div>
      )}
    </div>
  );
}
