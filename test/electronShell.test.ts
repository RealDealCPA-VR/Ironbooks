/**
 * Electron shell (J13/J14): every QB-style menu item opens a real page, and the spell checker is
 * configured local-only with a spelling-aware context menu.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { GLOBAL_SHORTCUTS } from '../lib/shortcuts';

const require = createRequire(import.meta.url);
const { MENU_SECTIONS, menuRoutes, buildSectionMenus } = require('../electron/menuRoutes.js');
const { configureSpellChecker, contextMenuTemplate, NO_DOWNLOAD_URL } = require('../electron/spelling.js');

const APP_DIR = path.resolve(__dirname, '..', 'app');

describe('application menus', () => {
  it('has the QuickBooks menu sections', () => {
    expect(MENU_SECTIONS.map((s: { label: string }) => s.label)).toEqual([
      'Company',
      'Customers',
      'Vendors',
      'Employees',
      'Banking',
      'Reports',
      'Lists',
    ]);
  });

  it('every menu route is an existing page', () => {
    for (const route of menuRoutes() as string[]) {
      const pathname = route.split('?')[0];
      const page = path.join(APP_DIR, ...pathname.split('/').filter(Boolean), 'page.tsx');
      expect(fs.existsSync(page), `${route} -> ${page}`).toBe(true);
    }
  });

  it('menu items navigate through the bridge', () => {
    const navigate = vi.fn();
    const menus = buildSectionMenus(navigate);
    const invoices = menus
      .find((m: { label: string }) => m.label === 'Customers')
      .submenu.find((i: { label?: string }) => i.label === 'Create Invoices');
    invoices.click();
    expect(navigate).toHaveBeenCalledWith('/invoices?new=1');
  });

  it('shows the QuickBooks shortcut keys next to their items without registering them', () => {
    const menus = buildSectionMenus(vi.fn(), 'win32');
    const items = menus.flatMap((m: { submenu: Array<Record<string, unknown>> }) => m.submenu);
    const keyed = items.filter((i: Record<string, unknown>) => i.accelerator);
    expect(keyed.length).toBeGreaterThan(0);
    for (const i of keyed) expect(i.registerAccelerator, String(i.label)).toBe(false);
    const byLabel = (label: string) => items.find((i: Record<string, unknown>) => i.label === label)?.accelerator;
    expect(byLabel('Write Checks')).toBe('Ctrl+W');
    expect(byLabel('Create Invoices')).toBe('Ctrl+I');
    expect(byLabel('Customer Center')).toBe('Ctrl+J');
    expect(byLabel('Chart of Accounts')).toBe('Ctrl+A');
    expect(byLabel('Use Register')).toBe('Ctrl+R');
    expect(byLabel('Memorized Transaction List')).toBe('Ctrl+T');
    expect(byLabel('Make Deposits')).toBeUndefined(); // no QB key: Ctrl+D is Delete
  });

  it('each shown key is the app shortcut that opens the same page', () => {
    for (const section of MENU_SECTIONS) {
      for (const item of section.items as Array<{ label?: string; route?: string; shortcut?: string }>) {
        if (!item.shortcut) continue;
        const sc = GLOBAL_SHORTCUTS.find((s) => s.keys === item.shortcut);
        expect(sc?.href, `${item.label} ${item.shortcut}`).toBe(item.route);
      }
    }
  });

  it('macOS gets no key equivalents (they would take the key before the page)', () => {
    const items = buildSectionMenus(vi.fn(), 'darwin').flatMap((m: { submenu: Array<Record<string, unknown>> }) => m.submenu);
    expect(items.some((i: Record<string, unknown>) => i.accelerator)).toBe(false);
  });
});

describe('spell checker', () => {
  it('never downloads dictionaries where the OS checker is not available', () => {
    const ses = { setSpellCheckerEnabled: vi.fn(), setSpellCheckerDictionaryDownloadURL: vi.fn() };
    configureSpellChecker(ses, 'linux', true);
    expect(ses.setSpellCheckerDictionaryDownloadURL).toHaveBeenCalledWith(NO_DOWNLOAD_URL);
    expect(new URL(NO_DOWNLOAD_URL).hostname).toBe('127.0.0.1');
    expect(ses.setSpellCheckerEnabled).toHaveBeenCalledWith(true);
  });

  it('uses the OS checker on Windows/macOS and can be turned off', () => {
    const ses = { setSpellCheckerEnabled: vi.fn(), setSpellCheckerDictionaryDownloadURL: vi.fn() };
    expect(configureSpellChecker(ses, 'win32', false).nativeChecker).toBe(true);
    expect(ses.setSpellCheckerDictionaryDownloadURL).not.toHaveBeenCalled();
    expect(ses.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
  });

  it('context menu offers suggestions, add-to-dictionary and edit actions', () => {
    const replace = vi.fn();
    const addToDictionary = vi.fn();
    const tpl = contextMenuTemplate(
      { misspelledWord: 'reciept', dictionarySuggestions: ['receipt', 'recipe'], isEditable: true },
      { replace, addToDictionary },
    );
    tpl[0].click();
    expect(replace).toHaveBeenCalledWith('receipt');
    tpl.find((i: { label?: string }) => i.label === 'Add to Dictionary').click();
    expect(addToDictionary).toHaveBeenCalledWith('reciept');
    expect(tpl.some((i: { role?: string }) => i.role === 'paste')).toBe(true);
    expect(contextMenuTemplate({ selectionText: 'hi' }, { replace, addToDictionary })).toEqual([{ role: 'copy' }]);
    expect(contextMenuTemplate({}, { replace, addToDictionary })).toEqual([]);
  });
});
