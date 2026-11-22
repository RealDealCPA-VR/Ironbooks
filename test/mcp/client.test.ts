/**
 * The connector's link to Ironbooks (mcp/client.mjs): this computer only, proof before the token,
 * the token only on the connection that proved itself.
 *
 * A stand-in for the app's server listens on 127.0.0.1 and records every request it gets, so the
 * tests can say exactly when the token crossed the wire, and when it did not.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AWAY_MESSAGE,
  BAD_TOKEN_MESSAGE,
  HOST,
  IronbooksClient,
  IronbooksError,
  LOST_ANSWER_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  NOT_STARTED_MESSAGE,
  NO_TOKEN_MESSAGE,
  MAX_OPEN_WAITS,
  PENDING_RESTART_KEEP_MS,
  RESTARTING_OPERATIONS,
  RESTART_GRACE_MS,
  START_ENV,
  UPDATE_GRACE_MS,
  UPDATE_OPERATION,
  UPDATING_MESSAGE,
  WAITS_BUSY_CODE,
  WAITS_BUSY_MESSAGE,
  appStartCommand,
  appStartEnv,
  endpointDir,
  expectedProof,
  loadToken,
  readEndpoint,
  tokenTag,
} from '../../mcp/client.mjs';
import * as serverSide from '@/lib/agent/endpointFile';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import { DEFAULT_REQUEST_EXPIRY_DAYS } from '@/lib/agent/policy';

const TAG = '0123abcd';
const TOKEN = `ibka_${TAG}_${'k'.repeat(43)}`;
const CHECK = 'ab'.repeat(32);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ironbooks-mcp-client-'));

interface Seen {
  url: string;
  auth: string | undefined;
  socket: object;
}
interface Stub {
  port: number;
  seen: Seen[];
  /** What the next API request answers. */
  reply: { status: number; body: string };
  check: string;
  keepAlive: boolean;
  close: () => Promise<void>;
}

async function stub(): Promise<Stub> {
  const s: Stub = { port: 0, seen: [], reply: { status: 200, body: JSON.stringify({ ok: true }) }, check: CHECK, keepAlive: true, close: async () => undefined };
  const server = http.createServer((req, res) => {
    s.seen.push({ url: req.url ?? '', auth: req.headers.authorization, socket: req.socket });
    const url = new URL(req.url ?? '/', 'http://x');
    const extra = s.keepAlive ? {} : { connection: 'close' };
    if (url.pathname === '/api/agent/hello') {
      const proof = expectedProof(s.check, url.searchParams.get('nonce'), s.port, url.searchParams.get('tag'));
      res.writeHead(200, { 'content-type': 'application/json', ...extra }).end(JSON.stringify({ proof }));
      return;
    }
    res.writeHead(s.reply.status, { 'content-type': 'application/json', ...extra }).end(s.reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  s.port = (server.address() as AddressInfo).port;
  s.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return s;
}

function writeEndpoint(port: number, extra: Record<string, unknown> = {}, tag = TAG) {
  fs.writeFileSync(path.join(DIR, `${tag}.json`), JSON.stringify({ schema: 'ironbooks-agent-endpoint/v1', tag, port, pid: 1, check: CHECK, ...extra }));
}

let app: Stub;
const clients: IronbooksClient[] = [];
function client(opts: Record<string, unknown> = {}) {
  const c = new IronbooksClient({ token: TOKEN, endpointDir: DIR, timeoutMs: 5000, ...opts });
  clients.push(c);
  return c;
}
async function failure(p: Promise<unknown>): Promise<IronbooksError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IronbooksError);
    return e as IronbooksError;
  }
  throw new Error('expected the call to fail');
}
const tokenSeen = () => app.seen.some((r) => r.auth !== undefined);

