/**
 * Two workstations, one company file on a shared folder — the PACKAGED app, run twice with
 * separate settings and working-copy folders, exactly as two computers would use it:
 *
 *   npm run build && npx electron-builder --dir && npm run test:e2e:multiuser
 *
 *  1. Workstation A opens "Acme Plumbing.ironbooks" from the shared folder, sets up its Admin and
 *     a second user (Bob), and enters an invoice.
 *  2. Workstation B opens the same file: it is told A has it open and chooses Ask to Come In.
 *  3. A sees the request and chooses Let Them In: A serves the file over the office network
 *     (HTTPS with its own certificate, pinned by B through the lock folder).
 *  4. B reconnects as a multi-user client, signs in as Bob, sees A's invoice and adds one of its
 *     own; A sees Bob's invoice too (one set of books, one writer).
 *  5. A closes the file: everything is saved into the company file and the lock is released.
 *
 * Windows may ask (once) whether to allow the test build of Ironbooks through the firewall when
 * A starts serving the office network; the test does not need that (both run on this computer).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appCount, clickNativeButton, connect, dumpWindows, makeAssert, onFileServer, sleep, stopApps, until } from './e2e-helpers.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const format = require(path.join(root, 'electron', 'companyFileFormat.js'));
const companyLock = require(path.join(root, 'electron', 'companyLock.js'));
const { PGlite } = require('@electric-sql/pglite');

const EXE = process.env.E2E_EXE || path.join(root, 'release', 'win-unpacked', 'Ironbooks.exe');
const PORT_A = 9341;
const PORT_B = 9342;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-mu-'));
const SHOTS = process.env.E2E_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const share = onFileServer(path.join(tmp, 'FileServer', 'Accounting'));
const companyFile = path.join(share, 'Acme Plumbing.ironbooks');
const { assert, state } = makeAssert();

function workstation(name, port) {
  const userData = path.join(tmp, name, 'settings');
  const local = path.join(tmp, name, 'Local');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ companyFile, recentCompanies: [companyFile], theme: { mode: 'light', accent: 'blue' } }));
  return {
    name,
    port,
    launch() {
      spawn(EXE, [`--remote-debugging-port=${port}`], {
        env: { ...process.env, IRONBOOKS_USER_DATA: userData, LOCALAPPDATA: local },
        stdio: 'ignore',
      });
    },
  };
}

async function invoicesInFile() {
  const out = path.join(tmp, `check-${randomBytes(3).toString('hex')}`);
  await format.extractCompanyFile(companyFile, out);
  const pg = new PGlite(out);
  try {
    return (await pg.query("select total::text as total from invoices order by total")).rows.map((r) => r.total);
  } finally {
    await pg.close();
  }
}

const postJson = (page, url, body) =>
  page.eval(`fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`Packaged app not found: ${EXE}`);
  if ((await appCount(EXE)) > 0) throw new Error('The test build of Ironbooks is already running; close it first.');
  console.log(`E2E multi-user: two workstations, one company file on ${share}`);

  fs.mkdirSync(share, { recursive: true });
  const fileId = randomBytes(8).toString('hex');
  await format.writeCompanyFile(companyFile, {
    manifest: { formatVersion: 1, fileId, companyName: 'Acme Plumbing', saveId: 'new', savedAt: new Date().toISOString() },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Acme Plumbing' })) },
      { name: '.file-id', data: Buffer.from(fileId) },
    ],
  });
  const A = workstation('A', PORT_A);
  const B = workstation('B', PORT_B);

  // 1. Workstation A.
  A.launch();
  let pageA = await connect(PORT_A, (u) => /^http:\/\/localhost:\d+\//.test(u));
  await until(() => pageA.eval('location.pathname').then((p) => p === '/signup'), 90_000);
  const su = await postJson(pageA, '/api/auth/signup', {
    name: 'Mary Owner', email: 'Admin', password: 'secret123', companyName: 'Acme Plumbing',
    challengeQuestion: 'Name of your first pet', challengeAnswer: 'Rex',
  });
  assert(su.status === 201, 'A: the Admin is set up');
  await pageA.eval(`window.bookkeeper.company.signedIn('Admin')`);
  const bob = await postJson(pageA, '/api/users', { name: 'Bob Clerk', login: 'bob', password: 'bobpass123', roleKeys: ['bookkeeper'] });
  assert(bob.status === 201 || bob.status === 200, `A: user Bob is added (HTTP ${bob.status})`);
  const invA = await pageA.eval(`(async () => {
    const j = (r) => r.json();
    const accts = await fetch('/api/accounts').then(j);
    const income = accts.find((a) => a.code === '4000');
    const c = await fetch('/api/customers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Oak Street Apartments' }) }).then(j);
    const inv = await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: c.id, date: '2026-10-20', lines: [{ description: 'Water heater', quantity: 1, rate: 1850, accountId: income.id }] }) }).then(j);
    return inv.total;
  })()`);
  assert(invA === '1850.00', 'A: an invoice is entered');
  await pageA.eval(`location.assign('/dashboard')`);
  await sleep(2500);

  // 2. Workstation B opens the same file.
  B.launch();
  const asked = await clickNativeButton(EXE, 'Ask to Come In', 90);
  assert(asked, 'B: told A has the file open, and asks to come in');

  // 3. A lets B in.
  const letIn = await clickNativeButton(EXE, 'Let Them In', 60);
  assert(letIn, 'A: the request appears on screen, and A lets B in');
  const holder = await until(() => {
    const h = companyLock.readHolder(companyFile);
    return h && h.owner && h.owner.mode === 'multi' ? h : null;
  }, 30_000);
  assert(holder && Array.isArray(holder.owner.host?.urls) && /^[0-9a-f]{64}$/.test(holder.owner.host?.fingerprint || ''),
    `the lock now says multi-user, with A's office-network address and certificate (${holder?.owner?.host?.urls?.join(', ')})`);

  // 4. B is a client of A now (relaunched): sign in as Bob.
  const pageB = await connect(PORT_B, (u) => /^https:\/\/[\d.]+:\d+\//.test(u), 120_000);
  const atLogin = await until(() => pageB.eval(`!!document.getElementById('login-password')`), 60_000);
  assert(atLogin, "B: opens A's company file over the office network, at the sign-in screen");
  if (!atLogin) {
    const why = await Promise.race([
      pageB.eval(`location.href + ' | ' + document.title + ' | ' + (document.body ? document.body.innerText.slice(0, 400) : '')`).catch((e) => String(e)),
      sleep(8000).then(() => '(page not answering)'),
    ]);
    console.error('    B shows:', why);
    const tabs = await (await fetch(`http://127.0.0.1:${PORT_B}/json/list`)).json().catch(() => []);
    console.error('    B pages:', JSON.stringify(tabs.map((t) => [t.type, t.url, t.title])));
    console.error((await dumpWindows(EXE)).split(String.fromCharCode(10)).slice(0, 40).map((l) => '    ' + l.trim()).join(String.fromCharCode(10)));
    throw new Error('B did not reach the sign-in screen');
  }
  await sleep(800);
  await pageB.shot(SHOTS, 'mu-1-B-sign-in');
  const loginB = await postJson(pageB, '/api/auth/login', { email: 'bob', password: 'bobpass123' });
  assert(loginB.status === 200, 'B: Bob signs in with his own user name and password');
  const seen = await pageB.eval(`fetch('/api/invoices').then(r => r.json()).then(d => (Array.isArray(d) ? d : d.items || d.data || []).map(i => i.total))`);
  assert(Array.isArray(seen) && seen.includes('1850.00'), "B: Bob sees the invoice entered on A");
  const invB = await pageB.eval(`(async () => {
    const j = (r) => r.json();
    const accts = await fetch('/api/accounts').then(j);
    const income = accts.find((a) => a.code === '4000');
    const cs = await fetch('/api/customers').then(j);
    const list = Array.isArray(cs) ? cs : cs.items || cs.data || [];
    const inv = await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: list[0].id, date: '2026-10-21', lines: [{ description: 'Faucet repair', quantity: 1, rate: 240, accountId: income.id }] }) }).then(j);
    return inv.total;
  })()`);
  assert(invB === '240.00', 'B: Bob enters an invoice of his own');
  await pageB.eval(`location.assign('/invoices')`);
  await sleep(3000);
  await pageB.shot(SHOTS, 'mu-2-B-invoices');
  const onA = await pageA.eval(`fetch('/api/invoices').then(r => r.json()).then(d => (Array.isArray(d) ? d : d.items || d.data || []).map(i => i.total))`);
  assert(Array.isArray(onA) && onA.includes('240.00'), "A: Bob's invoice is in the same books");
  const sessions = await pageA.eval(`fetch('/api/sessions').then(r => r.ok ? r.json() : null)`);
  const names = JSON.stringify(sessions || '');
  assert(/Bob/.test(names), 'A: Multi-user status lists Bob as signed in');
  pageB.close();

  // 5. A closes the company file: saved, lock released.
  await pageA.eval('window.close()').catch(() => {});
  pageA.close();
  const released = await until(() => companyLock.readHolder(companyFile) === null, 120_000);
  assert(released, 'A closes the file: it is saved and the lock is released');
  const totals = await invoicesInFile();
  assert(totals.includes('1850.00') && totals.includes('240.00'), 'both invoices are in the company file on the shared folder');

  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(state.failures === 0 ? 'E2E MULTI-USER PASSED' : `E2E MULTI-USER FAILED (${state.failures})`);
}

main()
  .catch((e) => {
    console.error('E2E ERROR:', e.stack || e.message);
    state.failures++;
  })
  .finally(async () => {
    await stopApps(EXE);
    process.exit(state.failures === 0 ? 0 : 1);
  });
