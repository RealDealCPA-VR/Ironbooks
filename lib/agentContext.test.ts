/**
 * Agent access: the way in (lib/agentContext.ts, lib/context.ts, lib/net/requestInfo.ts).
 *
 * The real `getServerContext` runs here, with next/headers standing in for a request the way
 * lib/services/users.test.ts does (middleware's stamp of path + method, cookies, headers).
 *
 * What is proved:
 *  - a good token gives the agent's own context: its company, no user id, the view-only role, a
 *    read-only database handle, never Admin;
 *  - a wrong or removed token is refused, and a request with an Authorization header NEVER falls
 *    through to a sign-in cookie it carries or to the first-run fallback;
 *  - an agent is never the app window (remote trust even with the launch pass), so host-only
 *    settings stay closed to it;
 *  - nothing but the listed read routes, GET only; not through the multi-user proxy, not from a
 *    browser, not before a person signed in, not in a practice copy, not in single-user mode;
 *  - the same permission map as a person with that role;
 *  - people's requests are untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-context');
const TEST_DIR = path.join(ROOT, 'data');
const ENDPOINTS = path.join(ROOT, 'endpoints');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-context-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = ENDPOINTS;
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;
delete process.env.PORT;

import { getDb, closeDb, type DB } from '@/lib/db';
import { isReadOnlyDb } from '@/lib/db/readOnly';
import { companies, users } from '@/lib/db/schema';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext, getSessionGate } from '@/lib/context';
import { AGENT_AUTH_MESSAGE, AGENT_HOST_ONLY_MESSAGE, AGENT_NOT_AVAILABLE_MESSAGE, AGENT_NOT_READY_MESSAGE, AGENT_SANDBOX_MESSAGE } from '@/lib/agentContext';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { AGENT_READ_ROUTES } from '@/lib/permissions/agentAccess';
import { fullAccess } from '@/lib/permissions/model';
import { UNVERIFIED_LOCAL_ADDR, getRequestOrigin, originFromHeaders } from '@/lib/net/requestInfo';
import { isRemoteRequest } from '@/lib/net/hostOnly';
import { endpointDir, helloMessage, resetAgentEndpointState } from '@/lib/agent/endpointFile';
import { createCompany } from '@/lib/services/company';
import { ServiceError, type ServiceContext, inTransaction, writeAudit } from '@/lib/services/_base';
import { AGENTS_BLOCKED_MESSAGE, agentFileTag, createAgent, revokeAgent } from '@/lib/services/agents';
import { requireAccessInCompany, requireFileAdmin } from '@/lib/services/access';
import { enterSingleUserMode, exitSingleUserMode, startSession } from '@/lib/services/sessions';
import { SANDBOX_MARKER, SANDBOX_MARKER_SCHEMA } from '@/lib/services/sandboxState';
import { createHmac } from 'node:crypto';
import { GET as helloGET } from '@/app/api/agent/hello/route';
import { GET as whoamiGET } from '@/app/api/agent/whoami/route';
import { GET as agentsGET, POST as agentsPOST } from '@/app/api/agents/route';
import { DELETE as agentDELETE } from '@/app/api/agents/[id]/route';
import { PUT as policyPUT } from '@/app/api/network-policy/route';
import { PUT as aiSettingsPUT } from '@/app/api/ai/settings/route';
import { PUT as emailPUT } from '@/app/api/email/settings/route';

let db: DB;
let companyId: string;
let otherCompanyId: string;
let ownerId: string;
let admin: ServiceContext;
let token: string;
let agentId: string;

/** A request as middleware would hand it on: stamped path + method, plus headers and cookies. */
function request(method: string | null, routePath: string | null, opts: { token?: string; auth?: string; user?: string; sid?: string; headers?: Record<string, string> } = {}) {
  h.headers.clear();
  h.cookies.clear();
  if (routePath !== null) h.headers.set(ROUTE_PATH_HEADER, routePath);
  if (method !== null) h.headers.set(ROUTE_METHOD_HEADER, method);
  h.headers.set('host', 'localhost:45123');
  if (opts.token) h.headers.set('authorization', `Bearer ${opts.token}`);
  if (opts.auth) h.headers.set('authorization', opts.auth);
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.headers.set(k, v);
  if (opts.user) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(opts.user, 'user', opts.sid));
    h.cookies.set(COMPANY_COOKIE, companyId);
  }
}

