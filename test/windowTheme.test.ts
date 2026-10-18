/**
 * Appearance (light / dark / auto + accent color) and the themed desktop frame:
 * lib/theme.ts (the page side), electron/windowTheme.js (the window side), the CSS variables in
 * app/globals.css, and the boot script that applies the cookie before the first paint.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import {
  ACCENTS,
  DEFAULT_THEME,
  THEME_BOOT_SCRIPT,
  THEME_MODES,
  WINDOW_COLORS,
  parseTheme,
  serializeTheme,
  themeFromCookie,
} from '@/lib/theme';
import tailwindConfig from '../tailwind.config';

const require = createRequire(import.meta.url);
const wt = require('../electron/windowTheme.js');
const ROOT = path.resolve(__dirname, '..');
// CRLF-tolerant: Windows checkouts may convert line endings.
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('app/globals.css');

/** The declarations inside the first `selector {` block (no nested braces in these blocks). */
function block(css: string, selector: string, from = 0): Record<string, string> {
  const start = css.indexOf(selector, from);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().replace(/\s+/g, ' ')]),
  );
}
const channels = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

describe('theme choice (lib/theme.ts)', () => {
  it('round-trips and falls back piece by piece', () => {
    expect(parseTheme(serializeTheme({ mode: 'dark', accent: 'purple' }))).toEqual({ mode: 'dark', accent: 'purple' });
    expect(parseTheme('dark.chartreuse')).toEqual({ mode: 'dark', accent: DEFAULT_THEME.accent });
    expect(parseTheme('neon.green')).toEqual({ mode: DEFAULT_THEME.mode, accent: 'green' });
    expect(parseTheme(null)).toEqual(DEFAULT_THEME);
  });

  it('reads its cookie out of document.cookie', () => {
    expect(themeFromCookie('a=1; ib-theme=light.orange; b=2')).toEqual({ mode: 'light', accent: 'orange' });
    expect(themeFromCookie('xib-theme=dark.red')).toEqual(DEFAULT_THEME);
    expect(themeFromCookie('')).toEqual(DEFAULT_THEME);
  });
});

describe('boot script: the theme is on <html> before the first paint', () => {
  function run(cookie: string, chrome?: unknown) {
    const attrs: Record<string, string> = {};
    const documentElement = { setAttribute: (k: string, v: string) => (attrs[k] = v) };
    const ctx = { document: { cookie, documentElement }, window: { bookkeeper: chrome ? { chrome } : undefined } };
    vm.runInNewContext(THEME_BOOT_SCRIPT, ctx);
    return attrs;
  }

  it('applies the saved choice', () => {
    expect(run('ib-theme=dark.pink')).toEqual({ 'data-theme': 'dark', 'data-accent': 'pink' });
  });

  it('ignores a tampered cookie', () => {
    expect(run('ib-theme=%3Cscript%3E.%22x')).toEqual({ 'data-theme': DEFAULT_THEME.mode, 'data-accent': DEFAULT_THEME.accent });
  });

  it('reserves the title bar only in the frameless desktop window', () => {
    expect(run('', { frameless: true, platform: 'win32' })['data-desktop']).toBe('win32');
    expect(run('', { frameless: false, platform: 'win32' })['data-desktop']).toBeUndefined();
    expect(run('')['data-desktop']).toBeUndefined();
  });
});

describe('desktop frame (electron/windowTheme.js)', () => {
  it('knows the same modes, accents and colors as the page', () => {
    expect(wt.MODES).toEqual([...THEME_MODES]);
    expect(wt.ACCENTS).toEqual(ACCENTS.map((a) => a.id));
    expect(wt.WINDOW_COLORS).toEqual(WINDOW_COLORS);
    expect(wt.DEFAULT_THEME).toEqual(DEFAULT_THEME);
  });

  it('accepts only known values from the renderer or an old config file', () => {
    expect(wt.normalizeTheme({ mode: 'dark', accent: 'teal' })).toEqual({ mode: 'dark', accent: 'teal' });
    expect(wt.normalizeTheme({ mode: '__proto__', accent: 42 })).toEqual(DEFAULT_THEME);
    expect(wt.normalizeTheme('dark')).toEqual(DEFAULT_THEME);
    expect(wt.normalizeTheme(undefined)).toEqual(DEFAULT_THEME);
  });

  it('is frameless on every platform, window controls in the theme colors', () => {
    expect(wt.frameOptions('win32', true)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: WINDOW_COLORS.dark.chrome, symbolColor: WINDOW_COLORS.dark.symbol, height: 36 },
      backgroundColor: WINDOW_COLORS.dark.background,
    });
    expect(wt.frameOptions('linux', false).titleBarOverlay.color).toBe(WINDOW_COLORS.light.chrome);
    const mac = wt.frameOptions('darwin', false);
    expect(mac.titleBarStyle).toBe('hiddenInset');
    expect(mac.titleBarOverlay).toBeUndefined();
  });

  it('hands the page its theme cookie for the server origin', () => {
    const c = wt.themeCookie('http://localhost:51234/', { mode: 'light', accent: 'green' }, 1000);
    expect(c).toMatchObject({ url: 'http://localhost:51234/', name: 'ib-theme', value: 'light.green', path: '/' });
    expect(c.expirationDate).toBe(1000 + 365 * 24 * 3600);
    expect(wt.themeCookie('http://x/', { mode: 'evil;', accent: 'x' }).value).toBe('system.blue');
  });

  it('lists the application menu labels without mnemonic ampersands', () => {
    expect(wt.menuLabels({ items: [{ label: '&File' }, { label: 'Edit' }, {}] })).toEqual(['File', 'Edit', '']);
    expect(wt.menuLabels(null)).toEqual([]);
  });
});

