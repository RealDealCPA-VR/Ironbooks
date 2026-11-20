/**
 * End-to-end test of agent access (AGENT_ACCESS.md), driving the PACKAGED app (Windows) and the
 * connector that ships inside it:
 *
 *   npm run desktop:pack && npm run test:e2e:agent
 *
 * Runs in a throwaway settings folder (IRONBOOKS_USER_DATA) and a throwaway LOCALAPPDATA (working
 * copies and agent endpoint files), never the person's own Ironbooks data, and only ever touches
 * the test build's own processes (by executable path): an installed Ironbooks is left alone.
 *
 * Part A, Ironbooks open and a person signed in:
 *  1. a new company file (not protected with passwords) is set up; the Admin makes three agents
 *     in the app window: one that reads, one that proposes, one that posts and may work while
 *     nobody is signed in. Each gets its token once and the settings for this computer;
 *  2. the connector is started the way those settings say (the app's own program, run as Node);
 *     it lists its tools and reads the books;
 *  3. the reading agent is refused every change;
 *  4. the posting agent tries a dry run (nothing kept), enters a journal entry, and asking again
 *     with the same request id enters nothing twice;
 *  5. the proposing agent's entry waits; the Admin approves it in the app; it is then entered;
 *  6. a bank statement line is brought in, entered, and the account reconciled to 0.00.
 * Part B, Ironbooks closed:
 *  7. an agent without the permission cannot start Ironbooks, with or without the start setting;
 *  8. the agent with the permission starts Ironbooks with NO window, works, and the company file
 *     lock says an agent has it;
 *  9. another computer asks for the file and gets it at once: saved, closed, released, and what
 *     the agent entered is in the company file;
 * 10. a person starting Ironbooks while it runs for an agent gets its window;
 * 11. a company file protected with passwords is never opened for an agent.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect, dumpWindows, makeAssert, powershell, ownProcs, sleep, stopApps, until } from './e2e-helpers.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const format = require(path.join(root, 'electron', 'companyFileFormat.js'));
const companyLock = require(path.join(root, 'electron', 'companyLock.js'));
const { PGlite } = require('@electric-sql/pglite');

const EXE = process.env.E2E_EXE || path.join(root, 'release', 'win-unpacked', 'Ironbooks.exe');
const PORT = Number(process.env.E2E_CDP_PORT || 9344);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-agent-'));
const { assert, state } = makeAssert();
const failures = () => state.failures;
const ADMIN_PASSWORD = `e2e-${randomBytes(6).toString('hex')}`; // made here, for this throwaway file only

/** One throwaway "computer": its settings folder, its LOCALAPPDATA and a company file. */
function profile(name, companyName) {
  const dir = path.join(tmp, name);
  const p = {
    userData: path.join(dir, 'userData'),
    local: path.join(dir, 'Local'),
    companyFile: path.join(dir, 'Books', `${companyName}.ironbooks`),
    companyName,
  };
  fs.mkdirSync(p.userData, { recursive: true });
  fs.mkdirSync(p.local, { recursive: true });
  fs.mkdirSync(path.dirname(p.companyFile), { recursive: true });
  return p;
}

async function newCompanyFile(p) {
  const fileId = randomBytes(8).toString('hex');
  await format.writeCompanyFile(p.companyFile, {
    manifest: { formatVersion: 1, fileId, companyName: p.companyName, saveId: 'new', previousSaveId: null, savedAt: new Date().toISOString() },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: p.companyName })) },
      { name: '.file-id', data: Buffer.from(fileId) },
    ],
  });
  fs.writeFileSync(path.join(p.userData, 'config.json'), JSON.stringify({ companyFile: p.companyFile, recentCompanies: [p.companyFile], theme: { mode: 'light', accent: 'blue' } }));
}

function appEnv(p) {
  const env = { ...process.env, IRONBOOKS_USER_DATA: p.userData, LOCALAPPDATA: p.local, ELECTRON_ENABLE_LOGGING: '' };
  for (const k of ['BKA_AUTH_SECRET', 'ELECTRON_RUN_AS_NODE', 'IRONBOOKS_AGENT_TOKEN', 'IRONBOOKS_AGENT_TOKEN_FILE', 'IRONBOOKS_AGENT_START', 'IRONBOOKS_AGENT_ENDPOINT_DIR']) delete env[k];
  return env;
}

