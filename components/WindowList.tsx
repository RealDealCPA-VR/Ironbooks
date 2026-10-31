'use client';
/**
 * QuickBooks' windows, mounted once by components/AppShell.tsx. Ironbooks shows one page at a
 * time; the pages opened this session are its "open windows" (lib/windowList.ts):
 *
 *   Ctrl+Tab / Ctrl+F6                 the next open window (Ctrl+F6 on a list with a highlighted
 *                                      name or account: its QuickReport, as Intuit lists it)
 *   Ctrl+Shift+Tab / Ctrl+Shift+F6     the previous one
 *   Ctrl+F4                            close the open form (asking about changes, as Esc does);
 *                                      with none open, close this window and show the one before it
 *   Esc (nothing selected, no form)    close this window, as in QuickBooks
 *   Window > Open Window List          the list; Enter switches to a window, Delete closes it
 *
 * Every switch goes through the leave-this-form check (navigateGuarded).
 */
import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button, CLOSE_DIALOG_EVENT, Modal } from '@/components/ui';
import { paletteDestinations } from '@/lib/nav';
import { globalShortcutFor, isEditableTarget, navigateGuarded } from '@/lib/shortcuts';
import { openDialog, selectedRow } from '@/lib/keyboardTargets';
import { type OpenWindow, closeWindow, cycleWindow, parseWindowList, visitWindow } from '@/lib/windowList';
import { useTypeAhead } from '@/lib/menuKeys';

const STORAGE_KEY = 'ironbooks.openWindows';

/** Window > Open Window List (desktop menu) and the Window keys' list. */
export const OPEN_WINDOW_LIST_EVENT = 'ironbooks:open-window-list';
/** Window > Close Window / Next Window / Previous Window from the desktop menu: detail { action }. */
export const WINDOW_COMMAND_EVENT = 'ironbooks:window-command';
export type WindowCommand = 'close' | 'next' | 'prev';

/** Best-matching menu label for a path (longest href prefix wins). */
export function windowLabelFor(pathname: string): string | null {
  let best: { label: string; href: string } | null = null;
  for (const d of paletteDestinations) {
    const href = d.href.split('?')[0];
    if (pathname === href || pathname.startsWith(href + '/')) {
      if (!best || href.length > best.href.length) best = { label: d.label, href };
    }
  }
  return best?.label ?? null;
}

function readList(): OpenWindow[] {
  try {
    return parseWindowList(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}
function writeList(list: OpenWindow[]) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the list lives for this page only */
  }
}

/** Something on the page has a list or menu open (it takes Esc for itself). */
function popupOpen(): boolean {
  return !!document.querySelector('[aria-expanded="true"]');
}

