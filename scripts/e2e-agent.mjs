/**
 * End-to-end test of agent full access (AGENT_ACCESS.md, _vr_tmp/AGENT-FULL-ACCESS-PLAN.md §10),
 * driving the PACKAGED Windows build and the MCP connector that ships inside it:
 *
 *   npm run desktop:pack && npm run test:e2e:agent
 *   npm run test:e2e:agent -- --list          (print the scenarios; starts nothing)
 *   npm run test:e2e:agent -- --only P0,P3    (setup, those scenarios, then the check on disk)
 *   npm run test:e2e:agent -- --keep          (keep the throwaway folder even when all passes)
 *
 * Safe on a computer people work on. Before anything else, and refusing to run otherwise:
 *  - Windows only; the build is release\win-unpacked\Ironbooks.exe of this checkout (or E2E_EXE),
 *    never an installed copy (Program Files, %LOCALAPPDATA%\Programs);
 *  - nothing runs that build yet: the test drives only a copy it starts itself;
 *  - everything it writes is in a fresh folder under the system temp folder: the app's own
 *    IRONBOOKS_USER_DATA and LOCALAPPDATA, its company file (made here, not protected with
 *    passwords) and the folders the agents may use. No BKA_* or IRONBOOKS_* setting of the
 *    person running it reaches the app, so it cannot open any other books;
 *  - the debugging port is a free one, and the page is driven only once the program listening
 *    there is the one this test started; the company file it shows must be the one made here;
 *  - processes are stopped by id and executable path only, never by name: the connector runs as
 *    Ironbooks.exe too (as Node), and so may an office copy or someone else's connector. Only the
 *    copies of the build this test started (and what they started, still running the test build),
 *    the connectors this test spawned, and what those connectors were seen to start (tracked by id
 *    while they ran) are ever stopped. When Windows reports the build's path in a spelling the
 *    test does not recognise, the copy it started is still stopped, through its own handle;
 *  - a connector may start Ironbooks by itself only in scenario U, which tracks what it starts;
 *    everywhere else that setting is taken out of its settings before it runs;
 *  - mail goes to a catcher on 127.0.0.1 that this script starts: nothing is sent anywhere.
 *
 * A person's side always goes through the person's own routes (/api/agent-requests/**,
 * /api/agents/**, contract §11) from the signed-in Admin's Ironbooks window, never with an agent's
 * token. The agent's side goes through the connector's tools (POST /api/agent/actions).
 *
 * One scenario per phase of the plan, each checking the books afterwards (SCENARIOS below, or
 * --list), then the company file on disk once Ironbooks is closed (F), then the earlier script's
 * part B with Ironbooks closed (U): an agent allowed to work while nobody is signed in starts it
 * with no window, another computer is handed the file at once, and a company file with passwords
 * is never opened for an agent. Output: one line per check, a summary table at the end, exit code
 * 1 on any failure, and the throwaway folder kept (its path printed) when anything failed.
 *
 * Not covered any more: a person starting Ironbooks while it runs hidden for an agent gets that
 * copy's window (the earlier script's step 10). That second start can leave a native "could not
 * start" box behind on any computer (agents or not), which this script would have to click.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep, until } from './e2e-helpers.mjs';
import {
  Connector,
  MailCatcher,
  agentHttp,
  freePort,
  listenerPids,
  pidsRunning,
  processTable,
  sameExe,
  samePath,
  stopOwnTree,
  treeOf,
  windowCall,
  windowsShown,
  within,
} from './e2e-agent-lib.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.resolve(process.env.E2E_EXE || path.join(root, 'release', 'win-unpacked', 'Ironbooks.exe'));

// ---------------------------------------------------------------------------
// The scenarios (what --list prints)
// ---------------------------------------------------------------------------

/** @typedef {{ id: string, title: string, steps: string[], run: () => Promise<void>, always?: boolean }} Scenario */

/** @type {Scenario[]} */
const SCENARIOS = [
  {
    id: 'S',
    title: 'Safety and setup',
    always: true,
    steps: [
      'refuses to run unless: Windows, the test build exists and is not an installed copy, nothing runs that build yet',
      'a fresh folder under the temp folder holds the app settings (IRONBOOKS_USER_DATA), LOCALAPPDATA and a new company file',
      'starts the build itself on a free debugging port; drives the page only once that port belongs to the process it started',
      'the window shows the company file made here, with no users yet; the Admin is set up in it',
      'the Admin makes six agents in the window (Read only, Ask for every change, Trusted bookkeeper, Full with asks; one may work while nobody is signed in)',
      'each gets its token once and connector settings that start the app\'s own program as Node; only the one allowed to work unattended may start Ironbooks; the list never shows a token',
      'the connector starts as those settings say, lists its tools and reads the books',
      'the Read only agent is refused a change, in plain words, and nobody is asked',
    ],
    run: setup,
  },
  {
    id: 'P0',
    title: 'Phase 0: ask, approve, deny, ask once',
    steps: [
      'a dry run shows the ledger lines and keeps nothing',
      'an "Ask for every change" agent asks to enter a journal entry; the same request id asks once',
      'the person sees one request, with the agent\'s name, its reason as its own words and Ironbooks\' own summary',
      'approved in the person\'s window: the entry is in the books once, with the right lines',
      'the audit trail words it "<agent> (agent), approved by <person>" and names the request',
      'a second entry is denied with a note; the agent reads the note; nothing is in the books',
      'sending the approved request id again enters nothing twice',
    ],
    run: phase0,
  },
  {
    id: 'P1',
    title: 'Phase 1: a one-hour grant and a batch of five bills',
    steps: [
      'the agent asks ahead for standing permission to enter journal entries for 60 minutes; the person approves it',
      'the agent sees the standing permission; an entry then posts without asking, under it',
      'the audit trail words it "under permission from <person> until <time>"; the grant counts one use',
      'the person takes it back: the next entry asks again (the agent withdraws that request)',
      'five bills are asked for; the person approves all five in one call; the books hold all five, each named as approved',
    ],
    run: phase1,
  },
  {
    id: 'P2',
    title: 'Phase 2: files in and out',
    steps: [
      'the Admin adds a folder for a "Trusted bookkeeper" agent; the agent sees it',
      'the agent enters a bill, hands Ironbooks a receipt file and files it on that bill; the bill holds it, at the size handed in',
      'the agent makes a Profit & Loss PDF and reads back its size',
      'saving it to a folder outside the allowed ones is refused before anyone is asked; nothing is written there',
      'saving it to the allowed folder asks; approved at the host window, the whole PDF is there',
    ],
    run: phase2,
  },
  {
    id: 'P3',
    title: 'Phase 3: a pay run with SSNs masked, and one approved reveal',
    steps: [
      'the person adds an employee with an SSN; the agent\'s list of employees never shows it in full',
      'the agent dry runs and asks for a pay run; no full SSN in its answers or on the approval card',
      'approved: the paycheck is in the books, for the gross pay the card showed',
      'the agent asks to reveal the employee\'s SSN; approved, it reads it in full (also replaying the same request id)',
      'the audit trail words it "Revealed ... to agent ..., approved by <person>"; an ordinary read stays masked',
    ],
    run: phase3,
  },
  {
    id: 'P4',
    title: 'Phase 4: an email reminder held until approval',
    steps: [
      'mail goes to a catcher on 127.0.0.1 started by this script (Preferences > Send Forms set up in the window)',
      'a recipient that is not a plain address is refused before anyone is asked',
      'a dry run shows the email it would send and sends nothing',
      'asked: nothing is sent while it waits; the card shows the recipient\'s domain in full',
      'approved: exactly one email reaches the catcher, to the customer, and the collection contact is recorded',
    ],
    run: phase4,
  },
  {
    id: 'P5',
    title: 'Phase 5: closing date, with the password typed by the approver',
    steps: [
      'the Admin sets a closing date with a password; an Admin-role agent asks to move it',
      'approved with a wrong password: nothing changes and the request fails',
      'that wrong password counted exactly one guess (four more of the person\'s own lock the password, three do not)',
      'asked again and approved with the right password: the closing date moves, named as approved',
      'neither password appears in anything the agent reads, the request, or the audit trail',
    ],
    run: phase5,
  },
  {
    id: 'P6',
    title: 'Phase 6: a desktop operation, and what an agent can never do',
    steps: [
      'a backup of the company file is asked for, approved at the host window, and saved to the agent\'s folder',
      'an agent cannot approve a request (not through its door, not with its token on the person\'s route)',
      'an agent cannot change an agent\'s policy, either way (wider or tighter; door and token); the policy is unchanged',
      'an agent cannot change or delete a role an agent holds (dry run or run); a role no agent holds is not refused that way',
      'Pause all agents stops every verb of every agent; resuming lets them work again',
    ],
    run: phase6,
  },
  {
    id: 'F',
    title: 'The company file on disk, after Ironbooks closes',
    always: true,
    steps: [
      'closing the window quits the build this test started (its own process, by id); nothing of it is left running',
      'the company file is released, and holds what each scenario that ran left in the books',
      'no password (closing-date, right or wrong, or the Admin\'s) is stored in any request, stored answer or audit row, or in the transaction log',
    ],
    run: onDisk,
  },
  {
    id: 'U',
    title: 'With Ironbooks closed: an agent allowed to work while nobody is signed in',
    steps: [
      'an agent not allowed to work unattended is told to wait for a person, and nothing starts Ironbooks',
      'the agent allowed to work unattended gets the books: its connector starts Ironbooks with no window (tracked by process id and path)',
      'the company file lock says an agent has it; the agent enters a journal entry on its own',
      'an agent not allowed to work unattended is still refused, even with the start setting forced on, and starts nothing',
      'another computer asks for the file and is handed it at once: Ironbooks saves, closes and quits; the entry is in the company file',
      'a second company file, protected with passwords (made here, in a copy of the build started here), is never opened for an agent: Ironbooks does not stay open and nothing is decrypted',
    ],
    run: unattended,
  },
];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

class Stop extends Error {}
/** Refused before anything ran: the computer is not one this test may run on as it is. */
class Refuse extends Error {}

/** @type {Array<{ id: string, title: string, checks: number, failures: number, ms: number, state: string, error: string | null }>} */
const report = [];
let current = null;

