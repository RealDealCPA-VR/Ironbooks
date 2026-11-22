/**
 * How the connector reaches Ironbooks: the app's own server on this computer, nothing else.
 *
 *  - It only ever connects to 127.0.0.1. The address is fixed here; nothing read from a file or
 *    the environment can point it anywhere else.
 *  - It finds the port in the endpoint file Ironbooks writes while the company file is open and
 *    has an agent (lib/agent/endpointFile.ts), in the signed-in person's own profile folder.
 *  - Before the token goes anywhere, the program on that port must prove it is the Ironbooks that
 *    wrote the file: it answers a random question with a keyed hash only that server can make.
 *    The token is then sent on that same connection, and only on a connection that passed.
 *  - It reads (GET), and it sends an agent's actions and verbs to one route (POST
 *    /api/agent/actions). It opens no listening socket of its own.
 *  - When Ironbooks answered before and is gone now, it is most likely restarting (a company file
 *    switched or restored, an update installed). The connector looks for it again with growing
 *    pauses for a while before it gives up with a plain message, and does not start a second one
 *    until Ironbooks has been silent for RESTART_GRACE_MS (5 minutes), or UPDATE_GRACE_MS
 *    (15 minutes) while an update this agent asked for may be installing. Each time, the program
 *    found must prove itself again before the token goes out.
 *  - A long wait for a person's decision goes out on a connection of its own (at most
 *    MAX_OPEN_WAITS of them, one per wait), proved the same way, so the agent's other tools are
 *    not held up behind it and two waits never queue behind each other.
 *  - When Ironbooks is closed, and only when its settings say so (IRONBOOKS_AGENT_START=1, which
 *    the Agents tab adds for an agent an Admin allowed to work while nobody is signed in), it
 *    starts the installed app with `--agent-service`: Ironbooks opens the company file with no
 *    window and closes it again when the agent is done (electron/agentService.js). Ironbooks
 *    itself decides whether that agent may work; starting it gives nobody anything.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN_ENV = 'IRONBOOKS_AGENT_TOKEN';
export const TOKEN_FILE_ENV = 'IRONBOOKS_AGENT_TOKEN_FILE';
export const ENDPOINT_DIR_ENV = 'IRONBOOKS_AGENT_ENDPOINT_DIR';
export const HELLO_LABEL = 'ironbooks-agent-hello';
export const HOST = '127.0.0.1';
export const ACTION_ROUTE = '/api/agent/actions';
export const START_ENV = 'IRONBOOKS_AGENT_START';
export const START_FLAG = '--agent-service';
/** How long to wait for Ironbooks to open the company file after starting it. */
export const START_WAIT_MS = 75_000;
/** Ironbooks is started at most once in this long, however often the agent asks. */
export const START_EVERY_MS = 3 * 60_000;
/** How long one request looks for an Ironbooks that answered before and is gone (a restart). */
export const RECONNECT_WAIT_MS = 30_000;
/** The first pause between looks; each one after is twice as long, up to RECONNECT_MAX_PAUSE_MS. */
export const RECONNECT_FIRST_PAUSE_MS = 250;
export const RECONNECT_MAX_PAUSE_MS = 4_000;
/**
 * When Ironbooks answered this connector less than this long ago and is gone now, it is most
 * likely restarting: the connector does not start it until it has been silent this long, so a
 * second copy never gets in the way of the one coming back. Five minutes: switching, opening or
 * restoring a company file takes well under that. (The hidden copy the connector starts closes
 * itself after 10 minutes without the agent, electron/agentService.js IDLE_MS, so the next request
 * after that comes later than this and starts it at once.)
 */
export const RESTART_GRACE_MS = 5 * 60_000;
/**
 * The same, while an update this agent asked for may be installing (shell.update.install asked
 * or approved, UPDATE_OPERATION). The installer replaces the whole app and starts it again when it
 * is done; on a slow disk, with a virus scanner checking every file it writes, that can take
 * several minutes, and a copy started meanwhile could hold files the installer must replace.
 * Fifteen minutes is three times the five above. The agent is told meanwhile to wait and try
 * again (UPDATING_MESSAGE).
 */
