'use client';
/**
 * Read and change the appearance (lib/theme.ts). Changing it updates <html> at once, saves the
 * cookie for the next page load, and tells the desktop app so the window frame and title bar
 * follow (electron/main.js 'chrome:theme').
 */
import * as React from 'react';
import {
  DEFAULT_THEME,
  THEME_COOKIE,
  parseTheme,
  serializeTheme,
  type ThemeChoice,
} from '@/lib/theme';

export interface ChromeBridge {
  frameless: boolean;
  platform: string;
  setTheme?: (t: ThemeChoice) => unknown;
  menus?: () => Promise<string[]>;
  popupMenu?: (index: number, x: number, y: number) => Promise<unknown>;
}

export function chromeBridge(): ChromeBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: { chrome?: ChromeBridge } }).bookkeeper?.chrome;
}

const EVENT = 'ib-theme-change';

export function currentTheme(): ThemeChoice {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const d = document.documentElement;
  return parseTheme(`${d.getAttribute('data-theme')}.${d.getAttribute('data-accent')}`);
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function isDark(t: ThemeChoice): boolean {
  return t.mode === 'dark' || (t.mode === 'system' && systemDark());
}

/**
 * Tell the desktop app the choice: it sets the window's light/dark mode (which "Auto" resolves
 * against), paints the title bar and background to match, and remembers it for the next launch.
 */
export function syncWindowChrome(t: ThemeChoice = currentTheme()) {
  const bridge = chromeBridge();
  if (!bridge?.setTheme) return;
  try {
    void bridge.setTheme({ mode: t.mode, accent: t.accent });
  } catch {
    /* an older desktop shell without the call: the page still themes itself */
  }
}

export function setTheme(t: ThemeChoice) {
  const d = document.documentElement;
  d.setAttribute('data-theme', t.mode);
  d.setAttribute('data-accent', t.accent);
  document.cookie = `${THEME_COOKIE}=${encodeURIComponent(serializeTheme(t))}; path=/; max-age=31536000; SameSite=Lax`;
  syncWindowChrome(t);
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The current appearance, kept up to date when it changes anywhere on the page. */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setState] = React.useState<ThemeChoice>(DEFAULT_THEME);
  React.useEffect(() => {
    const read = () => setState(currentTheme());
    read();
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, []);
  return [theme, setTheme];
}

/**
 * Mounted once (app/layout.tsx): hands the page's theme to the desktop frame on load (the cookie
 * is the page's record; the desktop app keeps its own copy for painting the window at launch).
 */
export function ThemeSync() {
  React.useEffect(() => {
    syncWindowChrome();
  }, []);
  return null;
}
