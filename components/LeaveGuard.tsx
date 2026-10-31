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
 * keyboard paths ask alike — or a form on the page (Write Checks, a register's blank line) has
 * been changed, wherever the cursor is now (trackFormChanges, started when a field there first
 * takes the focus).
 */
import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ConfirmDialog, formWasChanged, trackFormChanges } from '@/components/ui';
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

/** A reload the person already agreed to (no second "leave this page?" from the browser). */
let reloadingOnPurpose = false;

/** The page is about to leave because the person chose to (a "Skip" button): don't ask again. */
export function leaveOnPurpose() {
  reloadingOnPurpose = true;
}

/** Start the page over in place (components/PageRefresh.tsx), else reload the window. */
export function refreshNow() {
  const ev = new Event(PAGE_REFRESH_EVENT, { cancelable: true });
  window.dispatchEvent(ev);
  if (!ev.defaultPrevented) {
    reloadingOnPurpose = true;
    window.location.reload();
  }
}

/** Ask for a refresh through the guard (F5, View > Refresh). */
export function requestRefresh() {
  window.dispatchEvent(new Event(REFRESH_REQUEST_EVENT));
}

/** In the shell's own chrome (header, sidebar, title bar) rather than on the page. */
const inChrome = (el: Element | null) => !!el?.closest?.('[data-shell-chrome], [data-window-titlebar]');
const onPage = (el: Element | null) => !!el?.closest?.('main, [role="dialog"]') && !inChrome(el);

/** The forms on a page (not in a dialog) whose changes leaving would lose. */
export const PAGE_FORMS = 'main form, main [data-shortcut-scope], main [data-register-entry]';

/** After a save: the page's forms count as unchanged again (the next edit notes them afresh). */
export function resetPageFormChanges(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>(PAGE_FORMS).forEach((f) => {
    if (!f.closest('[role="dialog"]') && formWasChanged(f)) trackFormChanges(f).reset();
  });
}

/** A form on the page has been changed. */
export function pageFormChanged(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>(PAGE_FORMS)).some(
    (f) => !f.closest('[role="dialog"]') && formWasChanged(f),
  );
}

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
      // Start noticing changes to the page form this field belongs to.
      const form = isFormField(el) ? (el.closest(PAGE_FORMS) as HTMLElement | null) : null;
      if (form && !form.closest('[role="dialog"]')) trackFormChanges(form);
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

  const atRisk = React.useCallback(() => leaveRisk(document.activeElement, remembered.current) || pageFormChanged(), []);

  React.useEffect(() => {
    window.__ironbooksUnsavedWork = atRisk;
    // In a browser, closing the tab or typing another address asks too (the desktop window asks
    // through electron/main.js instead: there a beforeunload refusal would silently keep it open).
    const desktop = Boolean((window as unknown as { bookkeeper?: { isDesktop?: boolean } }).bookkeeper?.isDesktop);
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (desktop || reloadingOnPurpose || !atRisk()) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
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

  // Every in-app link (a page's own links, a menu link): a plain click that would leave a form
  // being typed asks first. Ctrl / Shift / middle clicks, new-window and download links and
  // other sites are left alone.
  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return; // same page (#anchor)
      if (!atRisk()) return;
      e.preventDefault();
      e.stopPropagation();
      const href = `${url.pathname}${url.search}${url.hash}`;
      setPending({ kind: 'leave', run: () => router.push(href) });
    }
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
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
