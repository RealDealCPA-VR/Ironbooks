// The desktop window's frame follows the app's appearance (lib/theme.ts): no system title bar,
// the page draws its own (components/WindowTitleBar.tsx) and the window controls (Windows/Linux)
// or traffic lights (macOS) sit on top of it in the theme's colors.
'use strict';

/** Must match THEME_MODES / ACCENTS / WINDOW_COLORS in lib/theme.ts (test/windowTheme.test.ts). */
const MODES = ['light', 'dark', 'system'];
const ACCENTS = ['blue', 'purple', 'pink', 'red', 'orange', 'green', 'teal', 'graphite'];
const WINDOW_COLORS = {
  light: { chrome: '#ECECF0', symbol: '#1D1D1F', background: '#F5F5F7' },
  dark: { chrome: '#28282B', symbol: '#F5F5F7', background: '#121214' },
};
const DEFAULT_THEME = { mode: 'system', accent: 'blue' };
/** Title bar height in window pixels; the page reads it back as env(titlebar-area-height). */
const TITLEBAR_HEIGHT = 36;

/** Anything from the renderer or an old config file → a known { mode, accent }. */
function normalizeTheme(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: MODES.includes(t.mode) ? t.mode : DEFAULT_THEME.mode,
    accent: ACCENTS.includes(t.accent) ? t.accent : DEFAULT_THEME.accent,
  };
}

/** The title-bar overlay (window controls) for Windows / Linux. */
function overlayFor(dark) {
  const c = WINDOW_COLORS[dark ? 'dark' : 'light'];
  return { color: c.chrome, symbolColor: c.symbol, height: TITLEBAR_HEIGHT };
}

/** BrowserWindow options for a frameless, themed window on this platform. */
function frameOptions(platform, dark) {
  const background = WINDOW_COLORS[dark ? 'dark' : 'light'].background;
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 11 }, backgroundColor: background };
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: overlayFor(dark), backgroundColor: background };
}

/** The cookie the page reads its theme from (lib/theme.ts THEME_COOKIE), kept for a year. */
function themeCookie(url, theme, nowSeconds = Math.floor(Date.now() / 1000)) {
  const t = normalizeTheme(theme);
  return {
    url,
    name: 'ib-theme',
    value: `${t.mode}.${t.accent}`,
    path: '/',
    sameSite: 'lax',
    expirationDate: nowSeconds + 365 * 24 * 3600,
  };
}

/** Top-level menu labels for the in-page menu bar (mnemonic ampersands removed). */
function menuLabels(menu) {
  return (menu?.items ?? []).map((item) => String(item.label ?? '').replace(/&/g, ''));
}

module.exports = {
  MODES,
  ACCENTS,
  WINDOW_COLORS,
  DEFAULT_THEME,
  TITLEBAR_HEIGHT,
  normalizeTheme,
  overlayFor,
  frameOptions,
  themeCookie,
  menuLabels,
};
