'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import CommandPalette, { CommandBarButton } from './CommandPalette';
import AssistantPanel from './AssistantPanel';
import {
  linkHref,
  paletteDestinations,
  searchPages,
  visibleNavGroups,
  type NavGroup,
  type NavMode,
  type PageSearchResult,
} from '@/lib/nav';
import { canDo, useMe } from '@/lib/usePermissions';
import { refreshPreferences, usePreferences } from '@/lib/usePreferences';
import { api } from '@/lib/client';
import { Help } from '@/components/Help';
import { pageHelpFor } from '@/lib/pageHelp';
import type { Area } from '@/lib/permissions/model';
import { blockingFeatureGate, featureHiddenPaths, multiCurrencyHiddenPaths } from '@/lib/preferences';
import FeatureOff from './FeatureOff';
import AccountantCopyBanner from './AccountantCopyBanner';
import PreferenceBehaviors from './PreferenceBehaviors';
import AttentionBadge from './AttentionBadge'; // team home: count on the "Needs attention" link
import UndoToast from './UndoToast';
import ReceiptDropZone from './ReceiptDropZone'; // receipt capture: drop a receipt anywhere
import { BackupIndicator, BackupWarningBanner } from './BackupStatus'; // team backups
import FormShortcuts from './FormShortcuts';
import {
  AMOUNT_KEY_HELP,
  DATE_KEY_HELP,
  FORM_KEY_HELP,
  GLOBAL_SHORTCUTS,
  GRID_KEY_HELP,
  isEditableTarget,
} from '@/lib/shortcuts';
import { Modal, toast } from '@/components/ui';
import { Briefcase, Building2, ChevronDown, ChevronRight, LogOut, Search, Sparkles } from 'lucide-react';

// Routes that render without the app chrome (full-screen).
const BARE = ['/login', '/signup', '/onboarding', '/reset-password', '/portal', '/unlock', '/m', '/change-password'];

interface CompanyRow {
  id: string;
  name: string;
}

/** Best-matching sidebar label for the current path (longest href prefix wins). */
function pageLabelFor(pathname: string): string | null {
  let best: { label: string; href: string } | null = null;
  for (const d of paletteDestinations) {
    if (pathname === d.href || pathname.startsWith(d.href + '/')) {
      if (!best || d.href.length > best.href.length) best = d;
    }
  }
  return best?.label ?? null;
}

/**
 * Keeps document.title in sync with the active page + company:
 * "Ironbooks — <page label> — <company>". The Electron window title
 * follows document.title automatically, so the native title bar updates too.
 */
function TitleSync({ company }: { company: string | null }) {
  const pathname = usePathname() || '';
  React.useEffect(() => {
    const label = pageLabelFor(pathname);
    document.title = ['Ironbooks', label, company].filter(Boolean).join(' — ');
  }, [pathname, company]);
  return null;
}

/**
 * Active-company chip with a quick switcher. Read-only fetch of the active company
 * (GET /api/company) and the caller's company list (GET /api/companies); switching
 * POSTs /api/companies/select then reloads so every page refetches under the new company.
 */
