/**
 * End-to-end smoke test against the built standalone server.
 * Spawns the production server on a throwaway local DB, checks first-run page redirects, runs a
 * full business workflow through the HTTP API (auth → master data → invoice → payment → reports),
 * asserts invariants, and tears down.
 *
 * Usage: npm run build && npm run test:e2e
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.E2E_PORT || '3999';
const BASE = `http://127.0.0.1:${PORT}`;
const root = process.cwd();
const dataDir = mkdtempSync(path.join(tmpdir(), 'bka-e2e-'));

let failures = 0;
const cookies = {};
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  for (const [k, v] of res.headers) {
    if (k.toLowerCase() === 'set-cookie') {
      const m = /^([^=]+)=([^;]+)/.exec(v);
      if (m) cookies[m[1]] = m[2];
    }
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const server = spawn(process.execPath, [path.join(root, '.next', 'standalone', 'server.js')], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    HOSTNAME: '127.0.0.1',
    BKA_DATA_DIR: dataDir,
    BKA_MIGRATIONS_DIR: path.join(root, 'drizzle'),
    BKA_AUTH_SECRET: 'e2e-secret',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/me`);
      if (r.ok || r.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  if (!(await waitUp())) throw new Error('server did not start');
  console.log('E2E: full accounting workflow');

  // First-run page boot with no cookies: the unlock gate must fire before the login gate, and
  // /unlock must render without a session (regression guard for the /unlock ↔ /login redirect loop).
  const home = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert(home.status >= 300 && home.status < 400 && (home.headers.get('location') || '').includes('/unlock'), 'GET / redirects to /unlock');
  const unlock = await fetch(`${BASE}/unlock`, { redirect: 'manual' });
  assert(unlock.status === 200, 'GET /unlock renders without a session');
  const login = await fetch(`${BASE}/login`, { redirect: 'manual' });
  assert(login.status >= 300 && login.status < 400 && (login.headers.get('location') || '').includes('/unlock'), 'GET /login redirects to /unlock (unlock gate precedes login gate)');

  const signup = await call('POST', '/api/auth/signup', {
    name: 'E2E', email: 'e2e@test.local', password: 'secret123', companyName: 'E2E Co',
  });
  assert(signup.status === 201 && signup.data.companyId, 'signup creates user + company + session');

  const accounts = (await call('GET', '/api/accounts')).data;
  assert(Array.isArray(accounts) && accounts.length >= 20, `seeded chart of accounts (${accounts.length})`);
  const income = accounts.find((a) => a.code === '4000');

  const agencies = await call('GET', '/api/tax-agencies');
  assert(agencies.status >= 200 && agencies.status < 300 && Array.isArray(agencies.data), 'tax agencies list returns');

  const customer = (await call('POST', '/api/customers', { displayName: 'E2E Customer' })).data;
  assert(customer.id, 'create customer');

  const invoice = (await call('POST', '/api/invoices', {
    customerId: customer.id, date: '2026-03-01',
    lines: [{ description: 'Work', quantity: 4, rate: 250, accountId: income.id }],
  })).data;
  assert(invoice.total === '1000.00', `invoice total computed ($${invoice.total})`);

  const payment = await call('POST', '/api/payments', {
    customerId: customer.id, date: '2026-03-05', method: 'check', amount: '1000.00',
    applications: [{ invoiceId: invoice.id, amountApplied: '1000.00' }],
  });
  assert(payment.status >= 200 && payment.status < 300, `receive payment (HTTP ${payment.status})`);

  const inv2 = (await call('GET', `/api/invoices/${invoice.id}`)).data;
  assert(inv2.status === 'paid' && inv2.balanceDue === '0.00', 'invoice marked paid, balance cleared');

  const gl = await call('GET', '/api/reports/general-ledger');
  assert(gl.status >= 200 && gl.status < 300 && gl.data != null, 'general ledger report returns');

  const errs = await call('POST', '/api/errors', {});
  assert(errs.status === 200 || errs.status === 201, 'AI error scan runs');

  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures} assertion(s))`);
}

main()
  .catch((e) => { console.error('E2E ERROR:', e.message); failures++; })
  .finally(() => {
    try { server.kill(); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    process.exit(failures === 0 ? 0 : 1);
  });