function short(v, max = 300) {
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** One check: one line. The detail is shown only when it fails. */
function check(cond, text, detail) {
  const ok = Boolean(cond);
  if (current) {
    current.checks++;
    if (!ok) current.failures++;
  }
  const id = (current?.id ?? '').padEnd(3);
  if (ok) console.log(`  ok    ${id} ${text}`);
  else console.error(`  FAIL  ${id} ${text}${detail !== undefined ? `  [got: ${short(detail)}]` : ''}`);
  return ok;
}

/** A check the rest of the scenario cannot do without: the scenario stops when it fails. */
function need(cond, text, detail) {
  if (!check(cond, text, detail)) throw new Stop(`cannot go on: ${text}`);
  return cond;
}

const note = (text) => console.log(`        ${(current?.id ?? '').padEnd(3)} ${text}`);

// ---------------------------------------------------------------------------
// The world this run builds (all of it inside the throwaway folder)
// ---------------------------------------------------------------------------

const AGENTS = {
  reader: { name: 'Reader', roleKeys: ['view_only'], preset: 'read_only' },
  clerk: { name: 'Clerk', roleKeys: ['bookkeeper'], preset: 'ask_every_change' },
  keeper: { name: 'Night bookkeeper', roleKeys: ['full_access'], preset: 'trusted_bookkeeper' },
  payroll: { name: 'Payroll helper', roleKeys: ['payroll_processor'], preset: 'ask_every_change' },
  admin: { name: 'Office admin', roleKeys: ['admin'], preset: 'full_with_asks' },
  // Used only in U, once Ironbooks is closed: the one agent whose connector may start it.
  closer: { name: 'Night closer', roleKeys: ['full_access'], preset: 'trusted_bookkeeper', unattended: true },
};
const AGENT_COUNT = Object.keys(AGENTS).length;

const PERSON = 'Pat Owner';
const SSN = '987-65-4321'; // the range set aside for advertising: never anyone's
const SSN_DIGITS = SSN.replace(/\D/g, '');

const W = {
  tmp: '',
  profile: null,
  adminPassword: `e2e-${randomBytes(9).toString('hex')}`, // this throwaway file only, never printed
  closingPassword: `close-${randomBytes(6).toString('hex')}`,
  wrongClosingPassword: `wrong-${randomBytes(6).toString('hex')}`,
  child: null,
  pid: 0,
  exited: null,
  knownPids: new Set(),
  cdpPort: 0,
  appPort: 0,
  page: null,
  agents: {},
  accounts: { cash: null, expense: null },
  folders: { exports: '', backups: '', outside: '' },
  vendorId: null,
  mail: null,
  /** What the check on disk looks for, added by each scenario that ran. */
  disk: [],
  setupDone: false,
  /** F closed the build cleanly: it quit and nothing of it is left running (U needs that). */
  closedClean: false,
};
/**
 * Every copy of the test build this script started itself, with a debugging port: W (the office's
 * books) and, in U, the copy for the company file with passwords. Each has the fields W has for
 * it: child, pid, exited, knownPids, cdpPort, appPort, page.
 */
const builds = [];
/** Every connector this script spawned, kept to the end so cleanup can stop what each one started. */
/** @type {Connector[]} */
const connectors = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = day(new Date());
const YEAR_START = `${TODAY.slice(0, 4)}-01-01`;
function addDays(d, n) {
  const [y, m, dd] = d.split('-').map(Number);
  return day(new Date(y, m - 1, dd + n));
}
/** The last day of the month `back` months before today's. */
function monthEndBack(back) {
  const [y, m] = TODAY.split('-').map(Number);
  return day(new Date(y, m - back, 0));
}

/** Decimal text as whole cents (BigInt), or null. Money is compared as text, never as a JavaScript number. */
function cents(v) {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(2, '0');
  if (/[1-9]/.test(frac.slice(2))) return null;
  const n = BigInt(m[2]) * 100n + BigInt(frac.slice(0, 2));
  return m[1] ? -n : n;
}

const asList = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);
const idOf = (body, key) => body?.[key]?.id ?? body?.id ?? null;
const holdsSsn = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.includes(SSN) || s.includes(SSN_DIGITS);
};

/** The request id of an answer that waits for a person, or null. */
const askedId = (res) => (res?.ok && res.data?.outcome === 'asked' && typeof res.data.request_id === 'string' ? res.data.request_id : null);

/** A person's request from their own window. */
const call = (method, url, body, headers) => windowCall(W.page, method, url, body, headers);

/**
 * A connector for an agent ({ name, connection, token }), on the throwaway computer `p`, started as
 * its settings say. It may start Ironbooks by itself only with `opts.mayStartApp` (scenario U, which
 * tracks what it starts); otherwise that setting is taken out first (Connector).
 * @param {{ mayStartApp?: boolean, extraEnv?: Record<string, string> }} [opts]
 */
async function openConnector(a, p, opts = {}) {
  let conn;
  try {
    conn = new Connector(a.connection, a.token, appEnv(p), { exe: EXE, ...opts });
  } catch (err) {
    throw new Stop(`the connector of ${a.name} was not started: ${err.message}`);
  }
  connectors.push(conn);
  const init = await conn.start();
  if (init?.serverInfo?.name !== 'ironbooks') throw new Stop(`the connector of ${a.name} did not start (${short(conn.stderr)})`);
  return conn;
}

/** The agent's connector, started the first time it is needed. It never starts Ironbooks. */
async function agent(key) {
  const a = W.agents[key];
  if (!a) throw new Stop(`the agent "${key}" was not made`);
  if (!a.conn || a.conn.exited) a.conn = await openConnector(a, W.profile);
  return a.conn;
}

/** Stop every connector (each only its own process); what they started is stopped in cleanup. */
function stopConnectors() {
  for (const c of connectors) c.stop();
  for (const a of Object.values(W.agents)) a.conn = null;
}

/** An answer as a failing check prints it, without the agent's token (a throwaway, but never printed). */
function hideToken(res) {
  const body = res?.body && typeof res.body === 'object' ? { ...res.body, ...(res.body.token ? { token: '(not shown)' } : {}) } : res?.body;
  return { status: res?.status, body, ...(res?.text ? { text: res.text } : {}) };
}

/** Text for a RegExp that matches `s` literally. */
const literal = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tool = async (key, name, args = {}, timeoutMs) => (await agent(key)).tool(name, args, timeoutMs);

async function pendingFor(agentId) {
  const r = await call('GET', `/api/agent-requests?status=pending&agentId=${encodeURIComponent(agentId)}`);
  return asList(r.body, 'requests');
}
const requestView = async (id) => (await call('GET', `/api/agent-requests/${id}`)).body?.request ?? null;
const approve = (id, input = {}) => call('POST', `/api/agent-requests/${id}/approve`, input);
const decision = (key, id, seconds = 5) => tool(key, 'wait_for_decision', { request_id: id, timeout_seconds: seconds });

/** Journal entries with this description (the whole year to date), as the person's Journal lists them. */
async function entriesWith(description) {
  const r = await call('GET', `/api/journal-entries?from=${YEAR_START}&to=${addDays(TODAY, 1)}&limit=500`);
  return asList(r.body, 'entries').filter((e) => e.description === description);
}
async function auditRows(query = '') {
  const r = await call('GET', `/api/audit-trail?limit=200${query}`);
  return asList(r.body, 'rows');
}

/** A journal entry the curated tool takes: `amount` from the expense account to cash. */
function je(amount, description, date = TODAY) {
  return {
    date,
    description,
    lines: [
      { account_id: W.accounts.expense, debit: amount },
      { account_id: W.accounts.cash, credit: amount },
    ],
  };
}

/** The environment of the throwaway computer: the person's own Ironbooks and agent settings never reach it. */
function appEnv(p) {
  const env = { ...process.env, IRONBOOKS_USER_DATA: p.userData, LOCALAPPDATA: p.local, ELECTRON_ENABLE_LOGGING: '' };
  for (const k of Object.keys(env)) {
    if (/^(BKA_|IRONBOOKS_)/i.test(k) && k !== 'IRONBOOKS_USER_DATA') delete env[k];
  }
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DATABASE_URL']) delete env[k];
  return env;
}

// ---------------------------------------------------------------------------
// Safety, before anything runs
// ---------------------------------------------------------------------------

function installedFolders() {
  return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
}

async function refuseUnsafe() {
  if (process.platform !== 'win32') throw new Refuse('This test drives the packaged Windows build. Run it on Windows.');
  if (!fs.existsSync(EXE) || !fs.statSync(EXE).isFile()) throw new Refuse(`The packaged app is not there: ${EXE}. Run npm run desktop:pack first.`);
  if (path.basename(EXE).toLowerCase() !== 'ironbooks.exe') throw new Refuse(`${EXE} is not Ironbooks.exe. Point E2E_EXE at a packaged Ironbooks.exe.`);
  const installed = installedFolders().find((dir) => within(EXE, dir));
  if (installed) {
    throw new Refuse(`${EXE} is an installed copy of Ironbooks (inside ${installed}). This test only runs a build made in a checkout (release\\win-unpacked), never the office's own app.`);
  }
  const running = await pidsRunning(EXE);
  if (running.length) {
    throw new Refuse(`The test build is already running (process ${running.join(', ')}). This test only drives a copy it starts itself: close it first.`);
  }
}

/** One throwaway "computer" inside the run's own folder. */
function profile(name, companyName) {
  const dir = path.join(W.tmp, name);
  const p = {
    dir,
    userData: path.join(dir, 'userData'),
    local: path.join(dir, 'Local'),
    companyFile: path.join(dir, 'Books', `${companyName}.ironbooks`),
    companyName,
  };
  for (const d of [p.userData, p.local, path.dirname(p.companyFile)]) fs.mkdirSync(d, { recursive: true });
  for (const v of [p.userData, p.local, p.companyFile]) if (!within(v, W.tmp)) throw new Refuse(`${v} is not inside ${W.tmp}.`);
  return p;
}

/** A new company file for the throwaway computer `p`, not protected with passwords. Sets p.fileId. */
async function newCompanyFile(p) {
  const format = require(path.join(root, 'electron', 'companyFileFormat.js'));
  p.fileId = randomBytes(8).toString('hex');
  await format.writeCompanyFile(p.companyFile, {
    manifest: { formatVersion: 1, fileId: p.fileId, companyName: p.companyName, saveId: 'new', previousSaveId: null, savedAt: new Date().toISOString() },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: p.companyName })) },
      { name: '.file-id', data: Buffer.from(p.fileId) },
    ],
  });
  // The app opens this file and only this one: it is the only one it has ever seen.
  fs.writeFileSync(path.join(p.userData, 'config.json'), JSON.stringify({ companyFile: p.companyFile, recentCompanies: [p.companyFile], theme: { mode: 'light', accent: 'blue' } }));
}

/** A copy of the build that has not been started yet (W is the office's). */
const newBuild = () => ({ child: null, pid: 0, exited: null, knownPids: new Set(), cdpPort: 0, appPort: 0, page: null });

/** Wait for the build this test started to listen on the debugging port; refuse anything else there. */
async function ownDebugPort(run) {
  const end = Date.now() + 120_000;
  for (;;) {
    if (run.exited) throw new Refuse(`The test build closed right after it started (exit ${run.exited.code}). Nothing was done.`);
    const owners = await listenerPids(run.cdpPort);
    if (owners.length) {
      const table = await processTable();
      const tree = treeOf(run.pid, EXE, table);
      for (const p of tree) run.knownPids.add(p);
      if (owners.every((pid) => tree.has(pid))) return owners;
      throw new Refuse(`Another program (process ${owners.join(', ')}) listens on the debugging port ${run.cdpPort}. The test drives only the copy it started; nothing was done.`);
    }
    if (Date.now() > end) throw new Refuse(`The test build did not open its debugging port ${run.cdpPort} within two minutes.`);
    await sleep(1000);
  }
}

/**
 * Start the build itself for the throwaway computer `p`, on a free debugging port, and connect to
 * its window once that port and the window's server belong to the process it started. `label`
 * starts each line ("" for the office's books, "Protected Co: " for the second file).
 */
