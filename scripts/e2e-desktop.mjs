/**
 * Desktop end-to-end test of the single company file, driving the PACKAGED app (Windows):
 *
 *   npm run build && npx electron-builder --dir && npm run test:e2e:desktop
 *
 * Runs in a throwaway settings folder (IRONBOOKS_USER_DATA) and working-copy folder (LOCALAPPDATA),
 * never the person's own Ironbooks data. Steps:
 *  1. a new company file on a "file server" folder opens: lock next to it, Admin setup screen;
 *  2. the Admin is set up, a customer and an invoice are entered; autosave writes the file;
 *  3. "another workstation" asks to come in: the request dialog appears on screen and "Not Now"
 *     answers it (Windows UI Automation clicks the native dialog);
 *  4. it asks again and "Hand It Over" saves, closes and releases the file (No Company Open);
 *  5. reopening from the No Company Open list shows the sign-in screen with the company name,
 *     the file's location and the user name filled in; signing in shows the invoice;
 *  6. closing the window saves and releases the file; the invoice is in the company file.
 * Screenshots go to E2E_SHOTS (default: a folder in the temp directory).
 */
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { clickNativeButton as clickHelper, onFileServer } from './e2e-helpers.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const format = require(path.join(root, 'electron', 'companyFileFormat.js'));
const companyLock = require(path.join(root, 'electron', 'companyLock.js'));
const { PGlite } = require('@electric-sql/pglite');

const EXE = process.env.E2E_EXE || path.join(root, 'release', 'win-unpacked', 'Ironbooks.exe');
const PORT = Number(process.env.E2E_CDP_PORT || 9333);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-desktop-'));
const SHOTS = process.env.E2E_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const userData = path.join(tmp, 'userData');
const local = path.join(tmp, 'Local');
const share = onFileServer(path.join(tmp, 'Server', 'Accounting'));
const companyFile = path.join(share, 'Acme Plumbing.ironbooks');
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

async function until(fn, ms = 60_000, step = 500) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

// --- the app ---------------------------------------------------------------
let app = null;
function launch() {
  app = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    env: { ...process.env, IRONBOOKS_USER_DATA: userData, LOCALAPPDATA: local, ELECTRON_ENABLE_LOGGING: '' },
    stdio: 'ignore',
    detached: false,
  });
  return app;
}
/** This test's own app (by its executable path: an installed Ironbooks is never touched). */
function ownAppPs(action) {
  const exe = EXE.replace(/'/g, "''");
  return `Get-Process -Name Ironbooks -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' } | ${action}`;
}
function appRunning() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', ownAppPs('Measure-Object | Select-Object -ExpandProperty Count')], { windowsHide: true }, (_e, out) =>
      resolve(Number(String(out).trim()) > 0),
    );
  });
}
function stopApp() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', ownAppPs('Stop-Process -Force')], { windowsHide: true }, () => resolve());
  });
}

// --- Chrome DevTools protocol (the page) ------------------------------------
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 60_000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

/** Connect to the app's page whose URL matches `test` (the app window, not DevTools). */
async function connect(test) {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((t) => t.type === 'page' && test(t.url));
  }, 90_000);
  if (!target) throw new Error('no app window to connect to');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const page = new Page(ws);
  await page.send('Page.enable');
  return page;
}

// --- Windows UI Automation: click a button in one of the app's native dialogs (e2e-helpers) ---
function clickNativeButton(name, timeoutSec = 40) {
  return clickHelper(EXE, name, timeoutSec);
}

