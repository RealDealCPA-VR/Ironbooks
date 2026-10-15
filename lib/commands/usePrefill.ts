'use client';
/**
 * usePrefill — lets a form page accept a prefill handed over by the command bar
 * (lib/commands/prefill.ts). Checks sessionStorage on mount (the bar navigated here) and on the
 * PREFILL_EVENT (the page was already open). `onPrefill` typically opens the page's NEW form
 * with the values filled in; the user still reviews and saves it.
 *
 * Needs no useSearchParams, so pages do not need a Suspense boundary for it.
 */
import { useEffect, useRef } from 'react';
import { PREFILL_EVENT, takePrefill, type FormPrefill, type PrefillKind } from './prefill';

export function usePrefill(kind: PrefillKind, onPrefill: (p: FormPrefill) => void, ready = true): void {
  const cb = useRef(onPrefill);
  cb.current = onPrefill;
  useEffect(() => {
    if (!ready || typeof window === 'undefined') return;
    const check = () => {
      let storage: Storage;
      try {
        storage = window.sessionStorage;
      } catch {
        return;
      }
      const p = takePrefill(storage, kind);
      if (p) cb.current(p);
    };
    check();
    window.addEventListener(PREFILL_EVENT, check);
    return () => window.removeEventListener(PREFILL_EVENT, check);
  }, [kind, ready]);
}