/** Start the app the way a person does (with a debugging port, so the test can drive its page). */
function launch(p, args = [`--remote-debugging-port=${PORT}`]) {
  return spawn(EXE, args, { env: appEnv(p), stdio: 'ignore', detached: false });
}

/**
 * Is the test build's APP running? The connector runs as the same program (Ironbooks.exe as Node,
 * with ironbooks-mcp.mjs on its command line), so it is left out of the count.
 */
async function running() {
  const exe = EXE.replace(/'/g, "''");
  const r = await powershell(
    `(Get-CimInstance Win32_Process -Filter "Name='Ironbooks.exe'" | Where-Object { $_.ExecutablePath -eq '${exe}' -and $_.CommandLine -notmatch 'ironbooks-mcp\\.mjs' } | Measure-Object).Count`,
  );
  return Number(r.out) > 0;
}
/** Does the test build show a window? (A process with a main window handle.) */
async function windowShown() {
  const r = await powershell(`(${ownProcs(EXE)} | Where-Object { $_.MainWindowHandle -ne 0 } | Measure-Object).Count`);
  return Number(r.out) > 0;
}
/** Ask the window to close, the way the X button does (the app saves and quits). */
const closeWindow = () => powershell(`${ownProcs(EXE)} | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "$($_.Id) [$($_.MainWindowTitle)] $($_.CloseMainWindow())" }`);

// --- the connector, started the way the Agents tab's settings say -------------------------------
class Connector {
  constructor(connection, token, p, extraEnv = {}) {
    const env = { ...appEnv(p), ...connection.env, ...extraEnv, [connection.tokenEnv]: token };
    this.child = spawn(connection.command, connection.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.id = 0;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.child.stderr.on('data', (d) => (this.stderr += String(d)));
    this.child.stdout.on('data', (d) => {
      this.buffer += String(d);
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter(msg);
        }
      }
    });
  }
  rpc(method, params = {}, timeoutMs = 180_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer (${this.stderr.slice(-300)})`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async start() {
    const init = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ironbooks-e2e', version: '1' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return init.result;
  }
  /** Call a tool. { ok, data, text }: data is the tool's JSON answer when it gave one. */
  async tool(name, args = {}) {
    const msg = await this.rpc('tools/call', { name, arguments: args });
    const text = (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n') || msg.error?.message || '';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { ok: !msg.error && msg.result?.isError !== true, data, text };
  }
  stop() {
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      /* gone */
    }
  }
}
const connectors = [];
function connector(connection, token, p, extraEnv) {
  const c = new Connector(connection, token, p, extraEnv);
  connectors.push(c);
  return c;
}

/** Rows of a query against the books inside a (not protected) company file. */
async function queryCompanyFile(file, sqlText) {
  const out = path.join(tmp, `check-${randomBytes(3).toString('hex')}`);
  await format.extractCompanyFile(file, out, {});
  const pg = new PGlite(out);
  try {
    return (await pg.query(sqlText)).rows;
  } finally {
    await pg.close();
  }
}

const inPage = (page, body) => page.eval(`(async () => { const j = (r) => r.json(); const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); ${body} })()`);

async function setUpAdmin(page, p, protect) {
  const atSignup = await until(() => page.eval('location.pathname').then((x) => x === '/signup'), 90_000);
  assert(atSignup, `${p.companyName}: a new company file opens on the Admin setup screen`);
  const status = await inPage(
    page,
    `return (await post('/api/auth/signup', { name: 'Pat Owner', email: 'Admin', password: ${JSON.stringify(ADMIN_PASSWORD)}, companyName: ${JSON.stringify(p.companyName)}${protect ? '' : ', protect: false'} })).status;`,
  );
  assert(status === 201, `${p.companyName}: the Admin is set up`);
  await page.eval(`window.bookkeeper && window.bookkeeper.company.signedIn('Admin')`);
}

const makeAgent = (page, body) => inPage(page, `const r = await post('/api/agents', ${JSON.stringify(body)}); return { status: r.status, body: await j(r) };`);

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`Packaged app not found: ${EXE} (run npm run desktop:pack)`);
  if (await running()) throw new Error('The test build of Ironbooks is already running; close it first.');
  const A = profile('office', 'Agent Test Co');
  console.log(`E2E agent access: ${A.companyFile}`);
  await newCompanyFile(A);

  // ---------------------------------------------------------------- Part A: open, signed in
  launch(A);
  let page = await connect(PORT, (u) => /^http:\/\/localhost:\d+\//.test(u));
  await setUpAdmin(page, A, false);

  // 1. Three agents, made by the Admin in the app window.
  const reader = await makeAgent(page, { name: 'Reader', roleKeys: ['view_only'], mode: 'read_only' });
  const proposer = await makeAgent(page, { name: 'Drafter', roleKeys: ['bookkeeper'], mode: 'propose' });
  const poster = await makeAgent(page, { name: 'Night closer', roleKeys: ['full_access'], mode: 'post', unattended: true });
  assert(reader.status === 201 && proposer.status === 201 && poster.status === 201, 'the Admin makes three agents');
  const conn = reader.body.connection;
  assert(conn && conn.installed === true && path.resolve(conn.command) === path.resolve(EXE), 'the settings name the app\'s own program');
  assert(conn && fs.existsSync(conn.args[0]) && /resources[\\/]mcp[\\/]ironbooks-mcp\.mjs$/.test(conn.args[0]), 'and the connector that ships inside it');
  assert(conn.env.ELECTRON_RUN_AS_NODE === '1' && !('IRONBOOKS_AGENT_START' in conn.env), 'an ordinary agent\'s settings start nothing');
  assert(poster.body.connection.env.IRONBOOKS_AGENT_START === '1', 'only the agent allowed to work unattended gets the start setting');
  const listed = await inPage(page, `return await fetch('/api/agents').then(j);`);
  assert(JSON.stringify(listed).indexOf(reader.body.token) < 0 && listed.agents.length === 3, 'the list of agents never shows a token');
  assert(listed.agents.find((a) => a.name === 'Night closer')?.unattended === true, 'the list marks the agent that may work unattended');

  // 2. The connector, started as the settings say.
  const r = connector(conn, reader.body.token, A);
  const init = await r.start();
  assert(init?.serverInfo?.name === 'ironbooks', 'the connector starts under the app\'s own program and answers');
  const tools = (await r.rpc('tools/list')).result.tools;
  assert(tools.length === 57, `it offers its tools (${tools.length})`);
  const info = await r.tool('get_company_info');
  assert(info.ok && info.data?.company?.name === 'Agent Test Co' && info.data?.agent?.name === 'Reader', 'the reading agent sees which books these are and who it is');
  const accounts = await r.tool('list_accounts');
  assert(accounts.ok && accounts.data?.accounts?.length > 10, 'and reads the chart of accounts');
  const byCode = (code) => accounts.data.accounts.find((a) => String(a.number) === code)?.id;
  const cash = byCode('1000');
  const supplies = byCode('6300') ?? accounts.data.accounts.find((a) => /expense/i.test(String(a.type)))?.id;
  assert(cash && supplies, 'the accounts the test enters into exist');
  /** The journal entries whose memo or description has this text (distinct ids). */
  const entriesWith = async (c, text) => {
    const out = await c.tool('find_transactions', { memo: text, date_from: '2026-01-01', date_to: '2026-12-31' });
    return new Set((out.data?.rows ?? []).filter((row) => row.journal_entry_id).map((row) => row.journal_entry_id));
  };
  const je = (amount, description) => ({ date: '2026-03-02', description, lines: [{ account_id: supplies, debit: amount }, { account_id: cash, credit: amount }] });

  // 3. Read only means read only.
  const refused = await r.tool('enter_journal_entry', { ...je('5.00', 'Should not exist'), request_id: 'e2e-ro-1' });
  assert(!refused.ok && /can only read/.test(refused.text), 'the reading agent is refused a change, in plain words');

  // 4. Post: dry run, enter, never twice.
  const w = connector(poster.body.connection, poster.body.token, A);
  await w.start();
  const dry = await w.tool('enter_journal_entry', { ...je('41.00', 'Dry run only'), dry_run: true });
  assert(dry.ok && dry.data?.outcome === 'dry_run' && dry.data?.would_post?.length === 1, 'a dry run shows what would be entered');
  const first = await w.tool('enter_journal_entry', { ...je('64.20', 'Supplies from the agent'), request_id: 'e2e-je-1' });
  assert(first.ok && first.data?.outcome === 'posted', `the posting agent enters a journal entry (${first.text.slice(0, 120)})`);
  const again = await w.tool('enter_journal_entry', { ...je('64.20', 'Supplies from the agent'), request_id: 'e2e-je-1' });
  assert(again.ok && again.data?.repeated === true && again.data?.result?.id === first.data?.result?.id, 'the same request id returns the first answer');
  const once = await entriesWith(w, 'Supplies from the agent');
  assert(once.size === 1 && (await entriesWith(w, 'Dry run only')).size === 0 && (await entriesWith(w, 'Should not exist')).size === 0, `the books hold that entry once, and nothing from the dry run or the refusal (${once.size})`);
  const noId = await w.tool('enter_journal_entry', je('7.00', 'No request id'));
  assert(!noId.ok && /request_id/.test(noId.text), 'a change without a request id is not sent');

  // 5. Propose: waits for a person.
  const d = connector(proposer.body.connection, proposer.body.token, A);
  await d.start();
  const proposed = await d.tool('enter_journal_entry', { ...je('18.75', 'Drafted by the agent'), request_id: 'e2e-prop-1' });
  assert(proposed.ok && proposed.data?.outcome === 'proposed', `the proposing agent's entry waits for approval (${proposed.text.slice(0, 120)})`);
  assert((await entriesWith(w, 'Drafted by the agent')).size === 0, 'nothing is in the books yet');
  const waiting = await inPage(page, `return await fetch('/api/ai/proposals').then(j);`);
  const mine = (waiting.proposals ?? []).find((x) => JSON.stringify(x).includes('Drafted by the agent'));
  assert(mine && JSON.stringify(mine).includes('Drafter'), 'the Admin sees it under Waiting for your approval, with the agent\'s name');
  const approved = mine ? await inPage(page, `const r = await post('/api/ai/proposals/${mine?.id}', { action: 'approve' }); return { status: r.status, body: await j(r) };`) : { status: 0 };
  assert(approved.status === 200, `the Admin approves it (${JSON.stringify(approved.body ?? {}).slice(0, 160)})`);
  assert((await entriesWith(w, 'Drafted by the agent')).size === 1, 'and then it is entered');
  const outcome = await d.tool('list_my_proposals');
  assert(outcome.ok && /approved|posted/.test(JSON.stringify(outcome.data)), 'the agent can see what became of its proposal');

  // 6. A bank statement line, entered and reconciled.
  const acct = await w.tool('add_account', { name: 'E2E Checking', account_type: 'Bank', request_id: 'e2e-acct-1' });
  assert(acct.ok && acct.data?.result?.id, `the agent adds a bank account to the chart (${acct.text.slice(0, 120)})`);
  const ledgerId = acct.data?.result?.id;
  const linked = await inPage(page, `const r = await post('/api/bank-accounts', { accountId: ${JSON.stringify(ledgerId)}, bankName: 'First Test Bank', accountNumber: '000123456789' }); return { status: r.status, body: await j(r) };`);
  assert(linked.status === 201, 'a person sets the account up for statements, in the app');
  const bankId = linked.body?.id;
  const banks = await w.tool('list_bank_accounts');
  const bank = banks.data?.bank_accounts?.find((b) => b.bank_account_id === bankId);
  assert(bank && !JSON.stringify(bank).includes('000123456789'), 'the agent sees the bank account, never its full number');
  const statement = { bank_account_id: bankId, statement_kind: 'bank', opening_balance: '0.00', closing_balance: '-30.00', lines: [{ date: '2026-05-06', description: 'OFFICE DEPOT 4411', amount: '-30.00' }] };
  const imported = await w.tool('import_statement_lines', { ...statement, request_id: 'e2e-import-1' });
  assert(imported.ok && imported.data?.result?.added_to_feed === 1, `a statement line is brought into the bank feed (${imported.text.slice(0, 140)})`);
  const feed = await w.tool('get_bank_feed', { bank_account_id: bankId });
  const line = feed.data?.lines?.[0];
  const cat = await w.tool('categorize_bank_line', { bank_transaction_id: line?.bank_transaction_id, account_id: supplies, payee: 'Office Depot', request_id: 'e2e-cat-1' });
  assert(cat.ok && cat.data?.outcome === 'posted', `the line is entered as an expense (${cat.text.slice(0, 140)})`);
  const started = await w.tool('start_reconciliation', { bank_account_id: bankId, statement_date: '2026-05-31', statement_balance: '-30.00', request_id: 'e2e-recon-1' });
  const reconId = started.data?.result?.reconciliation_id;
  assert(started.ok && reconId, `a reconciliation is started (${started.text.slice(0, 140)})`);
  const sheet = await w.tool('get_reconciliation', { reconciliation_id: reconId });
  const lineIds = (sheet.data?.lines ?? []).map((l) => l.line_id);
  const early = await w.tool('finish_reconciliation', { reconciliation_id: reconId, dry_run: true });
  assert(lineIds.length === 1 && !early.ok, 'it cannot be finished while the difference is not 0.00');
  const marked = await w.tool('mark_cleared', { reconciliation_id: reconId, line_ids: lineIds, request_id: 'e2e-mark-1' });
  assert(marked.ok, 'the line is ticked off');
  const done = await w.tool('finish_reconciliation', { reconciliation_id: reconId, request_id: 'e2e-finish-1' });
  assert(done.ok && done.data?.result?.status === 'completed', `and the reconciliation finishes at 0.00 (${done.text.slice(0, 140)})`);

  // ---------------------------------------------------------------- Part B: Ironbooks closed
  for (const c of connectors.splice(0)) c.stop();
  await page.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
  page.close();
  assert(await until(async () => !(await running()), 120_000), 'closing the window quits the app');
  assert(companyLock.readHolder(A.companyFile) === null, 'and releases the company file');

  // 7. Without the permission, nothing starts Ironbooks.
  const r2 = connector(conn, reader.body.token, A);
  await r2.start();
  const closed = await r2.tool('get_company_info');
  assert(!closed.ok && /not ready/i.test(closed.text), 'with Ironbooks closed, an ordinary agent is told to wait for a person');
  await sleep(3000);
  assert(!(await running()), 'and Ironbooks was not started');

  // 8. With it, Ironbooks opens the company file with no window.
  const w2 = connector(poster.body.connection, poster.body.token, A);
  await w2.start();
  const t0 = Date.now();
  const woke = await w2.tool('get_company_info');
  assert(woke.ok && woke.data?.agent?.name === 'Night closer', `the agent allowed to work unattended gets the books (after ${Math.round((Date.now() - t0) / 1000)} s; ${woke.text.slice(0, 120)})`);
  assert(await running(), 'Ironbooks is running');
  assert(!(await windowShown()), 'with no window');
  const holder = companyLock.readHolder(A.companyFile);
  assert(holder && /agent/.test(String(holder.owner?.appUser ?? '')), `the company file's lock says an agent has it ("${holder?.owner?.appUser}")`);
  const night = await w2.tool('enter_journal_entry', { ...je('12.00', 'Entered while closed'), request_id: 'e2e-night-1' });
  assert(night.ok && night.data?.outcome === 'posted', `it enters a journal entry (${night.text.slice(0, 120)})`);
  // The start setting gives an agent without the permission nothing, even now.
  const r3 = connector(conn, reader.body.token, A, { IRONBOOKS_AGENT_START: '1' });
  await r3.start();
  const still = await r3.tool('get_company_info');
  assert(!still.ok, 'an agent without the permission is still refused while nobody is signed in');

  // 9. Another computer asks for the file: it gets it at once.
  const req = companyLock.requestAccess(A.companyFile, { appUser: 'Bob', computer: 'BACK-OFFICE', osUser: 'bob' });
  const answer = await until(() => companyLock.readResponse(A.companyFile, req) || (companyLock.readHolder(A.companyFile) === null && { decision: 'released' }), 60_000);
  assert(answer && (answer.decision === 'handoff' || answer.decision === 'released'), `another computer asking is handed the file without anyone answering (${answer?.decision})`);
  assert(await until(async () => !(await running()), 120_000), 'Ironbooks saves, closes the file and quits');
  assert(companyLock.readHolder(A.companyFile) === null, 'the company file is released');
  companyLock.cancelRequest?.(A.companyFile, req);
  const rows = await queryCompanyFile(A.companyFile, `select je.description, a.name as agent from journal_entries je left join agents a on a.id = je.agent_id where je.description in ('Supplies from the agent', 'Entered while closed', 'Drafted by the agent') order by je.description`);
  const who = Object.fromEntries(rows.map((x) => [x.description, x.agent]));
  assert(who['Entered while closed'] === 'Night closer' && who['Supplies from the agent'] === 'Night closer', 'what the agent entered is in the company file, under its name');
  assert(who['Drafted by the agent'] === 'Drafter', 'and so is the approved proposal, under the agent that drafted it');

  // 10. A person starting Ironbooks while it runs for an agent gets its window.
  for (const c of connectors.splice(0)) c.stop();
  // 10a. Started by the connector, exactly as for a real agent.
  const w3 = connector(poster.body.connection, poster.body.token, A);
  await w3.start();
  const woke2 = await w3.tool('list_accounts');
  assert(woke2.ok && (await running()) && !(await windowShown()), 'started again for the agent, with no window');
  const holderPid = companyLock.readHolder(A.companyFile)?.owner?.pid;
  launch(A, []); // a person double-clicks Ironbooks
  const shownBy = await until(async () => {
    const r = await powershell(`${ownProcs(EXE)} | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" }`);
    return r.out.split(/\r?\n/).filter(Boolean).find((line) => Number(line.split('|')[0]) === holderPid) ?? null;
  }, 60_000);
  assert(shownBy, `a person starting Ironbooks gets the window of the one already running (${shownBy ?? (await powershell(`${ownProcs(EXE)} | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" }`)).out})`);
  await sleep(3000);
  const others = (await powershell(`${ownProcs(EXE)} | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne ${holderPid ?? 0} } | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" }`)).out;
  // Not checked: the person's own second launch may leave an "Ironbooks could not start" box. That
  // happens on any second launch of Ironbooks (main and 1.7.19 too, no agents involved) and is
  // tracked separately; it is not part of agent access.
  if (others) console.log(`    (note: the second launch also showed: ${others.replace(/\r?\n/g, '; ')})`);
  assert((await w3.tool('list_accounts')).ok, 'the agent keeps working');
  await sleep(1500);
  const asked = await closeWindow();
  const quit = await until(async () => !(await running()), 120_000);
  if (!quit) {
    console.log(`    (close asked: ${JSON.stringify(asked)}; window shown: ${await windowShown()}; lock: ${JSON.stringify(companyLock.readHolder(A.companyFile)?.owner ?? null)})`);
    console.log((await dumpWindows(EXE)).split('\n').slice(0, 30).map((x) => `    | ${x}`).join('\n'));
  }
  assert(quit, 'closing that window saves and quits as usual');
  assert(companyLock.readHolder(A.companyFile) === null, 'and releases the company file');
  for (const c of connectors.splice(0)) c.stop();

  // 11. A company file protected with passwords is never opened for an agent.
  const B = profile('protected', 'Protected Co');
  await newCompanyFile(B);
  launch(B);
  page = await connect(PORT, (u) => /^http:\/\/localhost:\d+\//.test(u));
  await setUpAdmin(page, B, true);
  const guarded = await makeAgent(page, { name: 'Night closer', roleKeys: ['full_access'], mode: 'post', unattended: true });
  assert(guarded.status === 201, 'Protected Co: an agent is made with the unattended switch');
  await page.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
  page.close();
  assert(await until(async () => !(await running()), 120_000), 'Protected Co: the app closes');
  assert(format.isSealedManifest(format.readCompanyManifest(B.companyFile)), 'Protected Co: the company file is protected with passwords');
  const g = connector(guarded.body.connection, guarded.body.token, B);
  await g.start();
  const no = await g.tool('get_company_info');
  assert(!no.ok && /passwords|sign in/i.test(no.text), `Protected Co: the agent is told a person has to open it (${no.text.slice(0, 100)})`);
  assert(await until(async () => !(await running()), 60_000), 'Protected Co: Ironbooks did not stay open');
  assert(companyLock.readHolder(B.companyFile) === null, 'Protected Co: the company file is not held');
  const plain = fs.existsSync(B.local) && fs.readdirSync(B.local, { recursive: true }).some((n) => String(n).endsWith('PG_VERSION'));
  assert(!plain, 'Protected Co: nothing was decrypted on this computer');

  console.log(failures() === 0 ? '\nE2E AGENT ACCESS PASSED' : `\nE2E AGENT ACCESS FAILED (${failures()} assertion(s))`);
}

let crashed = false;
main()
  .catch((e) => {
    crashed = true;
    console.error('E2E ERROR:', e.stack || e.message);
  })
  .finally(async () => {
    for (const c of connectors.splice(0)) c.stop();
    if (await running()) {
      await stopApps(EXE);
      await sleep(1500);
    }
    if (!process.env.E2E_KEEP) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* best effort */
      }
    } else console.log(`Kept: ${tmp}`);
    process.exit(!crashed && failures() === 0 ? 0 : 1);
  });
