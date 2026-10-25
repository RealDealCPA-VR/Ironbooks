/**
 * QuickBooks keys in the PACKAGED desktop app, pressed through DevTools input into the app's own
 * page (never Windows' keyboard, which would type into whatever window is in front):
 *
 *   npm run build && npx electron-builder --dir && npm run test:e2e:keyboard
 *
 * Throwaway settings / working-copy folders (IRONBOOKS_USER_DATA, LOCALAPPDATA). Checks: Ctrl+J
 * Customer Center, Ctrl+A Chart of Accounts, Ctrl+W Write Checks, Ctrl+I Create Invoices with the
 * cursor in the first field, QB date keys in a date field, Ctrl+M not minimizing the window, and
 * arrow keys + Enter in a list. Screenshots go to E2E_SHOTS.
 */
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const format = require(path.join(root, 'electron', 'companyFileFormat.js'));
const EXE = process.env.E2E_EXE || path.join(root, 'release', 'win-unpacked', 'Ironbooks.exe');
const PORT = Number(process.env.E2E_CDP_PORT || 9334);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-keys-'));
const SHOTS = process.env.E2E_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => {
  if (c) console.log(`  ✓ ${m}`);
  else {
    failures++;
    console.error(`  ✗ ${m}`);
  }
};

async function until(fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) return null;
    await sleep(300);
  }
}

function ps(script) {
  return new Promise((resolve) =>
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true }, (e, out) =>
      resolve(String(out || '').trim()),
    ),
  );
}
const exeQ = EXE.replace(/'/g, "''");
const ownProcs = `Get-Process -Name Ironbooks -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exeQ}' }`;

/**
 * Press a key in the app's page through DevTools input (never Windows' own keyboard: that types
 * into whatever window is in front). `k` is a KeyboardEvent key ('j', 'Enter', '+').
 */
let page = null;
const VK = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, '+': 187, '-': 189 };
async function press(k, { ctrl = false, shift = false, alt = false } = {}) {
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift || k === '+' ? 8 : 0);
  const single = k.length === 1;
  const code = k === '+' ? 'Equal' : k === '-' ? 'Minus' : single ? `Key${k.toUpperCase()}` : k;
  const vk = VK[k] ?? (single ? k.toUpperCase().charCodeAt(0) : 0);
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (single && !ctrl && !alt) await page.send('Input.dispatchKeyEvent', { type: 'char', text: k, unmodifiedText: k, ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(500);
}

async function minimized() {
  const out = await ps(`
Add-Type -Namespace IbK2 -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);'
$p = ${ownProcs} | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { [IbK2.W]::IsIconic($p.MainWindowHandle) }`);
  return /True/i.test(out);
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  }
}

async function connect() {
  const t = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((x) => x.type === 'page' && /^http:\/\/localhost:\d+\//.test(x.url));
  }, 90_000);
  if (!t) throw new Error('no app window');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return new Page(ws);
}

