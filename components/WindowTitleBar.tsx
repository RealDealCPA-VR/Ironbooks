'use client';
/**
 * The desktop window's title bar. The window has no system frame (electron/windowTheme.js), so
 * this bar is what you drag, double-click to maximize, and where the menus live: File, Edit,
 * View, then the QuickBooks menus. Each opens the real application menu as a native popup, so
 * every item, accelerator and check mark stays defined once, in electron/main.js.
 *
 * The bar is reserved by CSS from the first paint (html[data-desktop], set by THEME_BOOT_SCRIPT)
 * and fills in after hydration. In a browser it never shows.
 */
import * as React from 'react';
import { Briefcase } from 'lucide-react';
import { chromeBridge } from '@/lib/useTheme';
import { cn } from '@/lib/utils';
import { formShortcutTarget } from './FormShortcuts';
import { CompanyFileStatus } from './CompanyFileStatus';

/**
 * Alt+letter opens a menu, QuickBooks' letters — unless the page has a button on that key (an
 * accesskey) or an open form takes it (Alt+S Save & New, Alt+A Save & Close, Alt+R Revert,
 * Alt+P / Alt+N Previous / Next: components/FormShortcuts.tsx).
 */
const MNEMONICS: Record<string, string> = {
  File: 'f',
  Edit: 'e',
  View: 'v',
  Company: 'c',
  Customers: 'u',
  Vendors: 'n',
  Employees: 'm',
  Banking: 'b',
  Reports: 'r',
  Lists: 'l',
  Window: 'w',
  Help: 'h',
};

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

export default function WindowTitleBar() {
  const [menus, setMenus] = React.useState<string[]>([]);
  const [platform, setPlatform] = React.useState<string | null>(null);
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const title = useDocumentTitle();

  React.useEffect(() => {
    const bridge = chromeBridge();
    if (!bridge?.frameless) return;
    setPlatform(bridge.platform);
    // macOS keeps its menu bar at the top of the screen.
    if (bridge.platform !== 'darwin') bridge.menus?.().then((m) => setMenus(Array.isArray(m) ? m : [])).catch(() => {});
  }, []);

  const openMenu = React.useCallback(async (index: number) => {
    const bridge = chromeBridge();
    const el = buttons.current[index];
    if (!bridge?.popupMenu || !el) return;
    const r = el.getBoundingClientRect();
    setOpenIndex(index);
    try {
      await bridge.popupMenu(index, r.left, r.bottom + 2);
    } finally {
      setOpenIndex(null);
    }
  }, []);

  React.useEffect(() => {
    if (!menus.length) return;
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented || e.key.length !== 1) return;
      const letter = e.key.toLowerCase();
      // A button or field on the page owns Alt+<its letter> (batch entry: Alt+S save, ...).
      if (document.querySelector(`[accesskey="${letter}" i]`)) return;
      // So does an open form with that button (Alt+R Revert, Alt+N Next, ...).
      if (formShortcutTarget(e)) return;
      const index = menus.findIndex((m) => MNEMONICS[m] === letter);
      if (index < 0) return;
      e.preventDefault();
      void openMenu(index);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menus, openMenu]);

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
          <nav aria-label="Application menu" className="flex min-w-0 items-center overflow-hidden">
            {menus.map((label, i) => (
              <button
                key={label}
                ref={(el) => {
                  buttons.current[i] = el;
                }}
                type="button"
                aria-haspopup="menu"
                aria-expanded={openIndex === i}
                aria-keyshortcuts={MNEMONICS[label] ? `Alt+${MNEMONICS[label].toUpperCase()}` : undefined}
                onClick={() => void openMenu(i)}
                className={cn(
                  'app-no-drag h-7 shrink-0 rounded-md px-2.5 text-[13px] text-navy/80 outline-none transition-colors hover:bg-navy/[.07] hover:text-navy focus-visible:ring-2 focus-visible:ring-electric/50',
                  openIndex === i && 'bg-navy/10 text-navy',
                )}
              >
                {label}
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
