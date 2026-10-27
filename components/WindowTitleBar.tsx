'use client';
/**
 * The desktop window's title bar. The window has no system frame (electron/windowTheme.js), so
 * this bar is what you drag, double-click to maximize, and where the menus live: File, Edit,
 * View, then the QuickBooks menus. Each opens the real application menu as a native popup, so
 * every item, accelerator and check mark stays defined once, in electron/main.js.
 *
 * The bar is reserved by CSS from the first paint (html[data-desktop], set by THEME_BOOT_SCRIPT)
 * and fills in after hydration. In a browser it never shows.
 *
 * Keyboard, as in QuickBooks (Windows menus):
 *   Alt+letter         opens that menu (MENU_MNEMONICS: QuickBooks' underlined letters; the
 *                      physical key counts, so a Cyrillic or Greek layout opens them too)
 *   Alt alone          the menu bar takes the keyboard, its letters underlined: Left / Right move,
 *                      Down / Enter / Space or the letter open a menu, Esc or Alt go back to the page
 */
import * as React from 'react';
import { Briefcase } from 'lucide-react';
import { chromeBridge } from '@/lib/useTheme';
import { cn } from '@/lib/utils';
import { MENU_MNEMONICS, menuForKey, menuForLetter } from '@/lib/shortcuts';
import { formShortcutTarget } from './FormShortcuts';
import { CompanyFileStatus } from './CompanyFileStatus';

/** A menu's label with its letter underlined while the menu bar shows its keys. */
function MenuLabel({ label, show }: { label: string; show: boolean }) {
  const letter = MENU_MNEMONICS[label];
  const at = letter ? label.toLowerCase().indexOf(letter) : -1;
  if (!show || at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)}
      <span className="underline underline-offset-2">{label[at]}</span>
      {label.slice(at + 1)}
    </>
  );
}

function useDocumentTitle(): string {
  const [title, setTitle] = React.useState('');
  React.useEffect(() => {
    const read = () => setTitle(document.title);
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => obs.disconnect();
  }, []);
  return title;
}

/** Window event: the desktop menus changed (Favorites customized) — read their labels again. */
export const MENUS_CHANGED_EVENT = 'ironbooks:menus-changed';

