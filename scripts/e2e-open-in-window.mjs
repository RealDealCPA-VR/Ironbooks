/**
 * Desktop end-to-end test: company files open, close and change in the ONE app window, without
 * the app restarting, driving the PACKAGED app (Windows):
 *
 *   npm run build && npx electron-builder --dir && npm run test:e2e:window
 *
 * Runs in a throwaway settings folder (IRONBOOKS_USER_DATA) and working-copy folder (LOCALAPPDATA),
 * never the person's own Ironbooks data, and never types through Windows' keyboard. Steps:
 *  1. the app starts on No Company Open (its page has only the start-screen calls);
 *  2. choosing a company file opens it in that same window and the same app process: the window
 *     says "Opening Acme Plumbing…", then shows the file's first screen (Admin setup) with the
 *     company-page calls; the file is locked by this computer;
 *  3. File > Close Company saves and releases the file and shows No Company Open, in the same
 *     window and the same app process;
 *  4. opening it again asks for the password again (the sign-in from step 2 is worth nothing,
 *     though the app never restarted); signing in opens the books;
 *  5. switching to another company file from the open one: the first is saved and released, the
 *     other opens, same window, same app; switching back asks for the password again;
 *  6. back on No Company Open, the window is closed WHILE a file is opening: the app finishes
 *     opening it, then closes it properly (the app quits, the file is not left locked);
 *  7. a start that goes straight to the company file has its window up, saying "Opening…", while
 *     the file is prepared; closing the window saves and releases the file.
 * Screenshots go to E2E_SHOTS (default: a folder in the temp directory).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appCount, connect, makeAssert, ownProcs, powershell, sleep, stopApps, until } from './e2e-helpers.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const format = require(path.join(root, 'electron', 'companyFileFormat.js'));
const companyLock = require(path.join(root, 'electron', 'companyLock.js'));

const EXE = process.env.E2E_EXE || path.join(root, 'release', 'win-unpacked', 'Ironbooks.exe');
const PORT = Number(process.env.E2E_CDP_PORT || 9477);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-window-'));
const SHOTS = process.env.E2E_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const userData = path.join(tmp, 'userData');
const local = path.join(tmp, 'Local');
const share = path.join(tmp, 'Server', 'Accounting');
const companyFile = path.join(share, 'Acme Plumbing.ironbooks');
const otherFile = path.join(share, 'Birch Dental.ironbooks');
const { assert, state } = makeAssert();

const isStart = (u) => u.startsWith('data:text/html');
const isCompany = (u) => /^http:\/\/localhost:\d+\//.test(u);

function launch() {
  const env = { ...process.env, IRONBOOKS_USER_DATA: userData, LOCALAPPDATA: local, ELECTRON_ENABLE_LOGGING: '' };
  delete env.BKA_AUTH_SECRET;
  spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore', detached: false });
}

/** A new company file, as File > New Company writes it. */
async function newCompanyFile(file, companyName) {
  const fileId = randomBytes(8).toString('hex');
  await format.writeCompanyFile(file, {
    manifest: { formatVersion: 1, fileId, companyName, saveId: 'new', previousSaveId: null, savedAt: new Date().toISOString() },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: companyName })) },
      { name: '.file-id', data: Buffer.from(fileId) },
    ],
  });
}

/** What identifies this run of the app and its window: they must not change when a file opens. */
async function identity() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const win = await powershell(`(${ownProcs(EXE)} | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 | ForEach-Object { "$($_.Id) $($_.MainWindowHandle)" })`);
  return { app: version.webSocketDebuggerUrl, pages: pages.map((p) => p.id), window: win.out };
}

function assertSame(before, after, what) {
  assert(after.app === before.app, `the app did not restart to ${what}`);
  assert(after.pages.length === 1 && after.pages[0] === before.pages[0], 'it is the same window, and the only one');
  assert(after.window && after.window === before.window, `the same window on the desktop (${before.window} -> ${after.window})`);
}

const heading = (page) => page.eval(`(document.querySelector('h1') || {}).textContent || ''`);
const origin = (page) => page.eval('location.origin');
const config = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
const locked = (file) => {
  const h = companyLock.readHolder(file);
  return Boolean(h && !h.stale && h.owner.computer === os.hostname());
};
const atSignIn = (page) => until(() => page.eval(`location.pathname === '/login' && !!document.getElementById('login-password')`), 120_000);

/** Back (Alt+Left) on a company's first screen has nowhere to go but that company's own pages. */
async function assertNoWayBack(page) {
  // (The company's own pages may add entries of their own: "/" goes on to the sign-in screen.)
  const here = await origin(page);
  const noBack = await until(() => page.send('Page.getNavigationHistory').then((h) => h.entries.length > 0 && h.entries.every((e) => e.url.startsWith(`${here}/`))), 15_000, 200);
  assert(noBack, 'Back cannot return to a screen the window showed before this company');
}

