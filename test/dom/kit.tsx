/**
 * Browser side of the DOM tests (test/domHarness.ts runs a bundle of a *.dom.tsx file in a hidden
 * Electron window): a tiny test runner, real key presses (DevTools Input.dispatchKeyEvent, so Tab
 * moves focus and letters type, exactly as on a keyboard), and React mounting.
 *
 *   domTest('Esc on a changed form asks', async () => { ...; await press('Escape'); check(...) });
 *   runDomTests();   // last line of the *.dom.tsx file
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

interface Bridge {
  press: (key: string, mods?: KeyMods) => Promise<boolean>;
  type: (text: string) => Promise<boolean>;
  done: (results: DomResult[]) => Promise<boolean>;
}
export interface KeyMods {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** Physical key when it differs from the default for `key` ('KeyS'). */
  code?: string;
}
export interface DomResult {
  name: string;
  ok: boolean;
  error?: string;
  /** How long the test took. */
  ms?: number;
}

const bridge = (window as unknown as { __domTest: Bridge }).__domTest;
const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

export function domTest(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Let React and timers settle (effects, setTimeout(0) presses, animation frames). */
export async function settle(ms = 30) {
  await sleep(ms);
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await sleep(0);
}

/** Press a key (with modifiers) as a real keyboard would, then let the page react. */
export async function press(key: string, mods: KeyMods = {}) {
  await bridge.press(key, mods);
  await settle();
}

/** Type text into the focused field (as an IME commit: one input event per call). */
export async function typeText(text: string) {
  for (const ch of text) await bridge.press(ch);
  await settle();
}

export class CheckError extends Error {}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new CheckError(message);
}

export function equal<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new CheckError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Wait until `fn` returns something truthy (or fail with `message`). */
export async function until<T>(fn: () => T, message: string, ms = 2000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new CheckError(`timed out: ${message}`);
    await sleep(20);
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Render `node` as the page (replacing the previous test's page). */
export async function mount(node: React.ReactNode) {
  await unmount();
  host = document.createElement('div');
  host.id = 'dom-test-root';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  await settle(50);
}

export async function unmount() {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/** The focused element's accessible label (aria-label, its <label>, placeholder, text, id). */
export function focusedLabel(): string {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return '(nothing)';
  const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : null;
  return (
    el.getAttribute('aria-label') ||
    byFor ||
    (el as HTMLInputElement).placeholder ||
    el.textContent?.trim() ||
    el.id ||
    el.tagName
  ).trim();
}

export const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<T>(sel));

/** A button by its visible text (or aria-label). */
export function button(text: string | RegExp, scope: ParentNode = document): HTMLButtonElement | null {
  const match = (s: string) => (typeof text === 'string' ? s.trim() === text : text.test(s.trim()));
  return (
    $$<HTMLButtonElement>('button', scope).find((b) => match(b.getAttribute('aria-label') || '') || match(b.textContent || '')) ?? null
  );
}

export async function focus(el: Element | null, message = 'element to focus') {
  check(el, `missing ${message}`);
  (el as HTMLElement).focus();
  await settle();
}

// ---------------------------------------------------------------------------
// fetch: the page's API calls answered by the test
// ---------------------------------------------------------------------------

export interface FetchCall {
  method: string;
  /** Path and query ('/api/todos?open=1'). */
  path: string;
  body: unknown;
}

/** A canned answer: a JSON body (status 200), or { status, body } / a function of the call. */
export type FetchAnswer =
  | unknown
  | { __status: number; body?: unknown }
  | ((call: FetchCall) => unknown | { __status: number; body?: unknown } | Promise<unknown>);

/** Status + body for a stubbed answer: `reply(500, { error: 'down' })`. */
export function reply(status: number, body?: unknown): { __status: number; body?: unknown } {
  return { __status: status, body };
}

const realFetch = window.fetch.bind(window);
let fetchCalls: FetchCall[] = [];

/**
 * Answer the page's fetch calls from `routes` — keys are 'METHOD /path' (the query is ignored
 * unless the key has one) — and record every call. Unknown routes answer 404. The stub stays
 * until the next stubFetch / restoreFetch (each test starts from the real fetch).
 */
export function stubFetch(routes: Record<string, FetchAnswer>): FetchCall[] {
  fetchCalls = [];
  const calls = fetchCalls;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown = init?.body ?? null;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* not JSON: kept as text */
      }
    }
    // The test page is a file: URL, where '/api/x' resolves under the drive letter ('/C:/api/x').
    const pathname = url.protocol === 'file:' ? url.pathname.replace(/^\/[A-Za-z]:/, '') : url.pathname;
    const call: FetchCall = { method, path: `${pathname}${url.search}`, body };
    calls.push(call);
    const key = `${method} ${pathname}${url.search}`;
    const found = key in routes ? routes[key] : routes[`${method} ${pathname}`];
    if (found === undefined) return new Response(JSON.stringify({ error: `no stub for ${key}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    let answer = typeof found === 'function' ? await (found as (c: FetchCall) => unknown)(call) : found;
    let status = 200;
    if (answer && typeof answer === 'object' && '__status' in (answer as object)) {
      status = (answer as { __status: number }).__status;
      answer = (answer as { body?: unknown }).body;
    }
    return new Response(answer === undefined ? null : JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;
  return calls;
}

/** Put the real fetch back. */
export function restoreFetch() {
  window.fetch = realFetch;
}

/** The calls made since the last stubFetch. */
export function fetchLog(): FetchCall[] {
  return fetchCalls;
}

/** Click an element as a mouse would (a trusted-looking sequence of pointer and mouse events). */
export async function click(el: Element | null, message = 'element to click') {
  check(el, `missing ${message}`);
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  (el as HTMLElement).focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  (el as HTMLElement).click();
  await settle();
}

/** The text of the page (or `scope`), whitespace collapsed. */
export function textOf(scope: Element | null = document.body): string {
  return (scope?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Run every registered test in order and hand the results to the runner. */
export async function runDomTests() {
  const results: DomResult[] = [];
  for (const t of tests) {
    // Shown with a run that times out (test/domHarness.ts), so the test that hung is named.
    console.warn(`[dom] ${Math.round(performance.now())}ms ${t.name}`);
    const started = performance.now();
    try {
      await t.fn();
      results.push({ name: t.name, ok: true, ms: Math.round(performance.now() - started) });
    } catch (err) {
      results.push({ name: t.name, ok: false, ms: Math.round(performance.now() - started), error: err instanceof Error ? `${err.message}${err instanceof CheckError ? '' : `\n${err.stack ?? ''}`}` : String(err) });
    }
    try {
      await unmount();
      restoreFetch();
      window.history.replaceState(null, '', '#');
    } catch {
      /* the next test mounts afresh */
    }
  }
  await bridge.done(results);
}

window.addEventListener('error', (e) => console.error(`uncaught: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => console.error(`unhandled rejection: ${String(e.reason)}`));
