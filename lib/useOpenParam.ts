'use client';

/**
 * useOpenParam — opens the record named by `?open=<id>` once the page is ready: the QuickZoom
 * from a report's detail line to its source form (lib/services/sourceForms.ts →
 * /invoices?open=<id>, /bills?open=<id>, …). The parameter is removed from the address afterwards,
 * so closing the form and refreshing does not open it again.
 *
 * Reads window.location (not useSearchParams), so a page needs no Suspense boundary for it.
 */
import { useEffect, useRef } from 'react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id in `?open=` of a URL, or null (only a real id — never anything else). */
export function openParamOf(search: string): string | null {
  const id = new URLSearchParams(search).get('open');
  return id && UUID_RE.test(id) ? id : null;
}

export function useOpenParam(onOpen: (id: string) => void, ready = true): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready || typeof window === 'undefined') return;
    done.current = true;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('open')) return;
    const id = openParamOf(url.search);
    url.searchParams.delete('open');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (id) onOpenRef.current(id);
  }, [ready]);
}