function CompanyChip({
  company,
  onCompany,
}: {
  company: CompanyRow | null;
  onCompany: (c: CompanyRow | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [list, setList] = React.useState<CompanyRow[] | null>(null);
  const [switching, setSwitching] = React.useState<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/company')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (!cancelled && c?.id) onCompany({ id: c.id, name: c.name });
      })
      .catch(() => {
        /* not signed in / first run: chip stays hidden */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the dropdown on outside click / Escape.
  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && list === null) {
      try {
        const r = await fetch('/api/companies');
        if (r.ok) {
          const rows = (await r.json()) as CompanyRow[];
          setList(rows.map((c) => ({ id: c.id, name: c.name })));
        } else {
          setList([]);
        }
      } catch {
        setList([]);
      }
    }
  }

  async function switchTo(c: CompanyRow) {
    if (c.id === company?.id) {
      setOpen(false);
      return;
    }
    setSwitching(c.id);
    try {
      const r = await fetch('/api/companies/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyId: c.id }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${r.status}`);
      }
      // Full reload: every page/cache refetches under the new company cookie.
      window.location.reload();
    } catch (err) {
      setSwitching(null);
      toast(err instanceof Error ? err.message : 'Could not switch company', 'danger');
    }
  }

  if (!company) return null;
  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Active company — click to switch"
        className="flex items-center gap-2 rounded-full bg-white border border-slate-200 pl-2.5 pr-2 py-1 text-sm font-semibold text-navy shadow-sm hover:border-electric/50 hover:text-electric transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
      >
        <Building2 className="h-4 w-4 text-electric shrink-0" />
        <span className="max-w-[220px] truncate">{company.name}</span>
        <ChevronDown className="h-3.5 w-3.5 text-navy/40 shrink-0" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 mt-1 w-64 rounded-xl bg-white shadow-xl border border-slate-100 py-1 z-50"
        >
          <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-navy/30">
            Switch company
          </div>
          {list === null && (
            <div className="px-3 py-2 text-sm text-navy/40">Loading…</div>
          )}
          {list?.length === 0 && (
            <div className="px-3 py-2 text-sm text-navy/40">No other companies</div>
          )}
          {list?.map((c) => (
            <button
              key={c.id}
              role="option"
              aria-selected={c.id === company.id}
              disabled={switching !== null}
              onClick={() => switchTo(c)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-electric/5 disabled:opacity-50 ${
                c.id === company.id ? 'text-electric font-semibold' : 'text-navy'
              }`}
            >
              <span className="truncate">{c.name}</span>
              {c.id === company.id && <span className="text-xs text-navy/40">active</span>}
              {switching === c.id && <span className="text-xs text-navy/40">switching…</span>}
            </button>
          ))}
          <div className="border-t border-slate-100 mt-1 pt-1">
            <Link
              href="/companies"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-navy/70 hover:bg-electric/5 hover:text-electric"
            >
              Manage companies…
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function ShortcutRow({ keys, description }: { keys: string; description: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-navy/70">{description}</span>
      <kbd className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-navy whitespace-nowrap">
        {keys}
      </kbd>
    </div>
  );
}

/**
 * App-wide keyboard shortcuts (QB parity): Ctrl+I/E/R/J/D navigation, "?" opens the
 * shortcuts help. Keystrokes inside inputs/textareas/selects are ignored; Ctrl+K /
 * Ctrl+F (palette) are handled by CommandPalette itself.
 */
function GlobalShortcuts() {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = React.useState(false);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const sc = GLOBAL_SHORTCUTS.find((s) => s.ctrlKey === e.key.toLowerCase());
        if (sc?.href) {
          e.preventDefault();
          router.push(sc.href);
        }
        return;
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setHelpOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  return (
    <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard Shortcuts" size="md">
      <div className="space-y-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-navy/40 mb-1">
            Anywhere
          </div>
          {GLOBAL_SHORTCUTS.map((s) => (
            <ShortcutRow key={s.keys} keys={s.keys} description={s.description} />
          ))}
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-navy/40 mb-1">
            Forms
          </div>
          {FORM_KEY_HELP.map((s) => (
            <ShortcutRow key={s.keys} keys={s.keys} description={s.description} />
          ))}
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-navy/40 mb-1">
            Date fields
          </div>
          {DATE_KEY_HELP.map((s) => (
            <ShortcutRow key={s.keys} keys={s.keys} description={s.description} />
          ))}
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-navy/40 mb-1">
            Amount fields
          </div>
          {AMOUNT_KEY_HELP.map((s) => (
            <ShortcutRow key={s.keys} keys={s.keys} description={s.description} />
          ))}
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-navy/40 mb-1">
            Line grids
          </div>
          {GRID_KEY_HELP.map((s) => (
            <ShortcutRow key={s.keys} keys={s.keys} description={s.description} />
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// p1 ux: Simple / Advanced menus, collapsible groups, page search
// ---------------------------------------------------------------------------

const NAV_MODE_KEY = 'bka.navMode';
const collapsedKey = (userId: string | undefined) => `bka.nav.collapsed.${userId ?? 'anon'}`;

function readLocal(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: not remembered */
  }
}

/** Simple / All menus switch at the top of the sidebar (saved to My Preferences). */
function MenuModeToggle({
  mode,
  onChange,
  className = 'hidden lg:flex mx-1 mb-3',
}: {
  mode: NavMode;
  onChange: (m: NavMode) => void;
  className?: string;
}) {
  const btn = (m: NavMode, label: string, title: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      title={title}
      onClick={() => mode !== m && onChange(m)}
      className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50 ${
        mode === m ? 'bg-white text-electric shadow-sm' : 'text-navy/60 hover:text-navy'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="Menu style" className={`${className} gap-1 rounded-lg bg-slate-100 p-1 shrink-0`}>
      {btn('simple', 'Simple', 'Everyday tasks only')}
      {btn('advanced', 'All menus', 'Every screen, grouped like the QuickBooks menus')}
    </div>
  );
}

/**
 * Search box: finds any page by its name, its QuickBooks name or plain words ("pay a bill",
 * "record a sale"), limited to pages this person can open. Enter opens the top match.
 */
function SidebarSearch({
  permissions,
  hiddenPaths,
  idPrefix = 'ss',
  className = 'relative mx-1 mb-3 hidden lg:block',
}: {
  permissions: Partial<Record<Area, readonly string[]>> | null | undefined;
  hiddenPaths: ReadonlySet<string>;
  /** Keeps element ids unique when a second (narrow-window) copy is on the page. */
  idPrefix?: string;
  className?: string;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const results: PageSearchResult[] = React.useMemo(
    () => searchPages(q, { permissions, hiddenPaths, limit: 8 }),
    [q, permissions, hiddenPaths],
  );

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function go(href: string) {
    setOpen(false);
    setQ('');
    router.push(href);
  }

  return (
    <div ref={rootRef} className={`${className} shrink-0`}>
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-navy/40" aria-hidden="true" />
      <input
        type="search"
        role="combobox"
        aria-label="Find a page"
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        aria-controls={`${idPrefix}-search-results`}
        aria-activedescendant={open && results[active] ? `${idPrefix}-opt-${active}` : undefined}
        placeholder="Find a page (e.g. pay bills)"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && results[active]) {
            e.preventDefault();
            go(results[active].href);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-2 text-sm text-navy placeholder:text-navy/40 outline-none focus:border-electric/50 focus:bg-white focus:ring-2 focus:ring-electric/30"
      />
      {open && q.trim() && (
        <div
          id={`${idPrefix}-search-results`}
          role="listbox"
          className="absolute left-0 z-50 mt-1 w-80 max-w-[80vw] rounded-xl border border-slate-100 bg-white py-1 shadow-xl"
        >
          {results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-navy/50">
              No page found. Try other words, like &ldquo;pay a bill&rdquo; or &ldquo;record a sale&rdquo;.
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.href}
                id={`${idPrefix}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r.href)}
                className={`block w-full px-3 py-2 text-left ${i === active ? 'bg-electric/10' : ''}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-navy">{r.label}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wide text-navy/30">{r.group}</span>
                </span>
                {r.description && <span className="block text-xs text-navy/50">{r.description}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function NavItems({
  groups,
  pathname,
  collapsible,
  collapsed,
  onToggle,
}: {
  groups: NavGroup[];
  pathname: string;
  collapsible: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (heading: string) => void;
}) {
  return (
    <>
      {groups.map((group) => {
        const hasActive = group.links.some((l) => pathname === l.path || pathname.startsWith(l.path + '/'));
        // The group holding the current page always shows (without changing what is remembered).
        const isCollapsed = collapsible && !!group.heading && collapsed.has(group.heading) && !hasActive;
        const listId = `nav-group-${(group.heading || 'home').toLowerCase().replace(/[^a-z]+/g, '-')}`;
        return (
          <div key={group.heading || 'home'} className="mb-2">
            {group.heading && (
              <>
                {collapsible ? (
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    aria-controls={listId}
                    onClick={() => onToggle(group.heading)}
                    className="hidden lg:flex w-full items-center justify-between rounded px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-navy/40 hover:text-navy outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
                  >
                    {group.heading}
                    {isCollapsed ? <ChevronRight className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
                  </button>
                ) : (
                  <div className="hidden lg:block px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-navy/30">
                    {group.heading}
                  </div>
                )}
                {/* Collapsed mode: divider stands in for the group heading. */}
                <div className="lg:hidden mx-2 my-2 border-t border-slate-100" aria-hidden="true" />
              </>
            )}
            <div id={listId} className={isCollapsed ? 'lg:hidden' : ''}>
              {group.links.map((nav) => {
                const Icon = nav.icon;
                const active = pathname === nav.path || pathname.startsWith(nav.path + '/');
                return (
                  <Link
                    key={nav.label}
                    href={linkHref(nav)}
                    prefetch={false}
                    title={nav.qb && nav.qb !== nav.label ? `${nav.label} (QuickBooks: ${nav.qb})` : nav.label}
                    aria-current={active ? 'page' : undefined}
                    className={`relative flex items-center justify-center lg:justify-start gap-3 px-2 lg:px-3 py-2 rounded-lg transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-electric/50 ${
                      active
                        ? 'bg-electric/10 text-electric font-semibold shadow-[inset_3px_0_0_0_theme(colors.electric)]'
                        : 'text-navy/80 font-medium hover:text-electric hover:bg-electric/5'
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" />
                    <span className="hidden lg:inline-block text-sm">{nav.label}</span>
                    {nav.path === '/attention' && <AttentionBadge />}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const bare = BARE.some((p) => pathname === p || pathname.startsWith(p + '/'));
  const [company, setCompany] = React.useState<CompanyRow | null>(null);
  // Users & Roles: hide sidebar entries the user's roles can't use (cosmetic; server enforces).
  const { me } = useMe(!bare);
  // Preferences: features turned off (estimates, sales orders, POs, inventory, time, sales tax,
  // units of measure) drop out of the sidebar like QB's menus, their pages show a plain
  // 'turned off' message, and the server refuses their saves (lib/featureGate.ts).
  const prefs = usePreferences(!bare);
  const hiddenPaths = React.useMemo(
    () =>
      new Set([
        ...featureHiddenPaths(prefs.company),
        // gapsb A2: Currencies is hidden while Multiple Currencies is off.
        ...(prefs.loaded ? multiCurrencyHiddenPaths(prefs.company) : []),
      ]),
    [prefs.company, prefs.loaded],
  );
  // Menu style (My Preferences > General > Menu style, or the switch in the sidebar). The last
  // choice is cached locally so the menu doesn't flicker while preferences load.
  const [localMode, setLocalMode] = React.useState<NavMode | null>(null);
  React.useEffect(() => {
    const cached = readLocal(NAV_MODE_KEY);
    if (cached === 'simple' || cached === 'advanced') setLocalMode(cached);
  }, []);
  React.useEffect(() => {
    if (prefs.loaded) {
      setLocalMode(prefs.my.navMode);
      writeLocal(NAV_MODE_KEY, prefs.my.navMode);
    }
  }, [prefs.loaded, prefs.my.navMode]);
  const navMode: NavMode = localMode ?? (prefs.loaded ? prefs.my.navMode : 'simple');
  async function changeMode(m: NavMode) {
    setLocalMode(m);
    writeLocal(NAV_MODE_KEY, m);
    try {
      await api.patch('/api/preferences/my', { navMode: m });
      await refreshPreferences();
    } catch {
      toast('Could not save the menu style; it will reset next time.', 'danger');
    }
  }
  // Advanced mode: groups fold away and stay the way the person left them.
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    const raw = readLocal(collapsedKey(me?.id));
    try {
      setCollapsed(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setCollapsed(new Set());
    }
  }, [me?.id]);
  function toggleGroup(heading: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(heading)) next.delete(heading);
      else next.add(heading);
      writeLocal(collapsedKey(me?.id), JSON.stringify([...next]));
      return next;
    });
  }
  const visibleGroups = React.useMemo(
    () => visibleNavGroups(navMode, me?.permissions, hiddenPaths),
    [navMode, me?.permissions, hiddenPaths],
  );
  const blockedGate = prefs.loaded ? blockingFeatureGate(pathname, prefs.company) : null;
  const [assistantOpen, setAssistantOpen] = React.useState(false);
  const closeAssistant = React.useCallback(() => setAssistantOpen(false), []);

  if (bare) return <>{children}</>;

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  }

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100">
      <aside className="w-20 lg:w-60 sticky top-0 h-screen bg-white shadow-xl z-10 flex flex-col py-6 px-2 lg:px-3 border-r border-slate-100">
        <div className="flex flex-col items-center gap-3 mb-8 shrink-0">
          <div className="rounded-xl bg-navy h-12 w-12 flex items-center justify-center shadow-md">
            <Briefcase className="text-gold h-6 w-6" />
          </div>
          <h1 className="text-navy font-extrabold text-2xl tracking-tight leading-tight hidden lg:block">
            Ironbooks
          </h1>
        </div>
        <MenuModeToggle mode={navMode} onChange={changeMode} />
        <SidebarSearch permissions={me?.permissions} hiddenPaths={hiddenPaths} />
        <nav
          aria-label={navMode === 'simple' ? 'Everyday tasks' : 'All menus'}
          className="flex flex-col gap-0.5 w-full flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 -mr-1"
        >
          <NavItems
            groups={visibleGroups}
            pathname={pathname}
            collapsible={navMode === 'advanced'}
            collapsed={collapsed}
            onToggle={toggleGroup}
          />
          {navMode === 'simple' && (
            <button
              type="button"
              onClick={() => changeMode('advanced')}
              className="hidden lg:block mt-1 px-3 py-2 text-left text-xs font-semibold text-electric hover:underline outline-none focus-visible:ring-2 focus-visible:ring-electric/50 rounded"
            >
              Show all menus…
            </button>
          )}
        </nav>
        <div className="shrink-0 pt-3 mt-1 border-t border-slate-100">
          <BackupIndicator />
          <button
            onClick={logout}
            className="flex items-center justify-center lg:justify-start gap-3 text-navy/60 hover:text-red-500 hover:bg-red-50 font-medium px-2 lg:px-3 py-2 rounded-lg w-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" />
            <span className="hidden lg:inline-block text-sm">Sign out</span>
          </button>
          <div className="hidden lg:block px-3 pt-2 text-[10px] text-navy/30">
            Ironbooks v{process.env.NEXT_PUBLIC_APP_VERSION}
          </div>
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-end gap-3 px-6 pt-4 -mb-2">
          {/* "What is this page?" — plain-language help for the current screen (lib/pageHelp.ts). */}
          {pageHelpFor(pathname) ? (
            <span className="mr-auto text-sm text-navy/60">
              <Help key={pathname} page={pathname} side="bottom">
                What is this page?
              </Help>
            </span>
          ) : (
            <span className="mr-auto" />
          )}
          {/* Narrow windows: the sidebar shows icons only, so page search and the menu switch live here. */}
          <SidebarSearch
            permissions={me?.permissions}
            hiddenPaths={hiddenPaths}
            idPrefix="ts"
            className="relative w-48 sm:w-64 lg:hidden"
          />
          <MenuModeToggle mode={navMode} onChange={changeMode} className="flex lg:hidden w-40" />
          <CommandBarButton />
          <button
            type="button"
            onClick={() => setAssistantOpen(true)}
            title="Ask about your books"
            className="flex items-center gap-1.5 rounded-full bg-white border border-slate-200 px-3 py-1 text-sm font-semibold text-navy shadow-sm hover:border-electric/50 hover:text-electric transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
          >
            <Sparkles className="h-4 w-4 text-electric" />
            Ask AI
          </button>
          <CompanyChip company={company} onCompany={setCompany} />
        </header>
        <BackupWarningBanner />
        <AccountantCopyBanner pathname={pathname} />
        {blockedGate ? <FeatureOff gate={blockedGate} /> : children}
      </main>
      <CommandPalette permissions={me?.permissions} hiddenPaths={hiddenPaths} />
      <AssistantPanel open={assistantOpen} onClose={closeAssistant} />
      <GlobalShortcuts />
      <PreferenceBehaviors />
      <UndoToast />
      <ReceiptDropZone enabled={canDo(me, 'lists', 'create')} />
      <FormShortcuts />
      <TitleSync company={company?.name ?? null} />
    </div>
  );
}
