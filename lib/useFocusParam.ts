'use client';

/**
 * useFocusParam — reads the `focus` query param produced by global-search
 * result hrefs (e.g. /invoices?focus=<id>) and, once the record list has
 * loaded, invokes `onFocus` with the matching record exactly once.
 *
 * Callers use useSearchParams, so the page component must be rendered inside
 * a <Suspense> boundary.
 */

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export function useFocusParam<T extends { id: string }>(
  records: T[],
  loading: boolean,
  onFocus: (record: T) => void,
): void {
  const searchParams = useSearchParams();
  const focusId = searchParams.get('focus');

  const consumedRef = useRef(false);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useEffect(() => {
    if (consumedRef.current || !focusId || loading) return;
    // Consume once the list has loaded — even when the id is absent
    // (e.g. record deactivated), so later refetches don't re-trigger.
    consumedRef.current = true;
    const match = records.find((r) => r.id === focusId);
    if (match) onFocusRef.current(match);
  }, [focusId, loading, records]);
}

/**
 * useFocusId — like useFocusParam, for pages that open a record by its id (they fetch it
 * themselves, so a record not on the loaded list — an older or voided one — still opens). Calls
 * `onFocus(id)` once, as soon as `ready` (the page can open forms) is true.
 *
 * Callers use useSearchParams, so the page component must be rendered inside a <Suspense>.
 */
export function useFocusId(ready: boolean, onFocus: (id: string) => void): void {
  const searchParams = useSearchParams();
  const focusId = searchParams.get('focus');
  const consumedRef = useRef(false);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useEffect(() => {
    if (consumedRef.current || !focusId || !ready) return;
    consumedRef.current = true;
    if (/^[0-9a-f-]{36}$/i.test(focusId)) onFocusRef.current(focusId);
  }, [focusId, ready]);
}

/**
 * useNewParam — reads the `?new=1` query param produced by the global
 * keyboard shortcuts and Quick Actions (e.g. Ctrl+I → /invoices?new=1) and
 * invokes `onNew` (typically: open the page's create modal). The param is
 * then stripped via router.replace so closing the modal and pressing the
 * shortcut again re-triggers it — this also makes it work when the user is
 * already on the page (router.push only changes the query string).
 *
 * Callers use useSearchParams, so the page component must be rendered inside
 * a <Suspense> boundary.
 */
export function useNewParam(onNew: () => void): void {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const isNew = searchParams.get('new') === '1';

  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  useEffect(() => {
    if (!isNew) return;
    onNewRef.current();
    router.replace(pathname, { scroll: false });
  }, [isNew, pathname, router]);
}