async function startBuild(run, p, label = '') {
  run.cdpPort = await freePort();
  run.child = spawn(EXE, [`--remote-debugging-port=${run.cdpPort}`], { env: appEnv(p), stdio: 'ignore', detached: false });
  run.pid = run.child.pid;
  run.exited = null;
  run.child.on('exit', (code) => (run.exited = { code }));
  run.child.on('error', (err) => (run.exited = { code: err.message }));
  builds.push(run);
  need(Number.isInteger(run.pid) && run.pid > 0, `${label}the test build is started by this script (process ${run.pid})`);
  const owners = await ownDebugPort(run);
  check(true, `${label}the debugging port ${run.cdpPort} belongs to that process (${owners.join(', ')}), nothing else`);
  run.page = await connect(run.cdpPort, (u) => /^http:\/\/localhost:\d+\//.test(u));
  const origin = await run.page.eval('location.origin');
  run.appPort = Number(new URL(origin).port);
  const serverOwners = await listenerPids(run.appPort);
  const tree = treeOf(run.pid, EXE, await processTable());
  for (const pid of tree) run.knownPids.add(pid);
  need(serverOwners.length > 0 && serverOwners.every((pid) => tree.has(pid)), `${label}the window's server is part of the test build`, { serverOwners, tree: [...tree] });
  const info = (await windowCall(run.page, 'GET', '/api/company-file/info')).body;
  need(info && samePath(info.location, p.companyFile) && info.fileId === p.fileId, `${label}the window shows the company file made here, and no other`, { location: info?.location, fileId: info?.fileId });
  return info;
}

/** Wait (up to 90 s) for a new company file's window to show the Admin setup screen. */
async function atSignup(page) {
  return Boolean(await until(async () => (await page.eval('location.pathname').catch(() => '')) === '/signup', 90_000, 400));
}

/**
 * Close a copy of the build the way the X button does (it saves and quits), wait for its own
 * process to end, then for every process seen in its tree to be gone; what is still there after
 * that is stopped, by id and path. { quit, left }: left is what had to be stopped.
 */
async function closeBuild(run) {
  for (const pid of treeOf(run.pid, EXE, await processTable())) run.knownPids.add(pid);
  if (run.page && !run.exited) {
    await run.page.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
    run.page.close();
  }
  run.page = null;
  const quit = Boolean(await until(() => run.exited, 120_000, 500));
  let left = [];
  for (let i = 0; i < 30; i++) {
    const t = await processTable();
    left = [...run.knownPids].filter((pid) => sameExe(t.get(pid)?.exe, EXE));
    if (!left.length) break;
    await sleep(1000);
  }
  if (left.length) await stopOwnTree(run.pid, EXE, left);
  return { quit, left };
}

// ---------------------------------------------------------------------------
// S: setup
// ---------------------------------------------------------------------------

async function setup() {
  need(fs.readdirSync(W.tmp).length === 0 && within(W.tmp, os.tmpdir()) && !samePath(W.tmp, os.tmpdir()), 'the run has a fresh, empty folder of its own under the temp folder', W.tmp);
  const p = (W.profile = profile('office', 'Agent Test Co'));
  await newCompanyFile(p);
  check(fs.existsSync(p.companyFile), 'a new company file is made there, not protected with passwords');
  for (const [k, sub] of [['exports', 'Exports'], ['backups', 'Backups'], ['outside', 'Not for agents']]) {
    W.folders[k] = path.join(k === 'outside' ? W.tmp : p.dir, sub);
    fs.mkdirSync(W.folders[k], { recursive: true });
  }

  // Start the build itself, on a free debugging port.
  const info = await startBuild(W, p);
  check(info.hasUsers === false, 'it has no users yet');

  check(await atSignup(W.page), 'a new company file opens on the Admin setup screen');
  const signup = await call('POST', '/api/auth/signup', { name: PERSON, email: 'Admin', password: W.adminPassword, companyName: p.companyName, protect: false });
  need(signup.status === 201, `the Admin (${PERSON}) is set up and signed in`, signup.body ?? signup.text);
  await W.page.eval(`window.bookkeeper && window.bookkeeper.company.signedIn('Admin')`).catch(() => {});

  // The agents, made by the Admin in the window.
  for (const [key, def] of Object.entries(AGENTS)) {
    const made = await call('POST', '/api/agents', def);
    const how = `${def.roleKeys.join(', ')}, ${def.preset}${def.unattended ? ', may work while nobody is signed in' : ''}`;
    if (!check(made.status === 201 && made.body?.token && made.body?.agent?.id, `the Admin makes "${def.name}" (${how})`, hideToken(made))) continue;
    W.agents[key] = { ...def, unattended: def.unattended === true, id: made.body.agent.id, token: made.body.token, connection: made.body.connection, conn: null };
    check(made.body.agent.preset === def.preset && made.body.agent.unattended === (def.unattended === true), `"${def.name}" has the preset it was made with`, { preset: made.body.agent.preset, unattended: made.body.agent.unattended });
  }
  need(Object.keys(W.agents).length === AGENT_COUNT, `all ${AGENT_COUNT} agents exist`);

  // Each agent's connector settings: the app's own program run as Node, the connector shipped
  // inside it, the token in its variable, and nothing else, except that the one agent allowed to
  // work while nobody is signed in may start Ironbooks.
  for (const a of Object.values(W.agents)) {
    const c = a.connection;
    const env = c?.env ?? {};
    const keys = Object.keys(env).sort().join();
    const wantKeys = a.unattended ? 'ELECTRON_RUN_AS_NODE,IRONBOOKS_AGENT_START' : 'ELECTRON_RUN_AS_NODE';
    check(
      c &&
        c.installed === true &&
        samePath(c.command, EXE) &&
        fs.existsSync(c.args?.[0] ?? '') &&
        /resources[\\/]mcp[\\/]ironbooks-mcp\.mjs$/.test(c.args[0]) &&
        c.tokenEnv === 'IRONBOOKS_AGENT_TOKEN' &&
        env.ELECTRON_RUN_AS_NODE === '1' &&
        keys === wantKeys &&
        (!a.unattended || env.IRONBOOKS_AGENT_START === '1'),
      `"${a.name}": its connector settings run the app's own program as Node, with the connector shipped inside it, and ${a.unattended ? 'may start Ironbooks (it may work while nobody is signed in)' : 'start nothing by themselves'}`,
      c,
    );
  }
  const listed = (await call('GET', '/api/agents')).body;
  const listedText = JSON.stringify(listed ?? {});
  const rows = asList(listed, 'agents');
  check(
    rows.length === AGENT_COUNT && Object.values(W.agents).every((a) => !listedText.includes(a.token)),
    `the list of agents shows all ${AGENT_COUNT} and never a token`,
    rows.length,
  );
  check(
    rows.every((r) => r.unattended === (r.name === AGENTS.closer.name)) && listed?.unattendedPossible === true,
    `the list marks only "${AGENTS.closer.name}" as allowed to work while nobody is signed in (possible in this file)`,
    { marked: rows.filter((r) => r.unattended).map((r) => r.name), unattendedPossible: listed?.unattendedPossible },
  );

  // The connector, started as the settings say.
  const c = await agent('clerk');
  const names = new Set((await c.tools()).map((t) => t.name));
  const wanted = ['run_operation', 'wait_for_decision', 'find_operations', 'describe_operation', 'ask_for_permission', 'list_my_requests', 'cancel_request', 'get_my_permissions', 'upload_file', 'get_file', 'save_file', 'export_report', 'enter_journal_entry', 'enter_bill'];
  check(wanted.every((n) => names.has(n)), `the connector starts under the app's program and offers its tools (${names.size})`, wanted.filter((n) => !names.has(n)));
  const ci = await tool('clerk', 'get_company_info');
  check(ci.ok && ci.data?.company?.name === p.companyName && ci.data?.agent?.name === 'Clerk', 'the agent sees which books these are and who it is', ci.text);
  const accounts = await tool('clerk', 'list_accounts');
  const list = asList(accounts.data, 'accounts');
  const byNumber = (n) => list.find((a) => String(a.number) === n)?.id ?? null;
  W.accounts.cash = byNumber('1000') ?? list.find((a) => /bank|cash/i.test(String(a.type)))?.id ?? null;
  W.accounts.expense = byNumber('6300') ?? list.find((a) => /expense/i.test(String(a.type)))?.id ?? null;
  need(W.accounts.cash && W.accounts.expense, 'the agent reads the chart of accounts (a cash and an expense account)', list.length);

  // Read only means read only, and nobody is asked.
  const refused = await tool('reader', 'enter_journal_entry', { ...je('5.00', 'E2E S should not exist'), request_id: 'e2e-s-ro-1' });
  check(!refused.ok && /^Refused:/.test(refused.text) && !/[{}]/.test(refused.text.split('\n')[0]), 'the Read only agent is refused a change, in plain words', refused.text);
  check((await pendingFor(W.agents.reader.id)).length === 0, 'and nobody is asked about it');
  W.setupDone = true;
}

// ---------------------------------------------------------------------------
// P0: ask, approve, deny, ask once
// ---------------------------------------------------------------------------

async function phase0() {
  const A = W.agents.clerk;
  const d1 = 'E2E P0 office supplies';
  const d2 = 'E2E P0 entry to deny';
  const reason = 'Office supplies bought on the company card on the 2nd; the receipt is in the shared folder.';

  const dry = await tool('clerk', 'enter_journal_entry', { ...je('64.20', d1), dry_run: true });
  check(dry.ok && dry.data?.outcome === 'dry_run' && asList(dry.data, 'would_post').length === 1, 'a dry run shows the one entry it would post', dry.text);

  const asked = await tool('clerk', 'enter_journal_entry', { ...je('64.20', d1), request_id: 'e2e-p0-je-1', reason });
  const r1 = need(askedId(asked), 'asking to enter it waits for a person (outcome asked, with a request id)', asked.text);
  const again = await tool('clerk', 'enter_journal_entry', { ...je('64.20', d1), request_id: 'e2e-p0-je-1', reason });
  check(again.ok && again.data?.repeated === true && again.data?.request_id === r1, 'asking again with the same request id gives the same request', again.text);
  const waiting = await pendingFor(A.id);
  check(waiting.filter((r) => r.id === r1).length === 1 && waiting.length === 1, 'the person sees exactly one request for it', waiting.map((r) => r.id));

  const view = await requestView(r1);
  check(view?.status === 'pending' && view.agentName === A.name && view.canApprove === true, `the request names the agent and ${PERSON} may approve it`, view);
  check(view?.reason === reason, "the agent's reason is kept as its own words", view?.reason);
  check(typeof view?.summary === 'string' && view.summary.trim().length > 0 && view.summary !== reason, "the summary is Ironbooks' own line, not the agent's text", view?.summary);
  check((await entriesWith(d1)).length === 0, 'nothing is in the books before the approval');

  const ok = await approve(r1);
  check(ok.status === 200 && ok.body?.status === 'executed' && ok.body?.request?.posted === true, `${PERSON} approves it in the window, and it is posted`, ok.body ?? ok.text);
  const entries = await entriesWith(d1);
  need(entries.length === 1, 'the books hold the entry once', entries.length);
  const entryId = entries[0].id;
  check(asList(ok.body?.request, 'entryIds').includes(entryId), 'the approved request names that entry', ok.body?.request?.entryIds);
  const lines = asList((await call('GET', `/api/journal-entries/${entryId}`)).body?.entry, 'lines');
  check(
    lines.some((l) => cents(l.debit) === 6420n && l.accountId === W.accounts.expense) && lines.some((l) => cents(l.credit) === 6420n && l.accountId === W.accounts.cash),
    'with 64.20 debited to the expense account and credited to cash',
    lines,
  );
  const row = (await auditRows()).find((x) => x.entityId === entryId && x.action === 'create');
  check(row?.actorName === `${A.name} (agent), approved by ${PERSON}`, `the audit trail says "${A.name} (agent), approved by ${PERSON}"`, row?.actorName ?? 'no audit row');
  check(row?.agentRequestId === r1 && row?.agentId === A.id, 'and names the agent and its request', row && { agentId: row.agentId, agentRequestId: row.agentRequestId });
  const told = await decision('clerk', r1);
  check(told.ok && told.data?.decision === 'approved' && asList(told.data, 'entry_ids').includes(entryId), 'the agent reads that it was approved and posted, with the entry', told.text);

  // A denial with a note.
  const noteText = 'Not this month: the invoice for this is not in yet.';
  const asked2 = await tool('clerk', 'enter_journal_entry', { ...je('19.99', d2), request_id: 'e2e-p0-je-2', reason: 'A software subscription renewal.' });
  const r2 = need(askedId(asked2), 'a second entry is asked for', asked2.text);
  const denied = await call('POST', `/api/agent-requests/${r2}/deny`, { note: noteText });
  check(denied.status === 200 && denied.body?.request?.status === 'denied' && denied.body?.request?.note === noteText, `${PERSON} denies it with a note`, denied.body ?? denied.text);
  const told2 = await decision('clerk', r2);
  check(told2.ok && told2.data?.decision === 'denied' && told2.data?.note_from_person === noteText, "the agent reads the denial and the person's note", told2.text);
  check((await entriesWith(d2)).length === 0, 'the denied entry is not in the books');

  // The same request id, once more, after the approval.
  const replay = await tool('clerk', 'enter_journal_entry', { ...je('64.20', d1), request_id: 'e2e-p0-je-1', reason });
  check(replay.ok && replay.data?.repeated === true, 'sending the approved request id again gives its first answer', replay.text);
  check((await entriesWith(d1)).length === 1 && (await pendingFor(A.id)).length === 0, 'and enters nothing twice, asks nobody again');

  W.disk.push(
    { id: 'P0', text: 'the approved entry is in the company file, under the agent that asked', sql: `select a.name from journal_entries je left join agents a on a.id = je.agent_id where je.description = $1`, params: [d1], ok: (rows) => rows.length === 1 && rows[0].name === A.name },
    { id: 'P0', text: 'the denied entry is not', sql: `select id from journal_entries where description = $1`, params: [d2], ok: (rows) => rows.length === 0 },
    { id: 'P0', text: 'its audit row names the person who approved it', sql: `select approved_by from audit_logs where entity_id = $1::uuid and action = 'create' and agent_id is not null`, params: [entryId], ok: (rows) => rows.length >= 1 && rows.every((r) => r.approved_by) },
  );
}

// ---------------------------------------------------------------------------
// P1: a one-hour grant and a batch of five bills
// ---------------------------------------------------------------------------

async function phase1() {
  const A = W.agents.clerk;
  // Standing permission ends at midnight at the latest (lib/agent/policy.ts maxGrantMinutes).
  const now = new Date();
  const leftToday = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()) / 60_000);
  const minutes = Math.min(60, leftToday - 2);
  need(minutes >= 5, 'there is time left today for standing permission (it ends at midnight)', `${leftToday} minutes left`);
  if (minutes < 60) note(`only ${leftToday} minutes are left today, so the grant asked for is ${minutes} minutes, not 60`);

  const ask = await tool('clerk', 'ask_for_permission', {
    operation: 'journal-entries.create',
    minutes,
    reason: 'I am entering this month\'s accruals over the next hour and would like not to ask for each one.',
    request_id: 'e2e-p1-grant',
  });
  const g = need(askedId(ask), `the agent asks ahead for ${minutes} minutes of standing permission to enter journal entries`, ask.text);
  const gv = await requestView(g);
  check(gv?.kind === 'grant' && gv?.grantAsked?.minutes === minutes && gv?.canApprove === true, 'the person sees a standing-permission request, for the minutes asked', gv);
  const before = Date.now();
  const given = await approve(g);
  const grant = given.body?.request?.grant;
  const grantId = given.body?.request?.grantId;
  check(given.status === 200 && given.body?.status === 'executed' && grantId, `${PERSON} gives it`, given.body ?? given.text);
  const ends = Date.parse(grant?.expiresAt ?? '');
  check(grant?.minutes === minutes && Math.abs(ends - (before + minutes * 60_000)) < 3 * 60_000, `for ${minutes} minutes from now`, grant);
  const perms = await tool('clerk', 'get_my_permissions');
  check(perms.ok && asList(perms.data, 'standing_permissions').some((s) => s.operation === 'journal-entries.create' && s.standing_permission === grantId), 'the agent sees the standing permission it holds', perms.text);

  const d1 = 'E2E P1 accrual under the grant';
  const run = await tool('clerk', 'enter_journal_entry', { ...je('250.00', d1), request_id: 'e2e-p1-je-1' });
  check(run.ok && run.data?.outcome === 'posted' && run.data?.under_standing_permission === grantId, 'an entry now posts without asking, under that permission', run.text);
  check((await pendingFor(A.id)).length === 0 && (await entriesWith(d1)).length === 1, 'nobody is asked, and the books hold it once');
  const entryId = (await entriesWith(d1))[0]?.id;
  const row = (await auditRows()).find((x) => x.entityId === entryId && x.action === 'create');
  check(
    typeof row?.actorName === 'string' && row.actorName.startsWith(`${A.name} (agent), under permission from ${PERSON} until `) && row.agentGrantId === grantId,
    `the audit trail says "under permission from ${PERSON} until <time>"`,
    row?.actorName ?? 'no audit row',
  );
  const grants = asList((await call('GET', `/api/agents/${A.id}/grants`)).body, 'grants');
  check(grants.some((x) => x.id === grantId && x.uses === 1), 'the person sees the grant, used once', grants);

  // Taken back: the next one asks again.
  const back = await call('DELETE', `/api/agent-grants/${grantId}`);
  check(back.status === 200, `${PERSON} takes the standing permission back`, back.body ?? back.text);
  const d2 = 'E2E P1 after the grant was taken back';
  const after = await tool('clerk', 'enter_journal_entry', { ...je('12.00', d2), request_id: 'e2e-p1-je-2', reason: 'One more accrual.' });
  const r2 = askedId(after);
  check(r2, 'the next entry asks a person again', after.text);
  if (r2) {
    const cancelled = await tool('clerk', 'cancel_request', { request_id: r2 });
    check(cancelled.ok && cancelled.data?.decision === 'cancelled', 'the agent withdraws that request', cancelled.text);
  }
  check((await entriesWith(d2)).length === 0, 'and it is not in the books');

  // Five bills, approved in one call.
  const vendor = await call('POST', '/api/vendors', { displayName: 'E2E Paper Supply' });
  W.vendorId = need(idOf(vendor.body, 'vendor'), 'the person adds a vendor', vendor.body ?? vendor.text);
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const res = await tool('clerk', 'enter_bill', {
      vendor_id: W.vendorId,
      bill_number: `E2E-P1-${i}`,
      date: TODAY,
      lines: [{ account_id: W.accounts.expense, amount: `10${i}.00`, description: `Paper, box ${i}` }],
      request_id: `e2e-p1-bill-${i}`,
      reason: `Bill ${i} of 5 from the paper supplier's November statement.`,
    });
    const id = askedId(res);
    if (check(id, `bill ${i} of 5 waits for a person`, res.text)) ids.push(id);
  }
  need(ids.length === 5, 'all five bills are asked for');
  const billsOf = async () => asList((await call('GET', `/api/bills?vendorId=${W.vendorId}`)).body, 'bills').filter((b) => /^E2E-P1-\d$/.test(String(b.billNumber ?? '')));
  check((await billsOf()).length === 0, 'none is in the books yet');
  const batch = await call('POST', '/api/agent-requests/batch-approve', { ids });
  const results = asList(batch.body, 'results');
  check(batch.status === 200 && results.length === 5 && results.every((x) => x.status === 'executed'), `${PERSON} approves all five in one call`, results.map((x) => x.status ?? x));
  const bills = await billsOf();
  const totals = bills.map((b) => cents(b.total)).sort((a, b) => (a < b ? -1 : 1));
  check(bills.length === 5 && totals.join() === [10100n, 10200n, 10300n, 10400n, 10500n].join(), 'the books hold the five bills, 101.00 to 105.00', bills.map((b) => [b.billNumber, b.total]));
  const rows = await auditRows();
  const named = bills.filter((b) => rows.some((x) => x.entityId === b.id && x.action === 'create' && x.actorName === `${A.name} (agent), approved by ${PERSON}`));
  check(named.length === 5, `each is named "${A.name} (agent), approved by ${PERSON}" in the audit trail`, named.length);

  W.disk.push(
    { id: 'P1', text: 'the five approved bills are in the company file', sql: `select bill_number from bills where bill_number like 'E2E-P1-%'`, params: [], ok: (r) => r.length === 5 },
    { id: 'P1', text: 'the entry made under standing permission names the grant', sql: `select agent_grant_id from audit_logs where entity_id = $1::uuid and action = 'create'`, params: [entryId ?? '00000000-0000-0000-0000-000000000000'], ok: (r) => r.some((x) => x.agent_grant_id === grantId) },
  );
}