/** On No Company Open: choose the listed company file (the first), and follow the same window through. */
async function openFromStartScreen(page, shot) {
  await until(() => page.eval(`document.querySelectorAll('#list li').length`).then((n) => n > 0), 30_000);
  const before = await identity();
  await page.eval(`document.getElementById('open').click()`);
  // The same page connection: the window is not replaced, it only shows something else.
  const opening = await until(() => heading(page).then((t) => /^Opening Acme Plumbing/.test(t)), 15_000, 50);
  assert(opening, 'the window says it is opening the company file');
  if (opening) await page.shot(SHOTS, shot);
  const arrived = await until(() => page.eval('location.href').then(isCompany), 120_000, 200);
  assert(arrived, "the company's first screen loads in that window");
  assertSame(before, await identity(), 'open it');
  await assertNoWayBack(page);
}

/** File > Close Company from the open company: No Company Open, same window, same app. */
async function closeCompanyInWindow(page, file, shot) {
  const before = await identity();
  await page.eval(`window.bookkeeper.company.close()`);
  let sawClosing = false;
  const back = await until(async () => {
    const t = await heading(page);
    if (/^Closing /.test(t) && !sawClosing) {
      sawClosing = true;
      if (shot) await page.shot(SHOTS, shot).catch(() => {});
    }
    return t === 'No company open';
  }, 120_000, 40);
  assert(back, 'Close Company shows No Company Open');
  console.log(`    (the "Closing…" screen was ${sawClosing ? 'seen' : 'too quick to see'})`);
  assert(companyLock.readHolder(file) === null, 'the file is saved and released');
  assertSame(before, await identity(), 'close it');
  assert(config().companyClosed === true, 'the closed state is remembered');
  assert((await page.eval(`typeof window.startScreen + ' ' + typeof window.bookkeeper`)) === 'object undefined', 'No Company Open has the start-screen calls only');
  const history = await page.send('Page.getNavigationHistory');
  assert(history.entries.length === 1 && isStart(history.entries[0].url), "Back cannot return to the closed company's pages");
}

