'use client';
/**
 * The "Leave this form?" guard, mounted once on every page (app/layout.tsx) — the sign-in
 * screens and the setup interview included, which have no app shell. Ironbooks shows one page at
 * a time where QuickBooks would open a second window, so anything that leaves or restarts the
 * page asks first when typed work could be lost:
 *
 *  - every navigation request (lib/shortcuts.ts navigateGuarded / historyGuarded): the QuickBooks
 *    keys (Ctrl+W, Ctrl+I, …), the desktop menus, Window > Back / Forward (Alt+Left / Alt+Right),
 *    the command bar;
 *  - F5 and View > Refresh: QuickBooks' "Refresh list". Every F5 press is taken (held-down
 *    repeats too, which used to slip through to the window's own reload); the page area is
 *    started over in place (components/PageRefresh.tsx), which fetches its data again; screens
 *    without one reload.
 *  - closing the desktop window (Alt+F4): electron/main.js asks window.__ironbooksUnsavedWork().
 *
 * "Could be lost" is lib/shortcuts.ts leaveRisk: a form dialog is open, a page holds unsaved
 * answers (data-unsaved-work), or the cursor is in a field on the page — or was, just before the
 * command bar or the title-bar menu took the focus (remembered here), so the mouse and the
 * keyboard paths ask alike.
 */
import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ui';
import {
  NAVIGATE_REQUEST_EVENT,
  PAGE_REFRESH_EVENT,
  REFRESH_REQUEST_EVENT,
  type NavigateRequest,
  isFormField,
  isReloadKey,
  leaveRisk,
} from '@/lib/shortcuts';

type Pending = { kind: 'leave' | 'refresh'; run: () => void };

declare global {
  interface Window {
    /** For electron/main.js: closing the window now would lose typed work. */
    __ironbooksUnsavedWork?: () => boolean;
  }
}

/** Start the page over in place (components/PageRefresh.tsx), else reload the window. */
export function refreshNow() {
  const ev = new Event(PAGE_REFRESH_EVENT, { cancelable: true });
  window.dispatchEvent(ev);
  if (!ev.defaultPrevented) window.location.reload();
}

/** Ask for a refresh through the guard (F5, View > Refresh). */
export function requestRefresh() {
  window.dispatchEvent(new Event(REFRESH_REQUEST_EVENT));
}

/** In the shell's own chrome (header, sidebar, title bar) rather than on the page. */
const inChrome = (el: Element | null) => !!el?.closest?.('[data-shell-chrome], [data-window-titlebar]');
const onPage = (el: Element | null) => !!el?.closest?.('main, [role="dialog"]') && !inChrome(el);

export default function LeaveGuard() {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, setPending] = React.useState<Pending | null>(null);
  /** The field the cursor was last in on the page (kept while the command bar / menus have focus). */
  const remembered = React.useRef<Element | null>(null);
  const pendingRef = React.useRef<Pending | null>(null);
  pendingRef.current = pending;

  React.useEffect(() => {
    remembered.current = null;
  }, [pathname]);

  React.useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      const el = e.target as Element | null;
      if (!el || !onPage(el)) return; // the command bar, the menus: keep what was there
      remembered.current = isFormField(el) ? el : null;
    }
    function onFocusOut(e: FocusEvent) {
      // Clicking the page's background leaves no field active (the window losing focus to a
      // native menu does not count).
      if (!e.relatedTarget && document.hasFocus() && onPage(e.target as Element)) {
        window.setTimeout(() => {
          if (document.activeElement === document.body) remembered.current = null;
        }, 0);
      }
    }
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
    };
  }, []);

  const atRisk = React.useCallback(() => leaveRisk(document.activeElement, remembered.current), []);

  React.useEffect(() => {
    window.__ironbooksUnsavedWork = atRisk;
    return () => {
      if (window.__ironbooksUnsavedWork === atRisk) delete window.__ironbooksUnsavedWork;
    };
  }, [atRisk]);

  // Navigation requests.
  React.useEffect(() => {
    function onNavigate(e: Event) {
      const detail = (e as CustomEvent<NavigateRequest>).detail;
      if (!detail || (!detail.href && !detail.history)) return;
      e.preventDefault();
      const run = () => {
        if (detail.history === 'back') router.back();
        else if (detail.history === 'forward') router.forward();
        else if (detail.href) (detail.go ?? router.push)(detail.href);
      };
      if (atRisk()) setPending({ kind: 'leave', run });
      else run();
    }
    window.addEventListener(NAVIGATE_REQUEST_EVENT, onNavigate);
    return () => window.removeEventListener(NAVIGATE_REQUEST_EVENT, onNavigate);
  }, [router, atRisk]);

  // F5 / View > Refresh.
  React.useEffect(() => {
    function ask() {
      if (atRisk()) setPending({ kind: 'refresh', run: refreshNow });
      else refreshNow();
    }
    function onKey(e: KeyboardEvent) {
      if (!isReloadKey(e) || e.isComposing) return;
      // Every F5 is ours, held-down repeats too: none may reach the window's own reload.
      e.preventDefault();
      if (e.repeat || pendingRef.current) return;
      ask();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener(REFRESH_REQUEST_EVENT, ask);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener(REFRESH_REQUEST_EVENT, ask);
    };
  }, [atRisk]);

  return (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.kind === 'refresh' ? 'Refresh this window?' : 'Leave this form?'}
      message={
        pending?.kind === 'refresh'
          ? 'Refreshing starts this window over. Anything typed here and not saved will be lost.'
          : 'Ironbooks shows one window at a time. Anything typed here and not saved will be lost.'
      }
      confirmLabel={pending?.kind === 'refresh' ? 'Refresh' : 'Leave'}
      onConfirm={() => {
        const p = pending;
        setPending(null);
        p?.run();
      }}
      onClose={() => setPending(null)}
    />
  );
}