async function invoicesInFile() {
  const out = path.join(tmp, `check-${randomBytes(3).toString('hex')}`);
  await format.extractCompanyFile(companyFile, out);
  const pg = new PGlite(out);
  try {
    return (await pg.query("select total::text as total from invoices")).rows.map((r) => r.total);
  } finally {
    await pg.close();
  }
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`Packaged app not found: ${EXE} (run npx electron-builder --dir)`);
  if (await appRunning()) throw new Error('The test build of Ironbooks is already running; close it first.');
  console.log(`E2E desktop: single company file on ${share}`);

  // A new company file on the "file server", as File > New Company writes it.
  fs.mkdirSync(share, { recursive: true });
  const fileId = randomBytes(8).toString('hex');
  await format.writeCompanyFile(companyFile, {
    manifest: { formatVersion: 1, fileId, companyName: 'Acme Plumbing', saveId: 'new', previousSaveId: null, savedAt: new Date().toISOString() },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Acme Plumbing' })) },
      { name: '.file-id', data: Buffer.from(fileId) },
    ],
  });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ companyFile, recentCompanies: [companyFile], theme: { mode: 'light', accent: 'blue' } }),
  );

  // 1. Open.
  launch();
  let page = await connect((u) => /^http:\/\/localhost:\d+\//.test(u));
  const atSignup = await until(() => page.eval('location.pathname').then((p) => p === '/signup'), 90_000);
  assert(atSignup, 'a new company file opens on the Admin setup screen');
  await sleep(1500);
  await page.shot('01-admin-setup');
  const suggested = await page.eval(`document.getElementById('su-company').value`);
  assert(suggested === 'Acme Plumbing', `the setup screen suggests the company file's name, nothing else ("${suggested}")`);
  const holder = companyLock.readHolder(companyFile);
  assert(holder && !holder.stale && holder.owner.computer === os.hostname(), 'the company file is locked by this computer');

  // 2. Admin + work.
  const signup = await page.eval(`fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pat Owner', email: 'Admin', password: 'secret123', companyName: 'Acme Plumbing',
      challengeQuestion: 'Name of your first pet', challengeAnswer: 'Rex' }) }).then(r => r.status)`);
  assert(signup === 201, 'the Admin is set up');
  await page.eval(`window.bookkeeper && window.bookkeeper.company.signedIn('Admin')`);
  const made = await page.eval(`(async () => {
    const j = (r) => r.json();
    const accts = await fetch('/api/accounts').then(j);
    const income = accts.find((a) => a.code === '4000');
    const c = await fetch('/api/customers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Oak Street Apartments' }) }).then(j);
    const inv = await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: c.id, date: '2026-10-20', lines: [{ description: 'Water heater install', quantity: 1, rate: 1850, accountId: income.id }] }) }).then(j);
    return inv.total;
  })()`);
  assert(made === '1850.00', 'an invoice is entered');
  await page.eval(`location.assign('/dashboard')`);
  await sleep(4000);
  await page.shot('02-home');
  const saved = await until(async () => format.readCompanyManifest(companyFile)?.saveId !== 'new', 60_000);
  assert(saved, 'autosave wrote the company file');

  // 3. Another workstation asks; Not Now.
  const r1 = companyLock.requestAccess(companyFile, { appUser: 'Bob', computer: 'BACK-OFFICE', osUser: 'bob' });
  const clickedNo = await clickNativeButton('Not Now');
  assert(clickedNo, 'the request appears on screen and can be answered');
  const a1 = await until(() => companyLock.readResponse(companyFile, r1), 15_000);
  assert(a1?.decision === 'deny', 'Not Now tells the other workstation');

  // 4. Asks again; Hand It Over.
  const r2 = companyLock.requestAccess(companyFile, { appUser: 'Bob', computer: 'BACK-OFFICE', osUser: 'bob' });
  const clickedHand = await clickNativeButton('Hand It Over');
  assert(clickedHand, 'Hand It Over can be chosen');
  // The answer, or the lock already gone (the answer leaves with it once the file is saved and
  // released) — the requesting workstation treats both as "open it now" (askForAccessFlow).
  const a2 = await until(() => companyLock.readResponse(companyFile, r2) || (companyLock.readHolder(companyFile) === null && { decision: 'released' }), 15_000);
  assert(a2?.decision === 'handoff' || a2?.decision === 'released', `the other workstation is told the file is being handed over (${a2?.decision})`);
  page.close();
  const released = await until(() => companyLock.readHolder(companyFile) === null, 90_000);
  assert(released, 'the file is saved, closed and released');
  const totals = await invoicesInFile();
  assert(totals.includes('1850.00'), 'the invoice is in the company file on the file server');

  // 5. No Company Open, then reopen it.
  page = await connect((u) => u.startsWith('data:text/html'));
  await until(() => page.eval(`document.querySelectorAll('#list li').length`).then((n) => n > 0), 30_000);
  await page.shot('03-no-company-open');
  const listed = await page.eval(`document.querySelector('#list li .path').textContent`);
  assert(listed === companyFile, 'No Company Open lists the company file with its full location');
  await page.eval(`document.getElementById('open').click()`);
  page.close();
  page = await connect((u) => /^http:\/\/localhost:\d+\/login/.test(u));
  await until(() => page.eval(`!!document.getElementById('login-password') && document.getElementById('login-user').value === 'Admin'`), 60_000);
  await sleep(800);
  await page.shot('04-sign-in');
  const loginInfo = await page.eval(`document.querySelector('main').innerText`);
  assert(/Acme Plumbing/.test(loginInfo) && loginInfo.includes(companyFile), 'the sign-in screen names the company and the file location');
  const prefilled = await page.eval(`document.getElementById('login-user').value`);
  assert(prefilled === 'Admin', 'the user name is filled in');
  await page.eval(`(() => {
    const el = document.getElementById('login-password');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, 'secret123');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form button[type="submit"]').click();
  })()`);
  const signedIn = await until(() => page.eval('location.pathname').then((p) => p !== '/login'), 30_000);
  assert(signedIn, 'signing in opens the company');
  await sleep(3000);
  const where = await page.eval('location.pathname');
  if (where.startsWith('/security')) await page.eval(`location.assign('/invoices')`);
  else await page.eval(`location.assign('/invoices')`);
  await sleep(4000);
  await page.shot('05-invoices');
  const listedInvoice = await page.eval(`document.body.innerText.includes('Oak Street Apartments')`);
  assert(listedInvoice, 'the invoice is there after reopening');

  // 6. Close the window: saved and released.
  await page.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
  page.close();
  const gone = await until(async () => !(await appRunning()), 90_000);
  assert(gone, 'closing the window quits the app');
  assert(companyLock.readHolder(companyFile) === null, 'the lock is released when the app quits');
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures === 0 ? 'E2E DESKTOP PASSED' : `E2E DESKTOP FAILED (${failures} assertion(s))`);
}

main()
  .catch((e) => {
    console.error('E2E ERROR:', e.stack || e.message);
    failures++;
  })
  .finally(async () => {
    if (await appRunning()) {
      await stopApp();
      await sleep(1500);
    }
    if (!process.env.E2E_KEEP) {
      try {
        fs.rmSync(path.join(tmp, 'Local'), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    process.exit(failures === 0 ? 0 : 1);
  });