// ---------------------------------------------------------------------------
// P2: files in and out
// ---------------------------------------------------------------------------

async function phase2() {
  const A = W.agents.keeper;
  const folders = await call('PATCH', `/api/agents/${A.id}`, { folders: [W.folders.exports] });
  check(folders.status === 200, `the Admin adds a folder for "${A.name}"`, folders.body ?? folders.text);
  const perms = await tool('keeper', 'get_my_permissions');
  check(perms.ok && asList(perms.data, 'folders').some((f) => samePath(f, W.folders.exports)), 'the agent sees it among its folders', perms.text);

  // A bill, with a receipt filed on it.
  if (!W.vendorId) W.vendorId = idOf((await call('POST', '/api/vendors', { displayName: 'E2E Print Shop' })).body, 'vendor');
  need(W.vendorId, 'there is a vendor to bill');
  const bill = await tool('keeper', 'enter_bill', {
    vendor_id: W.vendorId,
    bill_number: 'E2E-P2-1',
    date: TODAY,
    lines: [{ account_id: W.accounts.expense, amount: '42.00', description: 'Printing' }],
    request_id: 'e2e-p2-bill',
  });
  const billId = bill.data?.result?.id;
  need(bill.ok && bill.data?.outcome === 'posted' && billId, 'the "Trusted bookkeeper" enters a bill on its own', bill.text);
  const receipt = Buffer.from(`Receipt E2E-P2-1\nPrinting 42.00\n${TODAY}\n`);
  const up = await tool('keeper', 'upload_file', { name: 'receipt-e2e-p2.txt', type: 'text/plain', base64: receipt.toString('base64') });
  const fileId = need(up.ok && up.data?.file_id, 'it hands Ironbooks the receipt (a staged file)', up.text);
  check(up.data?.size === receipt.length, `Ironbooks holds all of it (${receipt.length} bytes)`, up.data?.size);
  const attach = await tool('keeper', 'run_operation', {
    operation: 'attachments.create',
    body: { entityType: 'bill', entityId: billId, filename: 'receipt-e2e-p2.txt', mimeType: 'text/plain', base64: { fileId }, description: 'Receipt' },
    request_id: 'e2e-p2-attach',
    reason: 'The printer\'s receipt for bill E2E-P2-1.',
  });
  let attached = attach.ok && ['done', 'posted'].includes(attach.data?.outcome);
  const ra = askedId(attach);
  if (ra) {
    note('filing the document asked a person; approving it');
    const ok = await approve(ra);
    attached = ok.body?.status === 'executed';
  }
  check(attached, 'it files the staged file on that bill', attach.text);
  const docs = asList((await call('GET', `/api/attachments?entityType=bill&entityId=${billId}`)).body, 'attachments');
  // The size the list gives is compared, never assumed: an attachment row without one fails.
  check(
    docs.length === 1 && docs[0].filename === 'receipt-e2e-p2.txt' && Number.isInteger(docs[0].sizeBytes) && docs[0].sizeBytes === receipt.length,
    `the bill holds the receipt, whole (${receipt.length} bytes)`,
    docs.map((d) => ({ filename: d.filename, sizeBytes: d.sizeBytes })),
  );

  // A report, exported.
  const pdf = await tool('keeper', 'export_report', { key: 'profit-loss', format: 'pdf', options: { date_from: YEAR_START, date_to: TODAY } });
  const pdfId = need(pdf.ok && pdf.data?.file?.file_id, 'it makes a Profit & Loss PDF', pdf.text);
  const got = await tool('keeper', 'get_file', { file_id: pdfId });
  const staged = need(got.ok && got.data?.file_id === pdfId && Number.isInteger(got.data?.size) && got.data.size > 0 && got.data.size, 'it reads the PDF back, with its size', got.text);
  const pendingBefore = (await pendingFor(A.id)).length;

  // Outside the allowed folders: refused before anyone is asked.
  const outside = await tool('keeper', 'save_file', { file_id: pdfId, folder: W.folders.outside, name: 'pl.pdf', request_id: 'e2e-p2-save-out', reason: 'Saving the report.' });
  check(!outside.ok && /folder/i.test(outside.text), 'saving it to a folder outside the allowed ones is refused', outside.text);
  check((await pendingFor(A.id)).length === pendingBefore && fs.readdirSync(W.folders.outside).length === 0, 'before anyone is asked, and nothing is written there');

  // Inside: asked, approved at the host window.
  const name = `profit-loss-${TODAY}.pdf`;
  const save = await tool('keeper', 'save_file', { file_id: pdfId, folder: W.folders.exports, name, request_id: 'e2e-p2-save', reason: 'The P&L for the owner\'s folder.' });
  const rs = need(askedId(save), 'saving it to the allowed folder asks a person', save.text);
  check(!fs.existsSync(path.join(W.folders.exports, name)), 'nothing is saved while it waits');
  const ok = await approve(rs);
  check(ok.status === 200 && ok.body?.status === 'executed', `${PERSON} approves it at the host window`, ok.body ?? ok.text);
  const target = path.join(W.folders.exports, name);
  const bytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
  check(bytes && bytes.subarray(0, 5).toString('latin1') === '%PDF-' && bytes.length === staged, `the PDF is in the folder, whole (${staged} bytes, the size of the file Ironbooks made)`, bytes ? { size: bytes.length, staged } : 'missing');

  W.disk.push({
    id: 'P2',
    text: 'the receipt is filed on the bill in the company file, whole',
    sql: `select filename, size_bytes from attachments where entity_type = 'bill' and entity_id = $1::uuid`,
    params: [billId],
    ok: (r) => r.length === 1 && r[0].filename === 'receipt-e2e-p2.txt' && Number(r[0].size_bytes) === receipt.length,
  });
}