beforeAll(async () => {
  app = await stub();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  app.seen.length = 0;
  app.reply = { status: 200, body: JSON.stringify({ ok: true }) };
  app.check = CHECK;
  app.keepAlive = true;
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { force: true });
});
afterAll(async () => {
  await app.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe('proof before the token', () => {
  it('asks the app to prove itself, then sends the token on that same connection', async () => {
    writeEndpoint(app.port);
    app.reply = { status: 200, body: JSON.stringify({ accounts: [1, 2] }) };
    const out = await client().get('/api/accounts', { includeInactive: 'true', search: undefined, empty: '', none: null, n: 5, flag: false });
    expect(out).toEqual({ accounts: [1, 2] });
    // The question first, without the token; then the request, with it.
    expect(app.seen.map((r) => r.url.split('?')[0])).toEqual(['/api/agent/hello', '/api/accounts']);
    expect(app.seen[0].auth).toBeUndefined();
    expect(app.seen[0].url).toMatch(new RegExp(`^/api/agent/hello\\?tag=${TAG}&nonce=[0-9a-f]{64}$`));
    expect(app.seen[1].auth).toBe(`Bearer ${TOKEN}`);
    expect(app.seen[1].socket).toBe(app.seen[0].socket);
    // Empty values are left out of the query.
    expect(app.seen[1].url).toBe('/api/accounts?includeInactive=true&n=5&flag=false');
  });

  it('a new question each time: the nonce is never reused', async () => {
    writeEndpoint(app.port);
    const c = client();
    await c.get('/api/accounts');
    c.close();
    const c2 = client();
    await c2.get('/api/accounts');
    const nonces = app.seen.filter((r) => r.url.startsWith('/api/agent/hello')).map((r) => new URL(r.url, 'http://x').searchParams.get('nonce'));
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('a program that cannot prove itself never sees the token', async () => {
    writeEndpoint(app.port);
    app.check = 'cd'.repeat(32); // whatever is on the port does not know this run's check value
    const err = await failure(client().get('/api/accounts'));
    expect(err.message).toBe(NOT_CONNECTED_MESSAGE);
    expect(app.seen.length).toBeGreaterThan(0);
    expect(tokenSeen()).toBe(false);
  });

  it('a stale endpoint file (nothing listening) fails the same way', async () => {
    const dead = await stub();
    const port = dead.port;
    await dead.close();
    writeEndpoint(port);
    expect((await failure(client().get('/api/accounts'))).message).toBe(NOT_CONNECTED_MESSAGE);
  });

  it('no endpoint file: nothing is asked of anyone', async () => {
    expect((await failure(client().get('/api/accounts'))).message).toBe(NOT_CONNECTED_MESSAGE);
    // A file for another company file's tag does not count.
    writeEndpoint(app.port, {}, 'ffffffff');
    expect((await failure(client().get('/api/accounts'))).message).toBe(NOT_CONNECTED_MESSAGE);
    expect(app.seen).toEqual([]);
  });

  it('a connection that does not stay open never carries the token', async () => {
    writeEndpoint(app.port);
    app.keepAlive = false; // every answer closes its connection, so no connection is ever "the proven one"
    expect((await failure(client().get('/api/accounts'))).message).toBe(NOT_CONNECTED_MESSAGE);
    expect(app.seen.every((r) => r.url.startsWith('/api/agent/hello'))).toBe(true);
    expect(tokenSeen()).toBe(false);
  });
});

describe('this computer only', () => {
  it('always connects to 127.0.0.1, whatever the endpoint file says', async () => {
    expect(HOST).toBe('127.0.0.1');
    writeEndpoint(app.port, { host: 'attacker.example', url: 'http://attacker.example/', hostname: '10.0.0.9' });
    await client().get('/api/accounts');
    expect(app.seen).toHaveLength(2); // both requests came here
  });

  it('rejects an endpoint file that is not well formed', () => {
    for (const bad of [{ port: 0 }, { port: 70000 }, { port: 'abc' }, { check: 'short' }, { check: 'Z'.repeat(64) }, { tag: 'ffffffff' }]) {
      writeEndpoint(app.port, bad);
      expect(readEndpoint(TAG, DIR), JSON.stringify(bad)).toBeNull();
    }
    fs.writeFileSync(path.join(DIR, `${TAG}.json`), 'not json');
    expect(readEndpoint(TAG, DIR)).toBeNull();
    writeEndpoint(app.port);
    expect(readEndpoint(TAG, DIR)).toEqual({ port: app.port, check: CHECK, tag: TAG });
  });

  it('reads only the API', async () => {
    writeEndpoint(app.port);
    for (const p of ['/dashboard', 'http://example.com/api/x', '//example.com/api/x', 'api/accounts']) {
      await failure(client().get(p));
    }
    expect(app.seen).toEqual([]);
  });
});

describe('what the agent is told when Ironbooks says no', () => {
  it('passes a plain refusal on in the app\'s own words', async () => {
    writeEndpoint(app.port);
    app.reply = { status: 403, body: JSON.stringify({ error: 'You do not have permission to view Payroll. Ask your administrator for access.', code: 'FORBIDDEN' }) };
    const err = await failure(client().get('/api/employees'));
    expect(err.message).toBe('You do not have permission to view Payroll. Ask your administrator for access.');
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    app.reply = { status: 400, body: JSON.stringify({ error: 'from: Invalid date', code: 'VALIDATION' }) };
    expect((await failure(client().get('/api/find'))).message).toBe('from: Invalid date');
  });

  it('explains a token Ironbooks does not accept', async () => {
    writeEndpoint(app.port);
    app.reply = { status: 403, body: JSON.stringify({ error: 'Authentication required.', code: 'FORBIDDEN' }) };
    expect((await failure(client().get('/api/accounts'))).message).toMatch(/did not accept this agent/);
  });

  it('a 429 is passed on with how long Ironbooks asked to hold off (Retry-After)', async () => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const port = (server.address() as AddressInfo).port;
      if (url.pathname === '/api/agent/hello') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof: expectedProof(CHECK, url.searchParams.get('nonce'), port, url.searchParams.get('tag')) }));
        return;
      }
      const retry = url.searchParams.get('retry');
      res
        .writeHead(429, { 'content-type': 'application/json', ...(retry ? { 'retry-after': retry } : {}) })
        .end(JSON.stringify({ error: 'You are already waiting on 4 requests at once.', code: 'RATE_LIMITED', details: { waitsAtOnce: 4 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    try {
      writeEndpoint((server.address() as AddressInfo).port);
      const c = client({ startApp: null });
      const err = await failure(c.get('/api/agent/requests/r-1', { wait: 50, retry: '5' }, { wait: true }));
      expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 5, message: 'You are already waiting on 4 requests at once.' });
      // A missing or odd Retry-After is 0, and a huge one is held to an hour.
      expect((await failure(c.get('/api/agent/requests/r-1', { wait: 50 }, { wait: true }))).retryAfter).toBe(0);
      expect((await failure(c.get('/api/agent/requests/r-1', { retry: 'soon' }))).retryAfter).toBe(0);
      expect((await failure(c.get('/api/agent/requests/r-1', { retry: '99999' }))).retryAfter).toBe(3600);
      // The lane a wait used is free again after a refusal.
      expect((await failure(c.get('/api/agent/requests/r-1', { wait: 50 }, { wait: true }))).code).toBe('RATE_LIMITED');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps the inside of a server error to itself', async () => {
    writeEndpoint(app.port);
    app.reply = { status: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    expect((await failure(client().get('/api/accounts'))).message).toMatch(/could not answer that/);
    app.reply = { status: 200, body: '<html>not json</html>' };
    expect((await failure(client().get('/api/accounts'))).message).toMatch(/could not be read/);
  });
});

describe('the token', () => {
  it('comes from the environment or from a file, and must look like a token', () => {
    expect(loadToken({ IRONBOOKS_AGENT_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN);
    const file = path.join(DIR, 'token.txt');
    fs.writeFileSync(file, `${TOKEN}\r\n`);
    expect(loadToken({ IRONBOOKS_AGENT_TOKEN_FILE: file })).toBe(TOKEN);
    expect(() => loadToken({})).toThrow(NO_TOKEN_MESSAGE);
    expect(() => loadToken({ IRONBOOKS_AGENT_TOKEN: 'sk-something-else' })).toThrow(BAD_TOKEN_MESSAGE);
    expect(() => loadToken({ IRONBOOKS_AGENT_TOKEN_FILE: path.join(DIR, 'missing.txt') })).toThrow(/could not be read/);
    expect(tokenTag(TOKEN)).toBe(TAG);
    expect(tokenTag('nope')).toBeNull();
  });

  it('never appears in a message', async () => {
    writeEndpoint(app.port);
    app.check = 'cd'.repeat(32);
    const err = await failure(client().get('/api/accounts'));
    expect(`${err.message} ${err.stack}`).not.toContain(TOKEN);
    expect(() => loadToken({ IRONBOOKS_AGENT_TOKEN: `${TOKEN}x` })).toThrow(BAD_TOKEN_MESSAGE);
    expect(BAD_TOKEN_MESSAGE).not.toContain(TOKEN);
  });

  it('without a token nothing is sent', async () => {
    writeEndpoint(app.port);
    const c = new IronbooksClient({ env: {}, endpointDir: DIR });
    clients.push(c);
    expect((await failure(c.get('/api/accounts'))).message).toBe(NO_TOKEN_MESSAGE);
    expect(app.seen).toEqual([]);
  });
});

describe('the connector and the app agree', () => {
  it('on where the endpoint files live', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'],
      [{}, 'win32'],
      [{}, 'darwin'],
      [{}, 'linux'],
      [{ XDG_STATE_HOME: '/state' }, 'linux'],
      [{ IRONBOOKS_AGENT_ENDPOINT_DIR: '/custom/place' }, 'win32'],
    ];
    for (const [env, platform] of cases) expect(endpointDir(env, platform), `${platform} ${JSON.stringify(env)}`).toBe(serverSide.endpointDir(env, platform));
  });

  it('on the proof, with the file the app really writes', () => {
    const before = { dir: process.env.IRONBOOKS_AGENT_ENDPOINT_DIR, port: process.env.PORT };
    process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = DIR;
    process.env.PORT = '43210';
    try {
      serverSide.resetAgentEndpointState();
      expect(serverSide.publishEndpoint(TAG)).toBe(true);
      const ep = readEndpoint(TAG, DIR);
      expect(ep).toMatchObject({ port: 43210, tag: TAG });
      const nonce = 'e7'.repeat(32);
      expect(serverSide.helloProof(TAG, nonce)).toBe(expectedProof(ep!.check, nonce, ep!.port, TAG));
      // A different question, port or file gives a different answer.
      expect(serverSide.helloProof(TAG, 'e8'.repeat(32))).not.toBe(expectedProof(ep!.check, nonce, ep!.port, TAG));
      expect(expectedProof(ep!.check, nonce, 43211, TAG)).not.toBe(serverSide.helloProof(TAG, nonce));
      serverSide.withdrawEndpoint(TAG);
      expect(fs.existsSync(path.join(DIR, `${TAG}.json`))).toBe(false);
      expect(serverSide.helloProof(TAG, nonce)).toBeNull();
    } finally {
      serverSide.resetAgentEndpointState();
      if (before.dir === undefined) delete process.env.IRONBOOKS_AGENT_ENDPOINT_DIR;
      else process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = before.dir;
      if (before.port === undefined) delete process.env.PORT;
      else process.env.PORT = before.port;
    }
  });
});

describe('starting Ironbooks when it is closed', () => {
  const installed = {
    execPath: 'C:\\Program Files\\Ironbooks\\Ironbooks.exe',
    scriptDir: 'C:\\Program Files\\Ironbooks\\resources\\mcp',
    electron: '41.0.0',
    exists: (p: string) => p.replace(/\\/g, '/').endsWith('/resources/app'),
  };
  /** A stand-in for starting the app: counts, and (optionally) "comes up" a moment later. */
  function starter(comesUpOn?: () => number) {
    const s = { started: 0, start: () => undefined as void };
    s.start = () => {
      s.started++;
      if (comesUpOn) setTimeout(() => writeEndpoint(comesUpOn()), 60);
    };
    return s;
  }

  it('only when the settings ask for it, and only from the connector inside an installed Ironbooks', () => {
    expect(START_ENV).toBe('IRONBOOKS_AGENT_START');
    expect(appStartCommand({ [START_ENV]: '1' }, installed)).toEqual({ command: installed.execPath, args: ['--agent-service'] });
    // Not asked for: never.
    expect(appStartCommand({}, installed)).toBeNull();
    expect(appStartCommand({ [START_ENV]: 'true' }, installed)).toBeNull();
    expect(appStartCommand({ [START_ENV]: '0' }, installed)).toBeNull();
    // Run by plain Node (a source checkout): there is no app to start.
    expect(appStartCommand({ [START_ENV]: '1' }, { ...installed, electron: undefined })).toBeNull();
    // A copy of the script somewhere else, or no app beside it: never.
    expect(appStartCommand({ [START_ENV]: '1' }, { ...installed, scriptDir: 'C:\\Users\\me\\Downloads\\mcp', exists: () => false })).toBeNull();
    expect(appStartCommand({ [START_ENV]: '1' }, { ...installed, scriptDir: 'C:\\Program Files\\Ironbooks\\resources\\other' })).toBeNull();
    // Under the test runner (plain Node) the real thing is off too.
    expect(appStartCommand({ [START_ENV]: '1' })).toBeNull();
  });

  it('the command is never taken from the environment', () => {
    const cmd = appStartCommand({ [START_ENV]: '1', IRONBOOKS_APP: 'C:\\other.exe', IRONBOOKS_URL: 'http://example.com' }, installed);
    expect(cmd).toEqual({ command: installed.execPath, args: ['--agent-service'] });
  });

  it('Ironbooks is started without the token and without the settings meant for the connector', () => {
    const env = appStartEnv({ PATH: 'x', ELECTRON_RUN_AS_NODE: '1', IRONBOOKS_AGENT_TOKEN: TOKEN, IRONBOOKS_AGENT_TOKEN_FILE: 'C:\\t.txt', [START_ENV]: '1', IRONBOOKS_AGENT_ENDPOINT_DIR: DIR });
    expect(env).toEqual({ PATH: 'x' });
  });

  it('starts the app detached, and never asks Windows to hide it (that would also hide the window a person opens)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'mcp', 'client.mjs'), 'utf8');
    const body = src.slice(src.indexOf('function defaultStartApp('));
    expect(body).toContain("spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore', env: appStartEnv(env) })");
    expect(body).not.toMatch(/windowsHide\s*:/);
  });

  it('a connector that may not start it behaves exactly as before', async () => {
    const c = client({ startApp: null });
    expect((await failure(c.get('/api/accounts'))).message).toBe(NOT_CONNECTED_MESSAGE);
    expect(app.seen).toEqual([]);
  });

  it('starts it once, waits for it to open the company file, proves it, then sends', async () => {
    const s = starter(() => app.port);
    const c = client({ startApp: s.start, startPollMs: 20, startWaitMs: 4000 });
    app.reply = { status: 200, body: JSON.stringify({ accounts: [] }) };
    expect(await c.get('/api/accounts')).toEqual({ accounts: [] });
    expect(s.started).toBe(1);
    // Proof first, then the token on that connection, as always.
    expect(app.seen.map((r) => r.url.split('?')[0])).toEqual(['/api/agent/hello', '/api/accounts']);
    expect(app.seen[0].auth).toBeUndefined();
    expect(app.seen[1].socket).toBe(app.seen[0].socket);
    // Running now: the next request starts nothing.
    await c.get('/api/accounts');
    expect(s.started).toBe(1);
  });

  it('a leftover endpoint file from a run that is gone is no obstacle, and never gets the token', async () => {
    const dead = await stub();
    const deadPort = dead.port;
    await dead.close();
    writeEndpoint(deadPort);
    const s = starter(() => app.port);
    const c = client({ startApp: s.start, startPollMs: 20, startWaitMs: 4000 });
    expect(await c.act({ action: 'enter_journal_entry', input: {}, requestId: 'r-1' })).toEqual({ ok: true });
    expect(s.started).toBe(1);
    expect(app.seen.filter((r) => r.auth !== undefined)).toHaveLength(1);
  });

  it('when Ironbooks does not come up, the agent is told why in plain words, and it is not started over and over', async () => {
    const s = starter();
    const c = client({ startApp: s.start, startPollMs: 10, startWaitMs: 80, startEveryMs: 60_000 });
    const first = await failure(c.get('/api/accounts'));
    expect(first.message).toBe(NOT_STARTED_MESSAGE);
    expect(first.message).not.toContain(TOKEN);
    expect((await failure(c.get('/api/accounts'))).message).toBe(NOT_STARTED_MESSAGE);
    expect((await failure(c.act({ action: 'x' }))).message).toBe(NOT_STARTED_MESSAGE);
    expect(s.started).toBe(1);
    expect(app.seen).toEqual([]);
  });

  it('a program on the port that cannot prove itself is never sent the token, started or not', async () => {
    writeEndpoint(app.port);
    app.check = 'cd'.repeat(32);
    const s = starter();
    const c = client({ startApp: s.start, startPollMs: 10, startWaitMs: 80 });
    expect((await failure(c.get('/api/accounts'))).message).toBe(NOT_STARTED_MESSAGE);
    expect(s.started).toBe(1);
    expect(tokenSeen()).toBe(false);
  });

  it('a change whose answer was lost is never sent again by starting the app', async () => {
    const s = starter(() => app.port);
    let got = 0;
    // Proves itself, takes the change, then drops the connection without answering.
    const dropper = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/api/agent/hello') {
        const port = (dropper.address() as AddressInfo).port;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof: expectedProof(CHECK, url.searchParams.get('nonce'), port, url.searchParams.get('tag')) }));
        return;
      }
      got++;
      req.socket.destroy();
    });
    await new Promise<void>((resolve) => dropper.listen(0, HOST, resolve));
    try {
      writeEndpoint((dropper.address() as AddressInfo).port);
      const c = client({ startApp: s.start, startPollMs: 10, startWaitMs: 80 });
      const err = await failure(c.act({ action: 'enter_journal_entry', input: {}, requestId: 'r-2' }));
      expect(err.message).toBe(LOST_ANSWER_MESSAGE);
      expect(got).toBe(1);
      expect(s.started).toBe(0);
      expect(app.seen).toEqual([]);
    } finally {
      dropper.closeAllConnections();
      await new Promise<void>((resolve) => dropper.close(() => resolve()));
    }
  });
});