async function refusedWith(p: Promise<unknown>, message?: string | RegExp): Promise<ServiceError> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, 'the request was let through').toBeInstanceOf(ServiceError);
  const se = err as ServiceError;
  expect(se.code).toBe('FORBIDDEN');
  if (typeof message === 'string') expect(se.message).toBe(message);
  else if (message) expect(se.message).toMatch(message);
  return se;
}

/** A person works in the file: from now on (in this run) agents may. */
async function personSignsIn() {
  request('GET', '/api/accounts', { user: ownerId });
  return getServerContext();
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetAgentEndpointState();
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'owner@agentctx.test', name: 'Olive Owner', passwordHash: 'x' }).returning();
  ownerId = owner.id;
  companyId = (await createCompany(db, { name: 'Agent Context Co', ownerId })).id;
  otherCompanyId = (await createCompany(db, { name: 'Second Co', ownerId })).id;
  admin = { db, companyId, userId: ownerId, role: 'owner', access: fullAccess() };
  const made = await createAgent(admin, { name: 'Reader', roleKeys: ['bookkeeper'], mode: 'post' });
  token = made.token;
  agentId = made.agent.id;
});

afterAll(async () => {
  resetAgentEndpointState();
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  delete process.env.BKA_LAUNCH_PASS;
  delete process.env.BKA_COMPANY_SEALED;
});

describe('before anyone has signed in', () => {
  it('an agent with a good token is told to wait, and nothing is published', async () => {
    request('GET', '/api/accounts', { token });
    const err = await refusedWith(getServerContext(), AGENT_NOT_READY_MESSAGE);
    expect(err.details).toMatchObject({ agent: true, notReady: true });
    expect(fs.existsSync(path.join(endpointDir(), `${agentFileTag()}.json`))).toBe(false);
    const res = await helloGET(new NextRequest(`http://localhost:45123/api/agent/hello?tag=${agentFileTag()}&nonce=${'ab'.repeat(32)}`));
    expect(res.status).toBe(404);
  });

  it('a protected file nobody opened yet answers the same, without touching the database', async () => {
    process.env.BKA_COMPANY_SEALED = 'extract';
    try {
      request('GET', '/api/accounts', { token });
      await refusedWith(getServerContext(), AGENT_NOT_READY_MESSAGE);
    } finally {
      delete process.env.BKA_COMPANY_SEALED;
    }
  });
});

