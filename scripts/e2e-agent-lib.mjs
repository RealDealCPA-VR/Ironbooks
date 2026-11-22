/**
 * Pieces of the agent end-to-end test (scripts/e2e-agent.mjs) that are about staying safe on a
 * computer people work on, plus the two stand-ins it talks to. Used by that script only.
 *
 *  - Processes are found and stopped by process id and executable path, never by name: the MCP
 *    connector runs as Ironbooks.exe too (as Node), and so may an office copy of Ironbooks or
 *    another person's connector. A process is stopped only when it is the one the test started, or
 *    one that process started, AND it runs the test's own build. A connector that may start
 *    Ironbooks (an agent allowed to work while nobody is signed in) has what it starts tracked by
 *    id while it runs (Connector.track), since that copy is detached from it.
 *  - The debugging port is a free one picked here, and the test drives a page on it only once
 *    the program listening there is the one it started.
 *  - The mail server is a catcher on 127.0.0.1 that keeps what it is sent in memory and passes
 *    nothing on: no real mail ever leaves.
 *  - The connector is the one the Agents tab's settings start (the app's own program as Node),
 *    spoken to over its standard input and output like any MCP client would.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { powershell } from './e2e-helpers.mjs';

/** Text inside single quotes in PowerShell. */
const psq = (s) => String(s).replace(/'/g, "''");

/** The same file or folder, as Windows compares paths (case does not matter). */
export function samePath(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(String(a));
  const y = path.resolve(String(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const spellings = new Map();
/**
 * The ways Windows may report the test build's path: as the test names it, and with links,
 * subst drives and short names resolved. Comparing with both keeps the test's own processes
 * recognisable when the checkout sits behind a junction or a subst drive; anything else still
 * has to run the very same file.
 */
export function exeSpellings(exe) {
  const key = String(exe);
  let out = spellings.get(key);
  if (!out) {
    out = [path.resolve(key)];
    try {
      const real = fs.realpathSync.native(key);
      if (!out.some((s) => samePath(s, real))) out.push(path.resolve(real));
    } catch {
      /* not there: only the name the test gave */
    }
    spellings.set(key, out);
  }
  return out;
}

/** `p` is the test build's executable (by path, in any of its spellings). */
export function sameExe(p, exe) {
  return Boolean(p) && exeSpellings(exe).some((s) => samePath(p, s));
}

/** The spellings of `exe` as a PowerShell array of quoted strings. */
const psExes = (exe) => `@(${exeSpellings(exe).map((s) => `'${psq(s)}'`).join(', ')})`;

/** `child` is `dir` itself or somewhere inside it. */
export function within(child, dir) {
  if (!child || !dir) return false;
  const rel = path.relative(path.resolve(String(dir)), path.resolve(String(child)));
  if (rel === '') return true;
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(rel)) return false;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A port nothing listens on right now, on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

/**
 * Every process on this computer: id, parent id and executable path (null when Windows will not
 * say, for another account's process). Read by id and path only.
 * @returns {Promise<Map<number, { pid: number, ppid: number, exe: string | null }>>}
 */
export async function processTable() {
  const r = await powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress', 60_000);
  if (!r.ok || !r.out) throw new Error('Windows did not list its processes (Get-CimInstance Win32_Process failed).');
  let rows = JSON.parse(r.out);
  if (!Array.isArray(rows)) rows = [rows];
  const out = new Map();
  for (const x of rows) {
    const pid = Number(x.ProcessId);
    if (Number.isInteger(pid) && pid > 0) out.set(pid, { pid, ppid: Number(x.ParentProcessId) || 0, exe: typeof x.ExecutablePath === 'string' ? x.ExecutablePath : null });
  }
  return out;
}

/** The ids of the processes running `exe` (by path). */
export async function pidsRunning(exe, table) {
  const t = table ?? (await processTable());
  return [...t.values()].filter((p) => sameExe(p.exe, exe)).map((p) => p.pid);
}

/**
 * `root` and every process it started, and they started, that runs `exe`. A process that runs
 * another program is not followed or counted: it is not the test build.
 */
export function treeOf(root, exe, table) {
  const out = new Set();
  const me = table.get(root);
  if (!me || !sameExe(me.exe, exe)) return out;
  out.add(root);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table.values()) {
      if (!out.has(p.pid) && out.has(p.ppid) && sameExe(p.exe, exe)) {
        out.add(p.pid);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Of `pids`, the ones that still run `exe` and show a window (by id and path: it looks, it never
 * touches). Null when Windows would not say, so a caller can fail closed.
 */
export async function windowsShown(pids, exe) {
  const ids = [...pids].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const r = await powershell(
    `$exes = ${psExes(exe)}
foreach ($id in @(${ids.join(',')})) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.Path -and ($exes -icontains $p.Path) -and $p.MainWindowHandle -ne 0) { $id }
}
exit 0`,
    30_000,
  );
  if (!r.ok) return null;
  return r.out
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** The ids of the processes listening on `port` (TCP, this computer). */
export async function listenerPids(port) {
  const r = await powershell(
    `if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { exit 3 }
Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
exit 0`,
    30_000,
  );
  const ids = r.out
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length || r.ok) return [...new Set(ids)];
  // Get-NetTCPConnection is missing (an old Windows): read netstat instead.
  const n = await powershell('netstat -ano -p TCP', 30_000);
  const out = new Set();
  for (const line of n.out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && Number(m[1]) === Number(port)) out.add(Number(m[2]));
  }
  return [...out];
}

/**
 * Stop the test's own processes: each of `roots` (one id or several) and its tree (treeOf), plus
 * `known` (ids seen in such a tree earlier, whose parent may be gone by now), each only while it
 * still runs `exe`. The path is checked again right before each one is stopped, so an id Windows
 * has since given to another program is left alone. Returns the ids it stopped.
 */
export async function stopOwnTree(roots, exe, known = []) {
  const table = await processTable();
  const ids = new Set();
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (Number.isInteger(root) && root > 0) for (const pid of treeOf(root, exe, table)) ids.add(pid);
  }
  for (const pid of known) if (sameExe(table.get(pid)?.exe, exe)) ids.add(pid);
  if (!ids.size) return [];
  const list = [...ids].join(',');
  await powershell(
    `$exes = ${psExes(exe)}
foreach ($id in @(${list})) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if ($p -and $p.ExecutablePath -and ($exes -icontains $p.ExecutablePath)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}`,
    60_000,
  );
  return [...ids];
}

// ---------------------------------------------------------------------------
// The mail catcher
// ---------------------------------------------------------------------------

/**
 * A mail server on 127.0.0.1 that accepts every message and keeps it here, in memory: it relays
 * nothing, so no real mail leaves this computer. Enough SMTP for one sender at a time (EHLO,
 * MAIL, RCPT, DATA), no sign-in and no encryption (the company's set-up says "None", which
 * Ironbooks allows only for a server on this computer or its own network).
 */
export class MailCatcher {
  constructor() {
    /** @type {Array<{ from: string | null, to: string[], subject: string | null, data: string, at: number }>} */
    this.messages = [];
    /** Open connections, so stop() never waits on one the sender keeps open (a pooled transport). */
    this.sockets = new Set();
    this.server = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      this.session(sock);
    });
    this.port = 0;
  }
  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = /** @type {import('node:net').AddressInfo} */ (this.server.address()).port;
        resolve(this.port);
      });
    });
  }
  stop() {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve(undefined)));
  }
  session(sock) {
    sock.setEncoding('utf8');
    sock.setTimeout(60_000, () => sock.destroy());
    sock.on('error', () => {});
    let buf = '';
    let inData = false;
    let cur = { from: null, to: [], data: '' };
    const say = (line) => sock.write(`${line}\r\n`);
    const addr = (line) => (/<([^>]*)>/.exec(line)?.[1] ?? line.split(':').slice(1).join(':').trim()) || null;
    say('220 ironbooks-e2e mail catcher (keeps everything, sends nothing)');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 40 * 1024 * 1024) return sock.destroy();
      for (;;) {
        if (inData) {
          const text = `\r\n${buf}`;
          const end = text.indexOf('\r\n.\r\n');
          if (end < 0) break;
          const data = text.slice(2, Math.max(2, end));
          buf = text.slice(end + 5);
          inData = false;
          const subject = /^Subject:\s*(.*)$/im.exec(data)?.[1]?.trim() ?? null;
          this.messages.push({ from: cur.from, to: cur.to, subject, data: data.replace(/^\.\./gm, '.'), at: Date.now() });
          cur = { from: null, to: [], data: '' };
          say('250 2.0.0 kept (not sent anywhere)');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') sock.write('250-ironbooks-e2e\r\n250 8BITMIME\r\n');
        else if (cmd === 'HELO') say('250 ironbooks-e2e');
        else if (cmd === 'MAIL') {
          cur = { from: addr(line), to: [], data: '' };
          say('250 2.1.0 ok');
        } else if (cmd === 'RCPT') {
          cur.to.push(addr(line));
          say('250 2.1.5 ok');
        } else if (cmd === 'DATA') {
          inData = true;
          say('354 end with <CRLF>.<CRLF>');
        } else if (cmd === 'RSET') {
          cur = { from: null, to: [], data: '' };
          say('250 ok');
        } else if (cmd === 'NOOP') say('250 ok');
        else if (cmd === 'QUIT') {
          say('221 bye');
          sock.end();
          return;
        } else say('502 5.5.2 not here');
      }
    });
  }
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

