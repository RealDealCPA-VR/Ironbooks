/**
 * End-to-end test of the single company file ("ABC Company.ironbooks") against the built
 * standalone server, the way the desktop shell drives it:
 *
 *  1. a new company file on a "shared drive" folder; this "workstation" locks it and opens it
 *     into a working copy (electron/companyLock.js, electron/companySession.js);
 *  2. the server runs on the working copy: the sign-in screen's file info, the Admin setup with a
 *     challenge question, a customer and an invoice;
 *  3. autosave writes the company file by itself; closing saves and closes the database;
 *  4. "another workstation" opens the same company file into its own working copy, starts its own
 *     server, the old session is refused (passwords are per open of the file), the Admin signs in
 *     and the invoice is there.
 *
 * Usage: npm run build && npm run test:e2e:file
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const format = require(path.join(root, 'electron', 'companyFileFormat.js'));
const companyLock = require(path.join(root, 'electron', 'companyLock.js'));
const companySession = require(path.join(root, 'electron', 'companySession.js'));

const sandbox = mkdtempSync(path.join(tmpdir(), 'ib-e2e-file-'));
const share = path.join(sandbox, 'Server Share', 'Accounting');
const companyFile = path.join(share, 'Acme Plumbing.ironbooks');
let failures = 0;
const servers = [];

function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A server on a working copy, like startNextServer in electron/main.js. */
function startServer({ port, prep, lock, token }) {
  const proc = spawn(process.execPath, [path.join(root, '.next', 'standalone', 'server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      BKA_DATA_DIR: prep.dataDir,
      BKA_COMPANY_FILE: companyFile,
      BKA_COMPANY_STATE: path.join(prep.workDir, companySession.STATE_FILE),
      BKA_COMPANY_LOCK: lock.dir,
      BKA_COMPANY_LOCK_TOKEN: lock.token,
      BKA_MIGRATIONS_DIR: path.join(root, 'drizzle'),
      BKA_INTERNAL_TOKEN: token,
      BKA_OFFLINE: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  const cookies = {};
  async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const [k, v] of res.headers) {
      if (k.toLowerCase() === 'set-cookie') {
        const m = /^([^=]+)=([^;]*)/.exec(v);
        if (m) cookies[m[1]] = m[2];
      }
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }
  async function up() {
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`${base}/api/company-file/info`);
        if (r.ok) return true;
      } catch {
        /* starting */
      }
      await sleep(500);
    }
    return false;
  }
  return { proc, call, up, cookies, internal: { 'x-bka-internal': token } };
}

