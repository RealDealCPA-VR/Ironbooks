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

/** Run every registered test in order and hand the results to the runner. */
export async function runDomTests() {
  const results: DomResult[] = [];
  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
    } catch (err) {
      results.push({ name: t.name, ok: false, error: err instanceof Error ? `${err.message}${err instanceof CheckError ? '' : `\n${err.stack ?? ''}`}` : String(err) });
    }
    try {
      await unmount();
      window.history.replaceState(null, '', '#');
    } catch {
      /* the next test mounts afresh */
    }
  }
  await bridge.done(results);
}

window.addEventListener('error', (e) => console.error(`uncaught: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => console.error(`unhandled rejection: ${String(e.reason)}`));