// ---------------------------------------------------------------------------
// P3: payroll, SSNs masked, one approved reveal
// ---------------------------------------------------------------------------

async function phase3() {
  const A = W.agents.payroll;
  const made = await call('POST', '/api/employees', { firstName: 'Dana', lastName: 'Lee', payType: 'hourly', payRate: '25.00' });
  const employeeId = need(idOf(made.body, 'employee'), 'the person adds an employee', made.body ?? made.text);
  const ssn = await call('PATCH', `/api/employees/${employeeId}`, { ssn: SSN });
  check(ssn.status === 200, 'with a Social Security number', ssn.body ?? ssn.text);

  const listed = await tool('payroll', 'list_employees');
  check(listed.ok && listed.text.includes('Dana') && !holdsSsn(listed.text), "the agent's list of employees never shows the SSN in full", listed.text);

  const body = { payDate: TODAY, periodStart: addDays(TODAY, -13), periodEnd: TODAY, memo: 'E2E P3 pay run', employees: [{ employeeId, amount: '1000.00' }] };
  const dry = await tool('payroll', 'run_operation', { operation: 'payroll.pay-runs.create', body, dry_run: true });
  check(dry.ok && dry.data?.outcome === 'dry_run' && !holdsSsn(dry.text), 'a dry run of the pay run shows no full SSN', dry.text);
  const asked = await tool('payroll', 'run_operation', { operation: 'payroll.pay-runs.create', body, request_id: 'e2e-p3-payrun', reason: 'The pay run for the period ending today.' });
  const r = need(askedId(asked), 'the pay run waits for a person', asked.text);
  check(!holdsSsn(asked.text), 'the answer holds no full SSN');
  const view = await requestView(r);
  check(view && !holdsSsn(view), 'nor does the approval card', view && { input: view.input, preview: view.preview?.records });
  check(cents(view?.amount) === 100000n, 'the card shows the gross pay, 1000.00', view?.amount);
  const ok = await approve(r);
  check(ok.status === 200 && ok.body?.status === 'executed' && !holdsSsn(ok.body), `${PERSON} approves it`, ok.body ?? ok.text);
  const checks = asList((await call('GET', `/api/payroll?employeeId=${employeeId}`)).body, 'paychecks');
  check(checks.length === 1 && cents(checks[0].grossPay) === 100000n, 'the books hold one paycheck of 1000.00', checks.map((x) => x.grossPay));
  const told = await decision('payroll', r);
  check(told.ok && told.data?.decision === 'approved' && !holdsSsn(told.text), 'the agent reads that it was done, without the SSN', told.text);

  // One reveal, approved.
  const plain = await tool('payroll', 'run_operation', { operation: 'employees.get', params: { id: employeeId } });
  check(plain.ok && plain.data?.outcome === 'read' && !holdsSsn(plain.text), 'an ordinary read of the employee is masked', plain.text);
  const revealArgs = { operation: 'employees.get', params: { id: employeeId }, reveal: true, request_id: 'e2e-p3-reveal', reason: 'The state new-hire report needs Dana\'s full SSN.' };
  const ask = await tool('payroll', 'run_operation', revealArgs);
  const rr = need(askedId(ask), 'asking to reveal the SSN waits for a person', ask.text);
  check(!holdsSsn(ask.text), 'and shows nothing before it is approved');
  const yes = await approve(rr);
  check(yes.status === 200 && yes.body?.status === 'executed', `${PERSON} approves the reveal`, yes.body ?? yes.text);
  const read = await decision('payroll', rr);
  const shown = String(read.data?.result?.ssn ?? '').replace(/\D/g, '');
  check(read.ok && read.data?.decision === 'approved' && shown === SSN_DIGITS, 'the agent then reads the SSN in full', read.data?.result ?? read.text);
  const replay = await tool('payroll', 'run_operation', revealArgs);
  check(replay.ok && replay.data?.repeated === true && String(replay.data?.result?.ssn ?? '').replace(/\D/g, '') === SSN_DIGITS, 'replaying the same request id shows it too, while the reveal is fresh', replay.text);
  const rows = await auditRows('&entityType=agent_permission_request');
  const words = rows.map((x) => x.summary).find((s) => typeof s === 'string' && s.startsWith('Revealed '));
  check(
    typeof words === 'string' && new RegExp(`to agent "?${A.name}"?, approved by ${PERSON}\\.$`).test(words),
    `the audit trail says "Revealed ... to agent ${A.name}, approved by ${PERSON}."`,
    words ?? rows.map((x) => x.summary),
  );
  const again = await tool('payroll', 'run_operation', { operation: 'employees.get', params: { id: employeeId } });
  check(again.ok && !holdsSsn(again.text), 'the next ordinary read is masked again', again.text);

  W.disk.push(
    { id: 'P3', text: 'the paycheck is in the company file', sql: `select gross_pay from paychecks where employee_id = $1::uuid`, params: [employeeId], ok: (r) => r.length === 1 && cents(r[0].gross_pay) === 100000n },
    { id: 'P3', text: 'the stored pay-run request holds no full SSN', sql: `select input::text as input, result::text as result, preview::text as preview from agent_permission_requests where id = $1::uuid`, params: [r], ok: (x) => x.length === 1 && !holdsSsn(x[0]) },
  );
}

// ---------------------------------------------------------------------------
// P4: an email reminder held in the outbox until approval
// ---------------------------------------------------------------------------

async function phase4() {
  const A = W.agents.keeper;
  W.mail = new MailCatcher();
  const port = await W.mail.start();
  check(port > 0, `a mail catcher listens on 127.0.0.1:${port} (it keeps mail and sends nothing on)`);
  const setupMail = await call('PUT', '/api/email/settings', { host: '127.0.0.1', port, security: 'none', fromName: 'Agent Test Co', fromEmail: 'books@agent-test.example' });
  need(setupMail.status === 200, 'Preferences > Send Forms points at it, set up in the window', setupMail.body ?? setupMail.text);

  const cust = await call('POST', '/api/customers', { displayName: 'E2E Acme Corp', email: 'billing@acme.example' });
  const customerId = need(idOf(cust.body, 'customer'), 'the person adds a customer with an email address', cust.body ?? cust.text);
  const inv = await call('POST', '/api/invoices', {
    customerId,
    date: addDays(TODAY, -45),
    dueDate: addDays(TODAY, -15),
    lines: [{ description: 'E2E consulting', quantity: '1', rate: '450.00' }],
  });
  need(inv.status === 201 || inv.status === 200, 'and an invoice of theirs that is overdue', inv.body ?? inv.text);
  const pendingBefore = (await pendingFor(A.id)).length;

  const bad = await tool('keeper', 'run_operation', {
    operation: 'collections.email',
    body: { customerId, what: 'invoices', to: 'Acme Billing <billing@acme.example>' },
    request_id: 'e2e-p4-bad-to',
    reason: 'Reminder of the overdue invoice.',
  });
  check(!bad.ok && /address/i.test(bad.text), 'a recipient that is not a plain address is refused', bad.text);
  check((await pendingFor(A.id)).length === pendingBefore && W.mail.messages.length === 0, 'before anyone is asked, and nothing is sent');

  const body = { customerId, what: 'invoices' };
  const dry = await tool('keeper', 'run_operation', { operation: 'collections.email', body, dry_run: true });
  check(dry.ok && dry.data?.outcome === 'dry_run' && /acme\.example/.test(JSON.stringify(dry.data?.would_also ?? [])), 'a dry run shows the email it would send', dry.text);
  check(W.mail.messages.length === 0, 'and sends nothing');

  const asked = await tool('keeper', 'run_operation', { operation: 'collections.email', body, request_id: 'e2e-p4-reminder', reason: 'Acme is 15 days late; a polite reminder with the invoice.' });
  const r = need(askedId(asked), 'the reminder waits for a person', asked.text);
  await sleep(3000);
  check(W.mail.messages.length === 0, 'nothing is sent while it waits', W.mail.messages.length);
  const view = await requestView(r);
  const effects = asList(view?.preview, 'effects').filter((e) => e.kind === 'email');
  check(effects.length >= 1 && effects.every((e) => /billing@acme\.example/.test(e.summary)), "the card shows the email and its recipient's domain in full", effects.map((e) => e.summary));
  const ok = await approve(r);
  check(ok.status === 200 && ok.body?.status === 'executed', `${PERSON} approves it`, ok.body ?? ok.text);
  const arrived = await (async () => {
    const end = Date.now() + 30_000;
    while (Date.now() < end && W.mail.messages.length === 0) await sleep(250);
    await sleep(1500);
    return W.mail.messages;
  })();
  check(arrived.length === 1 && arrived[0].to.length === 1 && arrived[0].to[0] === 'billing@acme.example', 'exactly one email reaches the catcher, to the customer', arrived.map((m) => ({ to: m.to, subject: m.subject })));
  check(asList(ok.body, 'effects').some((e) => e.status === 'sent'), 'the approval reports it sent', ok.body?.effects);
  const notes = asList((await call('GET', `/api/collections/notes?customerId=${customerId}`)).body, 'notes');
  check(notes.some((n) => /billing@acme\.example/.test(String(n.note ?? n.text ?? ''))), 'the collection contact is recorded on the customer', notes);
  const told = await decision('keeper', r);
  check(told.ok && told.data?.decision === 'approved', 'the agent reads that it was sent', told.text);
}