export const UPDATE_GRACE_MS = 15 * 60_000;
/**
 * An approved restart is expected this soon after it was approved (the request's decidedAt, or
 * when the connector heard of it when the view gives no time): one approved longer before
 * Ironbooks last answered has happened already (or never will), and no longer explains a silence.
 * So yesterday's executed update, read again in list_my_requests by a connector that just started,
 * explains nothing.
 */
export const RESTART_EXPECTED_WITHIN_MS = 10 * 60_000;
/**
 * A restart request still waiting for a person explains a silence only until it expires: its
 * expiresAt when the view gives one, else this long after the connector heard of it (seven days,
 * how long a request waits unless the agent's policy says otherwise, lib/agent/policy.ts
 * DEFAULT_REQUEST_EXPIRY_DAYS). Read again later, the view's expiresAt takes over.
 */
export const PENDING_RESTART_KEEP_MS = 7 * 24 * 60 * 60_000;
/**
 * Operations after which Ironbooks restarts or changes company file (lib/agent/operations/shell.ts,
 * `restarts: true`; a test holds the two together).
 */
export const RESTARTING_OPERATIONS = [
  'shell.company.new',
  'shell.company.open',
  'shell.company.switch',
  'shell.company.close',
  'shell.portable.open',
  'shell.accountantCopy.open',
  'shell.backup.restoreAsNew',
  'shell.sandbox.enter',
  'shell.hosting.connect',
  'shell.hosting.disconnect',
  'shell.update.install',
];
/** The update install: the restart that takes longest (UPDATE_GRACE_MS). */
export const UPDATE_OPERATION = 'shell.update.install';
/** How many long waits for a person may be open at once (each on a connection of its own). */
export const MAX_OPEN_WAITS = 2;

const TOKEN_RE = /^ibka_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export const NOT_CONNECTED_MESSAGE =
  'Ironbooks is not ready for this agent. Open the company file in Ironbooks on this computer and sign in, then try again.';
export const NOT_STARTED_MESSAGE =
  'Ironbooks is closed and did not open the company file for this agent. It does that only for an agent an Admin allowed to work while nobody is signed in, and never for a company file with passwords. Otherwise open the company file in Ironbooks on this computer and sign in, then try again.';
export const LOST_ANSWER_MESSAGE =
  'Ironbooks did not answer. If this was a change, ask again with the SAME request_id: it is entered once, however often you ask.';
export const AWAY_MESSAGE =
  'Ironbooks stopped answering. It may be restarting (after a company file was switched or restored, or an update was installed), or it was closed. Nothing was sent. Wait a minute and try again; then read what you need again, because the books may have changed. If it stays away, ask the person to open the company file in Ironbooks and sign in.';
export const UPDATING_MESSAGE =
  'Ironbooks stopped answering, most likely because it is installing the update you asked for; it starts again by itself when the update is in, which can take several minutes. Nothing was sent. Wait a few minutes and try again; then read what you need again, because the books may have changed. If it stays away for more than 15 minutes, ask the person to open the company file in Ironbooks and sign in.';
/**
 * The same silence while the update this agent asked for is still waiting for a person, as far as
 * this connector knows: a person may have approved it meanwhile (and Ironbooks is installing it),
 * or Ironbooks was simply closed. It says both, and claims neither.
 */
export const UPDATE_MAYBE_MESSAGE =
  'Ironbooks stopped answering. Nothing was sent. If a person has approved the update you asked for since you last checked, Ironbooks is installing it and starts again by itself, which can take several minutes; otherwise it may be restarting, or it was closed. Wait a few minutes and try again; then read what you need again, because the books may have changed. If it stays away for more than 15 minutes, ask the person to open the company file in Ironbooks and sign in.';
/** Code of the error a wait gets when MAX_OPEN_WAITS are already open: nothing was sent. */
export const WAITS_BUSY_CODE = 'WAITS_BUSY';
export const WAITS_BUSY_MESSAGE = `You are already waiting on ${MAX_OPEN_WAITS} requests at once. Wait for one of those answers before you wait on another, or read this request without waiting.`;
export const NO_TOKEN_MESSAGE =
  `This connector has no access token. An Ironbooks Admin makes one under Users & Roles > Agents; put it in ${TOKEN_ENV} (or its file's path in ${TOKEN_FILE_ENV}).`;
