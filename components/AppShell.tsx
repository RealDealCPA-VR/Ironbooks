'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import CommandPalette from './CommandPalette';
import { filterNavGroups, navGroups, paletteDestinations } from '@/lib/nav';
import { useMe } from '@/lib/usePermissions';
import {
  AMOUNT_KEY_HELP,
  DATE_KEY_HELP,
  GLOBAL_SHORTCUTS,
  GRID_KEY_HELP,
  isEditableTarget,
} from '@/lib/shortcuts';
import { Modal, toast } from '@/components/ui';
import { Briefcase, Building2, ChevronDown, LogOut } from 'lucide-react';

// Routes that render without the app chrome (full-screen).
const BARE = ['/login', '/signup', '/onboarding', '/reset-password', '/portal', '/unlock'];

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
 * "BookKeeper AI — <page label> — <company>". The Electron window title
 * follows document.title automatically, so the native title bar updates too.
 */
function TitleSync({ company }: { company: string | null }) {
  const pathname = usePathname() || '';
  React.useEffect(() => {
    const label = pageLabelFor(pathname);
    document.title = ['BookKeeper AI', label, company].filter(Boolean).join(' — ');
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
      if (isEditableTarget(e.target)) return;
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

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const bare = BARE.some((p) => pathname === p || pathname.startsWith(p + '/'));
  const [company, setCompany] = React.useState<CompanyRow | null>(null);
  // Users & Roles: hide sidebar entries the user's roles can't use (cosmetic; server enforces).
  const { me } = useMe(!bare);
  const visibleGroups = React.useMemo(
    () => filterNavGroups(navGroups, me?.permissions),
    [me?.permissions],
  );

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
            BookKeeper AI
          </h1>
        </div>
        <nav className="flex flex-col gap-0.5 w-full flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 -mr-1">
          {visibleGroups.map((group) => (
            <div key={group.heading || 'home'} className="mb-2">
              {group.heading && (
                <>
                  <div className="hidden lg:block px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-navy/30">
                    {group.heading}
                  </div>
                  {/* Collapsed mode: divider stands in for the group heading. */}
                  <div className="lg:hidden mx-2 my-2 border-t border-slate-100" aria-hidden="true" />
                </>
              )}
              {group.links.map((nav) => {
                const Icon = nav.icon;
                const active = pathname === nav.path || pathname.startsWith(nav.path + '/');
                return (
                  <Link
                    key={nav.label}
                    href={nav.path}
                    prefetch={false}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center justify-center lg:justify-start gap-3 px-2 lg:px-3 py-2 rounded-lg transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-electric/50 ${
                      active
                        ? 'bg-electric/10 text-electric font-semibold shadow-[inset_3px_0_0_0_theme(colors.electric)]'
                        : 'text-navy/80 font-medium hover:text-electric hover:bg-electric/5'
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" />
                    <span className="hidden lg:inline-block text-sm">{nav.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="shrink-0 pt-3 mt-1 border-t border-slate-100">
          <button
            onClick={logout}
            className="flex items-center justify-center lg:justify-start gap-3 text-navy/60 hover:text-red-500 hover:bg-red-50 font-medium px-2 lg:px-3 py-2 rounded-lg w-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" />
            <span className="hidden lg:inline-block text-sm">Sign out</span>
          </button>
          <div className="hidden lg:block px-3 pt-2 text-[10px] text-navy/30">
            BookKeeper AI v1.0.0
          </div>
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-end gap-3 px-6 pt-4 -mb-2">
          <CompanyChip company={company} onCompany={setCompany} />
        </header>
        {children}
      </main>
      <CommandPalette />
      <GlobalShortcuts />
      <TitleSync company={company?.name ?? null} />
    </div>
  );
}