describe('after a person signed in', () => {
  beforeAll(async () => {
    const ctx = await personSignsIn();
    expect(ctx.userId).toBe(ownerId);
    expect(ctx.readOnly).toBeUndefined();
    expect(isReadOnlyDb(ctx.db)).toBe(false);
  });

  it('a good token gives the agent its own, read-only context', async () => {
    request('GET', '/api/accounts', { token });
    const ctx = await getServerContext();
    expect(ctx.companyId).toBe(companyId);
    expect(ctx.userId).toBeNull();
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.agent).toEqual({ id: agentId, name: 'Reader', mode: 'post' });
    // Post mode is stored, but in this version every agent only reads.
    expect(ctx.readOnly).toBe(true);
    expect(ctx.role).toBe('viewer');
    expect(isReadOnlyDb(ctx.db)).toBe(true);
    expect(ctx.closingDateOverride).toBe(false);
    // Always both: their absence would mean "trusted" to the services.
    expect(ctx.access).toBeDefined();
    expect(ctx.access!.isAdmin).toBe(false);
    expect(ctx.access!.permissions.users).toEqual([]);
    expect(ctx.access!.permissions.file_utilities).toEqual([]);
    expect(ctx.access!.flags).toEqual({ sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false });
  });

  it('that context cannot change the books, three ways over', async () => {
    request('GET', '/api/accounts', { token });
    const ctx = await getServerContext();
    // the view-only role
    await refusedWith(writeAudit(ctx, { action: 'update', entityType: 'customer', entityId: companyId }), /view-only/);
    await refusedWith(inTransaction(ctx, async () => 1), /view-only/);
    // the handle itself, for a service that forgets the role
    await expect(async () => ctx.db.update(companies).set({ name: 'Changed by agent' })).rejects.toBeInstanceOf(ServiceError);
    const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    expect(c.name).toBe('Agent Context Co');
  });

  it('re-checks from a user id find none and refuse', async () => {
    request('GET', '/api/accounts', { token });
    const ctx = await getServerContext();
    await refusedWith(requireFileAdmin(ctx));
    await refusedWith(requireAccessInCompany(ctx, otherCompanyId, 'reports_financial', 'view'));
    await refusedWith(requireAccessInCompany(ctx, companyId, 'reports_financial', 'view'));
  });

  it('a wrong token is refused, and never falls through to a sign-in cookie or first-run', async () => {
    const wrong = `${token.slice(0, -6)}${token.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA'}`;
    request('GET', '/api/accounts', { token: wrong });
    await refusedWith(getServerContext(), AGENT_AUTH_MESSAGE);
    // The Admin's own valid cookie rides along: still the agent rules, still refused.
    request('GET', '/api/accounts', { token: wrong, user: ownerId });
    await refusedWith(getServerContext(), AGENT_AUTH_MESSAGE);
    // Any other Authorization header is not a way in either, cookie or not.
    for (const auth of ['Basic b3duZXI6eA==', 'Bearer not-an-agent-token', 'ibka_x', token]) {
      request('GET', '/api/accounts', { auth, user: ownerId });
      await refusedWith(getServerContext(), AGENT_AUTH_MESSAGE);
    }
    // And with the dev fallback switched on, a bad token still gets nothing.
    process.env.BKA_ALLOW_DEV_FALLBACK = '1';
    try {
      request('GET', '/api/accounts', { token: wrong });
      await refusedWith(getServerContext(), AGENT_AUTH_MESSAGE);
    } finally {
      delete process.env.BKA_ALLOW_DEV_FALLBACK;
    }
  });

  it('the header name and scheme are read without regard to case', async () => {
    request('GET', '/api/accounts', { auth: `bearer ${token}` });
    expect((await getServerContext()).agent?.id).toBe(agentId);
    request('GET', '/api/accounts', { auth: `  BEARER   ${token}  ` });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });

  it('only reads: every other method is refused', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      request(method, '/api/accounts', { token });
      await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    }
    request('HEAD', '/api/accounts', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });

  it('only the listed routes: everything else is refused, whatever the role would allow', async () => {
    for (const routePath of [
      '/api/users',
      '/api/agents',
      `/api/agents/${agentId}`,
      '/api/roles',
      '/api/backup',
      '/api/backups',
      '/api/company',
      '/api/preferences',
      '/api/network-policy',
      '/api/ai/settings',
      '/api/attachments/11111111-2222-4333-8444-555555555555',
      '/api/reports/summary/profit-loss',
      '/api/reports/profit-loss',
      '/api/bank-transactions/suggestions',
      '/api/sessions',
      '/api/audit-trail',
      '/api/invoices',
      '/api/no-such-route',
      '/api',
      '/dashboard',
      '/users',
      '/',
    ]) {
      request('GET', routePath, { token });
      await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    }
    // No stamp (middleware did not run): no access. Never "GET by default".
    request('GET', null, { token });
    await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    request(null, '/api/accounts', { token });
    await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
  });

  it('every listed route is a mapped API route', async () => {
    const { API_ROUTE_PERMISSIONS } = await import('@/lib/permissions/routes');
    for (const p of AGENT_READ_ROUTES) expect(API_ROUTE_PERMISSIONS[p]?.GET, p).toBeDefined();
  });

  it('the same permission map as a person with that role', async () => {
    // Reports Only: reports, no lists and no registers.
    const limited = await createAgent(admin, { name: 'Reports only', roleKeys: ['reports_only'], mode: 'read_only' });
    request('GET', '/api/reports/std/profit-loss', { token: limited.token });
    expect((await getServerContext()).agent?.name).toBe('Reports only');
    request('GET', '/api/find', { token: limited.token });
    expect((await getServerContext()).agent?.name).toBe('Reports only');
    for (const routePath of ['/api/customers', '/api/vendors', '/api/items', '/api/employees', '/api/registers']) {
      request('GET', routePath, { token: limited.token });
      await refusedWith(getServerContext(), /You do not have permission/);
    }
    await revokeAgent(admin, limited.agent.id);
  });

  it('a removed agent is refused with its next request', async () => {
    const gone = await createAgent(admin, { name: 'Short-lived', roleKeys: ['view_only'], mode: 'read_only' });
    request('GET', '/api/accounts', { token: gone.token });
    expect((await getServerContext()).agent?.name).toBe('Short-lived');
    await revokeAgent(admin, gone.agent.id);
    request('GET', '/api/accounts', { token: gone.token });
    await refusedWith(getServerContext(), AGENT_AUTH_MESSAGE);
  });

  it('not through the multi-user proxy, and not from a web page', async () => {
    request('GET', '/api/accounts', { token, headers: { 'x-bka-remote-addr': '100.64.0.9', 'sec-bka-proxy': '1' } });
    await refusedWith(getServerContext(), AGENT_HOST_ONLY_MESSAGE);
    request('GET', '/api/accounts', { token, headers: { 'x-bka-remote-addr': '100.64.0.9' } });
    await refusedWith(getServerContext(), AGENT_HOST_ONLY_MESSAGE);
    request('GET', '/api/accounts', { token, headers: { 'sec-fetch-site': 'same-origin' } });
    await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    request('GET', '/api/accounts', { token, headers: { origin: 'http://localhost:45123' } });
    await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
  });

  it('not in a practice copy', async () => {
    const marker = path.join(TEST_DIR, SANDBOX_MARKER);
    fs.writeFileSync(marker, JSON.stringify({ schema: SANDBOX_MARKER_SCHEMA, kind: 'sandbox', realDataDir: TEST_DIR, sourceName: 'Agent Context Co', createdAt: new Date().toISOString() }));
    try {
      request('GET', '/api/accounts', { token });
      await refusedWith(getServerContext(), AGENT_SANDBOX_MESSAGE);
    } finally {
      fs.rmSync(marker, { force: true });
    }
    request('GET', '/api/accounts', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });

  it('not while the company is in single-user mode', async () => {
    const session = await startSession(db, { userId: ownerId, companyId });
    const holder: ServiceContext = { ...admin, sessionId: session.id };
    await enterSingleUserMode(holder);
    try {
      request('GET', '/api/accounts', { token });
      await refusedWith(getServerContext(), /single-user mode/);
    } finally {
      await exitSingleUserMode(holder);
    }
    request('GET', '/api/accounts', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });

  it('not in an archived company, and not when applications are blocked', async () => {
    await db.update(companies).set({ settings: { archived: true } }).where(eq(companies.id, companyId));
    request('GET', '/api/accounts', { token });
    await refusedWith(getServerContext(), AGENT_AUTH_MESSAGE);
    await db.update(companies).set({ settings: { integratedAppsBlocked: true } }).where(eq(companies.id, companyId));
    request('GET', '/api/accounts', { token });
    await refusedWith(getServerContext(), AGENTS_BLOCKED_MESSAGE);
    await db.update(companies).set({ settings: {} }).where(eq(companies.id, companyId));
    request('GET', '/api/accounts', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });

  it("routes about a person's own account are closed to it", async () => {
    request('GET', '/api/companies', { token });
    await refusedWith(getSessionGate(), AGENT_AUTH_MESSAGE);
    // …also with the Admin's cookie alongside.
    request('GET', '/api/companies', { token, user: ownerId });
    await refusedWith(getSessionGate(), AGENT_AUTH_MESSAGE);
    // A person is unaffected.
    request('GET', '/api/companies', { user: ownerId });
    expect((await getSessionGate()).userId).toBe(ownerId);
  });
});

describe('an agent is never the app window', () => {
  const PASS = 'pass-of-this-launch';

  it('counts as a program outside Ironbooks even when it carries the launch pass', async () => {
    process.env.BKA_LAUNCH_PASS = PASS;
    const app = new Headers({ 'x-bka-launch': PASS });
    expect(originFromHeaders(app)).toMatchObject({ remote: false, addr: 'local' });
    const agent = new Headers({ 'x-bka-launch': PASS, authorization: `Bearer ${token}` });
    expect(originFromHeaders(agent)).toMatchObject({ remote: true, addr: UNVERIFIED_LOCAL_ADDR });
    expect(originFromHeaders(new Headers({ cookie: `bka_launch=${PASS}`, authorization: 'Basic x' }))).toMatchObject({ remote: true });
    expect(isRemoteRequest({ headers: agent })).toBe(true);
    request('GET', '/api/accounts', { token, headers: { 'x-bka-launch': PASS } });
    expect((await getRequestOrigin()).remote).toBe(true);
  });

  it('also where no launch pass is enforced (dev, tests)', () => {
    expect(originFromHeaders(new Headers({}))).toMatchObject({ remote: false });
    expect(originFromHeaders(new Headers({ authorization: `Bearer ${token}` }))).toMatchObject({ remote: true, addr: UNVERIFIED_LOCAL_ADDR });
  });

  it('gets no address of its own: sign-in attempt counters are the ones any local program has', () => {
    process.env.BKA_LAUNCH_PASS = PASS;
    const plain = originFromHeaders(new Headers({}));
    const withJunk = originFromHeaders(new Headers({ authorization: 'Bearer ibka_junk' }));
    expect(withJunk.addr).toBe(plain.addr);
    // A teammate through the proxy keeps their own address whatever header they add.
    const teammate = new Headers({ 'x-bka-remote-addr': '100.64.0.9', 'sec-bka-proxy': '1', authorization: 'Bearer x' });
    expect(originFromHeaders(teammate)).toMatchObject({ remote: true, addr: '100.64.0.9' });
  });

  it('host-only settings stay closed to it', async () => {
    process.env.BKA_LAUNCH_PASS = PASS;
    const cases: Array<[string, (req: NextRequest) => Promise<Response>, unknown]> = [
      ['/api/network-policy', policyPUT, { mode: 'allow-cloud', cloudOptIn: { ai: true } }],
      ['/api/ai/settings', aiSettingsPUT, { providers: [{ id: 'p', kind: 'ollama', label: 'x', baseUrl: 'http://10.0.0.5:11434', model: 'm', enabled: true }] }],
      ['/api/email/settings', emailPUT, { host: 'smtp.example.com', port: 587 }],
    ];
    const before = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    for (const [routePath, handler, body] of cases) {
      // Even stamped as if middleware had let it pass, and carrying the launch pass.
      const headers = { authorization: `Bearer ${token}`, 'x-bka-launch': PASS, 'content-type': 'application/json' };
      request('PUT', routePath, { token, headers: { 'x-bka-launch': PASS } });
      const res = await handler(new NextRequest(`http://localhost:45123${routePath}`, { method: 'PUT', headers, body: JSON.stringify(body) }));
      expect(res.status, routePath).toBe(403);
    }
    expect(await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId))).toEqual(before);
  });

  it('cannot make, list or remove agents', async () => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    request('GET', '/api/agents', { token });
    expect((await agentsGET(new NextRequest('http://localhost:45123/api/agents', { headers }))).status).toBe(403);
    request('POST', '/api/agents', { token });
    const post = await agentsPOST(new NextRequest('http://localhost:45123/api/agents', { method: 'POST', headers, body: JSON.stringify({ name: 'Child', roleKeys: ['view_only'], mode: 'read_only' }) }));
    expect(post.status).toBe(403);
    request('DELETE', `/api/agents/${agentId}`, { token });
    const del = await agentDELETE(new NextRequest(`http://localhost:45123/api/agents/${agentId}`, { method: 'DELETE', headers }), { params: Promise.resolve({ id: agentId }) });
    expect(del.status).toBe(403);
    request('GET', '/api/accounts', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });
});

