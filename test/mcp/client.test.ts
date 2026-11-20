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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BAD_TOKEN_MESSAGE,
  HOST,
  IronbooksClient,
  IronbooksError,
  LOST_ANSWER_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  NOT_STARTED_MESSAGE,
  NO_TOKEN_MESSAGE,
  START_ENV,
  appStartCommand,
  appStartEnv,
  endpointDir,
  expectedProof,
  loadToken,
  readEndpoint,
  tokenTag,
} from '../../mcp/client.mjs';
import * as serverSide from '@/lib/agent/endpointFile';

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