describe('when Ironbooks restarts (a company file switched or restored, an update installed)', () => {
  const endpointFile = () => path.join(DIR, `${TAG}.json`);
  const quick = { reconnectFirstPauseMs: 20, reconnectMaxPauseMs: 80 };

  it('a connector Ironbooks answered looks for it again with growing pauses, and sends only after the new one proves itself', async () => {
    const before = await stub();
    let started = 0;
    try {
      writeEndpoint(before.port);
      const c = client({ startApp: () => void started++, startPollMs: 10, startWaitMs: 100, reconnectWaitMs: 5000, ...quick });
      expect(await c.get('/api/accounts')).toEqual({ ok: true });
      // It goes away: the port closes and its endpoint file goes. It comes back a moment later on another port.
      await before.close();
      fs.rmSync(endpointFile(), { force: true });
      setTimeout(() => writeEndpoint(app.port), 200);
      app.reply = { status: 200, body: JSON.stringify({ back: true }) };
      expect(await c.get('/api/accounts')).toEqual({ back: true });
      // The new one proved itself before the token went out, on that same connection.
      expect(app.seen.map((r) => [r.url.split('?')[0], r.auth ? 'token' : 'none'])).toEqual([
        ['/api/agent/hello', 'none'],
        ['/api/accounts', 'token'],
      ]);
      expect(app.seen[1].socket).toBe(app.seen[0].socket);
      // A restart is waited out: no second Ironbooks is started meanwhile.
      expect(started).toBe(0);
    } finally {
      await before.close();
    }
  });

  it('when it does not come back in time, the agent is told plainly; later asks look once, until it is back', async () => {
    const before = await stub();
    try {
      writeEndpoint(before.port);
      const c = client({ startApp: null, reconnectWaitMs: 250, ...quick });
      await c.get('/api/accounts');
      await before.close();
      fs.rmSync(endpointFile(), { force: true });
      let t = Date.now();
      expect((await failure(c.get('/api/accounts'))).message).toBe(AWAY_MESSAGE);
      expect(Date.now() - t).toBeGreaterThanOrEqual(150);
      t = Date.now();
      const again = await failure(c.act({ action: 'enter_journal_entry', input: {}, requestId: 'r-away' }));
      expect(again.message).toBe(AWAY_MESSAGE);
      expect(again.notConnected).toBe(true);
      expect(Date.now() - t).toBeLessThan(150);
      // Back: the next ask goes through, and a later loss is waited out again.
      writeEndpoint(app.port);
      expect(await c.get('/api/accounts')).toEqual({ ok: true });
      expect(AWAY_MESSAGE).toMatch(/restarting/);
      expect(AWAY_MESSAGE).toMatch(/Nothing was sent/);
      expect(AWAY_MESSAGE).not.toContain(TOKEN);
    } finally {
      await before.close();
    }
  });

  it('the pauses between looks grow, twice as long each time, up to the longest pause', async () => {
    writeEndpoint(app.port);
    const c = client({ startApp: null, reconnectWaitMs: 1500, reconnectFirstPauseMs: 40, reconnectMaxPauseMs: 320 });
    await c.get('/api/accounts');
    // From here every look finds nothing, and says when it looked.
    const looks: number[] = [];
    (c as unknown as { _send: () => Promise<never> })._send = async () => {
      looks.push(Date.now());
      throw new IronbooksError('gone', { notConnected: true });
    };
    // The pauses asked for, exactly (the clock itself is too rough on a busy machine to compare them).
    const timer = vi.spyOn(globalThis, 'setTimeout');
    let pauses: unknown[] = [];
    try {
      expect((await failure(c.get('/api/accounts'))).message).toBe(AWAY_MESSAGE);
      pauses = timer.mock.calls.map((args) => args[1]);
    } finally {
      timer.mockRestore();
    }
    // 40, 80, 160, 320, then 320 until the 1.5 seconds run out (how many depends on the clock).
    expect(pauses.slice(0, 5)).toEqual([40, 80, 160, 320, 320]);
    expect(pauses.slice(5).every((p) => p === 320)).toBe(true);
    expect(pauses.reduce((a, b) => (a as number) + (b as number), 0)).toBeLessThanOrEqual(1500);
    // One look before the first pause and one after each, never sooner than the pause.
    expect(looks).toHaveLength(pauses.length + 1);
    looks.slice(1).forEach((t, i) => expect(t - looks[i], `look ${i + 1}`).toBeGreaterThanOrEqual((pauses[i] as number) - 2));
  });

  it('while Ironbooks answered only a short while ago, it is not started (an update may still be installing); after that it is', async () => {
    const before = await stub();
    let started = 0;
    try {
      writeEndpoint(before.port);
      const c = client({ startApp: () => void started++, startPollMs: 10, startWaitMs: 60, reconnectWaitMs: 100, restartGraceMs: 600, ...quick });
      await c.get('/api/accounts');
      await before.close();
      fs.rmSync(endpointFile(), { force: true });
      // Gone just after it answered: looked for, not started, and the agent is told to wait.
      expect((await failure(c.get('/api/accounts'))).message).toBe(AWAY_MESSAGE);
      expect((await failure(c.get('/api/accounts'))).message).toBe(AWAY_MESSAGE);
      expect(started).toBe(0);
      // Silent for longer than that: started (it does not come up here, so the agent is told why).
      await new Promise((r) => setTimeout(r, 650));
      expect((await failure(c.get('/api/accounts'))).message).toBe(NOT_STARTED_MESSAGE);
      expect(started).toBe(1);
    } finally {
      await before.close();
    }
  });

  it('a connector that answered long ago starts Ironbooks at once, without first looking for it (the hidden copy closes itself when idle)', async () => {
    const before = await stub();
    let started = 0;
    try {
      writeEndpoint(before.port);
      const c = client({ startApp: () => void started++, startPollMs: 10, startWaitMs: 60, reconnectWaitMs: 5000, restartGraceMs: 100, ...quick });
      await c.get('/api/accounts');
      await before.close();
      fs.rmSync(endpointFile(), { force: true });
      await new Promise((r) => setTimeout(r, 150));
      const t = Date.now();
      expect((await failure(c.get('/api/accounts'))).message).toBe(NOT_STARTED_MESSAGE);
      expect(started).toBe(1);
      // No 5-second search first.
      expect(Date.now() - t).toBeLessThan(2000);
    } finally {
      await before.close();
    }
  });

  it('a connector Ironbooks never answered does not wait: it says at once that Ironbooks is not ready', async () => {
    const c = client({ startApp: null, reconnectWaitMs: 5000, ...quick });
    const t = Date.now();
    expect((await failure(c.get('/api/accounts'))).message).toBe(NOT_CONNECTED_MESSAGE);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('the connector knows which operations restart Ironbooks, as the registry says', () => {
    expect([...RESTARTING_OPERATIONS].sort()).toEqual(SHELL_OPERATIONS.filter((o) => o.restarts).map((o) => o.id).sort());
    expect(SHELL_OPERATIONS.find((o) => o.id === UPDATE_OPERATION)?.restarts).toBe(true);
    // The numbers, as documented: five minutes for a restart, fifteen while an update may be installing.
    expect(RESTART_GRACE_MS).toBe(5 * 60_000);
    expect(UPDATE_GRACE_MS).toBe(15 * 60_000);
  });

  it('while an update this agent asked for may be installing, Ironbooks is not started for longer; a refused one changes nothing', async () => {
    const before = await stub();
    let started = 0;
    try {
      writeEndpoint(before.port);
      const c = client({ startApp: () => void started++, startPollMs: 10, startWaitMs: 60, reconnectWaitMs: 60, restartGraceMs: 150, updateGraceMs: 60_000, ...quick });
      await c.get('/api/accounts');
      // The agent asked for the update (run_operation said "asked"); a person approves it and Ironbooks goes.
      c.noteRequest({ id: 'req-update', operation: UPDATE_OPERATION, status: 'pending' });
      c.noteRequest({ id: 'req-other', operation: 'invoices.create', status: 'pending' }); // not a restart: ignored
      await before.close();
      fs.rmSync(endpointFile(), { force: true });
      expect((await failure(c.get('/api/accounts'))).message).toBe(UPDATING_MESSAGE);
      // Longer than a plain restart is waited out: still not started, still told it is updating.
      await new Promise((r) => setTimeout(r, 250));
      expect((await failure(c.get('/api/accounts'))).message).toBe(UPDATING_MESSAGE);
      expect(started).toBe(0);
      // The person denied it after all: the silence is not an update, and the usual rule applies.
      c.noteRequest({ id: 'req-update', operation: UPDATE_OPERATION, status: 'denied' });
      expect((await failure(c.get('/api/accounts'))).message).toBe(NOT_STARTED_MESSAGE);
      expect(started).toBe(1);
      expect(UPDATING_MESSAGE).toMatch(/several minutes/);
      expect(UPDATING_MESSAGE).toMatch(/Nothing was sent/);
    } finally {
      await before.close();
    }
  });

  it('an approved update explains only the silence that follows it: once Ironbooks is back, or long after, it no longer counts', async () => {
    const before = await stub();
    let started = 0;
    try {
      writeEndpoint(before.port);
      const c = client({ startApp: () => void started++, startPollMs: 10, startWaitMs: 60, reconnectWaitMs: 60, restartGraceMs: 400, updateGraceMs: 60_000, restartExpectedWithinMs: 200, ...quick });
      await c.get('/api/accounts');
      c.noteRequest({ id: 'req-update', operation: UPDATE_OPERATION, status: 'executed' });
      // Ironbooks keeps answering for longer than an approved restart takes to start: it never came.
      await new Promise((r) => setTimeout(r, 300));
      await c.get('/api/accounts');
      await before.close();
      fs.rmSync(endpointFile(), { force: true });
      // Gone just now: the plain restart rule (looked for, not started yet), not the update's.
      expect((await failure(c.get('/api/accounts'))).message).toBe(AWAY_MESSAGE);
      await new Promise((r) => setTimeout(r, 450));
      expect((await failure(c.get('/api/accounts'))).message).toBe(NOT_STARTED_MESSAGE);
      expect(started).toBe(1);
    } finally {
      await before.close();
    }
    // Approved, Ironbooks went and came back: the update is in, and a later silence is a plain one.
    const first = await stub();
    try {
      writeEndpoint(first.port);
      const c = client({ startApp: null, reconnectWaitMs: 2000, restartGraceMs: 100, updateGraceMs: 60_000, ...quick });
      await c.get('/api/accounts');
      c.noteRequest({ id: 'req-update-2', operation: UPDATE_OPERATION, status: 'approved' });
      expect((c as unknown as { _grace: () => { graceMs: number } })._grace().graceMs).toBe(60_000);
      await first.close();
      fs.rmSync(endpointFile(), { force: true });
      setTimeout(() => writeEndpoint(app.port), 100);
      expect(await c.get('/api/accounts')).toEqual({ ok: true });
      const grace = () => (c as unknown as { _grace: () => { graceMs: number; update: boolean } })._grace();
      expect(grace()).toEqual({ graceMs: 100, update: false });
      // Reading that request again later (list_my_requests says executed) does not bring it back.
      c.noteRequest({ id: 'req-update-2', operation: UPDATE_OPERATION, status: 'executed' });
      expect(grace()).toEqual({ graceMs: 100, update: false });
    } finally {
      await first.close();
    }
  });

  it('an approved restart counts from when it was approved: one approved long ago, read again after the connector started, explains nothing', () => {
    type Grace = { graceMs: number; update: boolean };
    const c = client({ startApp: null, restartGraceMs: 100, updateGraceMs: 60_000 });
    const inside = c as unknown as { _grace: () => Grace; restarts: Map<string, { approvedAt: number | null }>; restartsOver: Set<string> };
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    // Yesterday's executed update, listed by list_my_requests: over long ago, not "installing now".
    c.noteRequest({ id: 'old-update', operation: UPDATE_OPERATION, status: 'executed', decidedAt: ago(24 * 60 * 60_000) });
    expect(inside._grace()).toEqual({ graceMs: 100, update: false });
    expect(inside.restartsOver.has('old-update')).toBe(true);
    // Read again, with or without its time: still over.
    c.noteRequest({ id: 'old-update', operation: UPDATE_OPERATION, status: 'executed' });
    expect(inside._grace()).toEqual({ graceMs: 100, update: false });
    // Approved a minute ago: it counts, from when it was approved, not from when it was heard of.
    const before = Date.now();
    c.noteRequest({ id: 'new-update', operation: UPDATE_OPERATION, status: 'approved', decidedAt: ago(60_000) });
    expect(inside._grace()).toEqual({ graceMs: 60_000, update: true });
    expect(inside.restarts.get('new-update')!.approvedAt!).toBeLessThanOrEqual(before - 60_000 + 1_000);
    // A first of two approvals leaves it pending, with a time: it has not restarted anything yet.
    c.noteRequest({ id: 'two-people', operation: 'shell.company.switch', status: 'pending', decidedAt: ago(1_000), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(inside.restarts.get('two-people')!.approvedAt).toBeNull();
  });

  it('a restart request still waiting counts only until it expires', async () => {
    type Grace = { graceMs: number; update: boolean };
    const c = client({ startApp: null, restartGraceMs: 100, updateGraceMs: 60_000, pendingRestartKeepMs: 80 });
    const inside = c as unknown as { _grace: () => Grace; restarts: Map<string, unknown> };
    // Expired already: nobody can approve it, so it explains no silence.
    c.noteRequest({ id: 'gone', operation: UPDATE_OPERATION, status: 'pending', expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(inside.restarts.has('gone')).toBe(false);
    expect(inside._grace()).toEqual({ graceMs: 100, update: false });
    // Still waiting, until the time its view gives.
    c.noteRequest({ id: 'waiting', operation: UPDATE_OPERATION, status: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(inside._grace()).toEqual({ graceMs: 60_000, update: true });
    // Heard of with no time (run_operation's "asked"): kept PENDING_RESTART_KEEP_MS at most.
    const d = client({ startApp: null, restartGraceMs: 100, updateGraceMs: 60_000, pendingRestartKeepMs: 80 });
    const dIn = d as unknown as { _grace: () => Grace };
    d.noteRequest({ id: 'asked', operation: UPDATE_OPERATION, status: 'pending' });
    expect(dIn._grace()).toEqual({ graceMs: 60_000, update: true });
    await new Promise((r) => setTimeout(r, 120));
    expect(dIn._grace()).toEqual({ graceMs: 100, update: false });
    // The documented bound: seven days, how long a request waits by default.
    expect(PENDING_RESTART_KEEP_MS).toBe(7 * 24 * 60 * 60_000);
    expect(PENDING_RESTART_KEEP_MS).toBe(DEFAULT_REQUEST_EXPIRY_DAYS * 24 * 60 * 60_000);
  });

  it('a change whose answer was lost is never sent again by looking for Ironbooks', async () => {
    let posts = 0;
    const dropper = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const port = (dropper.address() as AddressInfo).port;
      if (url.pathname === '/api/agent/hello') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof: expectedProof(CHECK, url.searchParams.get('nonce'), port, url.searchParams.get('tag')) }));
        return;
      }
      if (req.method === 'POST') {
        posts++;
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => dropper.listen(0, HOST, resolve));
    try {
      writeEndpoint((dropper.address() as AddressInfo).port);
      const c = client({ startApp: null, reconnectWaitMs: 2000, ...quick });
      await c.get('/api/accounts');
      expect((await failure(c.act({ action: 'enter_journal_entry', input: {}, requestId: 'r-lost' }))).message).toBe(LOST_ANSWER_MESSAGE);
      expect(posts).toBe(1);
    } finally {
      dropper.closeAllConnections();
      await new Promise<void>((resolve) => dropper.close(() => resolve()));
    }
  });
});

describe('a long wait for a person', () => {
  it('goes out on its own connection, proved the same way, and does not hold up the other requests', async () => {
    const seen: Array<{ path: string; auth?: string; socket: object }> = [];
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((r) => (release = r));
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, auth: req.headers.authorization, socket: req.socket });
      const port = (server.address() as AddressInfo).port;
      if (url.pathname === '/api/agent/hello') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof: expectedProof(CHECK, url.searchParams.get('nonce'), port, url.searchParams.get('tag')) }));
        return;
      }
      if (url.pathname.startsWith('/api/agent/requests/')) {
        expect(url.searchParams.get('wait')).toBe('50');
        void waiting.then(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ request: { id: 'r', status: 'approved' } })));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accounts: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    try {
      writeEndpoint((server.address() as AddressInfo).port);
      const c = client({ startApp: null });
      const decision = c.get('/api/agent/requests/r-1', { wait: 50 }, { wait: true });
      // While the wait is open, other requests still go through.
      expect(await c.get('/api/accounts')).toEqual({ accounts: [] });
      expect(await c.act({ action: 'list_my_proposals', input: {} })).toEqual({ accounts: [] });
      release();
      expect(await decision).toEqual({ request: { id: 'r', status: 'approved' } });
      // Two connections, each proved before it carried the token.
      const hellos = seen.filter((s) => s.path === '/api/agent/hello');
      const asks = seen.filter((s) => s.path !== '/api/agent/hello');
      expect(hellos).toHaveLength(2);
      expect(hellos.every((h) => h.auth === undefined)).toBe(true);
      expect(new Set(hellos.map((h) => h.socket)).size).toBe(2);
      for (const a of asks) {
        expect(a.auth).toBe(`Bearer ${TOKEN}`);
        expect(hellos.some((h) => h.socket === a.socket), a.path).toBe(true);
      }
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /** A stand-in whose long waits each answer after `holdMs`, recording when each began and on which connection. */
  async function waitingApp(holdMs: number) {
    const seen: Array<{ path: string; auth?: string; socket: object; at: number }> = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, auth: req.headers.authorization, socket: req.socket, at: Date.now() });
      const port = (server.address() as AddressInfo).port;
      if (url.pathname === '/api/agent/hello') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof: expectedProof(CHECK, url.searchParams.get('nonce'), port, url.searchParams.get('tag')) }));
        return;
      }
      const id = url.pathname.split('/').pop();
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ request: { id, status: 'pending' } })), holdMs);
    });
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    return {
      seen,
      port: (server.address() as AddressInfo).port,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it('two waits at once each have a connection of their own: neither sits behind the other', async () => {
    const HOLD = 600;
    const w = await waitingApp(HOLD);
    try {
      writeEndpoint(w.port);
      const c = client({ startApp: null });
      const t = Date.now();
      const [a, b] = await Promise.all([
        c.get('/api/agent/requests/r-a', { wait: 50 }, { wait: true }),
        c.get('/api/agent/requests/r-b', { wait: 50 }, { wait: true }),
      ]);
      const took = Date.now() - t;
      expect(a).toEqual({ request: { id: 'r-a', status: 'pending' } });
      expect(b).toEqual({ request: { id: 'r-b', status: 'pending' } });
      // Both waited at the same time: together they took about one hold, never two.
      expect(took).toBeLessThan(2 * HOLD);
      const waits = w.seen.filter((s) => s.path.startsWith('/api/agent/requests/'));
      expect(waits).toHaveLength(2);
      expect(Math.abs(waits[0].at - waits[1].at)).toBeLessThan(HOLD);
      expect(waits[0].socket).not.toBe(waits[1].socket);
      // Each on a connection that proved itself first.
      const hellos = w.seen.filter((s) => s.path === '/api/agent/hello');
      for (const x of waits) {
        expect(x.auth).toBe(`Bearer ${TOKEN}`);
        expect(hellos.some((h) => h.socket === x.socket && h.at <= x.at)).toBe(true);
      }
      expect(hellos.every((h) => h.auth === undefined)).toBe(true);
      // The next two waits reuse those two proven connections: no new question needed.
      await Promise.all([c.get('/api/agent/requests/r-c', { wait: 50 }, { wait: true }), c.get('/api/agent/requests/r-d', { wait: 50 }, { wait: true })]);
      expect(w.seen.filter((s) => s.path === '/api/agent/hello')).toHaveLength(hellos.length);
    } finally {
      await w.close();
    }
  });

  it(`a wait beyond ${MAX_OPEN_WAITS} at once is refused at once, with nothing sent, instead of queueing for up to 50 seconds`, async () => {
    const w = await waitingApp(400);
    try {
      writeEndpoint(w.port);
      const c = client({ startApp: null });
      const open = [c.get('/api/agent/requests/r-1', { wait: 50 }, { wait: true }), c.get('/api/agent/requests/r-2', { wait: 50 }, { wait: true })];
      const t = Date.now();
      const third = await failure(c.get('/api/agent/requests/r-3', { wait: 50 }, { wait: true }));
      expect(Date.now() - t).toBeLessThan(100);
      expect(third).toMatchObject({ code: WAITS_BUSY_CODE, message: WAITS_BUSY_MESSAGE, notConnected: false });
      // A read without waiting still goes, on the agent's own connection.
      expect(await c.get('/api/agent/requests/r-3', { wait: 0 })).toEqual({ request: { id: 'r-3', status: 'pending' } });
      await Promise.all(open);
      expect(w.seen.filter((s) => s.path.endsWith('/r-3'))).toHaveLength(1);
      // Once they are back, a new wait goes out.
      expect(await c.get('/api/agent/requests/r-4', { wait: 50 }, { wait: true })).toEqual({ request: { id: 'r-4', status: 'pending' } });
    } finally {
      await w.close();
    }
  });
});