// ---------------------------------------------------------------------------
// P5: closing date, with the password typed by the approver
// ---------------------------------------------------------------------------

async function phase5() {
  const A = W.agents.admin;
  const first = monthEndBack(3);
  const moved = monthEndBack(2);
  const set = await call('PATCH', '/api/company/closing-date', { closingDate: first, password: W.closingPassword });
  need(set.status === 200 && set.body?.closingDate === first && set.body?.hasPassword === true, `the Admin sets the closing date to ${first}, with a password`, set.body ?? set.text);
  const closingDate = async () => (await call('GET', '/api/company/closing-date')).body?.closingDate ?? null;

  const ask = async (requestId) =>
    tool('admin', 'run_operation', { operation: 'company.closing-date.update', body: { closingDate: moved }, request_id: requestId, reason: `Month-end close is done: move the closing date to ${moved}.` });
  const a1 = await ask('e2e-p5-close-1');
  const r1 = need(askedId(a1), `"${A.name}" asks to move it to ${moved}`, a1.text);
  const v1 = await requestView(r1);
  check(asList(v1?.needs, 'secrets').includes('closing_password'), 'the card asks the approver for the closing-date password', v1?.needs);

  const wrong = await approve(r1, { secrets: { closing_password: W.wrongClosingPassword } });
  check(wrong.status === 200 && wrong.body?.status === 'failed' && /password/i.test(String(wrong.body?.request?.error ?? '')), 'approved with a wrong password, the request fails and says why', wrong.body ?? wrong.text);
  check((await closingDate()) === first, 'the closing date has not moved');

  // The card's wrong password counted ONE guess. Five wrong guesses in 15 minutes lock the
  // closing-date password (lib/closingPasswordLimiter.ts, lib/net/rateLimit.ts), counted under the
  // approving person's own keys, the same keys as a wrong x-closing-password from their window. So
  // after the card's one, four of the person's own are let through (the fourth locks it) and the
  // fifth is refused. Had the card counted none, the fifth would be let through; two, the fourth
  // would be refused.
  const guess = () => call('GET', '/api/company/closing-date', undefined, { 'x-closing-password': W.wrongClosingPassword });
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await guess()).status);
  check(answers.slice(0, 4).every((s) => s === 200) && answers[4] === 403, 'the wrong password on the card counted exactly one guess (four more are let through and lock it; the fifth is refused)', answers);
  note('waiting 62 seconds for the closing-date password lock to end');
  await sleep(62_000);

  const a2 = await ask('e2e-p5-close-2');
  const r2 = need(askedId(a2), 'the agent asks again, with a new request id', a2.text);
  const right = await approve(r2, { secrets: { closing_password: W.closingPassword } });
  check(right.status === 200 && right.body?.status === 'executed', `${PERSON} approves it with the right password`, right.body ?? right.text);
  check((await closingDate()) === moved, `the closing date is now ${moved}`);
  const row = (await auditRows()).find((x) => x.agentRequestId === r2 && x.agentId === A.id);
  check(row?.actorName === `${A.name} (agent), approved by ${PERSON}`, `the audit trail says "${A.name} (agent), approved by ${PERSON}"`, row ?? 'no audit row');

  const seen = [
    (await decision('admin', r1)).text,
    (await decision('admin', r2)).text,
    JSON.stringify(await requestView(r1)),
    JSON.stringify(await requestView(r2)),
    JSON.stringify(await auditRows()),
    JSON.stringify(right.body ?? {}),
    JSON.stringify(wrong.body ?? {}),
  ].join('\n');
  check(!seen.includes(W.closingPassword) && !seen.includes(W.wrongClosingPassword), 'neither password appears in what the agent reads, the request or the audit trail');

  W.disk.push({ id: 'P5', text: `the closing date in the company file is ${moved}`, sql: `select settings->>'closingDate' as d from companies`, params: [], ok: (r) => r.some((x) => x.d === moved) });
}

// ---------------------------------------------------------------------------
// P6: a desktop operation, and what an agent can never do
// ---------------------------------------------------------------------------

async function phase6() {
  const A = W.agents.admin;
  const C = W.agents.clerk;

  // A backup, saved to the agent's folder.
  const folders = await call('PATCH', `/api/agents/${A.id}`, { folders: [W.folders.backups] });
  check(folders.status === 200, `the Admin adds a backup folder for "${A.name}"`, folders.body ?? folders.text);
  const ask = await tool('admin', 'run_operation', { operation: 'backup.download', request_id: 'e2e-p6-backup', reason: 'A copy of the books before the year-end work.' });
  const rb = need(askedId(ask), 'a backup of the company file is asked for', ask.text);
  const bv = await requestView(rb);
  check(bv?.needs?.admin === true || bv?.needs?.fileAdmin === true, 'only an Admin may approve it', bv?.needs);
  const ok = await approve(rb);
  check(ok.status === 200 && ok.body?.status === 'executed', `${PERSON} approves it at the host window`, ok.body ?? ok.text);
  const made = await decision('admin', rb);
  const file = made.data?.file;
  need(made.ok && file?.file_id, 'the agent gets the backup as a staged file', made.text);
  const save = await tool('admin', 'save_file', { file_id: file.file_id, folder: W.folders.backups, request_id: 'e2e-p6-backup-save', reason: 'Keep the backup in the backups folder.' });
  const rs = need(askedId(save), 'saving it to the agent\'s folder asks a person (a desktop operation, host only)', save.text);
  const sv = await requestView(rs);
  check(sv?.needs?.hostOnly === true && sv?.canApprove === true, 'it is approvable at the host window', sv?.needs);
  const saved = await approve(rs);
  check(saved.status === 200 && saved.body?.status === 'executed', `${PERSON} approves the save at the host window`, saved.body ?? saved.text);
  const inFolder = fs.readdirSync(W.folders.backups).map((n) => ({ n, size: fs.statSync(path.join(W.folders.backups, n)).size }));
  check(inFolder.length === 1 && inFolder[0].size === file.size && inFolder[0].size > 0, 'the backup is in the folder, whole', { inFolder, staged: file.size });

  // A request the agents will try to approve themselves.
  const p = await tool('clerk', 'enter_journal_entry', { ...je('7.00', 'E2E P6 waits for a person'), request_id: 'e2e-p6-pending', reason: 'Postage.' });
  const pid = need(askedId(p), 'an agent\'s request waits for a person', p.text);

  // An agent cannot approve.
  const door = await tool('admin', 'run_operation', { operation: 'agent-requests.approve', params: { id: pid }, request_id: 'e2e-p6-self-approve', reason: 'Approving.' });
  check(!door.ok && /^Refused:/.test(door.text), 'an agent cannot approve a request through its door', door.text);
  const direct = await agentHttp(W.appPort, A.token, 'POST', `/api/agent-requests/${pid}/approve`, {});
  check(direct.status === 403, "nor with its token on the person's own route", direct);
  const peek = await agentHttp(W.appPort, A.token, 'GET', '/api/agent-requests?status=pending');
  check(peek.status === 403 && peek.body?.details?.personOnly === true, "its token does not even open the person's list of requests", peek);
  check((await requestView(pid))?.status === 'pending', 'the request still waits for a person');

  // An agent cannot change a policy, either way: not wider, and not tighter either (an agent can
  // never change agents, plan 4.6; tightening is open to people only).
  for (const [preset, way] of [
    ['full_with_asks', 'widen'],
    ['read_only', 'tighten'],
  ]) {
    const pol = await tool('admin', 'run_operation', { operation: 'agents.update', params: { id: C.id }, body: { preset }, request_id: `e2e-p6-policy-${preset}`, reason: `${way} the clerk.` });
    check(!pol.ok && /^Refused:/.test(pol.text), `an agent cannot ${way} an agent's policy through its door (to ${preset})`, pol.text);
    const polDirect = await agentHttp(W.appPort, A.token, 'PATCH', `/api/agents/${C.id}`, { preset });
    check(polDirect.status === 403, `nor with its token on the person's route (to ${preset})`, polDirect);
  }
  const clerk = (await call('GET', `/api/agents/${C.id}`)).body;
  check(clerk?.policy?.preset === C.preset, `the policy is unchanged (${C.preset})`, clerk?.policy?.preset);

  // A role an agent holds.
  const held = await call('POST', '/api/roles', { cloneFrom: 'view_only', name: 'E2E Held Role', description: 'held by an agent' });
  const free = await call('POST', '/api/roles', { cloneFrom: 'view_only', name: 'E2E Free Role', description: 'held by nobody' });
  const heldId = held.body?.key ?? held.body?.id;
  const freeId = free.body?.key ?? free.body?.id;
  need(heldId && freeId, 'the person makes two custom roles', [held.body ?? held.text, free.body ?? free.text]);
  const holder = await call('POST', '/api/agents', { name: 'Role holder', roleKeys: [heldId], preset: 'read_only' });
  need(holder.status === 201, 'and gives one of them to an agent', hideToken(holder));
  const change = { description: 'changed by an agent' };
  const tries = [
    ['roles.update', { params: { id: heldId }, body: change, dry_run: true }, 'a dry run of changing it'],
    ['roles.update', { params: { id: heldId }, body: change, request_id: 'e2e-p6-role-change', reason: 'Tidy the role.' }, 'changing it'],
    ['roles.delete', { params: { id: heldId }, request_id: 'e2e-p6-role-delete', reason: 'Remove the role.' }, 'deleting it'],
  ];
  // The door names the role as the agent named it (its id, lib/agent/operate.ts roleHeldNote);
  // the approval path names it by its name (lib/agent/bridge.ts). Either one is the role.
  const namesHeld = new RegExp(`"(?:${literal(heldId)}|E2E Held Role)"`);
  for (const [operation, args, what] of tries) {
    const res = await tool('admin', 'run_operation', { operation, ...args });
    check(!res.ok && /agent holds it/i.test(res.text) && namesHeld.test(res.text), `${what} is refused: the note names the role (by its id or name) and says an agent holds it`, res.text);
  }
  const roleNow = (await call('GET', `/api/roles/${heldId}`)).body;
  check(JSON.stringify(roleNow ?? {}).includes('held by an agent') && !JSON.stringify(roleNow ?? {}).includes('changed by an agent'), 'the role is unchanged', roleNow);
  check(!asList(await pendingFor(A.id), 'requests').some((r) => /role/i.test(String(r.operation))), 'and nobody was asked about it');
  const freeTry = await tool('admin', 'run_operation', { operation: 'roles.update', params: { id: freeId }, body: change, dry_run: true });
  check(freeTry.ok && freeTry.data?.outcome === 'dry_run' && !/agent holds it/i.test(freeTry.text), 'a dry run of changing a role no agent holds goes through (the refusal is about the held role)', freeTry.text);

  // Pause all agents.
  const before = await tool('clerk', 'upload_file', { name: 'before-pause.txt', type: 'text/plain', base64: Buffer.from('before the pause').toString('base64') });
  const stagedId = before.data?.file_id ?? '00000000-0000-0000-0000-000000000000';
  const paused = await call('POST', '/api/agents/pause-all', { paused: true });
  need(paused.status === 200 && paused.body?.paused === true, `${PERSON} pauses all agents`, paused.body ?? paused.text);
  try {
    const verbs = [
      ['describe_operation', { operation: 'journal-entries.create' }],
      ['run_operation', { operation: 'accounts.list' }],
      ['list_my_requests', {}],
      ['cancel_request', { request_id: pid }],
      ['get_my_permissions', {}],
      ['ask_for_permission', { operation: 'journal-entries.create', minutes: 5, reason: 'While paused.', request_id: 'e2e-p6-paused-ask' }],
      ['upload_file', { name: 'paused.txt', type: 'text/plain', base64: Buffer.from('paused').toString('base64') }],
      ['get_file', { file_id: stagedId }],
      ['save_file', { file_id: stagedId, folder: W.folders.exports, request_id: 'e2e-p6-paused-save', reason: 'While paused.' }],
      ['list_accounts', {}],
      ['enter_journal_entry', { ...je('3.00', 'E2E P6 while paused'), request_id: 'e2e-p6-paused-je', reason: 'While paused.' }],
    ];
    const through = [];
    for (const [name, args] of verbs) {
      const res = await tool('clerk', name, args);
      if (res.ok) through.push(name);
    }
    const found = await tool('clerk', 'find_operations', { query: 'journal entry' });
    const ops = asList(found.data, 'operations');
    if (found.ok && !(ops.length > 0 && ops.every((o) => o.treatment === 'refused'))) through.push('find_operations');
    const other = await tool('admin', 'run_operation', { operation: 'accounts.list' });
    if (other.ok) through.push(`${A.name}: run_operation`);
    check(through.length === 0, 'while paused, every verb of every agent is refused (find_operations lists everything as refused)', through);
    check((await requestView(pid))?.status === 'pending' && (await entriesWith('E2E P6 while paused')).length === 0, 'and nothing they sent was done');
  } finally {
    const resumed = await call('POST', '/api/agents/pause-all', { paused: false });
    check(resumed.status === 200 && resumed.body?.paused === false, `${PERSON} resumes them`, resumed.body ?? resumed.text);
  }
  const works = await tool('clerk', 'get_my_permissions');
  check(works.ok && works.data?.paused === false, 'the agents can work again', works.text);
  const withdrawn = await tool('clerk', 'cancel_request', { request_id: pid });
  check(withdrawn.ok && withdrawn.data?.decision === 'cancelled', 'the agent withdraws the request it left waiting', withdrawn.text);
}