/** The settings a connector may carry (lib/agent/connection.ts): anything else is refused. */
const CONNECTOR_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'IRONBOOKS_AGENT_START']);
const TOKEN_ENV = 'IRONBOOKS_AGENT_TOKEN';
/** Starts Ironbooks when it is closed (mcp/client.mjs START_ENV). */
const START_ENV = 'IRONBOOKS_AGENT_START';
/** Points the connector at another endpoint folder (mcp/client.mjs ENDPOINT_DIR_ENV). */
const ENDPOINT_DIR_ENV = 'IRONBOOKS_AGENT_ENDPOINT_DIR';

/**
 * The MCP connector, started exactly as the Agents tab's settings say (`connection`), with the
 * agent's token in the variable they name. `env` is the throwaway computer's environment.
 *
 * Refused before anything starts: settings that name another program than the test build
 * (`opts.exe`), or carry a setting the Agents tab does not give (one could point the connector or
 * the app at another profile). The endpoint folder is always the throwaway LOCALAPPDATA's.
 *
 * A connector can start Ironbooks itself (IRONBOOKS_AGENT_START=1, mcp/client.mjs). That copy is
 * the connector's child, not the test's, so it is stopped only when it is tracked: by default the
 * setting is taken out, and only a caller that tracks what the connector starts (track(), by id
 * and path) passes `opts.mayStartApp`. Only this object's own child process, and what track() saw
 * it start, are ever stopped.
 *
 * @param {{ exe: string, mayStartApp?: boolean, extraEnv?: Record<string, string> }} opts
 */
