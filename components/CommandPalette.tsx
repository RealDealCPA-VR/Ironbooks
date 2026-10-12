'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import { paletteDestinations } from '@/lib/nav';
import { filterNavActions, matchIntents } from '@/lib/nav-actions';

interface Dest { label: string; href: string; group: string }
interface SearchResult { type: string; label: string; href: string; description?: string }

// Flat list of navigable destinations, derived from the sidebar's nav data (lib/nav.ts)
// so the palette can never drift out of sync with the sidebar.
const DESTINATIONS: Dest[] = paletteDestinations.map(({ label, href }) => ({ label, href, group: 'Go to' }));

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ctrl/Cmd+K toggles; Ctrl/Cmd+F is a QB-style alias for the same palette.
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (k === 'k' || k === 'f')) {
        e.preventDefault();
        setOpen((o) => (k === 'f' ? true : !o));
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
    else {
      setQ('');
      setResults([]);
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`);
        if (!cancelled) setResults(r.results);
      } catch {
        /* ignore */
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const navMatches = DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  // Quick actions (lib/nav-actions.ts): all of them on an empty query so the palette
  // doubles as a "what can I do" menu, filtered alongside destinations otherwise.
  const actionMatches = filterNavActions(q).slice(0, 7);
  // Plain-language intents ("I got paid" -> Receive Payments) lead the list, with a short
  // explanation so the user also learns the screen's name. Deduped against the rest by href.
  const intentMatches = matchIntents(q);
  const intentHrefs = new Set(intentMatches.map((i) => i.href));
  const combined: SearchResult[] = [
    ...intentMatches.map((i) => ({ type: 'Suggested', label: i.label, href: i.href, description: i.description })),
    ...actionMatches
      .filter((a) => !intentHrefs.has(a.href))
      .map((a) => ({ type: 'Actions', label: a.label, href: a.href })),
    ...navMatches
      .filter((d) => !intentHrefs.has(d.href))
      .map((d) => ({ type: 'Go to', label: d.label, href: d.href })),
    ...results,
  ];

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] p-4">
      <div className="absolute inset-0 bg-navy/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="relative z-10 w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-slate-100 overflow-hidden">
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search or describe what you want to do"
          aria-expanded={combined.length > 0}
          aria-controls="command-palette-results"
          aria-activedescendant={combined[active] ? `cp-opt-${active}` : undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, combined.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            }
            else if (e.key === 'Enter' && combined[active]) go(combined[active].href);
          }}
          placeholder="Search, jump to a page, or say what happened (e.g. “I got paid”)"
          className="w-full px-5 py-4 text-navy outline-none border-b border-slate-100 text-base"
        />
        <div id="command-palette-results" role="listbox" className="max-h-80 overflow-y-auto py-2">
          {combined.length === 0 && (
            <div className="px-5 py-6 text-center text-navy/40 text-sm">
              {q
                ? 'No matches. Try describing it, e.g. “pay a bill” or “move money between accounts”.'
                : 'Type to search across your books and pages'}
            </div>
          )}
          {combined.map((r, i) => (
            <button
              key={`${r.type}-${r.label}-${i}`}
              id={`cp-opt-${i}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r.href)}
              className={`w-full text-left px-5 py-2.5 flex items-center justify-between gap-3 ${
                i === active ? 'bg-electric/10' : ''
              }`}
            >
              <span className="min-w-0">
                <span className="block text-navy">{r.label}</span>
                {r.description && <span className="block text-xs text-navy/50">{r.description}</span>}
              </span>
              <span className="shrink-0 text-xs font-semibold text-navy/40 uppercase tracking-wide">{r.type}</span>
            </button>
          ))}
        </div>
        <div className="px-5 py-2 border-t border-slate-100 text-xs text-navy/40 flex gap-4">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto">⌘/Ctrl + K</span>
        </div>
      </div>
    </div>
  );
}
