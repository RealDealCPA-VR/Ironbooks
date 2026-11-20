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
 *  - It only reads (GET). It opens no listening socket of its own.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_ENV = 'IRONBOOKS_AGENT_TOKEN';
export const TOKEN_FILE_ENV = 'IRONBOOKS_AGENT_TOKEN_FILE';
export const ENDPOINT_DIR_ENV = 'IRONBOOKS_AGENT_ENDPOINT_DIR';
export const HELLO_LABEL = 'ironbooks-agent-hello';
export const HOST = '127.0.0.1';

const TOKEN_RE = /^ibka_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export const NOT_CONNECTED_MESSAGE =
  'Ironbooks is not ready for this agent. Open the company file in Ironbooks on this computer and sign in, then try again.';
export const NO_TOKEN_MESSAGE =
  `This connector has no access token. An Ironbooks Admin makes one under Users & Roles > Agents; put it in ${TOKEN_ENV} (or its file's path in ${TOKEN_FILE_ENV}).`;
export const BAD_TOKEN_MESSAGE = 'The access token is not in the form Ironbooks gives out. Copy it again from Users & Roles > Agents (it is shown once, when the agent is made).';

/** A failure with a message meant for the agent to read. */
export class IronbooksError extends Error {
  /** @param {string} message @param {{ status?: number, code?: string }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'IronbooksError';
    this.isIronbooksError = true;
    this.status = info.status ?? 0;
    this.code = info.code ?? '';
  }
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
   * @param {{ token?: string, env?: Record<string, string | undefined>, endpointDir?: string, timeoutMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.token = opts.token ?? null;
    this.dir = opts.endpointDir ?? null;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    // One connection at a time, kept open, so the request that carries the token goes out on the
    // connection that just proved itself.
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    /** Connections that answered the proof. */
    this.proven = new WeakSet();
  }

  close() {
    this.agent.destroy();
  }

  /** One HTTP exchange on the kept connection. `beforeSend` sees the socket before any header goes out. */
  _exchange(port, pathAndQuery, beforeSend) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: HOST, port, path: pathAndQuery, method: 'GET', agent: this.agent, headers: { accept: 'application/json' } });
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
        res.on('end', () => done(resolve, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), socket: used }));
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
          req.end();
        } catch (err) {
          req.destroy(/** @type {Error} */ (err));
        }
      });
    });
  }

  /** Ask the program on the port to prove it is the Ironbooks that wrote the endpoint file. */
  async _prove(endpoint) {
    const nonce = randomBytes(32).toString('hex');
    let res;
    try {
      res = await this._exchange(endpoint.port, `/api/agent/hello?tag=${endpoint.tag}&nonce=${nonce}`, () => true);
    } catch {
      throw new IronbooksError(NOT_CONNECTED_MESSAGE);
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
      throw new IronbooksError(NOT_CONNECTED_MESSAGE);
    }
    if (res.socket && !res.socket.destroyed) this.proven.add(res.socket);
  }

  /**
   * GET an API path with query values (undefined, null and '' are left out). Returns the parsed
   * JSON. Throws IronbooksError with a message for the agent.
   * @param {string} apiPath
   * @param {Record<string, string | number | boolean | null | undefined>} [query]
   */
  async get(apiPath, query = {}) {
    if (!this.token) this.token = loadToken(this.env);
    const token = this.token;
    const tag = tokenTag(token);
    if (!tag) throw new IronbooksError(BAD_TOKEN_MESSAGE);
    if (!apiPath.startsWith('/api/')) throw new IronbooksError('Only the Ironbooks API can be read.');
    const endpoint = readEndpoint(tag, this.dir ?? endpointDir(this.env));
    if (!endpoint) throw new IronbooksError(NOT_CONNECTED_MESSAGE);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const target = qs.toString() ? `${apiPath}?${qs}` : apiPath;

    let res = null;
    for (let attempt = 0; attempt < 4 && !res; attempt++) {
      try {
        res = await this._exchange(endpoint.port, target, (req, socket) => {
          if (!this.proven.has(socket)) return false; // never on a connection that has not proved itself
          req.setHeader('authorization', `Bearer ${token}`);
          return true;
        });
      } catch (err) {
        if (err instanceof IronbooksError) throw err;
        if (/** @type {any} */ (err)?.unproven) {
          await this._prove(endpoint);
          continue;
        }
        throw new IronbooksError(NOT_CONNECTED_MESSAGE);
      }
    }
    if (!res) throw new IronbooksError(NOT_CONNECTED_MESSAGE);

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
