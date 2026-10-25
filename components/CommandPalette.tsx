'use client';
/**
 * Command bar (Ctrl+K / Cmd+K, or the "Search or type a command" button) — mounted
 * once from the app shell (components/AppShell.tsx).
 *
 * One box, five sources, all limited to what this person may use (same rules as the sidebar):
 *   - Do it      — a plain-English command understood by the deterministic grammar
 *                  (lib/commands/grammar.ts), previewed live as you type; Enter runs it through
 *                  POST /api/command-bar (read-only: forms open PREFILLED for you to save)
 *   - Suggested  — everyday phrases ("I got paid" → Receive Payments)
 *   - Actions    — new invoice, pay bills, reconcile, record deposit…
 *   - Pages      — the sidebar's page search (lib/nav.ts searchPages)
 *   - Records    — customers, vendors, items, invoices/bills by number (GET /api/search)
 * plus "Ask: <text>" which also lets the company's AI model (if one is configured) interpret
 * the request into the same structured command. Everything works with AI off.
 *
 * Keyboard: ↑/↓ move, Enter runs, Esc closes. ARIA: dialog + combobox + listbox with groups.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search, Sparkles, CornerDownLeft } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { searchPages } from '@/lib/nav';
import { matchIntents } from '@/lib/nav-actions';
import { parseCommand } from '@/lib/commands/grammar';
import { describeIntent, type CommandIntent, type ResolveHints } from '@/lib/commands/intent';
import { filterActions, canOpenHref, type PermissionMap } from '@/lib/commands/actions';
import { PREFILL_EVENT, stashPrefill, type FormPrefill } from '@/lib/commands/prefill';
import type { Area } from '@/lib/permissions/model';
import { toast } from '@/components/ui';

/** Fired on window to open the command bar from anywhere (e.g. the header button). */
export const OPEN_COMMAND_BAR_EVENT = 'ironbooks:open-command-bar';
export function openCommandBar(initial?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_BAR_EVENT, { detail: { text: initial ?? '' } }));
}

interface SearchResult {
  type: string;
  label: string;
  href: string;
  description?: string;
}

interface ChooseOption {
  label: string;
  description?: string;
  intent: CommandIntent;
  hints?: ResolveHints;
}

type CommandResult = {
  source: string;
  understood?: string;
  aiAvailable?: boolean;
  ai?: { providerId: string; locality: string; redacted: boolean };
} & (
  | { type: 'prefill'; form: FormPrefill['kind']; href: string; title: string; summary: string; notes: string[]; prefill: FormPrefill }
  | { type: 'navigate'; href: string; title: string; summary?: string; notes?: string[] }
  | {
      type: 'answer';
      title: string;
      answer: string;
      amount: string;
      range: { from: string; to: string; label: string };
      breakdown: { label: string; amount: string }[];
      href: string | null;
      linkLabel: string;
      notes?: string[];
    }
  | { type: 'choose'; question: string; options: ChooseOption[] }
  | { type: 'denied'; message: string }
  | { type: 'unknown'; message: string; examples: string[] }
);

interface Row {
  id: string;
  group: string;
  label: string;
  description?: string;
  badge?: string;
  run: () => void;
}

/** Panel shown above the rows after a command ran (answer, question, message). */
interface Panel {
  tone: 'answer' | 'question' | 'info' | 'warn';
  heading: string;
  body?: string;
  amount?: string;
  breakdown?: { label: string; amount: string }[];
  notes?: string[];
}