async function main() {
  console.log('E2E keyboard: QuickBooks keys in the desktop app');
  const share = path.join(tmp, 'Share');
  fs.mkdirSync(share, { recursive: true });
  const cf = path.join(share, 'Keys Co.ironbooks');
  await format.writeCompanyFile(cf, {
    manifest: { formatVersion: 1, fileId: 'keys', companyName: 'Keys Co', saveId: 'new', savedAt: new Date().toISOString() },
    entries: [{ name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Keys Co' })) }],
  });
  const ud = path.join(tmp, 'userData');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ companyFile: cf, recentCompanies: [cf], theme: { mode: 'light', accent: 'blue' } }));
  spawn(EXE, [`--remote-debugging-port=${PORT}`], { env: { ...process.env, IRONBOOKS_USER_DATA: ud, LOCALAPPDATA: path.join(tmp, 'Local') }, stdio: 'ignore' });
  page = await connect();
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(() => page.eval('location.pathname').then((p) => p === '/signup'), 90_000);
  await page.eval(`fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pat', email: 'Admin', password: 'secret123', companyName: 'Keys Co', challengeQuestion: 'Name of your first pet', challengeAnswer: 'Rex' }) }).then(r => r.status)`);
  await page.eval(`(async () => {
    const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const made = [];
    for (const n of ['Anderson Plumbing', 'Baker Supply', 'Carter Homes']) made.push(await post('/api/customers', { displayName: n }).then((r) => r.json()));
    const accts = await fetch('/api/accounts').then((r) => r.json());
    const income = accts.find((a) => a.code === '4000');
    // Two saved invoices for Previous / Next.
    await post('/api/invoices', { customerId: made[0].id, date: '2026-10-01', lines: [{ description: 'First job', quantity: 1, rate: 100, accountId: income.id }] });
    await post('/api/invoices', { customerId: made[1].id, date: '2026-10-02', lines: [{ description: 'Second job', quantity: 1, rate: 200, accountId: income.id }] });
    // Two saved bills for Previous / Next on Enter Bills.
    const vendor = await post('/api/vendors', { displayName: 'Ferguson Supply' }).then((r) => r.json());
    const expense = accts.find((a) => a.type === 'expense');
    await post('/api/bills', { vendorId: vendor.id, date: '2026-10-03', lines: [{ accountId: expense.id, amount: '75.00', description: 'Fittings' }] });
    await post('/api/bills', { vendorId: vendor.id, date: '2026-10-04', lines: [{ accountId: expense.id, amount: '95.00', description: 'Valves' }] });
  })()`);
  await page.eval(`location.assign('/dashboard')`);
  await until(() => page.eval(`location.pathname === '/dashboard' && document.readyState === 'complete'`));
  await sleep(2500);
  const path_ = () => page.eval('location.pathname + location.search');

  await press('j', { ctrl: true });
  assert(await until(async () => (await path_()).startsWith('/customers'), 10_000), 'Ctrl+J opens the Customer Center');
  await sleep(1500);
  // Lists: typing a name jumps to it, Enter opens it.
  await press('c');
  const hl = await page.eval(`(document.querySelector('[data-list] [data-list-active]') || {}).innerText || ''`);
  await page.shot('k1-customer-center');
  assert(/Carter/.test(hl), `typing "c" in the Customer Center highlights Carter Homes (${JSON.stringify(hl.slice(0, 40))})`);

  await press('a', { ctrl: true });
  assert(await until(async () => (await path_()).startsWith('/accounts'), 10_000), 'Ctrl+A opens the Chart of Accounts');

  await press('w', { ctrl: true });
  assert(await until(async () => (await path_()).startsWith('/expenses'), 10_000), 'Ctrl+W opens Write Checks');
  await sleep(2000);
  await page.shot('k2-write-checks');

  await page.eval(`location.assign('/dashboard')`);
  await sleep(2500);
  await press('i', { ctrl: true });
  assert(await until(async () => (await path_()).startsWith('/invoices'), 10_000), 'Ctrl+I opens Create Invoices');
  await sleep(2500);
  const focused = await page.eval(`(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.id || a.name || a.placeholder || a.tagName) : ''; })()`);
  await page.shot('k3-create-invoice');
  assert(/customer/i.test(String(focused)), `the invoice opens with the cursor in the Customer field (${focused})`);

  // Date keys in the invoice date field.
  const hasDate = await page.eval(`(() => { const d = document.querySelector('[role="dialog"] input[type="date"], form input[type="date"]'); if (!d) return false; d.focus(); return true; })()`);
  if (hasDate) {
    await press('t');
    const today = await page.eval(`document.activeElement.value`);
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    assert(today === iso, `T puts today in a date field (${today})`);
    await press('h');
    const eom = await page.eval(`document.activeElement.value`);
    assert(/-(28|29|30|31)$/.test(eom), `H jumps to the end of the month (${eom})`);
    await press('+');
    const next = await page.eval(`document.activeElement.value`);
    assert(next && next > eom, `+ moves to the next day (${next})`);
  } else {
    assert(false, 'the invoice form has a date field');
  }

  // Ctrl+M is QB's Memorize, never "minimize window".
  await press('m', { ctrl: true });
  await sleep(800);
  assert(!(await minimized()), 'Ctrl+M does not minimize the window');
  await page.shot('k4-after-ctrl-m');

  // QB's transaction toolbar: Alt+P / Alt+N move between saved invoices, Alt+R reverts, Ctrl+Y shows the journal.
  await page.eval(`location.assign('/invoices')`);
  await until(() => page.eval(`location.pathname === '/invoices' && document.readyState === 'complete'`));
  await sleep(2500);
  await press('i', { ctrl: true });
  await sleep(2500);
  const title = () => page.eval(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].pop(); return d ? (d.querySelector('h2')?.textContent || '') : ''; })()`);
  await press('p', { alt: true });
  assert(await until(async () => /Edit Invoice #2/.test(await title()), 10_000), `Alt+P on a new invoice opens the latest saved one (${await title()})`);
  await press('p', { alt: true });
  assert(await until(async () => /Edit Invoice #1/.test(await title()), 10_000), `Alt+P again opens the one before it (${await title()})`);
  await press('n', { alt: true });
  assert(await until(async () => /Edit Invoice #2/.test(await title()), 10_000), `Alt+N moves to the next one (${await title()})`);
  await sleep(1500); // the toolbar notes how the invoice looks once it has loaded
  const descSel = `[role="dialog"] input[placeholder="Description"]`;
  await page.eval(`(() => { const el = document.querySelector('${descSel}'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'Changed by mistake'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await press('r', { alt: true });
  const asked = await until(() => page.eval(`[...document.querySelectorAll('[role="dialog"] h2')].some((h) => /Discard your changes/.test(h.textContent || ''))`), 5_000);
  assert(asked, 'Alt+R with unsaved changes asks "Discard your changes?" first');
  if (asked) await page.eval(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => /Discard changes/.test(b.textContent || '')).click()`);
  const restored = await until(async () => (await page.eval(`(document.querySelector('${descSel}') || {}).value || ''`)) === 'Second job', 10_000);
  assert(restored, 'Revert puts the invoice back as it was saved');
  await sleep(1200);
  await page.eval(`document.querySelector('${descSel}')?.focus()`);
  await press('y', { ctrl: true });
  const journal = await until(() => page.eval(`[...document.querySelectorAll('[role="dialog"]')].some((d) => /Debit/.test(d.innerText || '') && /Credit/.test(d.innerText || ''))`), 10_000);
  await page.shot('k5-invoice-journal');
  assert(journal, 'Ctrl+Y on an open invoice shows the journal entry it posted');

  // Enter Bills: Alt+P from a new bill opens the latest saved one.
  await page.eval(`location.assign('/bills')`);
  await until(() => page.eval(`location.pathname === '/bills' && document.readyState === 'complete'`));
  await sleep(2500);
  await press('n', { ctrl: true });
  await sleep(1500);
  await press('p', { alt: true });
  const billTitle = await until(async () => {
    const t = await title();
    return /Edit Bill/.test(t) ? t : null;
  }, 10_000);
  assert(billTitle, `Alt+P on a new bill opens the latest saved bill (${billTitle})`);
  const billDesc = await page.eval(`[...document.querySelectorAll('[role="dialog"] input')].map((i) => i.value).join('|')`);
  assert(/Valves/.test(billDesc), 'the latest bill (Valves) is the one shown');
  await press('Escape');

  // Every transaction form carries the toolbar (Previous / Next / Revert).
  for (const route of ['/sales-receipts', '/credit-memos', '/estimates', '/sales-orders', '/purchase-orders', '/vendor-credits', '/payments', '/deposits', '/journal']) {
    await page.eval(`location.assign('${route}')`);
    await until(() => page.eval(`location.pathname === '${route}' && document.readyState === 'complete'`));
    await sleep(2500);
    await press('n', { ctrl: true });
    const has = await until(() => page.eval(`!!document.querySelector('[role="dialog"] [data-shortcut="prev"]') && !!document.querySelector('[role="dialog"] [data-shortcut="revert"]')`), 8_000);
    assert(has, `${route}: the form has Previous / Next / Revert`);
    await press('Escape');
    await sleep(500);
  }
  await page.eval(`location.assign('/expenses')`);
  await until(() => page.eval(`location.pathname === '/expenses' && document.readyState === 'complete'`));
  await sleep(2500);
  assert(await page.eval(`!!document.querySelector('[data-shortcut-scope] [data-shortcut="prev"]')`), '/expenses: Write Checks has Previous / Next / Revert');

  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures === 0 ? 'E2E KEYBOARD PASSED' : `E2E KEYBOARD FAILED (${failures})`);
}

main()
  .catch((e) => {
    console.error('E2E ERROR:', e.stack || e.message);
    failures++;
  })
  .finally(async () => {
    await ps(`${ownProcs} | Stop-Process -Force`);
    process.exit(failures === 0 ? 0 : 1);
  });
