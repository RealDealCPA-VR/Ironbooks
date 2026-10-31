/**
 * Desktop menus and QuickBooks keys (electron/main.js buildMenu). main.js starts the app when it is
 * loaded, so its company-file menu is read from the source: what matters is which keys the native
 * menu registers (a registered key reaches the window before the page and would take a QuickBooks
 * key away from it) and that the page actions go through the page. What the page does with those
 * actions is pressed in a browser engine: test/keyboardDom.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
/** The company-file menu: buildMenu's template (not the start screen's). */
const menu = main.slice(main.indexOf('function buildMenu()'), main.indexOf('function buildStartMenu()') > main.indexOf('function buildMenu()') ? main.indexOf('function buildStartMenu()') : undefined);
const body = menu.slice(0, menu.indexOf('Menu.setApplicationMenu') > 0 ? menu.indexOf('Menu.setApplicationMenu') : undefined);

describe('the desktop menus never take a QuickBooks key from the page', () => {
  it('no registered accelerator for Ctrl+W, R, O, P, F, N, Z, Y, M, V, F5, Alt+Left / Right', () => {
    const registered = [...body.matchAll(/accelerator:\s*'([^']+)'/g)].map((m) => m[1]);
    for (const k of ['CmdOrCtrl+O', 'Ctrl+O', 'CmdOrCtrl+W', 'Ctrl+W', 'CmdOrCtrl+R', 'Ctrl+R', 'CmdOrCtrl+P', 'CmdOrCtrl+F', 'CmdOrCtrl+N', 'CmdOrCtrl+M', 'F5', 'Alt+Left', 'Alt+Right']) {
      expect(registered, k).not.toContain(k);
    }
  });

  it('keys shown next to items are display-only on Windows (shownKey: registerAccelerator false)', () => {
    expect(main).toMatch(/const shownKey = \(accelerator\) =>\s*process\.platform === 'darwin' \? \{\} : \{ accelerator, registerAccelerator: false \}/);
    for (const k of ['Ctrl+Z', 'Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'F5', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+F4', 'Alt+Left', 'Alt+Right', 'F1', 'F2', 'Alt+F4']) {
      expect(body, k).toContain(`shownKey('${k}')`);
    }
  });

  it('View > Refresh (F5) asks the page, never the window reload', () => {
    expect(body).not.toMatch(/role:\s*'reload'/);
    expect(body).toMatch(/label: 'Refresh', \.\.\.shownKey\('F5'\), click: pageAction\('refresh'\)/);
  });

  it('Window > Back / Forward go through the page (a form being typed asks first)', () => {
    expect(body).not.toMatch(/navigationHistory\??\.goBack/);
    expect(body).toMatch(/label: 'Back', \.\.\.shownKey\('Alt\+Left'\), click: pageAction\('history-back'\)/);
    expect(body).toMatch(/label: 'Forward', \.\.\.shownKey\('Alt\+Right'\), click: pageAction\('history-forward'\)/);
  });

  it("QuickBooks' Window and Help items: Open Window List, Next / Previous / Close Window, Keyboard Shortcuts, Product Information", () => {
    for (const a of ['window-list', 'window-next', 'window-prev', 'window-close', 'keyboard-shortcuts', 'product-info', 'help', 'customize-favorites']) {
      expect(body, a).toContain(`pageAction('${a}')`);
    }
  });

  it("menus in QuickBooks' order: Lists and Favorites before Company", () => {
    expect(body).toMatch(/return \[\.\.\.lists, favorites, \.\.\.sections\.filter\(\(s\) => s\.label !== 'Lists'\)\]/);
  });

  it('closing the window with typed work asks first (Alt+F4, File > Exit)', () => {
    expect(main).toContain("message: 'Close Ironbooks?'");
    expect(main).toMatch(/confirmCloseOverUnsavedWork\(win\)\.then/);
    expect(main).toContain('window.__ironbooksUnsavedWork');
  });
});

describe('the page handles every menu action main.js sends', () => {
  it('each pageAction has a handler in components/DesktopBridge.tsx', () => {
    const bridge = fs.readFileSync(path.resolve(__dirname, '..', 'components', 'DesktopBridge.tsx'), 'utf8');
    const actions = [...new Set([...body.matchAll(/pageAction\('([^']+)'\)/g)].map((m) => m[1]))];
    expect(actions.length).toBeGreaterThan(8);
    for (const a of actions) {
      const windowCommand = /^window-(close|next|prev)$/.test(a);
      expect(windowCommand || new RegExp(`['\\s]${a.replace(/-/g, '\\-')}'?:`).test(bridge), a).toBe(true);
    }
  });
});
