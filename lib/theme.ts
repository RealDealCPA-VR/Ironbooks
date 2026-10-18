/**
 * Appearance: light / dark / auto (follows the computer) plus an accent color.
 *
 * The choice lives in a cookie (`ib-theme=<mode>.<accent>`) rather than localStorage: the desktop
 * app's local server gets a new port each launch, and localStorage is per port while cookies are
 * not. A tiny script in <head> (THEME_BOOT_SCRIPT) applies it to <html> before the first paint,
 * so there is no flash of the wrong theme. The colors themselves are CSS variables in
 * app/globals.css, keyed off `data-theme` and `data-accent`.
 */

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Accent colors, macOS-style. `label` is what the picker shows; `swatch` is its dot color. */
export const ACCENTS = [
  { id: 'blue', label: 'Blue', swatch: '#0A84FF' },
  { id: 'purple', label: 'Purple', swatch: '#BF5AF2' },
  { id: 'pink', label: 'Pink', swatch: '#FF375F' },
  { id: 'red', label: 'Red', swatch: '#FF453A' },
  { id: 'orange', label: 'Orange', swatch: '#FF9F0A' },
  { id: 'green', label: 'Green', swatch: '#30D158' },
  { id: 'teal', label: 'Ironbooks', swatch: '#0095FF' },
  { id: 'graphite', label: 'Graphite', swatch: '#8E8E93' },
] as const;
export type AccentId = (typeof ACCENTS)[number]['id'];

export interface ThemeChoice {
  mode: ThemeMode;
  accent: AccentId;
}

export const DEFAULT_THEME: ThemeChoice = { mode: 'system', accent: 'blue' };
export const THEME_COOKIE = 'ib-theme';

const isMode = (v: unknown): v is ThemeMode => typeof v === 'string' && (THEME_MODES as readonly string[]).includes(v);
const isAccent = (v: unknown): v is AccentId => typeof v === 'string' && ACCENTS.some((a) => a.id === v);

/** `"dark.purple"` → choice; anything unrecognized falls back to the default, piece by piece. */
export function parseTheme(raw: string | null | undefined): ThemeChoice {
  const [mode, accent] = String(raw ?? '').split('.');
  return { mode: isMode(mode) ? mode : DEFAULT_THEME.mode, accent: isAccent(accent) ? accent : DEFAULT_THEME.accent };
}

export function serializeTheme(t: ThemeChoice): string {
  return `${t.mode}.${t.accent}`;
}

/** Read the theme cookie out of a `document.cookie`-style string. */
export function themeFromCookie(cookie: string | null | undefined): ThemeChoice {
  const m = String(cookie ?? '').match(new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=([^;]*)`));
  return parseTheme(m ? decodeURIComponent(m[1]) : null);
}

/**
 * Window colors for the desktop title bar and background, per resolved scheme. These mirror the
 * --chrome / --ink / --canvas variables in app/globals.css (a test keeps them in step).
 */
export const WINDOW_COLORS = {
  light: { chrome: '#ECECF0', symbol: '#1D1D1F', background: '#F5F5F7' },
  dark: { chrome: '#28282B', symbol: '#F5F5F7', background: '#121214' },
} as const;

/**
 * Runs inline in <head> before anything paints. Keep it dependency-free ES5: it applies the
 * cookie's theme to <html>, and marks the desktop window (frameless, custom title bar) so the
 * title bar space is reserved from the first frame.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var d=document.documentElement,m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=([^;]*)/),v=m?decodeURIComponent(m[1]).split('.'):[];
var modes=${JSON.stringify(THEME_MODES)},accents=${JSON.stringify(ACCENTS.map((a) => a.id))};
d.setAttribute('data-theme',modes.indexOf(v[0])>=0?v[0]:${JSON.stringify(DEFAULT_THEME.mode)});
d.setAttribute('data-accent',accents.indexOf(v[1])>=0?v[1]:${JSON.stringify(DEFAULT_THEME.accent)});
var c=window.bookkeeper&&window.bookkeeper.chrome;if(c&&c.frameless)d.setAttribute('data-desktop',c.platform);
}catch(e){}})();`;