export class Connector {
  constructor(connection, token, env, opts) {
    if (!opts?.exe || !connection || !sameExe(connection.command, opts.exe)) {
      throw new Error(`the connector settings start ${connection?.command ?? 'nothing'}, not the test build`);
    }
    if (connection.tokenEnv !== TOKEN_ENV) throw new Error(`the connector settings put the token in ${connection.tokenEnv}, not ${TOKEN_ENV}`);
    const extra = Object.keys(connection.env ?? {}).filter((k) => !CONNECTOR_ENV.has(k));
    if (extra.length) throw new Error(`the connector settings carry ${extra.join(', ')}, which this test does not pass on`);
    const childEnv = { ...env, ...connection.env, ...(opts.extraEnv ?? {}), [TOKEN_ENV]: token };
    delete childEnv[ENDPOINT_DIR_ENV];
    if (opts.mayStartApp !== true) delete childEnv[START_ENV];
    this.exe = opts.exe;
    this.mayStartApp = childEnv[START_ENV] === '1';
    /** Every process seen in this connector's tree (itself included), by id: see track(). */
    this.known = new Set();
    this.child = spawn(connection.command, connection.args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    if (Number.isInteger(this.child.pid)) this.known.add(this.child.pid);
    this.id = 0;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.exited = null;
    this.child.on('exit', (code) => {
      this.exited = { code };
      for (const [, waiter] of this.pending) waiter({ error: { message: `the connector stopped (exit ${code}): ${this.stderr.slice(-300)}` } });
      this.pending.clear();
    });
    this.child.on('error', (err) => (this.stderr += `\n${err.message}`));
    this.child.stderr.on('data', (d) => {
      this.stderr = (this.stderr + String(d)).slice(-20_000);
    });
    this.child.stdout.on('data', (d) => {
      this.buffer += String(d);
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = msg && msg.id !== undefined ? this.pending.get(msg.id) : null;
        if (waiter) {
          this.pending.delete(msg.id);
          waiter(msg);
        }
      }
    });
  }
  get pid() {
    return this.child.pid;
  }
  /**
   * Note what this connector has started that runs the test build (Ironbooks for its agent), by
   * id, while the connector still runs: the copy it starts is detached, so once the connector is
   * gone its tree can no longer be read, and these ids are what is stopped (stopOwnTree checks the
   * path again first).
   */
  track(table) {
    if (!this.exited) for (const pid of treeOf(this.pid, this.exe, table)) this.known.add(pid);
    return this.known;
  }
  /** What the connector started, without the connector itself. */
  get started() {
    return [...this.known].filter((pid) => pid !== this.pid);
  }
  rpc(method, params = {}, timeoutMs = 180_000) {
    if (this.exited) return Promise.reject(new Error(`the connector is not running (exit ${this.exited.code}): ${this.stderr.slice(-300)}`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer within ${Math.round(timeoutMs / 1000)} s (${this.stderr.slice(-300)})`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async start() {
    const init = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ironbooks-e2e', version: '2' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return init.result;
  }
  async tools() {
    return (await this.rpc('tools/list')).result?.tools ?? [];
  }
  /** Call a tool: { ok, data, text }. `data` is the tool's JSON answer when it gave one. */
  async tool(name, args = {}, timeoutMs) {
    const msg = await this.rpc('tools/call', { name, arguments: args }, timeoutMs);
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
    } catch {
      /* gone */
    }
    try {
      if (!this.exited) this.child.kill();
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------------------
// The person's window
// ---------------------------------------------------------------------------

/**
 * One request from the person's own Ironbooks window (the page over the DevTools protocol): it
 * carries that person's sign-in and the window's launch pass, exactly as a click there would.
 * Never an agent's token. { status, body, text }: body is the parsed JSON answer, when it is JSON.
 */
export async function windowCall(page, method, url, body, headers = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  return page.eval(`(async () => {
    const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { j = null; }
    return { status: r.status, body: j, text: j === null ? t.slice(0, 500) : '' };
  })()`);
}

/**
 * The same request sent by another program on this computer with an agent's token, straight to
 * the app's server (no window, no launch pass): what an agent could try outside the connector.
 */
export async function agentHttp(appPort, token, method, url, body) {
  const res = await fetch(`http://127.0.0.1:${appPort}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text: json === null ? text.slice(0, 500) : '' };
}