function fmtMoney(v: string): string {
  // Display only — the value was computed with decimal.js on the server.
  const [int, frac = ''] = v.replace('-', '').split('.');
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v.startsWith('-') ? '-' : ''}$${withCommas}.${(frac + '00').slice(0, 2)}`;
}

function basePath(href: string) {
  return href.split('?')[0].split('#')[0];
}

export default function CommandPalette({
  permissions,
  hiddenPaths,
}: {
  permissions?: Partial<Record<Area, readonly string[]>> | null;
  hiddenPaths?: ReadonlySet<string>;
} = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [records, setRecords] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  /** Rows replacing the search results while a command's answer/choices are shown. */
  const [panelRows, setPanelRows] = useState<Row[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const perms: PermissionMap = permissions;

  const reset = useCallback(() => {
    setPanel(null);
    setPanelRows(null);
    setActive(0);
  }, []);

  // A QB shortcut typed in the box (Ctrl+I, Ctrl+W, …) moves to another page: close behind it.
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  // Open / close: Ctrl/Cmd+K toggles; the header button and openCommandBar() dispatch
  // OPEN_COMMAND_BAR_EVENT. (Ctrl+F is QB's Find: the Find Transactions page, lib/shortcuts.ts.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => {
          if (!o) restoreFocus.current = document.activeElement as HTMLElement | null;
          return !o;
        });
      }
    }
    function onOpen(e: Event) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      const text = (e as CustomEvent<{ text?: string }>).detail?.text ?? '';
      setQ(text);
      setOpen(true);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_COMMAND_BAR_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_COMMAND_BAR_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    setQ('');
    setRecords([]);
    setBusy(false);
    reset();
    restoreFocus.current?.focus?.();
  }, [open, reset]);

  // Records (customers, vendors, items, invoices/bills by number…), permission-filtered by the API.
  useEffect(() => {
    if (!open || !q.trim() || q.trim().length < 2) {
      setRecords([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q.trim())}`);
        if (!cancelled) setRecords(r.results);
      } catch {
        if (!cancelled) setRecords([]);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  const close = useCallback(() => setOpen(false), []);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  /** Open a page's NEW form with values filled in (sessionStorage handoff, lib/commands/prefill.ts). */
  const openPrefilled = useCallback(
    (href: string, prefill: FormPrefill, notes: string[] = []) => {
      if (hiddenPaths?.has(basePath(href))) {
        setPanel({ tone: 'warn', heading: 'That feature is turned off', body: 'Turn it on in Preferences to use it.' });
        setPanelRows([]);
        return;
      }
      let ok = false;
      try {
        ok = stashPrefill(window.sessionStorage, prefill);
      } catch {
        ok = false;
      }
      setOpen(false);
      router.push(href);
      // A page that is already open picks the prefill up from this event; a page that is
      // about to open reads it on mount.
      setTimeout(() => window.dispatchEvent(new Event(PREFILL_EVENT)), 0);
      if (!ok) toast('Could not pass the details to the form — fill it in by hand.', 'danger');
      for (const n of notes) toast(n, 'info');
    },
    [hiddenPaths, router],
  );

  // ---- running a plain-English command ----
  async function runCommand(body: { text?: string; intent?: CommandIntent; hints?: ResolveHints; allowAi?: boolean }) {
    setBusy(true);
    setPanel(null);
    setPanelRows(null);
    try {
      const r = await api.post<CommandResult>('/api/command-bar', body);
      showResult(r);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Something went wrong running that command.';
      setPanel({ tone: 'warn', heading: 'That did not work', body: msg });
      setPanelRows([backRow()]);
    } finally {
      setBusy(false);
      setActive(0);
    }
  }

  function backRow(): Row {
    return {
      id: 'back',
      group: 'Next',
      label: 'Back to search',
      run: () => {
        reset();
        inputRef.current?.focus();
      },
    };
  }

  function showResult(r: CommandResult) {
    const via = r.source === 'ai' ? ` (understood with your ${r.ai?.locality === 'cloud' ? 'cloud' : 'local'} AI model)` : '';
    switch (r.type) {
      case 'prefill':
        openPrefilled(r.href, r.prefill, r.notes);
        toast(r.summary + via, 'info');
        return;
      case 'navigate':
        if (hiddenPaths?.has(basePath(r.href))) {
          setPanel({ tone: 'warn', heading: 'That feature is turned off', body: 'Turn it on in Preferences to use it.' });
          setPanelRows([backRow()]);
          return;
        }
        go(r.href);
        if (r.summary) toast(r.summary + via, 'info');
        for (const n of r.notes ?? []) toast(n, 'info');
        return;
      case 'answer': {
        setPanel({
          tone: 'answer',
          heading: r.title,
          amount: r.amount,
          body: r.answer + via,
          breakdown: r.breakdown,
          notes: r.notes,
        });
        const rows: Row[] = [];
        if (r.href && canOpenHref(r.href, perms)) {
          const href = r.href;
          rows.push({ id: 'answer-link', group: 'Next', label: r.linkLabel, description: 'Opens the report with these dates', run: () => go(href) });
        }
        rows.push(backRow());
        setPanelRows(rows);
        return;
      }
      case 'choose':
        setPanel({ tone: 'question', heading: r.question });
        setPanelRows([
          ...r.options.map((o, i) => ({
            id: `choice-${i}`,
            group: 'Choose one',
            label: o.label,
            description: o.description,
            run: () => void runCommand({ intent: o.intent, hints: o.hints }),
          })),
          backRow(),
        ]);
        return;
      case 'denied':
        setPanel({ tone: 'warn', heading: 'Not allowed', body: r.message });
        setPanelRows([backRow()]);
        return;
      case 'unknown':
        setPanel({
          tone: 'info',
          heading: r.message,
          notes: r.aiAvailable === false ? ['Tip: an AI model can also interpret free-form requests — set one up in AI & Automation (optional).'] : undefined,
        });
        setPanelRows([
          ...r.examples.map((ex, i) => ({
            id: `example-${i}`,
            group: 'Try',
            label: ex,
            run: () => {
              reset();
              setQ(ex);
              inputRef.current?.focus();
            },
          })),
          backRow(),
        ]);
        return;
    }
  }

  // ---- search rows (live, as you type) ----
  const parsed = useMemo(() => (q.trim() ? parseCommand(q, new Date()) : null), [q]);

  const searchRows: Row[] = (() => {
    const rows: Row[] = [];
    const text = q.trim();
    const seen = new Set<string>();
    const add = (r: Row, key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(r);
    };
    if (parsed) {
      add(
        {
          id: 'command',
          group: 'Do it',
          label: describeIntent(parsed),
          description: 'Press Enter — nothing is saved until you confirm it',
          badge: 'Enter',
          run: () => void runCommand({ text }),
        },
        'command',
      );
    }
    const allowedHref = (href: string) => canOpenHref(href, perms) && !hiddenPaths?.has(basePath(href));
    if (text) {
      for (const i of matchIntents(text)) {
        if (!allowedHref(i.href)) continue;
        add({ id: `sug-${i.href}`, group: 'Suggested', label: i.label, description: i.description, run: () => go(i.href) }, basePath(i.href));
      }
    }
    for (const a of filterActions(text, perms, hiddenPaths, text ? 5 : 8)) {
      const run = a.prefillKind ? () => openPrefilled(a.href, { kind: a.prefillKind!, lines: [] }) : () => go(a.href);
      add({ id: `act-${a.key}`, group: 'Actions', label: a.label, description: a.description, run }, `act:${a.key}`);
    }
    if (text) {
      for (const p of searchPages(text, { permissions: perms, hiddenPaths, limit: 6 })) {
        add({ id: `page-${p.href}`, group: 'Pages', label: p.label, description: p.description, run: () => go(p.href) }, basePath(p.href));
      }
      records.forEach((r, i) =>
        add(
          { id: `rec-${i}`, group: 'Records', label: r.label, description: r.description, badge: r.type, run: () => go(r.href) },
          `rec:${r.type}:${r.href}:${r.label}`,
        ),
      );
      if (!parsed) {
        add(
          {
            id: 'ask',
            group: 'Ask',
            label: `Ask: “${text}”`,
            description: 'Work it out in plain English (uses your AI model if one is set up)',
            run: () => void runCommand({ text, allowAi: true }),
          },
          'ask',
        );
      }
    }
    return rows;
  })();

  const rows = panelRows ?? searchRows;
  useEffect(() => {
    if (active > rows.length - 1) setActive(Math.max(0, rows.length - 1));
  }, [rows.length, active]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (rows.length ? (a + 1) % rows.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0));
    } else if (e.key === 'Home' && panelRows) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && panelRows) {
      e.preventDefault();
      setActive(rows.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (busy) return;
      rows[active]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      // Keep focus inside the dialog: the input is the only tab stop (rows use activedescendant).
      e.preventDefault();
    }
  }

  if (!open) return null;

  const groups: { name: string; rows: { row: Row; index: number }[] }[] = [];
  rows.forEach((row, index) => {
    const g = groups.find((x) => x.name === row.group);
    if (g) g.rows.push({ row, index });
    else groups.push({ name: row.group, rows: [{ row, index }] });
  });
  const activeId = rows[active] ? `cb-opt-${active}` : undefined;

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--titlebar-h)] z-[200] flex items-start justify-center pt-[10vh] p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={close} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cb-title"
        aria-describedby="cb-help"
        className="relative z-10 w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-slate-100 overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id="cb-title" className="sr-only">
          Command bar
        </h2>
        <div className="flex items-center gap-3 px-5 border-b border-slate-100">
          <Search className="h-5 w-5 text-navy/40 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search, go to a page, or type a command in plain English"
            aria-autocomplete="list"
            aria-expanded={rows.length > 0}
            aria-controls="cb-results"
            aria-activedescendant={activeId}
            aria-busy={busy}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
              if (panel) reset();
            }}
            onKeyDown={onKeyDown}
            placeholder="Try “invoice Acme 3 hours consulting” or “what did we spend on fuel in Q3”"
            className="w-full py-4 text-navy outline-none text-base bg-transparent"
            autoComplete="off"
            spellCheck={false}
          />
          {busy && (
            <span className="shrink-0 text-xs text-navy/50" role="status">
              Working…
            </span>
          )}
        </div>

        {panel && (
          <div
            role="status"
            aria-live="polite"
            className={`px-5 py-4 border-b border-slate-100 ${
              panel.tone === 'warn' ? 'bg-amber-50' : panel.tone === 'answer' ? 'bg-electric/5' : 'bg-slate-50'
            }`}
          >
            <div className="text-sm font-semibold text-navy">{panel.heading}</div>
            {panel.amount !== undefined && (
              <div className="mt-1 text-3xl font-bold tracking-tight text-navy">{fmtMoney(panel.amount)}</div>
            )}
            {panel.body && <p className="mt-1 text-sm text-navy/70">{panel.body}</p>}
            {panel.breakdown && panel.breakdown.length > 1 && (
              <table className="mt-3 w-full text-sm">
                <caption className="sr-only">Breakdown by account</caption>
                <tbody>
                  {panel.breakdown.map((b) => (
                    <tr key={b.label} className="border-t border-slate-100">
                      <th scope="row" className="py-1 text-left font-normal text-navy/70">
                        {b.label}
                      </th>
                      <td className="py-1 text-right tabular-nums text-navy">{fmtMoney(b.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {panel.notes?.map((n) => (
              <p key={n} className="mt-2 text-xs text-navy/50">
                {n}
              </p>
            ))}
          </div>
        )}

        <div id="cb-results" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-2">
          {rows.length === 0 && !panel && (
            <div className="px-5 py-6 text-center text-navy/50 text-sm">
              {q ? 'No matches.' : 'Type to search pages, records and actions — or tell it what to do.'}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.name} role="group" aria-labelledby={`cb-g-${g.name.replace(/\W+/g, '-')}`}>
              <div
                id={`cb-g-${g.name.replace(/\W+/g, '-')}`}
                role="presentation"
                className="px-5 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-navy/40"
              >
                {g.name}
              </div>
              {g.rows.map(({ row, index }) => (
                <div
                  key={row.id}
                  id={`cb-opt-${index}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => !busy && row.run()}
                  className={`mx-2 px-3 py-2 rounded-lg cursor-pointer flex items-center justify-between gap-3 ${
                    index === active ? 'bg-electric/10' : ''
                  }`}
                >
                  <span className="min-w-0 flex items-start gap-2">
                    {row.group === 'Ask' && <Sparkles className="h-4 w-4 mt-0.5 text-electric shrink-0" aria-hidden="true" />}
                    <span className="min-w-0">
                      <span className="block text-navy truncate">{row.label}</span>
                      {row.description && <span className="block text-xs text-navy/50">{row.description}</span>}
                    </span>
                  </span>
                  {index === active ? (
                    <CornerDownLeft className="h-4 w-4 shrink-0 text-navy/40" aria-hidden="true" />
                  ) : (
                    row.badge && <span className="shrink-0 text-[11px] font-semibold text-navy/40 uppercase tracking-wide">{row.badge}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div id="cb-help" className="px-5 py-2 border-t border-slate-100 text-xs text-navy/50 flex flex-wrap gap-x-4 gap-y-1">
          <span>↑↓ move</span>
          <span>Enter run</span>
          <span>Esc close</span>
          <span className="ml-auto">Forms open filled in — nothing is saved until you click Save</span>
        </div>
      </div>
    </div>
  );
}

/** Header / sidebar button that opens the command bar (same as Ctrl+K). */
export function CommandBarButton({ className = '' }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openCommandBar()}
      aria-keyshortcuts="Control+K"
      title="Search, jump to a page, or type what you want to do (Ctrl+K)"
      className={`flex items-center gap-2 rounded-full bg-white border border-slate-200 px-3 py-1 text-sm text-navy/60 shadow-sm hover:border-electric/50 hover:text-electric transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50 ${className}`}
    >
      <Search className="h-4 w-4" aria-hidden="true" />
      <span className="hidden sm:inline">Search or type a command</span>
      <kbd className="hidden md:inline rounded border border-slate-200 bg-slate-50 px-1.5 text-[10px] font-semibold text-navy/50">Ctrl K</kbd>
    </button>
  );
}