// ---------------------------------------------------------------------------
// F: the company file on disk
// ---------------------------------------------------------------------------

const companyLock = () => require(path.join(root, 'electron', 'companyLock.js'));
const fileFormat = () => require(path.join(root, 'electron', 'companyFileFormat.js'));

/**
 * Rows of queries against the books inside a (not protected) company file, read from a copy
 * extracted into the run's folder. { results, dir }: one { rows, error } per query, and the folder
 * the copy is in (its other files, such as the transaction log, can be read there).
 */
async function queryCompanyFile(file, queries) {
  const { PGlite } = require('@electric-sql/pglite');
  const out = path.join(W.tmp, `check-${randomBytes(3).toString('hex')}`);
  if (!within(out, W.tmp)) throw new Error(`${out} is not inside ${W.tmp}`);
  await fileFormat().extractCompanyFile(file, out, {});
  const pg = new PGlite(out);
  try {
    const results = [];
    for (const q of queries) {
      try {
        results.push({ rows: (await pg.query(q.sql, q.params)).rows, error: null });
      } catch (err) {
        results.push({ rows: [], error: err.message });
      }
    }
    return { results, dir: out };
  } finally {
    await pg.close();
  }
}

/** The running transaction log inside an extracted copy (transactions.bktlg), as text, or null. */
function transactionLogIn(dir) {
  const found = fs.readdirSync(dir, { recursive: true }).map(String).find((n) => path.basename(n) === 'transactions.bktlg');
  return found ? fs.readFileSync(path.join(dir, found), 'utf8') : null;
}

async function onDisk() {
  need(W.child && W.pid, 'the test build was started');
  check(!W.exited, 'the test build was still running when the scenarios ended', W.exited);
  stopConnectors();
  const { quit, left } = await closeBuild(W);
  check(quit, `closing the window quits the build this test started (process ${W.pid})`);
  check(left.length === 0, 'nothing of it is left running', left);
  const released = companyLock().readHolder(W.profile.companyFile) === null;
  check(released, 'the company file is released');
  W.closedClean = quit && left.length === 0 && released;

  // Every password this run typed: the closing-date ones on the approval cards, and the Admin's.
  const passwords = [W.closingPassword, W.wrongClosingPassword, W.adminPassword];
  const secretsCheck = {
    id: 'F',
    text: 'no password (closing-date, right or wrong, or the Admin\'s) is stored in any request, the door\'s stored answers or any audit row',
    sql: `select count(*)::int as n from (
            select coalesce(input::text, '') || coalesce(result::text, '') || coalesce(preview::text, '') || coalesce(needs::text, '') || coalesce(error, '') || coalesce(note, '') || coalesce(reason, '') || coalesce(summary, '') as t from agent_permission_requests
            union all select coalesce(result::text, '') from agent_requests
            union all select coalesce(new_values::text, '') || coalesce(old_values::text, '') || coalesce(llm_reasoning, '') from audit_logs
          ) x where t like $1 or t like $2 or t like $3`,
    params: passwords.map((s) => `%${s}%`),
    ok: (r) => r.length === 1 && r[0].n === 0,
  };
  const queries = [...W.disk, secretsCheck];
  const { results, dir } = await queryCompanyFile(W.profile.companyFile, queries);
  queries.forEach((q, i) => {
    const res = results[i];
    check(!res.error && q.ok(res.rows), `${q.id === 'F' ? '' : `${q.id}: `}${q.text}`, res.error ?? res.rows);
  });
  // The transaction log keeps every change the books saw (lib/services/transactionLog.ts): it is
  // there, and no password is in it. (Only which of them is shown when it fails, never the text.)
  const log = transactionLogIn(dir);
  check(
    log !== null && log.length > 0 && passwords.every((s) => !log.includes(s)),
    'the transaction log is in the company file, and holds no password',
    log === null ? 'no transactions.bktlg in the company file' : { found: ['closing', 'wrong closing', 'Admin'].filter((_, i) => log.includes(passwords[i])) },
  );
}

// ---------------------------------------------------------------------------
// U: with Ironbooks closed, an agent allowed to work while nobody is signed in
// ---------------------------------------------------------------------------

/** Processes running the test build that are not one of this test's connectors (Ironbooks itself), by path. */
async function appsRunning() {
  const table = await processTable();
  const own = new Set(connectors.filter((c) => !c.exited).map((c) => c.pid));
  return (await pidsRunning(EXE, table)).filter((pid) => !own.has(pid));
}

/**
 * `work` (a tool call) while noting, every two seconds, what the connector has started. Ironbooks
 * started for an agent can quit again before the call returns (a company file with passwords), or
 * be left running when it does not: what was seen is what cleanup stops.
 */
async function tracking(conn, work) {
  let done = false;
  const poll = (async () => {
    while (!done) {
      conn.track(await processTable().catch(() => new Map()));
      if (!done) await sleep(2000);
    }
  })();
  try {
    return await work();
  } finally {
    done = true;
    await poll;
    conn.track(await processTable().catch(() => new Map()));
  }
}

/** Wait (up to `ms`) until nothing the connector started still runs the test build (by id and path). */
async function startedGone(conn, ms) {
  return Boolean(
    await until(
      async () => {
        const t = await processTable();
        conn.track(t);
        return conn.started.every((pid) => !sameExe(t.get(pid)?.exe, EXE));
      },
      ms,
      1000,
    ),
  );
}

/** Before a connector that may start Ironbooks runs a tool: what it starts must be trackable. */
async function trackable(conn, label = '') {
  const t = await processTable();
  conn.track(t);
  need(treeOf(conn.pid, EXE, t).has(conn.pid), `${label}Windows reports that connector as the test build, so what it starts is tracked by id and path`, { pid: conn.pid, exe: t.get(conn.pid)?.exe ?? null });
}

