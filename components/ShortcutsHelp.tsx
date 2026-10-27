'use client';
/**
 * The Help window (mounted once in app/layout.tsx, so it works on every screen):
 *
 *   F1                         opens it on "This page" (the page's plain-language help), or on the
 *                              keyboard shortcuts when the page has none
 *   ?                          opens it on "Keyboard shortcuts" (outside text fields)
 *   Help > Keyboard Shortcuts  the same, from the desktop menus (components/DesktopBridge.tsx)
 *
 * The shortcuts tab lists exactly the keys that work (lib/qbShortcuts.ts rows marked done; the
 * desktop menu keys only in the desktop app), under Intuit's own headings. QuickBooks keys that
 * do something else here, and why, are listed separately below them.
 *
 * Keyboard: Left / Right switch tabs, typing in "Find a key" filters, Esc closes.
 */
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Modal } from '@/components/ui';
import { pageHelpFor } from '@/lib/pageHelp';
import { QB_SHORTCUTS, QB_SHORTCUT_GROUPS, shortcutsHelpGroups, type QbShortcut } from '@/lib/qbShortcuts';
import { isEditableTarget } from '@/lib/shortcuts';

export type HelpTab = 'page' | 'shortcuts';

/** Window event that opens the Help window: detail { tab }. */
export const OPEN_HELP_EVENT = 'ironbooks:open-help';

export function openHelpWindow(tab: HelpTab) {
  window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT, { detail: { tab } }));
}

/** In the desktop app (its menus and window keys work there). */
function isDesktop(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { bookkeeper?: { isDesktop?: boolean } }).bookkeeper?.isDesktop);
}

/** Rows whose keys or descriptions contain every word of `q`. */
export function filterShortcutRows(rows: QbShortcut[], q: string): QbShortcut[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const text = `${r.keys} ${r.qb} ${r.ironbooks}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

function Keys({ keys }: { keys: string }) {
  return (
    <kbd className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-navy shadow-[0_1px_0_rgb(var(--slate-200))] whitespace-nowrap">
      {keys}
    </kbd>
  );
}

export default function ShortcutsHelp() {
  const pathname = usePathname() || '/';
  const [tab, setTab] = React.useState<HelpTab | null>(null);
  const [query, setQuery] = React.useState('');
  const [desktop, setDesktop] = React.useState(false);
  const page = pageHelpFor(pathname);
  const tabIds = { page: React.useId(), shortcuts: React.useId() };

  React.useEffect(() => setDesktop(isDesktop()), []);

  React.useEffect(() => {
    function onOpen(e: Event) {
      const want = (e as CustomEvent<{ tab?: HelpTab }>).detail?.tab ?? 'shortcuts';
      setQuery('');
      setTab(want === 'page' && !pageHelpFor(window.location.pathname) ? 'shortcuts' : want);
    }
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        openHelpWindow('page');
        return;
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target)) {
        e.preventDefault();
        openHelpWindow('shortcuts');
      }
    }
    window.addEventListener(OPEN_HELP_EVENT, onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_HELP_EVENT, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const groups = React.useMemo(
    () =>
      shortcutsHelpGroups({ desktop })
        .map((g) => ({ ...g, rows: filterShortcutRows(g.rows, query) }))
        .filter((g) => g.rows.length > 0),
    [desktop, query],
  );
  const different = React.useMemo(
    () => filterShortcutRows(QB_SHORTCUTS.filter((s) => s.status === 'na'), query),
    [query],
  );

  const tabs: { id: HelpTab; label: string }[] = page
    ? [
        { id: 'page', label: 'This page' },
        { id: 'shortcuts', label: 'Keyboard shortcuts' },
      ]
    : [{ id: 'shortcuts', label: 'Keyboard shortcuts' }];

  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === tab);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[next].id);
    document.getElementById(`${tabIds[tabs[next].id]}-tab`)?.focus();
  }

  return (
    <Modal open={tab !== null} onClose={() => setTab(null)} title="Help" size="lg">
      <div role="tablist" aria-label="Help" className="mb-4 flex gap-1 border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`${tabIds[t.id]}-tab`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${tabIds[t.id]}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={onTabKey}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-electric/50 ${
              tab === t.id ? 'border-electric text-electric' : 'border-transparent text-navy/60 hover:text-navy'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'page' && page && (
        <div id={`${tabIds.page}-panel`} role="tabpanel" aria-labelledby={`${tabIds.page}-tab`} className="space-y-3 text-sm text-navy/80" data-help-page>
          <h3 className="text-base font-semibold text-navy">{page.title}</h3>
          {page.qb && page.qb !== page.title && <p className="text-navy/55">QuickBooks calls this &ldquo;{page.qb}&rdquo;.</p>}
          <p>{page.what}</p>
          <p>
            <span className="font-semibold text-navy">First: </span>
            {page.first}
          </p>
          <p className="text-navy/55">
            Press <Keys keys="?" /> for the keyboard shortcuts.{' '}
            <a href="/help" target="_blank" rel="noopener noreferrer" className="font-semibold text-electric hover:underline">
              Open the full Help (new window)
            </a>
          </p>
        </div>
      )}

      {tab === 'shortcuts' && (
        <div id={`${tabIds.shortcuts}-panel`} role="tabpanel" aria-labelledby={`${tabIds.shortcuts}-tab`} data-help-shortcuts>
          <label className="mb-3 block">
            <span className="sr-only">Find a key</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a key or what it does (e.g. register, Ctrl+G, date)"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-4 focus:ring-electric/20"
            />
          </label>
          {groups.length === 0 && <p className="py-4 text-sm text-navy/50">No key matches &ldquo;{query}&rdquo;.</p>}
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
            {groups.map((g) => (
              <section key={g.id} aria-labelledby={`help-group-${g.id}`} data-shortcut-group={g.id}>
                <h3 id={`help-group-${g.id}`} className="mb-1 text-[11px] font-bold uppercase tracking-wider text-navy/40">
                  {g.title}
                </h3>
                <dl>
                  {g.rows.map((s) => (
                    <div key={`${s.keys}-${s.ironbooks}`} className="flex items-start justify-between gap-3 py-1.5" data-shortcut-row={s.keys}>
                      <dd className="text-sm text-navy/70">{s.ironbooks}</dd>
                      <dt className="shrink-0">
                        <Keys keys={s.keys} />
                      </dt>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          {different.length > 0 && (
            <details className="mt-5 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <summary className="cursor-pointer font-semibold text-navy/70 outline-none focus-visible:ring-2 focus-visible:ring-electric/50">
                QuickBooks keys that work differently here ({different.length})
              </summary>
              <dl className="mt-2">
                {different.map((s) => (
                  <div key={`${s.keys}-${s.qb}`} className="py-1.5" data-shortcut-na={s.keys}>
                    <dt className="flex items-center gap-2">
                      <Keys keys={s.keys} />
                      <span className="text-navy/60">QuickBooks: {s.qb}</span>
                    </dt>
                    <dd className="mt-0.5 text-navy/70">{s.ironbooks}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          <p className="mt-4 text-xs text-navy/45">
            Grouped as in Intuit&rsquo;s &ldquo;Keyboard shortcuts for QuickBooks Desktop&rdquo; ({QB_SHORTCUT_GROUPS.length} groups).
            {desktop ? '' : ' The menu-bar keys (Alt+letter) work in the desktop app.'}
          </p>
        </div>
      )}
    </Modal>
  );
}