export const BAD_TOKEN_MESSAGE = 'The access token is not in the form Ironbooks gives out. Copy it again from Users & Roles > Agents (it is shown once, when the agent is made).';

/** A failure with a message meant for the agent to read. */
export class IronbooksError extends Error {
  /** @param {string} message @param {{ status?: number, code?: string, notConnected?: boolean, retryAfter?: number }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'IronbooksError';
    this.isIronbooksError = true;
    this.status = info.status ?? 0;
    this.code = info.code ?? '';
    /** Ironbooks could not be reached and nothing was sent with the token. */
    this.notConnected = info.notConnected === true;
    /** Seconds Ironbooks asked to hold off before trying again (its Retry-After), or 0. */
    this.retryAfter = info.retryAfter ?? 0;
  }
}

/** A Retry-After header in whole seconds (0 when absent or not a number of seconds; at most an hour). */
function retryAfterOf(/** @type {unknown} */ header) {
  const n = Number(Array.isArray(header) ? header[0] : header);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 3600) : 0;
}

/** Ironbooks could not be reached (nothing carrying the token was sent). */
function notConnected(message = NOT_CONNECTED_MESSAGE) {
  return new IronbooksError(message, { notConnected: true });
}

/** @param {unknown} err */
function isNotConnected(err) {
  return err instanceof IronbooksError && err.notConnected;
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** A time Ironbooks gave as ISO text, in milliseconds, or null when there is none. */
function timeOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * The command that starts the installed Ironbooks for an agent, or null when this connector may
 * not or cannot start it: only when the settings ask for it, and only when this connector is the
 * one shipped inside an installed Ironbooks and is being run by that app's own program (the way
 * the Agents tab sets it up). The command is never read from a file or the environment.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ execPath?: string, scriptDir?: string, electron?: string | undefined, exists?: (p: string) => boolean }} [facts]
 * @returns {{ command: string, args: string[] } | null}
 */
export function appStartCommand(env = process.env, facts = {}) {
  if (env[START_ENV] !== '1') return null;
  const electron = 'electron' in facts ? facts.electron : process.versions.electron;
  if (!electron) return null;
  const scriptDir = facts.scriptDir ?? path.dirname(fileURLToPath(import.meta.url));
  const exists = facts.exists ?? ((p) => fs.existsSync(p));
  const resources = path.dirname(scriptDir);
  if (path.basename(scriptDir) !== 'mcp') return null;
  if (!exists(path.join(resources, 'app')) && !exists(path.join(resources, 'app.asar'))) return null;
  return { command: facts.execPath ?? process.execPath, args: [START_FLAG] };
}

/**
 * The environment Ironbooks is started with: this one, without the connector's own settings.
 * @param {Record<string, string | undefined>} [env]
 */
export function appStartEnv(env = process.env) {
  const out = { ...env };
  for (const k of ['ELECTRON_RUN_AS_NODE', TOKEN_ENV, TOKEN_FILE_ENV, START_ENV, ENDPOINT_DIR_ENV]) delete out[k];
  return out;
}

/**
 * The folder Ironbooks writes endpoint files in. Must match lib/agent/endpointFile.ts.
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 */
export function endpointDir(env = process.env, platform = process.platform) {
  const override = env[ENDPOINT_DIR_ENV];
  if (override) return path.resolve(override);
  const home = os.homedir();
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Ironbooks', 'agent-endpoints');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Ironbooks', 'agent-endpoints');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'ironbooks', 'agent-endpoints');
}

/**
 * The token from the environment, or from the file the environment names. Throws IronbooksError.
 * @param {Record<string, string | undefined>} [env]
 */
export function loadToken(env = process.env) {
  let token = (env[TOKEN_ENV] ?? '').trim();
  if (!token && env[TOKEN_FILE_ENV]) {
    try {
      token = fs.readFileSync(env[TOKEN_FILE_ENV], 'utf8').trim();
    } catch {
      throw new IronbooksError(`The token file named in ${TOKEN_FILE_ENV} could not be read.`);
    }
  }
  if (!token) throw new IronbooksError(NO_TOKEN_MESSAGE);
  if (!TOKEN_RE.test(token)) throw new IronbooksError(BAD_TOKEN_MESSAGE);
  return token;
}

