/**
 * next/navigation for the DOM tests (test/domHarness.ts aliases it): the router records where the
 * page asked to go (window.__nav) instead of navigating, and the path comes from window.__pathname.
 */
import * as React from 'react';

interface NavState {
  pushes: string[];
  backs: number;
  forwards: number;
  refreshes: number;
}

declare global {
  interface Window {
    __nav: NavState;
    __pathname?: string;
    __params?: Record<string, string>;
  }
}

window.__nav = window.__nav ?? { pushes: [], backs: 0, forwards: 0, refreshes: 0 };
const listeners = new Set<() => void>();

/** Change the path the page sees (re-renders every usePathname()). */
export function setTestPathname(p: string) {
  window.__pathname = p;
  for (const l of listeners) l();
}

const router = {
  push: (href: string) => {
    window.__nav.pushes.push(href);
    setTestPathname(href.split('?')[0]);
  },
  replace: (href: string) => {
    window.__nav.pushes.push(href);
  },
  back: () => {
    window.__nav.backs++;
  },
  forward: () => {
    window.__nav.forwards++;
  },
  refresh: () => {
    window.__nav.refreshes++;
  },
  prefetch: () => {},
};

export function useRouter() {
  return router;
}

export function usePathname(): string {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return window.__pathname ?? '/';
}

export function useSearchParams() {
  return new URLSearchParams(window.location.search);
}

export function useParams() {
  return window.__params ?? {};
}

export function redirect(href: string) {
  router.push(href);
}

export function notFound() {
  throw new Error('notFound');
}