async function main() {
  console.log('E2E: single company file');

  // 1. New company file on the share (what File > New Company writes), locked and opened.
  const fileId = randomBytes(8).toString('hex');
  mkdirSync(share, { recursive: true });
  await format.writeCompanyFile(companyFile, {
    manifest: { formatVersion: 1, fileId, companyName: 'Acme Plumbing', saveId: 'new', previousSaveId: null, savedAt: new Date().toISOString() },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Acme Plumbing' })) },
      { name: '.file-id', data: Buffer.from(fileId) },
    ],
  });
  assert(format.isCompanyFile(companyFile), 'a new company file is one file on the share');

  const lockA = companyLock.acquire(companyFile, { appUser: null });
  assert(lockA.ok, 'workstation A locks the company file');
  assert(!companyLock.acquire(companyFile).ok, 'a second workstation is refused while A has it open');
  const prepA = await companySession.prepareWorkingCopy(companyFile, { root: path.join(sandbox, 'A', 'Working') });
  assert(prepA.plan === 'extract', 'A opens it into a working copy');

  // 2. Work on A.
  const tokenA = randomBytes(16).toString('hex');
  const A = startServer({ port: 3991, prep: prepA, lock: lockA.lock, token: tokenA });
  if (!(await A.up())) throw new Error('server A did not start');
  const info = (await A.call('GET', '/api/company-file/info')).data;
  assert(info.singleFile === true && info.hasUsers === false && info.location === companyFile, 'sign-in screen: single file, its location, no users yet');

  const signup = await A.call('POST', '/api/auth/signup', {
    name: 'Pat Owner',
    email: 'Admin',
    password: 'secret123',
    companyName: 'Acme Plumbing',
    challengeQuestion: 'Name of your first pet',
    challengeAnswer: 'Rex',
  });
  assert(signup.status === 201, 'the Admin is set up with a user name and a challenge question');
  const accounts = (await A.call('GET', '/api/accounts')).data;
  const income = Array.isArray(accounts) ? accounts.find((a) => a.code === '4000') : null;
  const customer = (await A.call('POST', '/api/customers', { displayName: 'Oak Street Apartments' })).data;
  const invoice = (
    await A.call('POST', '/api/invoices', {
      customerId: customer?.id,
      date: '2026-10-20',
      lines: [{ description: 'Water heater install', quantity: 1, rate: 1850, accountId: income?.id }],
    })
  ).data;
  assert(invoice?.total === '1850.00', `invoice entered ($${invoice?.total})`);

  // 3. Autosave writes the company file by itself.
  let saved = false;
  for (let i = 0; i < 60 && !saved; i++) {
    await sleep(1000);
    const st = (await A.call('GET', '/api/company-file/status', null, A.internal)).data;
    const m = format.readCompanyManifest(companyFile);
    saved = Boolean(st && st.status === 'saved' && m && m.saveId !== 'new');
  }
  assert(saved, 'autosave wrote the company file within a minute');

  const close = await A.call('POST', '/api/company-file/close', null, A.internal);
  assert(close.status === 200 && close.data?.ok, 'closing saves and closes the database');
  const refused = await A.call('POST', '/api/company-file/close', null, {});
  assert(refused.status === 403, 'only the desktop shell may close the file');
  const oldCookies = { ...A.cookies };
  A.proc.kill();
  await sleep(500);
  companyLock.release(lockA.lock);
  assert(companyLock.readHolder(companyFile) === null, 'the lock is gone once A has closed the file');

  // 4. Workstation B opens the same file from the share.
  const lockB = companyLock.acquire(companyFile);
  assert(lockB.ok, 'workstation B can now open it');
  const prepB = await companySession.prepareWorkingCopy(companyFile, { root: path.join(sandbox, 'B', 'Working') });
  const B = startServer({ port: 3992, prep: prepB, lock: lockB.lock, token: randomBytes(16).toString('hex') });
  if (!(await B.up())) throw new Error('server B did not start');
  Object.assign(B.cookies, oldCookies);
  const stale = (await B.call('GET', '/api/auth/me')).data;
  assert(stale === null, "A's sign-in does not carry over: the password is asked again on every open");
  const login = await B.call('POST', '/api/auth/login', { email: 'admin', password: 'secret123' });
  assert(login.status === 200, 'the Admin signs in on B with the password stored in the file');
  const invoices = (await B.call('GET', '/api/invoices')).data;
  const list = Array.isArray(invoices) ? invoices : invoices?.items ?? invoices?.data ?? [];
  assert(list.some((x) => x.id === invoice?.id && x.total === '1850.00'), 'the invoice entered on A is in the company file on B');
  const tb = (await B.call('GET', '/api/reports/trial-balance')).data;
  assert(tb != null, 'reports run on the reopened file');

  const closeB = await B.call('POST', '/api/company-file/close', null, B.internal);
  assert(closeB.status === 200, 'B closes the file');
  companyLock.release(lockB.lock);

  console.log(failures === 0 ? '\nE2E COMPANY FILE PASSED' : `\nE2E COMPANY FILE FAILED (${failures} assertion(s))`);
}

main()
  .catch((e) => {
    console.error('E2E ERROR:', e.stack || e.message);
    failures++;
  })
  .finally(async () => {
    for (const s of servers) {
      try {
        s.kill();
      } catch {
        /* gone */
      }
    }
    await sleep(500);
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* Windows may hold a file for a moment */
    }
    process.exit(failures === 0 ? 0 : 1);
  });