/**
 * The company-file tag inside a token.
 * @param {string} token
 * @returns {string | null}
 */
export function tokenTag(token) {
  const m = TOKEN_RE.exec(token);
  return m ? m[1] : null;
}

/** Read and validate the endpoint file for a tag, or null. */
export function readEndpoint(tag, dir = endpointDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${tag}.json`), 'utf8'));
    const port = Number(raw.port);
    if (raw.tag !== tag || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof raw.check !== 'string' || !/^[0-9a-f]{64}$/.test(raw.check)) return null;
    return { port, check: raw.check, tag };
  } catch {
    return null;
  }
}

/** The proof Ironbooks must give for a nonce. Must match lib/agent/endpointFile.ts helloProof. */
export function expectedProof(check, nonce, port, tag) {
  return createHmac('sha256', Buffer.from(check, 'hex')).update(`${HELLO_LABEL}\n${nonce}\n${port}\n${tag}`).digest('hex');
}

function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * A reader of the Ironbooks API for one agent token.
 */
export class IronbooksClient {
  /**
   * @param {{ token?: string, env?: Record<string, string | undefined>, endpointDir?: string, timeoutMs?: number,
   *   startApp?: (() => void) | null, startWaitMs?: number, startEveryMs?: number, startPollMs?: number,
   *   reconnectWaitMs?: number, reconnectFirstPauseMs?: number, reconnectMaxPauseMs?: number, restartGraceMs?: number,
   *   updateGraceMs?: number, restartExpectedWithinMs?: number, pendingRestartKeepMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.token = opts.token ?? null;
    this.dir = opts.endpointDir ?? null;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    /** Starts Ironbooks for this agent when it is closed, or null when this connector may not. */
    this.startApp = 'startApp' in opts ? opts.startApp ?? null : defaultStartApp(this.env);
    this.startWaitMs = opts.startWaitMs ?? START_WAIT_MS;
    this.startEveryMs = opts.startEveryMs ?? START_EVERY_MS;
    this.startPollMs = opts.startPollMs ?? 500;
    this.startedAt = 0;
    this.reconnectWaitMs = opts.reconnectWaitMs ?? RECONNECT_WAIT_MS;
    this.reconnectFirstPauseMs = opts.reconnectFirstPauseMs ?? RECONNECT_FIRST_PAUSE_MS;
    this.reconnectMaxPauseMs = opts.reconnectMaxPauseMs ?? RECONNECT_MAX_PAUSE_MS;
    this.restartGraceMs = opts.restartGraceMs ?? RESTART_GRACE_MS;
    this.updateGraceMs = opts.updateGraceMs ?? UPDATE_GRACE_MS;
    this.restartExpectedWithinMs = opts.restartExpectedWithinMs ?? RESTART_EXPECTED_WITHIN_MS;
    this.pendingRestartKeepMs = opts.pendingRestartKeepMs ?? PENDING_RESTART_KEEP_MS;
    /** Ironbooks answered a request of this connector at least once. */
    this.answered = false;
    /** When Ironbooks last answered this connector (0: never). */
    this.lastAnswerAt = 0;
    /** When a search for an Ironbooks that went away last ran out (0: not away). */
    this.awaySince = 0;
    /** Ironbooks could not be reached since it last answered (it is coming back, or gone). */
    this.lost = false;
    /**
     * The run of Ironbooks that last answered, by the random value its endpoint file carries (a new
     * one each time Ironbooks starts, lib/agent/endpointFile.ts): an answer from another run means
     * Ironbooks restarted, even when this connector sent nothing while it was away.
     */
    this.run = null;
    /**
     * When this connector last saw Ironbooks come back: after a silence, or as a new run (0: never).
     * A restart approved before then has happened already, however late the connector hears of the
     * approval (noteRequest).
     */
    this.backAt = 0;
    /**
     * This agent's requests for an operation that restarts Ironbooks, by request id: how long a
     * silence it may explain, when it was approved (null while it waits), and until when one that
     * waits may still be approved.
     * @type {Map<string, { graceMs: number, update: boolean, approvedAt: number | null, until: number }>}
     */
    this.restarts = new Map();
    /** Approved restarts Ironbooks has come back from: hearing of them again explains nothing. */
    this.restartsOver = new Set();
    // One connection at a time, kept open, so the request that carries the token goes out on the
    // connection that just proved itself.
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    // Long waits (a person deciding) go on connections of their own, so they do not hold up
    // everything else. Each wait has a lane to itself (one connection, kept open): two waits at
    // once never share one, so neither sits behind the other's 50 seconds. Each connection proves
    // itself before it carries the token, as on the first.
    this.waitLanes = Array.from({ length: MAX_OPEN_WAITS }, () => ({
      agent: new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }),
      busy: false,
    }));
    /** Connections that answered the proof. */
    this.proven = new WeakSet();
  }

  close() {
    this.agent.destroy();
    for (const lane of this.waitLanes) lane.agent.destroy();
  }

  /**
   * What the tools learnt about one of this agent's requests (lib/agent/contract.ts
   * AgentRequestView, or the run_operation answer that asked it). A request for an operation that
   * restarts Ironbooks explains a silence while it waits or was just approved, so no second copy is
   * started meanwhile (RESTART_GRACE_MS, UPDATE_GRACE_MS). Anything else is ignored.
   *
   * An approved one counts from when it was approved (decidedAt), so one approved long ago, read
   * again (list_my_requests after the connector started), explains nothing
   * (RESTART_EXPECTED_WITHIN_MS). Nor does one approved before Ironbooks last came back (backAt):
   * the connector heard of the approval only after Ironbooks had already restarted for it. One
   * still waiting counts until it expires (expiresAt, or PENDING_RESTART_KEEP_MS when the answer
   * gives no time).
   * @param {{ id?: unknown, operation?: unknown, status?: unknown, decidedAt?: unknown, expiresAt?: unknown }} request
   */
  noteRequest(request) {
    const id = typeof request?.id === 'string' ? request.id : '';
    const op = typeof request?.operation === 'string' ? request.operation : '';
    if (!id || !RESTARTING_OPERATIONS.includes(op) || this.restartsOver.has(id)) return;
    const status = request.status;
    if (status !== 'pending' && status !== 'approved' && status !== 'executed') {
      // Denied, expired, withdrawn or failed: it will not restart anything.
      this.restarts.delete(id);
      return;
    }
    const now = Date.now();
    const update = op === UPDATE_OPERATION;
    const graceMs = update ? this.updateGraceMs : this.restartGraceMs;
    const seen = this.restarts.get(id);
    if (status === 'pending') {
      // (A first of two approvals leaves it pending, with a decidedAt: it has not restarted anything.)
      const until = timeOf(request.expiresAt) ?? seen?.until ?? now + this.pendingRestartKeepMs;
      if (until <= now) this.restarts.delete(id);
      else this.restarts.set(id, { graceMs, update, approvedAt: null, until });
      return;
    }
    const decided = timeOf(request.decidedAt);
    const approvedAt = decided !== null ? Math.min(decided, now) : (seen?.approvedAt ?? now);
    if (now - approvedAt > this.restartExpectedWithinMs || (decided !== null && approvedAt < this.backAt)) {
      // Approved long ago, or before Ironbooks last came back: that restart is over, or never came.
      this.restarts.delete(id);
      this.restartsOver.add(id);
      return;
    }
    this.restarts.set(id, { graceMs, update, approvedAt, until: Infinity });
  }

  /**
   * How long Ironbooks may be silent before this connector starts it: RESTART_GRACE_MS, or longer
   * while one of this agent's requests for a restart may explain the silence (one still waiting
   * for a person, or one approved shortly before Ironbooks last answered). `update`: an update this
   * agent asked for may be installing; `updateApproved`: one this connector knows a person approved
   * (otherwise it is only still waiting, as far as the connector knows).
   *
   * An update still waiting keeps the longer grace on purpose: a person may approve it at any
   * moment without the connector hearing of it, and a second copy started while the installer runs
   * could hold files it must replace. Only what the agent is told differs (UPDATE_MAYBE_MESSAGE).
   * @returns {{ graceMs: number, update: boolean, updateApproved: boolean }}
   */
  _grace() {
    let graceMs = this.restartGraceMs;
    let update = false;
    let updateApproved = false;
    const now = Date.now();
    for (const [id, r] of this.restarts) {
      if (r.approvedAt === null && r.until <= now) {
        // Still waiting when it expired: nobody can approve it any more.
        this.restarts.delete(id);
        continue;
      }
      if (r.approvedAt !== null && this.lastAnswerAt - r.approvedAt > this.restartExpectedWithinMs) {
        // Approved long before Ironbooks last answered: that restart is over, or never came.
        this.restarts.delete(id);
        this.restartsOver.add(id);
        continue;
      }
      graceMs = Math.max(graceMs, r.graceMs);
      update = update || r.update;
      updateApproved = updateApproved || (r.update && r.approvedAt !== null);
    }
    return { graceMs, update, updateApproved };
  }

  /** One HTTP exchange on a kept connection. `beforeSend` sees the socket before any header goes out. */
  _exchange(port, pathAndQuery, beforeSend, method = 'GET', body = null, agent = this.agent) {
    return new Promise((resolve, reject) => {
      const headers = { accept: 'application/json' };
      if (body !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      const req = http.request({ host: HOST, port, path: pathAndQuery, method, agent, headers });
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      req.setTimeout(this.timeoutMs, () => req.destroy(new IronbooksError('Ironbooks took too long to answer. Try a shorter date range.')));
      req.once('error', (err) => done(reject, err));
      req.once('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (err) => done(reject, err));
        res.on('end', () =>
          done(resolve, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), socket: used, retryAfter: retryAfterOf(res.headers['retry-after']) }),
        );
      });
      /** The connection this exchange went out on. */
      let used = null;
      req.once('socket', (socket) => {
        used = socket;
        try {
          if (beforeSend(req, socket) === false) {
            const stop = new Error('unproven connection');
            /** @type {any} */ (stop).unproven = true;
            req.destroy(stop);
            return;
          }
          req.end(body === null ? undefined : body);
        } catch (err) {
          req.destroy(/** @type {Error} */ (err));
        }
      });
    });
  }

  /** Ask the program on the port to prove it is the Ironbooks that wrote the endpoint file. */
  async _prove(endpoint, agent = this.agent) {
    const nonce = randomBytes(32).toString('hex');
    let res;
    try {
      res = await this._exchange(endpoint.port, `/api/agent/hello?tag=${endpoint.tag}&nonce=${nonce}`, () => true, 'GET', null, agent);
    } catch {
      throw notConnected();
    }
    let proof = null;
    try {
      proof = res.status === 200 ? JSON.parse(res.body).proof : null;
    } catch {
      proof = null;
    }
    if (!sameHex(proof, expectedProof(endpoint.check, nonce, endpoint.port, endpoint.tag))) {
      // Not Ironbooks, or not the run that wrote the file. The token stays here.
      res.socket?.destroy();
      throw notConnected();
    }
    if (res.socket && !res.socket.destroyed) this.proven.add(res.socket);
  }

  /**
   * GET an API path with query values (undefined, null and '' are left out). Returns the parsed
   * JSON. Throws IronbooksError with a message for the agent. `wait`: a long wait (a person
   * deciding), sent on a wait lane of its own; when all MAX_OPEN_WAITS lanes are in use it throws
   * at once (code WAITS_BUSY_CODE, nothing sent), so a third wait is never queued for up to 50
   * seconds behind another.
   * @param {string} apiPath
   * @param {Record<string, string | number | boolean | null | undefined>} [query]
   * @param {{ wait?: boolean }} [opts]
   */
  async get(apiPath, query = {}, opts = {}) {
    if (!this.token) this.token = loadToken(this.env);
    const token = this.token;
    const tag = tokenTag(token);
    if (!tag) throw new IronbooksError(BAD_TOKEN_MESSAGE);
    if (!apiPath.startsWith('/api/')) throw new IronbooksError('Only the Ironbooks API can be read.');

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const target = qs.toString() ? `${apiPath}?${qs}` : apiPath;
    if (opts.wait !== true) return this._request(tag, token, 'GET', target, null, this.agent);
    const lane = this.waitLanes.find((l) => !l.busy);
    if (!lane) throw new IronbooksError(WAITS_BUSY_MESSAGE, { code: WAITS_BUSY_CODE });
    lane.busy = true;
    try {
      return await this._request(tag, token, 'GET', target, null, lane.agent);
    } finally {
      lane.busy = false;
    }
  }

  /**
   * Send one request to the agent's door, the one action route: a curated action (lib/agent/
   * catalog.ts) as `{ action, input, dryRun?, requestId? }`, or a verb (lib/agent/contract.ts
   * AgentVerbs) as `{ verb, ...args }`. The only thing this connector ever POSTs.
   * @param {Record<string, unknown>} request
   */
  async act(request) {
    if (!this.token) this.token = loadToken(this.env);
    const token = this.token;
    const tag = tokenTag(token);
    if (!tag) throw new IronbooksError(BAD_TOKEN_MESSAGE);
    return this._request(tag, token, 'POST', ACTION_ROUTE, JSON.stringify(request), this.agent);
  }

  /** Ironbooks answered this connector a short while ago: if it is gone now, it is most likely restarting. */
  _recentlyAnswered() {
    return this.answered && Date.now() - this.lastAnswerAt < this._grace().graceMs;
  }

  /** What the agent is told while Ironbooks is away and may not be started yet. */
  _awayMessage() {
    const g = this._grace();
    if (!g.update || Date.now() - this.lastAnswerAt >= g.graceMs) return AWAY_MESSAGE;
    return g.updateApproved ? UPDATING_MESSAGE : UPDATE_MAYBE_MESSAGE;
  }

  /**
   * Send to the Ironbooks that has the company file open. When it answered before and cannot be
   * reached now, look for it again with growing pauses (it is most likely restarting). When none
   * can be reached, and this connector may start Ironbooks, start it once and wait for it to open
   * the file, but never while a restart may still be under way. A request is only ever sent again
   * when nothing carrying the token went out the first time.
   */
  async _request(tag, token, method, target, payload, agent) {
    const dir = this.dir ?? endpointDir(this.env);
    const attempt = () => {
      const endpoint = readEndpoint(tag, dir);
      if (!endpoint) throw notConnected();
      return this._send(endpoint, token, method, target, payload, agent);
    };
    try {
      return await attempt();
    } catch (err) {
      if (!isNotConnected(err)) throw err;
    }
    if (this.answered) this.lost = true;
    // Ironbooks answered this connector before: wait for it to come back before anything else.
    // Starting a second one meanwhile would only get in the way of the one that is restarting.
    // Once a search has run out, later requests look once and say so, until it answers again.
    // When it has been silent long enough that this connector may start it, it is started at
    // once instead of searched for (the hidden copy closes itself when the agent is idle).
    if (this.answered && !this.awaySince && (this._recentlyAnswered() || !this.startApp)) {
      const until = Date.now() + this.reconnectWaitMs;
      let pause = this.reconnectFirstPauseMs;
      while (Date.now() + pause <= until) {
        await sleep(pause);
        pause = Math.min(pause * 2, this.reconnectMaxPauseMs);
        try {
          return await attempt();
        } catch (err) {
          if (!isNotConnected(err)) throw err;
        }
      }
      this.awaySince = Date.now();
    }
    // An update can take minutes to install: while Ironbooks answered only a short while ago (or
    // an update this agent asked for may be installing), a copy started now could get in the way of
    // the one coming back. The agent is told to wait and try again.
    if (this.startApp && !this._recentlyAnswered()) return this._send(await this._startAndWait(tag, dir), token, method, target, payload, agent);
    throw notConnected(this.answered ? this._awayMessage() : NOT_CONNECTED_MESSAGE);
  }

  /** Start Ironbooks for this agent (at most once in a while) and wait until it proves itself. */
  async _startAndWait(tag, dir) {
    const now = Date.now();
    if (this.startedAt && now - this.startedAt < this.startEveryMs) throw notConnected(NOT_STARTED_MESSAGE);
    this.startedAt = now;
    try {
      /** @type {() => void} */ (this.startApp)();
    } catch {
      throw notConnected(NOT_STARTED_MESSAGE);
    }
    const until = now + this.startWaitMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, this.startPollMs));
      const endpoint = readEndpoint(tag, dir);
      if (endpoint) {
        try {
          await this._prove(endpoint);
          return endpoint;
        } catch {
          /* an old file, or not up yet: look again */
        }
      }
      if (Date.now() >= until) throw notConnected(NOT_STARTED_MESSAGE);
    }
  }

  /** One request with the token, on a connection of `agent` that has proved itself. */
  async _send(endpoint, token, method, target, payload, agent = this.agent) {
    let res = null;
    for (let attempt = 0; attempt < 4 && !res; attempt++) {
      try {
        res = await this._exchange(
          endpoint.port,
          target,
          (req, socket) => {
            if (!this.proven.has(socket)) return false; // never on a connection that has not proved itself
            req.setHeader('authorization', `Bearer ${token}`);
            return true;
          },
          method,
          payload,
          agent,
        );
      } catch (err) {
        if (err instanceof IronbooksError) throw err;
        if (/** @type {any} */ (err)?.unproven) {
          // Nothing was sent on that connection: prove a new one and send there.
          await this._prove(endpoint, agent);
          continue;
        }
        // The connection broke after the request went out. A change may or may not have been
        // entered; asking again with the same request_id settles it without entering it twice.
        if (method === 'POST') throw new IronbooksError(LOST_ANSWER_MESSAGE);
        throw notConnected();
      }
    }
    if (!res) throw notConnected();
    // Ironbooks is here (whatever it said): a later loss of it is worth waiting out.
    this.answered = true;
    this.lastAnswerAt = Date.now();
    this.awaySince = 0;
    // Another run than the one that answered last: Ironbooks restarted, even if nothing was sent
    // while it was away.
    const newRun = this.run !== null && this.run !== endpoint.check;
    this.run = endpoint.check;
    if (this.lost || newRun) {
      // Back after a silence: an approved restart has happened, and explains no later one. A
      // request still waiting for a person may yet restart it, so that one is kept; once the
      // connector hears it was approved before now, it counts as over too (noteRequest, backAt).
      this.lost = false;
      this.backAt = this.lastAnswerAt;
      for (const [id, r] of this.restarts) {
        if (r.approvedAt === null) continue;
        this.restarts.delete(id);
        this.restartsOver.add(id);
      }
    }

    let body = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = null;
    }
    if (res.status >= 200 && res.status < 300) {
      if (body === null) throw new IronbooksError('Ironbooks gave an answer that could not be read.', { status: res.status });
      return body;
    }
    const message = body && typeof body.error === 'string' && body.error ? body.error : '';
    const code = body && typeof body.code === 'string' ? body.code : '';
    if (res.status === 429) {
      // The wait from the Retry-After header, or, where a route gives none, from the answer itself
      // (the door's details.retryAfterSeconds, or an answer's retryAfterSeconds, contract wave 4).
      const retryAfter = res.retryAfter || retryAfterOf(body?.details?.retryAfterSeconds) || retryAfterOf(body?.retryAfterSeconds);
      const said = message || (body && typeof body.note === 'string' ? body.note.trim() : '');
      throw new IronbooksError(said || 'Ironbooks is busy with your other requests. Try again in a little while.', { status: 429, code, retryAfter });
    }
    if (res.status === 401 || (res.status === 403 && message === 'Authentication required.')) {
      throw new IronbooksError(
        'Ironbooks did not accept this agent. Its access may have been removed, or the token belongs to another computer or company file. An Admin can make a new agent under Users & Roles > Agents.',
        { status: res.status, code },
      );
    }
    if (res.status >= 500) throw new IronbooksError('Ironbooks could not answer that. Try again, or try a shorter date range.', { status: res.status, code });
    throw new IronbooksError(message || `Ironbooks refused the request (${res.status}).`, { status: res.status, code });
  }
}

/** The starter for this connector's own app, or null (see appStartCommand). */
function defaultStartApp(env) {
  const cmd = appStartCommand(env);
  if (!cmd) return null;
  return () => {
    // Never Windows' hide flag: Ironbooks hides its own window. That flag would make Windows swallow the
    // first "show", so a person starting Ironbooks would not see the window (electron/agentService.js).
    const child = spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore', env: appStartEnv(env) });
    child.on('error', () => {});
    child.unref();
  };
}