export default function WindowList() {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const [list, setList] = React.useState<OpenWindow[]>([]);
  const [showList, setShowList] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<OpenWindow[]>([]);
  listRef.current = list;
  const typeAhead = useTypeAhead();

  // Note each page as it opens (its title settles a moment after the page draws).
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const href = `${window.location.pathname}${window.location.search}`;
      const title = document.title.replace(/^Ironbooks( — )?/, '').split(' — ')[0];
      const next = visitWindow(readList(), href, windowLabelFor(window.location.pathname) ?? title ?? pathname);
      writeList(next);
      setList(next);
    }, 50);
    return () => window.clearTimeout(t);
  }, [pathname]);

  const go = React.useCallback((href: string) => navigateGuarded(href, (h) => router.push(h)), [router]);

  const run = React.useCallback(
    (cmd: WindowCommand) => {
      const current = window.location.pathname;
      if (cmd === 'close') {
        // An open form closes first, the way Esc closes it (asking about changes).
        if (openDialog()) {
          window.dispatchEvent(new Event(CLOSE_DIALOG_EVENT, { cancelable: true }));
          return;
        }
        const { list: rest, show } = closeWindow(readList(), current);
        writeList(rest);
        setList(rest);
        if (show !== `${current}${window.location.search}`) go(show);
        return;
      }
      const target = cycleWindow(readList(), current, cmd === 'next' ? 1 : -1);
      if (target) go(target.href);
    },
    [go],
  );

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const sc = globalShortcutFor(e, isEditableTarget(target));
      const cmd: WindowCommand | null =
        sc?.command === 'close-window' ? 'close' : sc?.command === 'next-window' ? 'next' : sc?.command === 'prev-window' ? 'prev' : null;
      if (cmd) {
        e.preventDefault();
        // Intuit's list: Ctrl+F6 on a list runs the highlighted name's or account's QuickReport.
        const quickReport =
          cmd === 'next' && e.key === 'F6' ? selectedRow(target, openDialog())?.getAttribute('data-quick-report') : null;
        if (quickReport) go(quickReport);
        else run(cmd);
        return;
      }
      // QuickBooks: Esc closes the active window. Only from the page itself — never from a field,
      // a dialog, a selected row or an open list, which all have their own Esc.
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !openDialog() && !popupOpen()) {
        const onBody = !target || target === document.body || target === document.documentElement || target.tagName === 'MAIN';
        if (onBody && window.location.pathname !== '/dashboard') {
          e.preventDefault();
          run('close');
        }
      }
    }
    function onCommand(e: Event) {
      const action = (e as CustomEvent<{ action?: WindowCommand }>).detail?.action;
      if (action) run(action);
    }
    function onOpenList() {
      const l = readList();
      setList(l);
      setActive(Math.max(0, l.findIndex((w) => w.path === window.location.pathname)));
      setShowList(true);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener(WINDOW_COMMAND_EVENT, onCommand);
    window.addEventListener(OPEN_WINDOW_LIST_EVENT, onOpenList);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(WINDOW_COMMAND_EVENT, onCommand);
      window.removeEventListener(OPEN_WINDOW_LIST_EVENT, onOpenList);
    };
  }, [run, go]);

  function closeFromList(w: OpenWindow) {
    const rest = readList().filter((x) => x.path !== w.path);
    writeList(rest);
    setList(rest);
    setActive((a) => Math.min(a, Math.max(0, rest.length - 1)));
    if (w.path === window.location.pathname) {
      setShowList(false);
      go(rest[rest.length - 1]?.href ?? '/dashboard');
    }
  }

  return (
    <Modal open={showList} onClose={() => setShowList(false)} title="Open Window List">
      <p className="mb-3 text-xs text-navy/55">
        The windows you opened this session. Enter switches to one, Delete closes it. Ctrl+Tab and Ctrl+F6 move to the next one
        from anywhere.
      </p>
      {list.length === 0 ? (
        <p className="py-4 text-sm text-navy/50">No windows are open.</p>
      ) : (
        <ul
          role="listbox"
          aria-label="Open windows"
          tabIndex={0}
          aria-activedescendant={`open-window-${active}`}
          className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (e.key === 'ArrowDown' ? Math.min(list.length - 1, a + 1) : Math.max(0, a - 1)));
            } else if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              setActive(e.key === 'Home' ? 0 : list.length - 1);
            } else if (e.key === 'Enter' && list[active]) {
              e.preventDefault();
              setShowList(false);
              go(list[active].href);
            } else if (e.key === 'Delete' && list[active]) {
              e.preventDefault();
              closeFromList(list[active]);
            } else {
              // A window's first letter jumps to it (Windows lists).
              const to = typeAhead(e, active, list.map((w) => w.label));
              if (to !== null) {
                e.preventDefault();
                setActive(to);
              }
            }
          }}
          ref={(el) => {
            if (el && showList) el.focus();
          }}
        >
          {list.map((w, i) => (
            <li
              key={w.path}
              id={`open-window-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              className={`flex items-center justify-between gap-2 px-3 py-2 text-sm ${i === active ? 'bg-electric/10' : ''}`}
            >
              <button
                type="button"
                tabIndex={-1}
                className="min-w-0 flex-1 truncate text-left text-navy"
                onClick={() => {
                  setShowList(false);
                  go(w.href);
                }}
              >
                {w.label}
                {w.path === pathname && <span className="ml-2 text-xs text-navy/45">(this window)</span>}
              </button>
              <Button size="sm" variant="ghost" tabIndex={-1} onClick={() => closeFromList(w)} aria-label={`Close ${w.label}`}>
                Close
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
