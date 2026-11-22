/**
 * Security plan, desktop shell side (electron/): what can be checked without starting Electron.
 *
 *  1.1b  the shell's own calls go to 127.0.0.1 by exact address, never to a multi-user host, and
 *        the window's "localhost" is mapped to 127.0.0.1 before the app is ready;
 *  1.1c  the per-launch pass: on the window as a cookie before the company server starts, as a
 *        header on the shell's calls, in the environment of every server the shell starts;
 *  1.1d  the start-up check that the port answers with the server the shell started;
 *  2.8   developer switches set on the PC never reach the installed app's server;
 *  4.1   requests with no window behind them (service workers) get the page filter too;
 *  4.2   a blocked navigation is only blocked, never opened in the person's browser;
 *  4.3   file types are checked on the path finally written (Save dialog and downloads).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { serverCheckProof } from '../lib/net/internalToken';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const localServer = require('../electron/localServer.js');
const security = require('../electron/security.js');
const saveTypes = require('../electron/saveTypes.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
/** The body of a top-level function in main.js (up to the next top-level declaration). */
const fnBody = (signature: string) => {
  const at = main.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const rest = main.slice(at + signature.length);
  const end = rest.search(/\n(?:async function |function |const |let |ipcMain\.|app\.on\()/);
  return main.slice(at, at + signature.length + (end < 0 ? rest.length : end));
};

describe('1.1b: the shell reaches its server by exact address', () => {
  it('directUrl turns localhost into 127.0.0.1 and refuses every other host', () => {
    expect(localServer.directUrl('http://localhost:51234', '/api/company-file/status')).toBe('http://127.0.0.1:51234/api/company-file/status');
    expect(localServer.directUrl('http://127.0.0.1:51234', '/api/x?y=1&z=%2F')).toBe('http://127.0.0.1:51234/api/x?y=1&z=%2F');
    expect(localServer.directUrl('http://LOCALHOST:51234/', '/a')).toBe('http://127.0.0.1:51234/a');
    for (const base of [
      'https://office.tail1234.ts.net:47800', // a multi-user host (client mode)
      'http://100.101.102.103:47800',
      'http://192.168.1.20:47800',
      'http://[::1]:51234', // the address an impostor would listen on
      'https://localhost:51234',
      'http://user:pw@localhost:51234',
      'not a url',
    ]) {
      expect(localServer.directUrl(base, '/api/x'), base).toBeNull();
    }
    // A route is a path on that server, never another address.
    expect(localServer.directUrl('http://localhost:51234', 'http://evil.example/x')).toBeNull();
    expect(localServer.directUrl('http://localhost:51234', '//evil.example/x')).toBeNull();
  });

  it('every main-process call to the app server goes through shellFetch (no bare fetch with the token)', () => {
    const tokenUses = main.split('\n').filter((l) => /x-bka-internal|internalToken/.test(l));
    // Generated once, handed to the servers in their environment, used by shellFetch and the check.
    for (const l of tokenUses) {
      // (`let`: made anew when a company is closed without the app restarting, renewLaunchSecrets.)
      expect(l, l).toMatch(/^let internalToken = crypto\.randomBytes\(32\)|^  internalToken = crypto\.randomBytes\(32\)|BKA_INTERNAL_TOKEN: internalToken|shellHeaders\(internalToken, launchPass\)|isOwnServer\(port, internalToken, |this launch's internal token/);
    }
    expect(main).not.toMatch(/fetch\(`\$\{(serverUrl|baseUrl|url)\}/);
    const shellFetch = fnBody('function shellFetch(baseUrl, route, init = {}) {');
    expect(shellFetch).toMatch(/localServer\.directUrl\(baseUrl, route\)/);
    expect(shellFetch).toMatch(/return Promise\.reject/);
  });

  it('the window resolves localhost to 127.0.0.1, set before the app is ready', () => {
    const rule = main.indexOf("app.commandLine.appendSwitch('host-resolver-rules', 'MAP localhost 127.0.0.1');");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(main.indexOf('app.whenReady()'));
    // Only the name localhost: a multi-user host's address and the update feed are not mapped.
    expect(main.match(/host-resolver-rules/g)).toHaveLength(1);
  });
});

describe('1.1c: the per-launch pass', () => {
  it('is set on the window before the company server starts, and removed in client mode', () => {
    const create = fnBody('async function createWindow() {');
    const set = create.indexOf('launchPassOnWindow = await setLaunchPassCookie();');
    const clear = create.indexOf('if (remote) await clearLaunchPassCookie();');
    const start = create.indexOf('await startNextServer()');
    expect(set).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(-1);
    expect(set).toBeLessThan(start);
    expect(start).toBeLessThan(create.indexOf('await mainWindow.loadURL('));
    const cookie = fnBody('async function setLaunchPassCookie() {');
    expect(cookie).toMatch(/httpOnly: true/);
    expect(cookie).toMatch(/sameSite: 'strict'/);
    expect(cookie).toMatch(/name: localServer\.LAUNCH_PASS_COOKIE/);
    expect(cookie).toMatch(/url: 'http:\/\/localhost\/'/);
  });

  it('every server the shell starts gets it by environment, never on the command line', () => {
    const company = fnBody('async function startNextServer() {');
    expect(company).toMatch(/BKA_LAUNCH_PASS: launchPassOnWindow \? launchPass : ''/);
    const scratch = fnBody('async function startScratchServer(dataDir) {');
    expect(scratch).toMatch(/BKA_LAUNCH_PASS: launchPass,/);
    expect(localServer.LAUNCH_PASS_ENV).toBe('BKA_LAUNCH_PASS');
    for (const body of [company, scratch]) expect(body).not.toMatch(/\[serverEntry, |launchPass\]/);
  });

  it("the shell's calls carry it with the internal token", () => {
    expect(localServer.shellHeaders('tok', 'pass')).toEqual({ 'x-bka-internal': 'tok', 'x-bka-launch': 'pass' });
  });
});

describe('1.1d: the start-up check', () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
    delete process.env.BKA_INTERNAL_TOKEN;
  });
  const listen = (handler: http.RequestListener): Promise<number> => {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  };
  const TOKEN = 'ab'.repeat(32);

  it('accepts the server that holds the token (the real route computes the same proof)', async () => {
    process.env.BKA_INTERNAL_TOKEN = TOKEN;
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await listen((req, res) => {
      seen.push(req.headers);
      const nonce = new URL(req.url ?? '/', 'http://x').searchParams.get('nonce');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ proof: serverCheckProof(nonce) }));
    });
    expect(await localServer.isOwnServer(port, TOKEN)).toBe(true);
    // Nothing secret goes to a listener that has not proved itself yet.
    expect(seen[0]['x-bka-internal']).toBeUndefined();
    expect(seen[0]['x-bka-launch']).toBeUndefined();
    expect(seen[0].cookie).toBeUndefined();
  });

  it('refuses an impostor: any answer, a replayed proof, an error page, a redirect, silence', async () => {
    const replay = localServer.handshakeProof(TOKEN, 'cd'.repeat(32));
    const impostors: http.RequestListener[] = [
      (_q, s) => s.end('hello'),
      (_q, s) => s.end(JSON.stringify({ proof: replay })),
      (_q, s) => s.end(JSON.stringify({ proof: localServer.handshakeProof('other-token', 'x') })),
      (_q, s) => s.end(JSON.stringify({})),
      (_q, s) => {
        s.writeHead(500);
        s.end();
      },
      (_q, s) => {
        s.writeHead(302, { location: 'http://127.0.0.1:1/api/handshake' });
        s.end();
      },
    ];
    for (const impostor of impostors) {
      const port = await listen(impostor);
      expect(await localServer.isOwnServer(port, TOKEN)).toBe(false);
    }
    const silent = await listen(() => {
      /* never answers */
    });
    expect(await localServer.isOwnServer(silent, TOKEN, { timeoutMs: 300 })).toBe(false);
  });

  it('main.js checks the company server and every scratch server before using them', () => {
    const verified = fnBody('async function startVerifiedServer(label, spawnOne, discard = (child) => stopChild(child)) {');
    expect(verified).toMatch(
      /await waitForServer\(port\);\s*(\/\/[^\n]*\n\s*)*if \(await localServer\.isOwnServer\(port, internalToken, \{ timeoutMs: 30_000 \}\)\) return \{ port, child \};/,
    );
    expect(verified).toMatch(/SERVER_START_ATTEMPTS/);
    expect(verified).toMatch(/if \(!\(await discard\(child\)\)\) throw/);
    expect(fnBody('async function startNextServer() {')).toMatch(/await startVerifiedServer\('server'/);
    expect(fnBody('async function startScratchServer(dataDir) {')).toMatch(/await startVerifiedServer\('scratch-server'/);
  });
});

describe('2.8: developer switches stay out of the installed app', () => {
  const pcEnv = {
    PATH: 'C:\\Windows',
    APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
    BKA_ALLOW_DEV_FALLBACK: '1',
    bka_auth_secret: 'fixed-secret', // Windows names are not case-sensitive
    BKA_TEST_FAST_KDF: '1',
    NODE_OPTIONS: '--require C:\\evil.js',
    NODE_DEBUG: 'http',
    NODE_PATH: 'C:\\evil',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    Node_Inspect: '1',
    NODE_EXTRA_CA_CERTS: 'C:\\corp\\ca.pem',
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://proxy.corp:8080',
    BKA_NETWORK_MODE: 'offline',
    BKA_DATA_DIR: 'D:\\Books',
  };

  it('the installed app drops them and keeps the rest', () => {
    const env = localServer.inheritedServerEnv(pcEnv, { packaged: true });
    expect(env).toEqual({
      PATH: 'C:\\Windows',
      APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
      NODE_EXTRA_CA_CERTS: 'C:\\corp\\ca.pem',
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://proxy.corp:8080',
      BKA_NETWORK_MODE: 'offline', // the documented administrator cap (PRIVACY.md)
      BKA_DATA_DIR: 'D:\\Books',
    });
    expect(pcEnv.NODE_OPTIONS).toBe('--require C:\\evil.js'); // the shell's own environment is untouched
  });

  it('a development run passes everything on', () => {
    expect(localServer.inheritedServerEnv(pcEnv, { packaged: false })).toEqual(pcEnv);
  });

  it('both server environments start from it, then add what the app sets itself', () => {
    for (const sig of ['async function startNextServer() {', 'async function startScratchServer(dataDir) {']) {
      const body = fnBody(sig);
      expect(body).toMatch(/\.\.\.localServer\.inheritedServerEnv\(process\.env, \{ packaged: !isDev \}\),\s*(\/\/[^\n]*\n\s*)*NODE_ENV: 'production',/);
      expect(body).not.toMatch(/\.\.\.process\.env,/);
    }
  });

  // The variables only the shell sets. A scratch server sets fewer of them than the company
  // server; one it does not set must arrive unset, not as a value planted in the PC's environment.
  // The agent ones (electron/agentShell.js, lib/agent/files.ts): where approved desktop requests
  // go and this launch's key for them, the shell's Documents, and where staged files are kept.
  const SHELL_ONLY = [
    'BKA_FILE_KNOWN_HERE', 'BKA_DEVICE_VAULT', 'BKA_PROXY_SECRET', 'BKA_LAUNCH_PASS', 'BKA_INTERNAL_TOKEN',
    'BKA_SANDBOX_DIR', 'BKA_SANDBOX_REAL_DIR', 'BKA_COMPANY_SEALED', 'BKA_COMPANY_FILE', 'BKA_COMPANY_STATE',
    'BKA_COMPANY_LOCK', 'BKA_COMPANY_LOCK_TOKEN', 'BKA_OFFLINE', 'BKA_SANDBOX', 'BKA_SANDBOX_ROOT',
    'BKA_REAL_COMPANY_FILE', 'BKA_MIGRATIONS_DIR', 'BKA_BACKUP_DIR', 'BKA_BACKUP_INTERVAL_HOURS',
    'BKA_AGENT_SHELL', 'BKA_AGENT_SHELL_KEY', 'BKA_AGENT_DOCUMENTS', 'BKA_AGENT_FILES_DIR',
  ];
  /** The names a server's env object in main.js sets itself (`NAME:` keys after the inherited part). */
  const setByShell = (sig: string) => {
    const body = fnBody(sig);
    const after = body.slice(body.indexOf('...localServer.inheritedServerEnv('));
    return new Set([...after.matchAll(/^\s*(BKA_[A-Z_]+):/gm)].map((m) => m[1]));
  };

  it('the installed app never inherits a variable only the shell sets', () => {
    const planted: Record<string, string> = { PATH: 'C:\\Windows', BKA_NETWORK_MODE: 'offline', BKA_DATA_DIR: 'D:\\Books', BKA_REPORT_EXPORT_DIR: 'D:\\Exports' };
    for (const k of SHELL_ONLY) planted[k] = 'planted';
    planted.bka_file_known_here = 'C:\\crafted'; // Windows names are not case-sensitive
    expect([...localServer.SHELL_ONLY].sort()).toEqual([...SHELL_ONLY].sort());
    const env = localServer.inheritedServerEnv(planted, { packaged: true });
    expect(env).toEqual({ PATH: 'C:\\Windows', BKA_NETWORK_MODE: 'offline', BKA_DATA_DIR: 'D:\\Books', BKA_REPORT_EXPORT_DIR: 'D:\\Exports' });
    expect(localServer.inheritedServerEnv(planted, { packaged: false })).toEqual(planted);
  });

  it('nothing is lost: the company server sets every one of them itself, and main.js never reads them as overrides', () => {
    const company = setByShell('async function startNextServer() {');
    for (const k of SHELL_ONLY) expect(company.has(k), `company server sets ${k}`).toBe(true);
    // The scratch server sets what it needs; the rest now arrive unset there.
    const scratch = setByShell('async function startScratchServer(dataDir) {');
    for (const k of ['BKA_DATA_DIR', 'BKA_COMPANY_FILE', 'BKA_DEVICE_VAULT', 'BKA_INTERNAL_TOKEN', 'BKA_LAUNCH_PASS', 'BKA_PROXY_SECRET', 'BKA_MIGRATIONS_DIR', 'BKA_OFFLINE']) {
      expect(scratch.has(k), `scratch server sets ${k}`).toBe(true);
    }
    expect(scratch.has('BKA_FILE_KNOWN_HERE')).toBe(false); // the gap this closes
    // No agent works in a scratch server: it says so for each agent name rather than inheriting one.
    for (const k of ['BKA_AGENT_SHELL', 'BKA_AGENT_SHELL_KEY', 'BKA_AGENT_DOCUMENTS', 'BKA_AGENT_FILES_DIR']) {
      expect(scratch.has(k), `scratch server sets ${k}`).toBe(true);
    }
    // The documented overrides main.js does read are not in the list (they would be dropped).
    const readByMain = new Set([...main.matchAll(/process\.env\.(BKA_[A-Z_]+)/g)].map((m) => m[1]));
    expect(readByMain.has('BKA_DATA_DIR')).toBe(true);
    expect(readByMain.has('BKA_REPORT_EXPORT_DIR')).toBe(true);
    for (const k of SHELL_ONLY) expect(readByMain.has(k), `main.js reads ${k} from its environment`).toBe(false);
  });
});

describe('4.1: the request filter', () => {
  const APP = 'http://localhost:51234';
  const allowed = (url: string, webContentsId: number | undefined, method = 'GET') =>
    security.sessionRequestAllowed({ url, webContentsId, method }, APP, false);

  it('pages: the app origin and internal schemes only', () => {
    expect(allowed(`${APP}/api/accounts`, 1)).toBe(true);
    expect(allowed('data:image/png;base64,AA', 1)).toBe(true);
    expect(allowed('blob:http://localhost:51234/x', 1)).toBe(true);
    expect(allowed('https://evil.example/collect', 1)).toBe(false);
    expect(allowed('https://api.github.com/gists', 1)).toBe(false);
    expect(allowed('http://localhost:3000/', 1)).toBe(false);
    expect(allowed('http://127.0.0.1:51234/api/accounts', 1)).toBe(false);
  });

  it('no window behind the request (a service worker): the same, plus reads from the update feed', () => {
    expect(allowed(`${APP}/api/accounts`, undefined)).toBe(true);
    expect(allowed('https://evil.example/collect', undefined)).toBe(false);
    expect(allowed('http://evil.example/collect', undefined)).toBe(false);
    for (const host of ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']) {
      expect(allowed(`https://${host}/RealDealCPA-VR/Ironbooks/releases/latest`, undefined), host).toBe(true);
      expect(allowed(`https://${host}/x`, undefined, 'POST'), `POST ${host}`).toBe(false);
      expect(allowed(`http://${host}/x`, undefined), `http ${host}`).toBe(false);
    }
    expect(allowed('https://gist.github.com/x', undefined)).toBe(false);
    expect(allowed('https://github.com.evil.example/x', undefined)).toBe(false);
  });

  it('the hot-reload socket only in development', () => {
    expect(security.sessionRequestAllowed({ url: 'ws://localhost:51234/_next/webpack-hmr', webContentsId: 1 }, APP, true)).toBe(true);
    expect(security.sessionRequestAllowed({ url: 'ws://localhost:51234/_next/webpack-hmr', webContentsId: 1 }, APP, false)).toBe(false);
  });

  it('client mode: the connected host is the app origin, this computer is not', () => {
    const HOST = 'https://office.tail1234.ts.net:47800';
    expect(security.sessionRequestAllowed({ url: `${HOST}/api/accounts`, webContentsId: 1 }, HOST, false)).toBe(true);
    expect(security.sessionRequestAllowed({ url: `${APP}/api/accounts`, webContentsId: 1 }, HOST, false)).toBe(false);
  });
});

describe('4.2: navigation away from the app', () => {
  const APP = 'http://localhost:51234';

  it('a navigation or redirect to another origin is blocked (and not opened anywhere)', () => {
    expect(security.navigationAllowed(`${APP}/login`, APP)).toBe(true);
    expect(security.navigationAllowed('about:blank', APP)).toBe(true);
    expect(security.navigationAllowed('https://fire.irs.gov/?data=secret', APP)).toBe(false);
    expect(security.navigationAllowed('http://localhost:3000/', APP)).toBe(false);
  });

  it('only a new window (a click on target=_blank, window.open) opens https in the browser', () => {
    expect(security.windowOpenAction(`${APP}/api/invoices/1/pdf`, APP)).toBe('allow');
    expect(security.windowOpenAction('https://fire.irs.gov', APP)).toBe('external');
    expect(security.windowOpenAction('http://example.com', APP)).toBe('deny');
    expect(security.windowOpenAction('file:///C:/Windows/system32/calc.exe', APP)).toBe('deny');
  });

  it('install() wires the guard to block only, and opens externally only from the window-open handler', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'security.js'), 'utf8');
    const guard = src.slice(src.indexOf('const guard = (event, url) => {'), src.indexOf("contents.on('will-navigate', guard);"));
    expect(guard).toMatch(/event\.preventDefault\(\);/);
    expect(guard).not.toMatch(/openExternally|openExternal/);
    // One call, in setWindowOpenHandler (the other match is its definition).
    expect(src.match(/openExternally\(url\);/g)).toHaveLength(1);
    expect(src).toMatch(/if \(action === 'external'\) openExternally\(url\);/);
  });

  it('install() still returns its helpers and filters service-worker requests', async () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    let filter: ((details: unknown, cb: (r: unknown) => void) => void) | null = null;
    const ses = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setSpellCheckerEnabled: vi.fn(),
      setSpellCheckerDictionaryDownloadURL: vi.fn(),
      webRequest: { onBeforeRequest: (f: typeof filter) => (filter = f) },
      on: (name: string, f: (...a: unknown[]) => void) => (handlers[name] = f),
    };
    // install() takes Electron's objects from require('electron'); stand them in.
    const electronPath = require.resolve('electron');
    const saved = require.cache[electronPath];
    const fake = { app: { on: vi.fn() }, session: { defaultSession: ses }, shell: { openExternal: vi.fn() }, dialog: { showMessageBox: vi.fn(() => Promise.resolve({})) }, BrowserWindow: { fromWebContents: () => null } };
    require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fake } as unknown as NodeJS.Module;
    const securityPath = require.resolve('../electron/security.js');
    delete require.cache[securityPath];
    try {
      const fresh = require('../electron/security.js');
      const log = vi.fn();
      const api = fresh.install({ getAppOrigin: () => APP, isDev: false, log });
      expect(api.requestAllowed(`${APP}/x`)).toBe(true);
      expect(api.isAppUrl('https://evil.example/')).toBe(false);
      const decide = (details: unknown) => new Promise((resolve) => filter!(details, resolve));
      expect(await decide({ url: 'https://evil.example/collect', webContentsId: undefined, method: 'POST' })).toEqual({ cancel: true });
      expect(await decide({ url: `${APP}/api/x`, webContentsId: undefined, method: 'GET' })).toEqual({});
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/blocked background request to https:\/\/evil\.example/));
      expect(typeof handlers['will-download']).toBe('function');
    } finally {
      if (saved) require.cache[electronPath] = saved;
      else delete require.cache[electronPath];
      delete require.cache[securityPath];
    }
  });
});