async function unattended() {
  const N = W.agents.closer;
  const C = W.agents.clerk;
  const file = W.profile.companyFile;
  need(W.closedClean, 'Ironbooks (the copy this test started) closed cleanly in F, and nothing of it runs');
  need(N && C, `"${AGENTS.closer.name}" and "${AGENTS.clerk.name}" were made`);
  const before = await appsRunning();
  need(before.length === 0, 'nothing runs the test build now', before);
  need(companyLock().readHolder(file) === null, 'the company file is not held by anyone');

  // Not allowed to work unattended: told to wait for a person, and nothing starts Ironbooks.
  const plain = await agent('clerk');
  const closed = await plain.tool('get_company_info');
  check(!closed.ok && /not ready/i.test(closed.text), `with Ironbooks closed, "${C.name}" (not allowed to work unattended) is told to wait for a person`, closed.text);
  await sleep(3000);
  plain.track(await processTable());
  const meanwhile = await appsRunning();
  check(plain.started.length === 0 && meanwhile.length === 0, 'and Ironbooks was not started', { started: plain.started, running: meanwhile });

  // Allowed to: its connector starts Ironbooks with no window, and the agent works.
  const night = await openConnector(N, W.profile, { mayStartApp: true });
  need(night.mayStartApp, `"${N.name}"'s connector may start Ironbooks, as its settings say`);
  await trackable(night);
  const t0 = Date.now();
  const woke = await tracking(night, () => night.tool('get_company_info', {}, 240_000));
  check(
    woke.ok && woke.data?.agent?.name === N.name && woke.data?.company?.name === W.profile.companyName,
    `"${N.name}" gets the books with nobody signed in (Ironbooks was started for it in ${Math.round((Date.now() - t0) / 1000)} s)`,
    woke.text,
  );
  const app = night.started;
  need(app.length > 0, 'Ironbooks runs, started by that connector (its processes noted by id)', [...night.known]);
  const shown = await windowsShown(app, EXE);
  check(Array.isArray(shown) && shown.length === 0, 'with no window', shown ?? 'Windows did not say');
  const holder = companyLock().readHolder(file);
  check(/agent/i.test(String(holder?.owner?.appUser ?? '')) && app.includes(Number(holder?.owner?.pid)), "the company file's lock says an agent has it, held by that copy", holder?.owner ?? null);
  const dNight = 'E2E U entered while Ironbooks was closed';
  const entered = await night.tool('enter_journal_entry', { ...je('12.00', dNight), request_id: 'e2e-u-night-1' });
  check(entered.ok && entered.data?.outcome === 'posted', 'it enters a journal entry on its own', entered.text);

  // The start setting gives an agent that is not allowed nothing, even now.
  const forced = await openConnector(C, W.profile, { mayStartApp: true, extraEnv: { IRONBOOKS_AGENT_START: '1' } });
  await trackable(forced);
  const still = await tracking(forced, () => forced.tool('get_company_info'));
  check(!still.ok && /sign in/i.test(still.text), `"${C.name}" is still refused while nobody is signed in, even with the start setting forced on`, still.text);
  check(forced.started.length === 0, 'and its connector started nothing', forced.started);
  forced.stop();

  // Another computer asks for the file: it is handed over at once.
  night.track(await processTable());
  let asked = null;
  try {
    asked = companyLock().requestAccess(file, { appUser: 'Bob', computer: 'BACK-OFFICE', osUser: 'bob' });
  } catch (err) {
    check(false, 'another computer asks for the company file', err.message);
  }
  if (asked) {
    const answer = await until(() => companyLock().readResponse(file, asked) || (companyLock().readHolder(file) === null && { decision: 'released' }), 60_000);
    check(answer && ['handoff', 'released'].includes(answer.decision), 'another computer asking is handed the file without anyone answering', answer);
  }
  const gone = await startedGone(night, 120_000);
  check(gone, 'Ironbooks saves, closes the file and quits (every process that connector started, by id)', night.started);
  if (!gone) await stopOwnTree([], EXE, night.started);
  check(companyLock().readHolder(file) === null, 'the company file is released');
  if (asked) companyLock().cancelRequest(file, asked);
  stopConnectors();
  const { results } = await queryCompanyFile(file, [
    { sql: `select a.name from journal_entries je left join agents a on a.id = je.agent_id where je.description = $1`, params: [dNight] },
  ]);
  const r = results[0];
  check(!r.error && r.rows.length === 1 && r.rows[0].name === N.name, `the entry is in the company file, under "${N.name}"`, r.error ?? r.rows);

  // A company file protected with passwords is never opened for an agent. Made here, in a second
  // throwaway computer, by a copy of the build started here.
  const P = profile('protected', 'Protected Co');
  await newCompanyFile(P);
  const B = newBuild();
  await startBuild(B, P, 'Protected Co: ');
  check(await atSignup(B.page), 'Protected Co: a new company file opens on the Admin setup screen');
  // Protected from its first save (no "protect: false"). The answer holds the recovery key: only
  // its status and error are ever printed.
  const signup = await windowCall(B.page, 'POST', '/api/auth/signup', { name: PERSON, email: 'Admin', password: W.adminPassword, companyName: P.companyName });
  need(signup.status === 201 && signup.body?.protected === true, 'Protected Co: the Admin is set up, and the file is protected with passwords', { status: signup.status, protected: signup.body?.protected, error: signup.body?.error ?? signup.text });
  await B.page.eval(`window.bookkeeper && window.bookkeeper.company.signedIn('Admin')`).catch(() => {});
  const guardedDef = { name: AGENTS.closer.name, roleKeys: ['full_access'], preset: 'trusted_bookkeeper', unattended: true };
  const made = await windowCall(B.page, 'POST', '/api/agents', guardedDef);
  need(made.status === 201 && made.body?.token && made.body?.connection?.env?.IRONBOOKS_AGENT_START === '1', 'Protected Co: the Admin makes an agent allowed to work while nobody is signed in', hideToken(made));
  const closedB = await closeBuild(B);
  check(closedB.quit && closedB.left.length === 0, 'Protected Co: closing the window quits that copy, and nothing of it is left running', closedB);
  let sealed = false;
  try {
    sealed = fileFormat().isSealedManifest(fileFormat().readCompanyManifest(P.companyFile));
  } catch {
    sealed = false;
  }
  check(sealed, 'Protected Co: the company file is protected with passwords');
  const idle = await appsRunning();
  need(idle.length === 0, 'Protected Co: nothing runs the test build now', idle);
  const g = await openConnector({ name: guardedDef.name, connection: made.body.connection, token: made.body.token }, P, { mayStartApp: true });
  await trackable(g, 'Protected Co: ');
  const no = await tracking(g, () => g.tool('get_company_info', {}, 240_000));
  check(!no.ok && /passwords|sign in/i.test(no.text), 'Protected Co: the agent is told a person has to open it', no.text);
  const quitAgain = await startedGone(g, 60_000);
  const after = await appsRunning();
  check(quitAgain && after.length === 0, 'Protected Co: Ironbooks did not stay open', { started: g.started, running: after });
  if (!quitAgain) await stopOwnTree([], EXE, g.started);
  check(companyLock().readHolder(P.companyFile) === null, 'Protected Co: the company file is not held');
  const decrypted = fs.existsSync(P.local) && fs.readdirSync(P.local, { recursive: true }).some((n) => String(n).endsWith('PG_VERSION'));
  check(!decrypted, 'Protected Co: nothing was decrypted on this computer');
  stopConnectors();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function printList() {
  console.log('Agent full access, end to end: the scenarios (nothing is started by --list)\n');
  for (const s of SCENARIOS) {
    console.log(`${s.id.padEnd(3)} ${s.title}${s.always ? '   (always runs)' : ''}`);
    for (const step of s.steps) console.log(`      - ${step}`);
  }
  console.log(`\nBuild: ${EXE}`);
  console.log('Run: npm run desktop:pack && npm run test:e2e:agent   (--only P0,P3,U runs setup, those, and the check on disk; --keep keeps the folder)');
}

function printSummary() {
  const rows = report.map((r) => [r.id, r.title, String(r.checks), String(r.checks - r.failures), String(r.failures), r.state === 'not run' ? '' : `${Math.round(r.ms / 1000)} s`, r.state]);
  const head = ['', 'Scenario', 'Checks', 'Passed', 'Failed', 'Time', 'Result'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i >= 2 && i <= 5 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  console.log(`\n${line(head)}`);
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  for (const r of report) if (r.error) console.log(`\n${r.id} stopped: ${r.error}`);
}

/** The ids of what this test started that may still run (for a message; nothing is stopped here). */
const ownIds = () => [...builds.filter((b) => b.pid && !b.exited).map((b) => b.pid), ...connectors.flatMap((c) => (c.exited ? c.started : [...c.known]))];

let cleaning = null;
async function cleanup() {
  cleaning ??= (async () => {
    // First, while the connectors still run: what each one started (Ironbooks for an agent).
    if (connectors.length) {
      const table = await processTable().catch(() => null);
      if (table) for (const c of connectors) c.track(table);
    }
    for (const c of connectors) c.stop();
    if (W.mail) await W.mail.stop().catch(() => {});
    for (const b of builds) if (b.page) b.page.close();
    // Then only what this test started, by id and path: the copies of the build it started (and
    // their trees), and what its connectors were seen to start.
    const running = builds.filter((b) => b.pid && !b.exited);
    const known = [...builds.flatMap((b) => [...b.knownPids]), ...connectors.flatMap((c) => c.started)];
    if (running.length || known.length) {
      const stopped = await stopOwnTree(
        running.map((b) => b.pid),
        EXE,
        known,
      ).catch(() => []);
      if (stopped.length) console.log(`Stopped the test's own processes (${stopped.join(', ')}).`);
      if (running.length) await sleep(1500);
    }
    // A copy this test started that is still running: Windows reports its path in a spelling the
    // test does not recognise (a subst drive, a junction, a short name), so the path check found
    // nothing to stop. It is still the very process this script started, stopped by its own handle.
    for (const b of running) {
      if (b.exited) continue;
      try {
        if (b.child.kill()) console.log(`Stopped the test build it started (process ${b.pid}) by its own handle.`);
      } catch {
        /* gone */
      }
    }
  })();
  return cleaning;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('node --experimental-websocket scripts/e2e-agent.mjs [--list] [--only P0,P1,...,U] [--keep]');
    return 0;
  }
  if (args.includes('--list')) {
    printList();
    return 0;
  }
  const onlyArg = args.find((a) => a.startsWith('--only'));
  const onlyText = onlyArg?.includes('=') ? onlyArg.split('=')[1] : onlyArg ? args[args.indexOf(onlyArg) + 1] : null;
  const only = onlyText ? new Set(onlyText.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) : null;
  const unknown = only ? [...only].filter((id) => !SCENARIOS.some((s) => s.id === id)) : [];
  if (unknown.length) {
    console.error(`No scenario called ${unknown.join(', ')}. --list shows them.`);
    return 1;
  }
  const keep = args.includes('--keep') || Boolean(process.env.E2E_KEEP);

  try {
    await refuseUnsafe();
  } catch (err) {
    console.error(`E2E AGENT ACCESS NOT RUN: ${err.message}`);
    return 1;
  }
  W.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-agent-'));
  console.log(`E2E agent access\n  build:  ${EXE}\n  folder: ${W.tmp}`);

  // Ctrl+C, Ctrl+Break, the console window closing (SIGHUP: Windows then gives about ten seconds)
  // or a plain kill: stop what this test started, keep the folder. A second one leaves at once.
  let interrupted = false;
  const onSignal = (sig) => {
    if (interrupted) {
      const ids = ownIds();
      console.error(`\n${sig} again: leaving at once.${ids.length ? ` What this test started may still run (process ${ids.join(', ')}).` : ''} Kept: ${W.tmp}`);
      process.exit(1);
    }
    interrupted = true;
    console.error(`\nInterrupted (${sig}): stopping what this test started.`);
    cleanup().finally(() => {
      console.error(`Kept: ${W.tmp}`);
      process.exit(1);
    });
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => onSignal(sig));

  for (const s of SCENARIOS) {
    const rec = { id: s.id, title: s.title, checks: 0, failures: 0, ms: 0, state: 'not run', error: null };
    report.push(rec);
    const wanted = s.always || !only || only.has(s.id);
    if (!wanted) continue;
    if (s.id !== 'S' && !W.setupDone && s.id !== 'F') continue;
    // Without a window there is nothing to close and nothing of the test's in the books: cleanup
    // stops the build (by id and path).
    if (s.id === 'F' && (!W.pid || !W.page)) continue;
    current = rec;
    console.log(`\n${s.id}  ${s.title}`);
    const t0 = Date.now();
    try {
      await s.run();
    } catch (err) {
      rec.failures++;
      rec.error = err instanceof Stop ? err.message : err instanceof Refuse ? `refused: ${err.message}` : (err?.stack || String(err));
      console.error(`  FAIL  ${s.id.padEnd(3)} stopped: ${err instanceof Stop || err instanceof Refuse ? err.message : err?.message ?? err}`);
    }
    rec.ms = Date.now() - t0;
    rec.state = rec.failures ? 'FAILED' : 'passed';
    current = null;
    if (interrupted) break;
  }

  await cleanup();
  printSummary();
  const failed = report.some((r) => r.failures > 0) || !W.setupDone;
  if (failed || keep) console.log(`\nKept: ${W.tmp}`);
  else {
    try {
      fs.rmSync(W.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.log(`\nCould not remove ${W.tmp}; remove it by hand.`);
    }
  }
  console.log(failed ? '\nE2E AGENT ACCESS FAILED' : '\nE2E AGENT ACCESS PASSED');
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('E2E ERROR:', err?.stack || err?.message || err);
    await cleanup().catch(() => {});
    if (W.tmp) console.error(`Kept: ${W.tmp}`);
    process.exit(1);
  });