async function signIn(page) {
  await page.eval(`(() => {
    const el = document.getElementById('login-password');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, 'secret123');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form button[type="submit"]').click();
  })()`);
  return until(() => page.eval('location.pathname').then((p) => p !== '/login'), 30_000);
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`Packaged app not found: ${EXE} (run npx electron-builder --dir)`);
  if ((await appCount(EXE)) > 0) throw new Error('The test build of Ironbooks is already running; close it first.');
  console.log(`E2E open-in-window: ${companyFile}`);

  // Two new company files; the app last showed No Company Open.
  fs.mkdirSync(share, { recursive: true });
  await newCompanyFile(companyFile, 'Acme Plumbing');
  await newCompanyFile(otherFile, 'Birch Dental');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ companyFile, companyClosed: true, recentCompanies: [companyFile, otherFile], theme: { mode: 'light', accent: 'blue' } }),
  );

  // 1. No Company Open.
  launch();
  const page = await connect(PORT, isStart);
  await until(() => heading(page).then((t) => t === 'No company open'), 30_000);
  await page.shot(SHOTS, '01-no-company-open');
  assert((await page.eval(`typeof window.startScreen + ' ' + typeof window.bookkeeper`)) === 'object undefined', 'No Company Open has the start-screen calls only');

  // 2. Open it: same window, same app.
  console.log(' 2. open from No Company Open');
  await openFromStartScreen(page, '02-opening');
  const atSignup = await until(() => page.eval('location.pathname').then((p) => p === '/signup'), 90_000);
  assert(atSignup, 'a new company file opens on the Admin setup screen');
  await sleep(1500);
  await page.shot(SHOTS, '03-admin-setup');
  assert((await page.eval(`typeof window.bookkeeper + ' ' + typeof window.startScreen`)) === 'object undefined', "the company's pages have the company calls only");
  assert((await page.eval(`window.bookkeeper.chrome.frameless`)) === true, 'the page draws the title bar of the frameless window');
  assert(locked(companyFile), 'the company file is locked by this computer');
  const signup = await page.eval(`fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pat Owner', email: 'Admin', password: 'secret123', companyName: 'Acme Plumbing',
      challengeQuestion: 'Name of your first pet', challengeAnswer: 'Rex' }) }).then(r => r.status)`);
  assert(signup === 201, 'the Admin is set up (and signed in)');
  await page.eval(`window.bookkeeper.company.signedIn('Admin')`);
  assert(await until(async () => format.readCompanyManifest(companyFile)?.saveId !== 'new', 60_000), 'autosave wrote the company file');
  assert((await page.eval(`fetch('/api/accounts').then((r) => r.status)`)) === 200, 'the signed-in Admin reads the books');

  // 3. File > Close Company: saved, released, No Company Open — same window, same app.
  console.log(' 3. Close Company');
  await closeCompanyInWindow(page, companyFile, '04-closing');
  await page.shot(SHOTS, '05-no-company-open-again');

  // 4. Open it again: the password is asked for again, then the books.
  console.log(' 4. open it again');
  await openFromStartScreen(page, '06-opening-again');
  assert(await atSignIn(page), 'the file asks for the password again, though the app never restarted');
  assert((await page.eval(`fetch('/api/accounts').then((r) => r.status)`)) !== 200, 'the earlier sign-in opens nothing in the reopened file');
  await until(() => page.eval(`document.getElementById('login-user').value === 'Admin'`), 15_000);
  await sleep(800);
  await page.shot(SHOTS, '07-sign-in');
  assert(config().companyClosed === false, 'the file is the one to open next time');
  assert(await signIn(page), 'signing in opens the company');
  await sleep(4000);
  await page.shot(SHOTS, '08-signed-in');

  // 5. Switch to another company file, and back.
  console.log(' 5. switch company files');
  let before = await identity();
  const firstOrigin = await origin(page);
  await page.eval(`window.bookkeeper.company.switch(${JSON.stringify(otherFile)})`);
  const openingOther = await until(() => heading(page).then((t) => /^Opening Birch Dental/.test(t)), 120_000, 40);
  assert(openingOther, 'the window says it is opening the other company file');
  if (openingOther) await page.shot(SHOTS, '09-opening-other');
  assert(await until(() => page.eval(`location.pathname === '/signup' && location.origin !== ${JSON.stringify(firstOrigin)}`), 120_000, 200), "the other company's first screen loads in that window");
  assertSame(before, await identity(), 'switch company files');
  assert(companyLock.readHolder(companyFile) === null, 'the first company file was saved and released');
  assert(locked(otherFile), 'the other company file is locked by this computer');
  await assertNoWayBack(page);
  assert((await page.eval(`fetch('/api/accounts').then((r) => r.status)`)) !== 200, 'the sign-in to the first file opens nothing in the other');
  await sleep(1000);
  await page.shot(SHOTS, '10-other-company');
  before = await identity();
  await page.eval(`window.bookkeeper.company.switch(${JSON.stringify(companyFile)})`);
  await until(() => heading(page).then((t) => /^Opening Acme Plumbing/.test(t)), 120_000, 40);
  assert(await atSignIn(page), 'switching back asks for the password again');
  assertSame(before, await identity(), 'switch back');
  assert(companyLock.readHolder(otherFile) === null && locked(companyFile), 'the locks changed hands with the files');
  assert(await signIn(page), 'signing in opens the first company again');
  assert(await until(() => page.eval(`fetch('/api/accounts').then((r) => r.status === 200)`), 30_000), 'and its books are there');

  // 6. Closed while it is opening: opened, then closed properly.
  console.log(' 6. window closed while a file opens');
  await closeCompanyInWindow(page, companyFile, null);
  await until(() => page.eval(`document.querySelectorAll('#list li').length`).then((n) => n > 0), 30_000);
  await page.eval(`document.getElementById('open').click()`);
  await until(() => heading(page).then((t) => /^Opening /.test(t)), 15_000, 50);
  await page.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
  page.close();
  assert(await until(async () => (await appCount(EXE)) === 0, 120_000), 'closing the window while the file opens still quits the app');
  assert(companyLock.readHolder(companyFile) === null, 'and the file is not left locked');

  // 7. A start that goes straight to the company file: the window is up while it opens.
  console.log(' 7. start straight into the company file');
  launch();
  const page2 = await connect(PORT, () => true);
  const sawOpening = await until(() => heading(page2).then((t) => /^Opening Acme Plumbing/.test(t)), 15_000, 50);
  assert(sawOpening, 'at start-up the window is there at once, saying it is opening the company file');
  if (sawOpening) await page2.shot(SHOTS, '11-start-up-opening');
  assert(await atSignIn(page2), 'then the sign-in screen, in that window');
  assert((await identity()).pages.length === 1, 'still one window');
  await page2.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
  page2.close();
  assert(await until(async () => (await appCount(EXE)) === 0, 90_000), 'closing the window quits the app');
  assert(companyLock.readHolder(companyFile) === null, 'the lock is released when the app quits');

  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(state.failures === 0 ? 'E2E OPEN-IN-WINDOW PASSED' : `E2E OPEN-IN-WINDOW FAILED (${state.failures} assertion(s))`);
}

main()
  .catch((e) => {
    console.error('E2E ERROR:', e.stack || e.message);
    state.failures++;
  })
  .finally(async () => {
    if ((await appCount(EXE)) > 0) {
      await stopApps(EXE);
      await sleep(1500);
    }
    if (!process.env.E2E_KEEP) {
      try {
        fs.rmSync(local, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    process.exit(state.failures === 0 ? 0 : 1);
  });
