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
const { ACCENT_RGB, recentEntries, startScreenHtml, openingScreenHtml } = require('../electron/startScreen.js');
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
      { dir: '/srv/books/Acme', name: 'Acme', exists: true, lastOpenedAt: '2026-10-01T12:00:00.000Z', passwordProtected: true, inUseBy: null },
      { dir: '/home/me/Docs/Beta', name: 'Beta', exists: true, lastOpenedAt: null, passwordProtected: false, inUseBy: null },
    ]);
  });

  it('says who has a company file open on another computer', () => {
    const rows = recentEntries(['/srv/books/Acme.ironbooks', '/srv/books/gone.ironbooks'], {
      ...io,
      inUseBy: (dir: string) => (dir.includes('Acme') ? 'Mary on FRONT-DESK' : null),
    });
    expect(rows.map((r: { inUseBy: string | null }) => r.inUseBy)).toEqual(['Mary on FRONT-DESK', null]);
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

describe('the "Opening…" page', () => {
  it('names the company file being opened, in the theme of the start screen', () => {
    const html = openingScreenHtml({ dark: true, accent: 'green', platform: 'win32', name: 'Acme Plumbing' });
    expect(html).toContain('Opening Acme Plumbing…');
    expect(html).toContain('data-scheme="dark"');
    expect(html).toContain(`--accent: ${ACCENT_RGB.green[1]}`);
    expect(openingScreenHtml({ dark: false, accent: 'blue', platform: 'darwin', name: 'A' })).toContain('padding-left: 80px');
    expect(openingScreenHtml({ dark: false, accent: 'blue', platform: 'win32' })).toContain('Opening your company file…');
  });

  it('a company name is text, never markup, and the page runs no script', () => {
    const html = openingScreenHtml({ dark: false, accent: 'blue', platform: 'win32', name: '<img src=x onerror=alert(1)> & "Co"' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;');
    expect(html).not.toContain('<script');
    expect(html).toContain(`default-src 'none'; style-src 'unsafe-inline'"`);
  });
});

describe('opening a company file in the one window (source pins)', () => {
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');
  const body = (signature: string) => {
    const at = main.indexOf(signature);
    expect(at, signature).toBeGreaterThan(-1);
    return main.slice(at, main.indexOf('\n}\n', at));
  };

  it('there is one app window: the start screen and the company share it', () => {
    // Only ensureMainWindow makes the app window (the others are small prompts in their own files).
    expect(main.match(/new BrowserWindow\(/g)).toHaveLength(1);
    const ensure = body('function ensureMainWindow() {');
    expect(ensure).toMatch(/if \(mainWindow && !mainWindow\.isDestroyed\(\)\) return mainWindow;/);
    expect(ensure).toMatch(/preload: path\.join\(__dirname, 'preload\.js'\)/);
    expect(ensure).toMatch(/sandbox: true/);
    expect(body('async function createStartWindow({ firstRun = false } = {}) {')).toMatch(/const win = ensureMainWindow\(\);/);
    expect(fs.existsSync(path.join(ROOT, 'electron', 'startPreload.js'))).toBe(false);
  });

  it('from No Company Open a company opens in that window, with no relaunch', () => {
    const relaunch = body('function relaunchApp(nextConfig = null) {');
    expect(relaunch).toMatch(/^function relaunchApp\(nextConfig = null\) \{\s*if \(canOpenInWindow\(\)\) return void openInWindow\(nextConfig\);/);
    // Only when nothing is open: no company file to save, no server to stop, not already closing.
    const can = body('function canOpenInWindow() {');
    for (const cond of ['startScreenMode', '!openingCompany', '!serverProcess', '!openFile', '!remoteHostOrigin', '!closingInProgress', '!quittingAfterBackup']) {
      expect(can, cond).toContain(cond);
    }
    const open = body('async function openInWindow(nextConfig) {');
    expect(open).toMatch(/if \(nextConfig\) saveConfig\(nextConfig\);\s*await createWindow\(\);/);
    expect(open).not.toMatch(/app\.relaunch/);
  });

  it('the window says "Opening…" before the file is locked and its server starts', () => {
    const create = body('async function createWindow() {');
    const opening = create.indexOf('await showOpeningScreen(');
    expect(opening).toBeGreaterThan(create.indexOf('isFirstRun()'));
    expect(opening).toBeLessThan(create.indexOf('await openSingleFileForLaunch('));
    expect(opening).toBeLessThan(create.indexOf('await startNextServer()'));
    // The start-screen calls stop being accepted the moment a company starts opening.
    expect(body('async function showOpeningScreen(location) {')).toMatch(/await showBusyScreen\(/);
    expect(body('async function showBusyScreen(label) {')).toMatch(/^async function showBusyScreen\(label\) \{\s*startScreenMode = false;/);
  });

  it("Back on the company's first page never returns to the screens the window showed before it", () => {
    expect(body('function forgetEarlierPages(win) {')).toMatch(/win\.webContents\.navigationHistory\.clear\(\);/);
    const create = body('async function createWindow() {');
    // After the company's page loaded (a multi-user host's too), and after the start screen.
    expect(create.match(/forgetEarlierPages\(mainWindow\);/g)).toHaveLength(2);
    expect(create.lastIndexOf('forgetEarlierPages(mainWindow);')).toBeGreaterThan(create.lastIndexOf('await mainWindow.loadURL('));
    expect(body('async function createStartWindow({ firstRun = false } = {}) {')).toMatch(/forgetEarlierPages\(win\);/);
  });

  it('a close or quit while a file is opening waits until it is open, then closes it properly', () => {
    expect(body('async function createWindow() {')).toMatch(/openingCompany = true;/);
    const quit = main.slice(main.indexOf("app.on('before-quit', (event) => {"));
    expect(quit.slice(0, 1600)).toMatch(/event\.preventDefault\(\);[\s\S]*if \(openingCompany\) \{\s*deferCloseUntilOpened\(\);\s*return;\s*\}[\s\S]*if \(closingInProgress\) return;/);
    expect(body('function ensureMainWindow() {')).toMatch(/if \(openingCompany && !quittingAfterBackup\) \{\s*e\.preventDefault\(\);\s*deferCloseUntilOpened\(\);/);
    const end = body('function endOpening() {');
    expect(end).toMatch(/openingCompany = false;/);
    expect(end).toMatch(/closeAfterOpening = false;\s*app\.quit\(\);/);
    // Every caller of createWindow ends the opening, also when it fails.
    expect(main.match(/endOpening\(\)/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it('closing or switching company files happens in the window too, in the order a quit uses', () => {
    const relaunch = body('function relaunchApp(nextConfig = null) {');
    expect(relaunch).toMatch(/if \(canCloseInWindow\(\)\) return void closeThenOpenInWindow\(nextConfig\);\s*restartApp\(nextConfig\);/);
    const can = body('function canCloseInWindow() {');
    for (const cond of ['startScreenMode', 'openingCompany', 'closingInProgress', 'quittingAfterBackup', 'installAfterClose', 'loadConfig().sandbox', 'sandboxActive()']) {
      expect(can, cond).toContain(cond);
    }
    // The sandbox still restarts (its server switched folders under the shell).
    for (const ch of ['sandbox:entered', 'sandbox:left']) {
      const at = main.indexOf(`ipcMain.handle('${ch}'`);
      const handler = main.slice(at, main.indexOf('\n});\n', at));
      expect(handler, ch).toMatch(/restartApp\(\);/);
      expect(handler, ch).not.toMatch(/relaunchApp\(/);
    }
    const close = body('async function closeThenOpenInWindow(nextConfig) {');
    const order = ['await runAutoBackup()', 'await closeOpenCompanyFile()', 'if (goOn === false) {', 'await showBusyScreen(', 'await releaseClosedCompany();', 'await openInWindow(nextConfig);'];
    const at = order.map((s) => close.indexOf(s));
    for (const [i, a] of at.entries()) expect(a, order[i]).toBeGreaterThan(i ? at[i - 1] : -1);
    // The company's page stays on screen until its file is saved and released.
    expect(close.indexOf('showBusyScreen(')).toBeGreaterThan(close.indexOf('closingInProgress = false;'));
  });

  it('a closed company leaves nothing running and nothing remembered, as a restart would', () => {
    const release = body('async function releaseClosedCompany() {');
    // The server is stopped (and waited for) before anything else is opened; on purpose, so quietly.
    expect(release).toMatch(/const server = serverProcess;\s*serverProcess = null;\s*if \(server && !\(await stopChild\(server\)\)\) throw/);
    expect(release).toMatch(/await hosting\.stopHosting\(hostingState\)/);
    for (const reset of ['openFile = null;', 'serverUrl = null;', 'remoteHostOrigin = null;', 'remotePin = null;', 'hostingState = null;', 'favoriteItems = [];', 'answeredRequests.clear();', 'setCertificateVerifyProc(null)', 'await forgetSessionCookies();']) {
      expect(release, reset).toContain(reset);
    }
    // Sign-ins are tied to this launch's secret (lib/auth.ts launchNonce): a new one, so the file
    // just closed asks for its password again when it is reopened without a restart.
    expect(release.indexOf('renewLaunchSecrets();')).toBeGreaterThan(release.indexOf('await stopChild(server)'));
    const renew = body('function renewLaunchSecrets() {');
    expect(renew).toMatch(/internalToken = crypto\.randomBytes\(32\)\.toString\('hex'\);/);
    expect(renew).toMatch(/launchPass = crypto\.randomBytes\(32\)\.toString\('hex'\);/);
    expect(read('lib/auth.ts')).toMatch(/function launchNonce\(\): string \{\s*return process\.env\.BKA_INTERNAL_TOKEN \|\| '';/);
    // If the server will not stop, the app restarts instead (the file is already saved and released).
    const close = body('async function closeThenOpenInWindow(nextConfig) {');
    expect(close).toMatch(/catch \(err\) \{[\s\S]*quittingAfterBackup = true;[\s\S]*app\.relaunch\(\{ args: relaunchArgs\(\) \}\);\s*app\.quit\(\);/);
  });

  it('"Closing…" uses the same waiting page', () => {
    const html = openingScreenHtml({ dark: false, accent: 'blue', platform: 'win32', label: 'Closing <b>Acme</b>…' });
    expect(html).toContain('Closing &lt;b&gt;Acme&lt;/b&gt;…');
    expect(html).not.toContain('Opening');
    expect(body('async function showBusyScreen(label) {')).toMatch(/^async function showBusyScreen\(label\) \{\s*startScreenMode = false;/);
  });

  it("each kind of page gets only its own calls from the window's one preload", () => {
    expect(preload).toMatch(/const shellPage = location\.protocol === 'data:';/);
    expect(preload).toMatch(/if \(shellPage\) \{\s*contextBridge\.exposeInMainWorld\('startScreen', \{/);
    expect(preload).toMatch(/if \(!shellPage\) contextBridge\.exposeInMainWorld\('bookkeeper', \{/);
    expect(preload.match(/exposeInMainWorld\(/g)).toHaveLength(2);
  });
});

describe('desktop wiring (source pins)', () => {
  const main = read('electron/main.js');

  it('File has Close Company and Company File Details', () => {
    expect(main).toMatch(/\{ label: 'Close Company', click: \(\) => \{ closeCompanyFlow\(\); \} \}/);
    expect(main).toMatch(/label: 'Company File Details…'.*navigate\('\/company-file'\)/);
  });

  it('closing releases the file: the next launch shows the start screen without starting a server', () => {
    // Written once the open file has closed (a failed save + Keep Working leaves it as it was).
    expect(main).toMatch(/relaunchApp\(\{ companyClosed: true, remoteHost: null, remotePin: null, remoteFile: null \}\);/);
    // An open single company file is saved into itself and its lock released on the way out.
    expect(main).toMatch(/\.then\(\(\) => closeOpenCompanyFile\(\)\)/);
    const create = main.indexOf('async function createWindow()');
    const startCheck = main.indexOf("loadConfig().companyClosed === true", create);
    const server = main.indexOf('await startNextServer()', create);
    expect(startCheck).toBeGreaterThan(create);
    expect(startCheck).toBeLessThan(server);
  });

  it('opening a file or a host ends the closed state', () => {
    expect(main).toMatch(/single \? \{ companyFile: location \} : \{ dataDir: location, companyFile: null \}/);
    expect(main).toMatch(/remoteFile: null,\s*\n\s*companyClosed: false,/);
    // (applied once the open company file has closed: relaunchApp hands it to before-quit)
    expect(main).toMatch(/relaunchApp\(\{ remoteHost: n\.origin, lastRemoteHost: value\.trim\(\), companyClosed: false \}\)/);
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
