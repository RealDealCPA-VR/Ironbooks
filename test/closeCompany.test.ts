/**
 * File > Close Company and the "No Company Open" screen (electron/startScreen.js): the recent
 * company files listed with their full locations, opened only from that list, and the open
 * file's location shown in the app (company menu in the toolbar).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ACCENT_RGB, recentEntries, startScreenHtml } = require('../electron/startScreen.js');
const ROOT = path.resolve(__dirname, '..');
// CRLF-tolerant: Windows checkouts may convert line endings.
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

describe('recent company files for "No Company Open"', () => {
  const io = {
    exists: (dir: string) => !dir.includes('gone'),
    readManifest: (dir: string) =>
      dir.endsWith('Acme') ? { lastOpenedAt: '2026-10-01T12:00:00.000Z', passwordProtected: true } : null,
    companyName: (dir: string) => path.basename(dir),
  };

  it('lists each file with its full location, most recent first', () => {
    const rows = recentEntries(['/srv/books/Acme', '/home/me/Docs/Beta'], io);
    expect(rows).toEqual([
      { dir: '/srv/books/Acme', name: 'Acme', exists: true, lastOpenedAt: '2026-10-01T12:00:00.000Z', passwordProtected: true },
      { dir: '/home/me/Docs/Beta', name: 'Beta', exists: true, lastOpenedAt: null, passwordProtected: false },
    ]);
  });

  it('marks a moved or deleted file instead of dropping it, and ignores junk', () => {
    const rows = recentEntries(['/books/gone', '/books/gone', 42, '', null, '/books/Acme'], io);
    expect(rows.map((r: { dir: string; exists: boolean }) => [r.dir, r.exists])).toEqual([
      ['/books/gone', false],
      ['/books/Acme', true],
    ]);
    expect(recentEntries(undefined, io)).toEqual([]);
  });
});

describe('a file is listed by its company name, not its folder name', () => {
  const companyFile = require('../electron/companyFile.js');
  const os = require('node:os');

  it('prefers the name the app recorded, then the file name, then the folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-close-'));
    const file = path.join(dir, 'default');
    try {
      expect(companyFile.companyName(file)).toBe('default');
      companyFile.ensureManifest(file);
      expect(companyFile.companyName(file)).toBe('default');
      companyFile.writeManifest(file, { displayName: '  Clip Test Co  ' });
      expect(companyFile.companyName(file)).toBe('Clip Test Co');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only the local app can record it, trimmed and capped', () => {
    const main = read('electron/main.js');
    const at = main.indexOf("ipcMain.handle('company:displayName'");
    expect(main.slice(at, at + 260)).toMatch(/fromLocalApp\(e\)/);
    expect(main.slice(at, at + 260)).toMatch(/name\.trim\(\)\.slice\(0, 200\)/);
  });
});

describe('the "No Company Open" page', () => {
  it('follows the theme: scheme and accent color', () => {
    const dark = startScreenHtml({ dark: true, accent: 'purple', platform: 'win32' });
    expect(dark).toContain('data-scheme="dark"');
    expect(dark).toContain(`--accent: ${ACCENT_RGB.purple[1]};`);
    const light = startScreenHtml({ dark: false, accent: 'nope', platform: 'win32' });
    expect(light).toContain('data-scheme="light"');
    expect(light).toContain(`--accent: ${ACCENT_RGB.blue[0]};`);
  });

  it('is locked down: its own CSP, and file names / paths only ever go in as text', () => {
    const html = startScreenHtml({ dark: false, accent: 'blue', platform: 'win32' });
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none';/);
    expect(html).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(html).toMatch(/el\('div', 'path', r\.dir\)/);
  });

  it('shows every recent file\'s location and the open / create / browse actions', () => {
    const html = startScreenHtml({ dark: false, accent: 'blue', platform: 'win32' });
    expect(html).toContain('No company open');
    expect(html).toContain('Company file and location');
    for (const id of ['open', 'remove', 'reveal', 'new', 'browse']) expect(html).toContain(`id="${id}"`);
  });

  it('leaves room for the macOS traffic lights', () => {
    expect(startScreenHtml({ dark: false, accent: 'blue', platform: 'darwin' })).toContain('padding-left: 80px');
  });
});

describe('desktop wiring (source pins)', () => {
  const main = read('electron/main.js');

  it('File has Close Company and Company File Details', () => {
    expect(main).toMatch(/\{ label: 'Close Company', click: \(\) => \{ closeCompanyFlow\(\); \} \}/);
    expect(main).toMatch(/label: 'Company File Details…'.*navigate\('\/company-file'\)/);
  });

  it('closing releases the file: the next launch shows the start screen without starting a server', () => {
    expect(main).toMatch(/saveConfig\(\{ companyClosed: true, remoteHost: null \}\);\s*\n\s*app\.relaunch\(\);/);
    const create = main.indexOf('async function createWindow()');
    const startCheck = main.indexOf("loadConfig().companyClosed === true", create);
    const server = main.indexOf('await startNextServer()', create);
    expect(startCheck).toBeGreaterThan(create);
    expect(startCheck).toBeLessThan(server);
  });

  it('opening a file or a host ends the closed state', () => {
    expect(main).toMatch(/saveConfig\(\{ dataDir: dir, remoteHost: null, companyClosed: false \}\)/);
    expect(main).toMatch(/saveConfig\(\{ remoteHost: n\.origin, lastRemoteHost: value\.trim\(\), companyClosed: false \}\)/);
  });

  it('the start screen opens and reveals only folders on the recent list, only from its own window', () => {
    for (const ch of ['start:list', 'start:open', 'start:remove', 'start:reveal', 'start:new', 'start:browse']) {
      const at = main.indexOf(`ipcMain.handle('${ch}'`);
      expect(at, ch).toBeGreaterThan(0);
      expect(main.slice(at, at + 160), ch).toMatch(/fromStartScreen\(e\)/);
    }
    for (const ch of ['start:open', 'start:reveal']) {
      const at = main.indexOf(`ipcMain.handle('${ch}'`);
      expect(main.slice(at, at + 160), ch).toMatch(/recentCompanyDirs\(\)\.includes\(dir\)/);
    }
    expect(main).toMatch(/e\.sender === mainWindow\.webContents/);
  });

  it('the app shows where the open company file lives', () => {
    const shell = read('components/AppShell.tsx');
    expect(shell).toContain('Company file location');
    expect(shell).toMatch(/data-company-file-path/);
    const preload = read('electron/preload.js');
    expect(preload).toMatch(/reveal: \(\) => ipcRenderer\.invoke\('company:reveal'\)/);
    expect(preload).toMatch(/close: \(\) => ipcRenderer\.invoke\('company:close'\)/);
  });
});