describe('CSS variables (app/globals.css)', () => {
  const light = block(CSS, ':root,\n  .theme-light {');
  const dark = block(CSS, "[data-theme='dark'] {");
  const systemDark = block(CSS, "[data-theme='system'] {", CSS.indexOf('@media (prefers-color-scheme: dark)'));

  it('"Auto" in dark mode is exactly the Dark theme', () => {
    expect(Object.keys(dark).length).toBeGreaterThan(40);
    expect(systemDark).toEqual(dark);
  });

  it('light and dark define the same variables', () => {
    const themed = Object.keys(light).filter((k) => k !== '--shadow-color');
    expect(themed.filter((k) => !(k in dark))).toEqual([]);
  });

  it('every accent has a light, a dark and an auto-dark color', () => {
    for (const { id } of ACCENTS) {
      expect(CSS, id).toMatch(new RegExp(`\\[data-accent='${id}'\\][^{]*\\{ --accent: \\d+ \\d+ \\d+; \\}`));
      expect(CSS, id).toMatch(new RegExp(`\\[data-theme='dark'\\]\\[data-accent='${id}'\\][^{]*\\{ --accent:`));
      expect(CSS, id).toMatch(new RegExp(`\\[data-theme='system'\\]\\[data-accent='${id}'\\] \\{ --accent:`));
    }
  });

  it('the window frame colors match the page chrome, text and canvas', () => {
    expect(light['--chrome']).toBe(channels(WINDOW_COLORS.light.chrome));
    expect(light['--ink']).toBe(channels(WINDOW_COLORS.light.symbol));
    expect(light['--canvas']).toBe(channels(WINDOW_COLORS.light.background));
    expect(dark['--chrome']).toBe(channels(WINDOW_COLORS.dark.chrome));
    expect(dark['--ink']).toBe(channels(WINDOW_COLORS.dark.symbol));
    expect(dark['--canvas']).toBe(channels(WINDOW_COLORS.dark.background));
  });

  it('prints in light colors whatever the screen theme', () => {
    const print = block(CSS, ':root[data-theme] {', CSS.indexOf('@media print'));
    expect(print['--ink']).toBe(light['--ink']);
    expect(print['--surface']).toBe('255 255 255');
  });
});

describe('Tailwind reads the theme', () => {
  const ext = (tailwindConfig.theme as { extend: Record<string, Record<string, unknown>> }).extend;
  it('brand names map to theme variables, bg-white to the surface', () => {
    expect(ext.colors.navy).toBe('rgb(var(--ink) / <alpha-value>)');
    expect(ext.colors.electric).toBe('rgb(var(--accent) / <alpha-value>)');
    expect((ext.colors.slate as Record<string, string>)[200]).toBe('rgb(var(--slate-200) / <alpha-value>)');
    expect(ext.backgroundColor.white).toBe('rgb(var(--surface) / <alpha-value>)');
  });

  it('every slate / red / amber / yellow shade it names is defined in both themes', () => {
    const light = block(CSS, ':root,\n  .theme-light {');
    const dark = block(CSS, "[data-theme='dark'] {");
    for (const name of ['slate', 'red', 'amber', 'yellow']) {
      for (const shade of Object.keys(ext.colors[name] as object)) {
        expect(light[`--${name}-${shade}`], `${name}-${shade}`).toBeDefined();
        expect(dark[`--${name}-${shade}`], `${name}-${shade}`).toBeDefined();
      }
    }
  });
});

describe('desktop shell wiring (source pins)', () => {
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');

  it('the main window is built frameless from the saved theme', () => {
    expect(main).toMatch(/windowTheme\.frameOptions\(process\.platform, nativeTheme\.shouldUseDarkColors\)/);
    expect(main).toMatch(/nativeTheme\.themeSource = theme\.mode;\s*\n\s*mainWindow = new BrowserWindow/);
    expect(main).not.toMatch(/backgroundColor: '#0b1f3a'/);
  });

  it('theme and menu calls are accepted only from the app\'s own pages', () => {
    for (const ch of ['chrome:theme', 'chrome:menus', 'chrome:popupMenu']) {
      const at = main.indexOf(`ipcMain.handle('${ch}'`);
      expect(at, ch).toBeGreaterThan(0);
      expect(main.slice(at, at + 200), ch).toMatch(/fromAppOrigin\(e\)/);
    }
  });

  it('the preload exposes the frame bridge', () => {
    expect(preload).toMatch(/ipcRenderer\.sendSync\('chrome:info'\)/);
    expect(preload).toMatch(/setTheme: \(theme\) => ipcRenderer\.invoke\('chrome:theme', theme\)/);
  });
});