describe('making agents is for an Admin at the computer that holds the file', () => {
  const PASS = 'pass-of-this-launch';
  const json = { 'content-type': 'application/json' };

  it('the Admin in the app window makes one and gets the token once', async () => {
    process.env.BKA_LAUNCH_PASS = PASS;
    request('POST', '/api/agents', { user: ownerId, headers: { 'x-bka-launch': PASS } });
    const res = await agentsPOST(
      new NextRequest('http://localhost:45123/api/agents', { method: 'POST', headers: { ...json, 'x-bka-launch': PASS }, body: JSON.stringify({ name: 'Made in the window', roleKeys: ['view_only'], mode: 'read_only' }) }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const made = await res.json();
    expect(made.token).toMatch(/^ibka_[0-9a-f]{8}_/);
    expect(made.agent).toMatchObject({ name: 'Made in the window', status: 'active' });
    expect(made.agent).not.toHaveProperty('tokenHash');

    request('GET', '/api/agents', { user: ownerId, headers: { 'x-bka-launch': PASS } });
    const list = await (await agentsGET(new NextRequest('http://localhost:45123/api/agents', { headers: { 'x-bka-launch': PASS } }))).json();
    expect(list.hostOnly).toBe(false);
    expect(JSON.stringify(list)).not.toContain(made.token);
    expect(list.agents.map((a: { name: string }) => a.name)).toContain('Made in the window');

    request('DELETE', `/api/agents/${made.agent.id}`, { user: ownerId, headers: { 'x-bka-launch': PASS } });
    const del = await agentDELETE(new NextRequest(`http://localhost:45123/api/agents/${made.agent.id}`, { method: 'DELETE', headers: { 'x-bka-launch': PASS } }), { params: Promise.resolve({ id: made.agent.id }) });
    expect(del.status).toBe(200);
    expect((await del.json()).agent.status).toBe('revoked');
  });

  it('the same Admin from anywhere else may look, not make or remove', async () => {
    process.env.BKA_LAUNCH_PASS = PASS;
    // Another program on this computer (no launch pass), and a teammate through the proxy. Both
    // are signed in as the Admin with a live session (a cookie without one is refused for them).
    const sid = (await startSession(db, { userId: ownerId, companyId, viaHost: true })).id;
    for (const extra of [{}, { 'x-bka-remote-addr': '100.64.0.9', 'sec-bka-proxy': '1' }] as Array<Record<string, string>>) {
      request('POST', '/api/agents', { user: ownerId, sid, headers: extra });
      const res = await agentsPOST(new NextRequest('http://localhost:45123/api/agents', { method: 'POST', headers: { ...json, ...extra }, body: JSON.stringify({ name: 'From afar', roleKeys: ['view_only'], mode: 'read_only' }) }));
      expect(res.status).toBe(403);
      expect((await res.json()).details).toEqual({ hostOnly: true });
      request('DELETE', `/api/agents/${agentId}`, { user: ownerId, sid, headers: extra });
      const del = await agentDELETE(new NextRequest(`http://localhost:45123/api/agents/${agentId}`, { method: 'DELETE', headers: extra }), { params: Promise.resolve({ id: agentId }) });
      expect(del.status).toBe(403);
      request('GET', '/api/agents', { user: ownerId, sid, headers: extra });
      const list = await (await agentsGET(new NextRequest('http://localhost:45123/api/agents', { headers: extra }))).json();
      expect(list.hostOnly).toBe(true);
      expect(list.connection).toBeNull();
    }
    request('GET', '/api/accounts', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });

  it('a bad request body is a plain 400', async () => {
    process.env.BKA_LAUNCH_PASS = PASS;
    for (const body of [{ name: '', roleKeys: ['view_only'], mode: 'read_only' }, { name: 'X', roleKeys: [], mode: 'read_only' }, { name: 'X', roleKeys: ['view_only'], mode: 'write' }, { name: 'X', roleKeys: ['view_only'], mode: 'read_only', isAdmin: true }]) {
      request('POST', '/api/agents', { user: ownerId, headers: { 'x-bka-launch': PASS } });
      const res = await agentsPOST(new NextRequest('http://localhost:45123/api/agents', { method: 'POST', headers: { ...json, 'x-bka-launch': PASS }, body: JSON.stringify(body) }));
      expect(res.status).toBe(400);
    }
  });
});

describe('finding the app', () => {
  it('the endpoint is published while the file has an agent, and proves itself', async () => {
    const tag = agentFileTag();
    const file = path.join(endpointDir(), `${tag}.json`);
    expect(endpointDir()).toBe(ENDPOINTS);
    // Published when the person signed in (the file had an agent); the port is the one people use.
    expect(fs.existsSync(file)).toBe(true);
    const ep = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(ep).toMatchObject({ tag, port: 45123, pid: process.pid });
    expect(ep.check).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(ep).sort()).toEqual(['check', 'pid', 'port', 'schema', 'tag']);

    const nonce = 'c1'.repeat(32);
    const res = await helloGET(new NextRequest(`http://localhost:45123/api/agent/hello?tag=${tag}&nonce=${nonce}`));
    expect(res.status).toBe(200);
    const { proof } = await res.json();
    expect(proof).toBe(createHmac('sha256', Buffer.from(ep.check, 'hex')).update(helloMessage(nonce, 45123, tag)).digest('hex'));
    expect(JSON.stringify(proof)).not.toContain(ep.check);

    // Malformed questions, another file's tag, and anything through the proxy: nothing.
    for (const url of [`?tag=${tag}&nonce=short`, `?tag=${tag}`, `?tag=00000000&nonce=${nonce}`, `?nonce=${nonce}`]) {
      expect((await helloGET(new NextRequest(`http://localhost:45123/api/agent/hello${url}`))).status).toBe(404);
    }
    const proxied = new NextRequest(`http://localhost:45123/api/agent/hello?tag=${tag}&nonce=${nonce}`, { headers: { 'x-bka-remote-addr': '100.64.0.9', 'sec-bka-proxy': '1' } });
    expect((await helloGET(proxied)).status).toBe(404);
  });

  it('whoami tells the agent who it is and which books these are, and no settings', async () => {
    request('GET', '/api/agent/whoami', { token });
    const res = await whoamiGET();
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.agent).toEqual({ name: 'Reader', mode: 'post', modeLabel: 'Post', canChangeBooks: false, roles: ['Bookkeeper'] });
    expect(info.company).toMatchObject({ name: 'Agent Context Co', fiscalYearEnd: '12-31', reportBasis: 'accrual', closingDate: null });
    expect(info.company.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(info.company).not.toHaveProperty('settings');
    expect(info.app.name).toBe('Ironbooks');
    // A person gets the same facts and no agent.
    request('GET', '/api/agent/whoami', { user: ownerId });
    expect((await (await whoamiGET()).json()).agent).toBeNull();
  });

  it('removing the last agent takes the endpoint away', async () => {
    const tag = agentFileTag();
    const file = path.join(endpointDir(), `${tag}.json`);
    const { listAgents } = await import('@/lib/services/agents');
    for (const a of await listAgents(admin)) if (a.status === 'active') await revokeAgent(admin, a.id);
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
    expect((await helloGET(new NextRequest(`http://localhost:45123/api/agent/hello?tag=${tag}&nonce=${'c1'.repeat(32)}`))).status).toBe(404);
    request('GET', '/api/accounts', { token });
    await refusedWith(getServerContext(), AGENT_AUTH_MESSAGE);
    // Making one again publishes it again.
    await createAgent(admin, { name: 'Back again', roleKeys: ['view_only'], mode: 'read_only' });
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
  });
});