export default function WindowTitleBar() {
  const [menus, setMenus] = React.useState<string[]>([]);
  const [platform, setPlatform] = React.useState<string | null>(null);
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);
  /** The menu bar has the keyboard (Alt pressed alone): its letters show, arrows move. */
  const [keyboardMode, setKeyboardMode] = React.useState(false);
  /** Alt is held: the letters show, as in Windows. */
  const [altHeld, setAltHeld] = React.useState(false);
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  /** Where the keyboard was before the menu bar took it. */
  const returnTo = React.useRef<HTMLElement | null>(null);
  const title = useDocumentTitle();

  React.useEffect(() => {
    const bridge = chromeBridge();
    if (!bridge?.frameless) return;
    setPlatform(bridge.platform);
    // macOS keeps its menu bar at the top of the screen.
    if (bridge.platform === 'darwin') return;
    const read = () => bridge.menus?.().then((m) => setMenus(Array.isArray(m) ? m : [])).catch(() => {});
    read();
    window.addEventListener(MENUS_CHANGED_EVENT, read);
    return () => window.removeEventListener(MENUS_CHANGED_EVENT, read);
  }, []);

  const leaveMenuBar = React.useCallback((restore: boolean) => {
    setKeyboardMode(false);
    const back = returnTo.current;
    returnTo.current = null;
    if (restore && back?.isConnected) back.focus();
  }, []);

  const openMenu = React.useCallback(
    async (index: number) => {
      const bridge = chromeBridge();
      const el = buttons.current[index];
      if (!bridge?.popupMenu || !el) return;
      const r = el.getBoundingClientRect();
      setOpenIndex(index);
      try {
        await bridge.popupMenu(index, r.left, r.bottom + 2);
      } finally {
        setOpenIndex(null);
        // Opened from the menu bar's keyboard mode: the page gets the keyboard back.
        if (returnTo.current) leaveMenuBar(true);
      }
    },
    [leaveMenuBar],
  );

  React.useEffect(() => {
    if (!menus.length) return;
    /** Alt went down and nothing else was pressed with it yet. */
    let altAlone = false;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Alt') {
        altAlone = !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.repeat ? true : altAlone && e.repeat;
        setAltHeld(true);
        return;
      }
      altAlone = false;
      if (e.defaultPrevented) return;
      const index = menuForKey(e, menus);
      if (index < 0) return;
      const letter = MENU_MNEMONICS[menus[index]];
      // A button or field on the page owns Alt+<its letter> (batch entry: Alt+S save, ...).
      if (document.querySelector(`[accesskey="${letter}" i]`)) return;
      // So does an open form with that button (Alt+R Revert, Alt+N Next, Alt+A Save & Close, ...).
      if (formShortcutTarget(e)) return;
      e.preventDefault();
      void openMenu(index);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== 'Alt') return;
      setAltHeld(false);
      if (!altAlone || e.defaultPrevented) return;
      altAlone = false;
      // Alt pressed and released alone: the menu bar takes the keyboard (or gives it back).
      e.preventDefault();
      if (document.activeElement?.closest?.('[data-window-titlebar]')) {
        leaveMenuBar(true);
        return;
      }
      returnTo.current = document.activeElement as HTMLElement | null;
      setKeyboardMode(true);
      buttons.current[0]?.focus();
    }
    function onBlur() {
      altAlone = false;
      setAltHeld(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [menus, openMenu, leaveMenuBar]);

  /** Keys while a menu button has the focus (after Alt alone, or Tab to the bar). */
  function onMenuKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = menus.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      buttons.current[(i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      buttons.current[e.key === 'Home' ? 0 : n - 1]?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openMenu(i);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      leaveMenuBar(true);
    } else if (keyboardMode) {
      const index = menuForLetter(e, menus);
      if (index >= 0) {
        e.preventDefault();
        void openMenu(index);
      }
    }
  }

  const pageTitle = title.replace(/^Ironbooks( — )?/, '');

  return (
    <div
      data-window-titlebar
      className="ib-titlebar hidden [html[data-desktop]_&]:flex sticky top-0 z-[70] h-[var(--titlebar-h)] shrink-0 select-none items-center border-b border-slate-200/80 bg-chrome text-navy app-drag"
    >
      <div
        className={cn('flex h-full min-w-0 items-center gap-1 pr-3', platform === 'darwin' ? 'pl-[80px]' : 'pl-3')}
        style={{ width: platform === 'darwin' ? '100%' : 'env(titlebar-area-width, 100%)' }}
      >
        <div className="mr-2 flex shrink-0 items-center gap-2" aria-hidden="true">
          <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-gradient-to-b from-electric/90 to-electric text-white shadow-sm">
            <Briefcase className="h-3 w-3" />
          </span>
          {menus.length === 0 && <span className="text-[13px] font-semibold">Ironbooks</span>}
        </div>
        {menus.length > 0 && (
          <nav
            aria-label="Application menu"
            className="flex min-w-0 items-center overflow-hidden"
            data-menu-keyboard={keyboardMode ? '' : undefined}
            onBlur={(e) => {
              // The keyboard left the menu bar (a click on the page): it is a plain bar again.
              if (keyboardMode && openIndex === null && !e.currentTarget.contains(e.relatedTarget as Node)) leaveMenuBar(false);
            }}
          >
            {menus.map((label, i) => (
              <button
                key={label}
                ref={(el) => {
                  buttons.current[i] = el;
                }}
                type="button"
                aria-haspopup="menu"
                aria-expanded={openIndex === i}
                aria-keyshortcuts={MENU_MNEMONICS[label] ? `Alt+${MENU_MNEMONICS[label].toUpperCase()}` : undefined}
                onClick={() => void openMenu(i)}
                onKeyDown={(e) => onMenuKeyDown(e, i)}
                className={cn(
                  'app-no-drag h-7 shrink-0 rounded-md px-2.5 text-[13px] text-navy/80 outline-none transition-colors hover:bg-navy/[.07] hover:text-navy focus-visible:ring-2 focus-visible:ring-electric/50',
                  openIndex === i && 'bg-navy/10 text-navy',
                )}
              >
                <MenuLabel label={label} show={keyboardMode || altHeld} />
              </button>
            ))}
          </nav>
        )}
        <div className="ml-auto hidden min-w-0 truncate pl-4 text-xs text-navy/45 xl:block" title={title}>
          {pageTitle}
        </div>
        {/* Saved / Saving… / Not saved for a single company file (nothing for older folders). */}
        <CompanyFileStatus className={cn('shrink-0', 'ml-auto xl:ml-2')} />
      </div>
    </div>
  );
}