describe('4.3: file types on the path finally written', () => {
  it("downloads: the app's own files and whatever people attached come back out; nothing that runs", () => {
    for (const ok of [
      // the app's own downloads
      'Backup 2026-11-18.bka', 'Books.bkp', 'Client.ibac', 'Changes.ibcx', 'Invoice 1001.pdf', 'accounts.csv', 'memorized-reports.xlsx',
      'lists.iif', 'transaction-log.csv', 'ABC Company transaction log.bktlg', 'transaction-log.verification.json', 'statements.zip', '1099-nec-2026.xml',
      'Ironbooks recovery codes.txt', 'C:\\Users\\me\\Documents\\Invoice.pdf',
      // Doc Center attachments keep any extension (lib/services/attachments.ts)
      'Site plan.dwg', 'Board deck.pptx', 'receipt.JPG', 'scan.heic', 'contract.docx', 'walkthrough.mp4', 'clip.mov', 'Budget.numbers',
      'Report.pages', 'logo.psd', 'logo.ai', 'drivers.cab',
      // no extension at all
      'Invoice', '.bka',
    ]) {
      expect(saveTypes.downloadAllowed(ok), ok).toBe(true);
    }
    for (const bad of [
      'Invoice.exe', 'a.exe. ', 'Invoice.exe.', 'Invoice.exe . .', 'a.pdf.exe', 'Invoice.pdf.exe', 'setup.msi', 'run.bat', 'run.cmd', 'x.ps1',
      'x.js', 'x.vbs', 'x.hta', 'x.lnk', 'x.url', 'x.scr', 'x.reg', 'x.iso', 'x.settingcontent-ms', 'Budget.xlsm', 'macro.docm', 'x.dmg',
      'a.pdf:evil.exe', 'report.pdf:hidden', '', 'C:\\Users\\me\\Downloads\\Invoice.exe', 'SETUP.EXE',
    ]) {
      expect(saveTypes.downloadAllowed(bad), bad).toBe(false);
    }
  });

  it('downloads refuse exactly the runnable kinds listed for the deny-list', () => {
    for (const ext of saveTypes.RUNNABLE_TYPES) expect(saveTypes.downloadAllowed(`file.${ext}`), ext).toBe(false);
    for (const ext of ['exe', 'lnk', 'xlsm', 'ps1', 'iso', 'appref-ms', 'apk']) expect(saveTypes.RUNNABLE_TYPES.has(ext), ext).toBe(true);
    for (const ext of ['cab', 'pdf', 'zip', 'dwg', 'pptx']) expect(saveTypes.RUNNABLE_TYPES.has(ext), ext).toBe(false);
  });

  it('Save dialog with filters: as before, the filter extension is added to any other name', () => {
    const plan = saveTypes.planSave({ defaultName: 'Invoice.exe', filters: [{ name: 'PDF Document', extensions: ['pdf', 'exe'] }] });
    expect(plan.base).toBe('Invoice');
    expect(plan.filters).toEqual([{ name: 'PDF Document', extensions: ['pdf'] }]);
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice.pdf', plan)).toBe('C:\\Docs\\Invoice.pdf');
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice.exe', plan)).toBe('C:\\Docs\\Invoice.exe.pdf');
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice.exe.', plan)).toBe('C:\\Docs\\Invoice.exe.pdf');
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice.pdf. ', plan)).toBe('C:\\Docs\\Invoice.pdf');
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice.csv', plan)).toBe('C:\\Docs\\Invoice.csv.pdf');
    expect(saveTypes.finalSavePath('C:\\Docs\\a.pdf:evil.exe', plan)).toBeNull();
  });

  it('Save dialog with no filters: the list is still enforced (it used to be skipped)', () => {
    const plan = saveTypes.planSave({ defaultName: 'Invoice.exe.' });
    expect(plan.filters).toEqual([]);
    expect(plan.base).toBe('Invoice');
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice.exe.', plan)).toBeNull();
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice.exe', plan)).toBeNull();
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice', plan)).toBeNull();
    expect(saveTypes.finalSavePath('C:\\Docs\\Invoice.csv', plan)).toBe('C:\\Docs\\Invoice.csv');
    const csv = saveTypes.planSave({ defaultName: 'accounts.csv' });
    expect(csv.base).toBe('accounts.csv');
    expect(saveTypes.finalSavePath('C:\\Docs\\accounts.exe', csv)).toBe('C:\\Docs\\accounts.exe.csv');
    expect(saveTypes.finalSavePath('C:\\Docs\\accounts.txt', csv)).toBe('C:\\Docs\\accounts.txt');
  });

  it("the app's own saves keep working", () => {
    for (const [name, ext] of [
      ['Books.bkp', 'bkp'],
      ['Client (Accountant Copy).ibac', 'ibac'],
      ['Changes.ibcx', 'ibcx'],
      ['Ironbooks recovery key.txt', 'txt'],
    ]) {
      const plan = saveTypes.planSave({ defaultName: name, filters: [{ name: 'File', extensions: [ext] }] });
      expect(plan.base).toBe(name);
      expect(saveTypes.finalSavePath(`C:\\Docs\\${name}`, plan)).toBe(`C:\\Docs\\${name}`);
    }
  });

  it('main.js writes only the checked path and hides paths from a host in client mode', () => {
    const save = main.slice(main.indexOf("ipcMain.handle('file:saveBytes'"), main.indexOf("ipcMain.handle('portable:open'"));
    expect(save).toMatch(/const target = saveTypes\.finalSavePath\(res\.filePath, plan\);/);
    expect(save).toMatch(/fs\.writeFileSync\(target, /);
    expect(save).not.toMatch(/fs\.writeFileSync\(res\.filePath/);
    const open = main.slice(main.indexOf("ipcMain.handle('dialog:openFile'"), main.indexOf('function decodeTextFile'));
    expect(open).toMatch(/filePath: remoteHostOrigin \? path\.basename\(filePath\) : filePath/);
  });
});
