/**
 * Agent access: the way in (lib/agentContext.ts, lib/context.ts, lib/net/requestInfo.ts).
 *
 * The real `getServerContext` runs here, with next/headers standing in for a request the way
 * lib/services/users.test.ts does (middleware's stamp of path + method, cookies, headers).
 *
 * What is proved:
 *  - a good token gives the agent's own context: its company, no user id, the view-only role, a
 *    read-only database handle, its preset, and its roles' access with every View flag and the
 *    closed-period right off, without Users & Roles and File Utilities, and never Admin;
 *  - the preset and the pause are read from the agent's row when the agents service does not
 *    hand them over (an older build of it), and a pause still holds;
 *  - a wrong or removed token is refused, and a request with an Authorization header NEVER falls
 *    through to a sign-in cookie it carries or to the first-run fallback;
 *  - an agent is never the app window (remote trust even with the launch pass), so host-only
 *    settings stay closed to it;
 *  - its own request reaches only the door (POST /api/agent/actions), its own reads, and GETs the
 *    registry classes as plain reads open to agents; every other method and every GET classed
 *    admin, file, outside or read_sensitive, person_only, hard_floor or left unclassified is
 *    refused (the reads of Users & Roles are class admin, the backup history class file);
 *  - not through the multi-user proxy, not from a browser, not before a person signed in, not in a
 *    practice copy, not in single-user mode, not while paused;
 *  - an agent may hold the Admin role (D1), but its own requests never reach Users & Roles or the
 *    agents, never act as an Admin, never list Users & Roles entries of the audit trail, and a
 *    direct read never shows a full SSN, whatever its role;
 *  - the agents routes refuse an agent in their own handler too, not only at the way in;
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

/**
 * The real registry, except that a path listed in `probe.unclassified` is answered as if its GET
 * had no hand-written classification. Every route is classified today, so this is the only way to
 * see what the way in does with one that is not.
 */
const probe = vi.hoisted(() => ({ unclassified: new Set<string>() }));
vi.mock('@/lib/agent/operations/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/agent/operations/registry')>();
  return {
    ...real,
    operationForPath: (method: string, pathname: string) => {
      const found = real.operationForPath(method, pathname);
      if (!found || !probe.unclassified.has(pathname)) return found;
      return { ...found, operation: { ...found.operation, classified: false, class: 'admin' as const } };
    },
  };
});

/**
 * The real agents service, except that while `older.find` is set, findAgentByToken answers the
 * way a build from before presets and pausing did: without `preset` and `pausedAt`. That is the
 * only way to see the way in read them from the agent's row itself (presetAndPause).
 */
const older = vi.hoisted(() => ({ find: false }));
vi.mock('@/lib/services/agents', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/services/agents')>();
  return {
    ...real,
    findAgentByToken: async (...args: Parameters<typeof real.findAgentByToken>) => {
      const found = await real.findAgentByToken(...args);
      if (!found || !older.find) return found;
      const rest: Record<string, unknown> = { ...found };
      delete rest.preset;
      delete rest.pausedAt;
      return rest as unknown as typeof found;
    },
  };
});

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
import { agents, companies, users } from '@/lib/db/schema';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext, getSessionGate } from '@/lib/context';
import {
  AGENT_AUTH_MESSAGE,
  AGENT_HOST_ONLY_MESSAGE,
  AGENT_NOT_AVAILABLE_MESSAGE,
  AGENT_NOT_READY_MESSAGE,
  AGENT_PAUSED_MESSAGE,
  AGENT_SANDBOX_MESSAGE,
  agentRequestAllowed,
  agentUseDoorMessage,
} from '@/lib/agentContext';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import {
  AGENT_ACTION_ROUTE,
  AGENT_DOOR_ONLY_AREAS,
  AGENT_OWN_ROUTES,
  agentRouteAllowed,
  type AgentRouteLookup,
} from '@/lib/permissions/agentAccess';
import { builtinRole, fullAccess, unionRoles, withoutAreas } from '@/lib/permissions/model';
import { canSeeAuditEntry, seesWholeLog } from '@/lib/services/auditVisibility';
import { DEFAULT_PRESET } from '@/lib/agent/policy';
import { allOperations, operationForPath, operationForRoute } from '@/lib/agent/operations/registry';
import { createVendor } from '@/lib/services/vendors';
import { GET as vendorGET } from '@/app/api/vendors/[id]/route';
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
import { GET as companyFileInfoGET } from '@/app/api/company-file/info/route';
import { middleware } from '@/middleware';

const ID = '11111111-2222-4333-8444-555555555555';
/** A concrete path for a route pattern ("/api/invoices/[id]" -> "/api/invoices/1111…"). */
const concrete = (pattern: string) => pattern.replace(/\[\.\.\.[^\]]+\]/g, 'a/b').replace(/\[[^\]]+\]/g, ID);

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
    // The preset is the one stored on the agent's row (changed on purpose: the context now names it).
    const [row] = await db.select({ preset: agents.preset }).from(agents).where(eq(agents.id, agentId));
    expect(ctx.agent).toEqual({ id: agentId, name: 'Reader', mode: 'post', preset: row.preset, onBehalfOf: ownerId });
    // Even in Post mode, the context a request arrives with only reads. A change is made through
    // the door alone (POST /api/agent/actions), for one run.
    expect(ctx.readOnly).toBe(true);
    expect(ctx.role).toBe('viewer');
    expect(isReadOnlyDb(ctx.db)).toBe(true);
    expect(ctx.closingDateOverride).toBe(false);
    // Always both: their absence would mean "trusted" to the services.
    expect(ctx.access).toBeDefined();
    expect(ctx.access!.isAdmin).toBe(false);
    // The Bookkeeper role's access, masked and without Users & Roles and File Utilities
    // (agentDirectAccess). The clamp keeps those areas now, for the door; a direct request, which
    // nobody is asked about, leaves them out.
    const bookkeeper = withoutAreas(unionRoles([builtinRole('bookkeeper')!]), AGENT_DOOR_ONLY_AREAS);
    expect(ctx.access!.permissions).toEqual(bookkeeper.permissions);
    expect(ctx.access!.activities).toEqual(bookkeeper.activities);
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

  it('every method but GET is refused, except a POST to the one door', async () => {
    // Changed on purpose: HEAD is refused now too ("every non-GET except the door"). No agent
    // needs it, and it runs the GET handler anyway.
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      request(method, '/api/accounts', { token });
      await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    }
    // The app's own save routes, also those the Bookkeeper role could use as a person. One open to
    // agents is refused with what to ask for through the door instead; the hard floor is simply
    // not available.
    for (const [method, routePath, id] of [
      ['POST', '/api/accounts', 'accounts.create'],
      ['POST', '/api/invoices', 'invoices.create'],
      ['PATCH', `/api/invoices/${ID}`, 'invoices.update'],
      ['DELETE', `/api/invoices/${ID}`, 'invoices.delete'],
      ['POST', '/api/bills', 'bills.create'],
      ['PUT', '/api/network-policy', 'network-policy.replace'],
      ['POST', '/api/users', 'users.create'],
    ]) {
      expect(operationForPath(method, routePath)?.operation).toMatchObject({ id, availability: 'agent' });
      request(method, routePath, { token });
      await refusedWith(getServerContext(), agentUseDoorMessage(id));
    }
    expect(agentUseDoorMessage('invoices.create')).toBe(
      'Ask for this through run_operation with operation "invoices.create". Ironbooks then runs it, asks a person to approve it, or refuses it, as this agent\'s settings say.',
    );
    for (const [method, routePath] of [
      ['POST', '/api/agents'],
      ['DELETE', `/api/agents/${agentId}`],
      ['POST', `/api/agents/${agentId}/pause`],
      ['POST', '/api/agents/pause-all'],
      ['POST', `/api/agent-requests/${ID}/approve`],
      ['POST', `/api/agent-requests/${ID}/deny`],
      ['DELETE', `/api/agent-grants/${ID}`],
    ]) {
      request(method, routePath, { token });
      await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    }
    for (const method of ['PUT', 'PATCH', 'DELETE', 'GET', 'HEAD']) {
      request(method, AGENT_ACTION_ROUTE, { token });
      await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    }
    // The door gives the same read-only context; what it may change is decided behind it.
    request('POST', AGENT_ACTION_ROUTE, { token });
    const actionCtx = await getServerContext();
    expect(actionCtx.readOnly).toBe(true);
    expect(actionCtx.role).toBe('viewer');
    expect(isReadOnlyDb(actionCtx.db)).toBe(true);
    // Over the whole registry: no route that changes something is open to a direct request.
    for (const op of allOperations()) {
      if (op.kind !== 'route' || op.method === 'GET') continue;
      const allowed = agentRequestAllowed(concrete(op.route), op.method);
      expect(allowed, `${op.method} ${op.route}`).toBe(op.method === 'POST' && op.route === AGENT_ACTION_ROUTE);
    }
  });

  it('a GET classed read is allowed; one classed anything else, or left unclassified, is refused', async () => {
    // Changed on purpose: the old fixed list of 38 reads is gone. Any GET the registry classes as a
    // plain read open to agents is reachable within the role, the company and the audit trail
    // among them; everything else goes through the door.
    const cases: Array<[string, string, string]> = [
      ['/api/accounts', 'read', 'agent'],
      ['/api/company', 'read', 'agent'],
      ['/api/audit-trail', 'read', 'agent'],
      ['/api/backup', 'file', 'agent'],
      ['/api/backups', 'file', 'agent'],
      ['/api/report-schedules', 'file', 'agent'],
      ['/api/users', 'admin', 'agent'],
      ['/api/roles', 'admin', 'agent'],
      ['/api/network-policy', 'outside', 'agent'],
      ['/api/bank-transactions/suggestions', 'outside', 'agent'],
      // A filed document as it is (a scanned W-9, a bank statement): masking cannot reach inside it.
      ['/api/attachments/[id]', 'read_sensitive', 'agent'],
      ['/api/reports/1099-xml', 'read_sensitive', 'agent'],
      ['/api/auth/me', 'read', 'person_only'],
      ['/api/handshake', 'read', 'person_only'],
      // A person's own account ('self'): the company files they belong to, who can open the file.
      ['/api/companies', 'read', 'person_only'],
      ['/api/file-protection', 'read', 'person_only'],
      // The sign-in screen's read of the company file's name: class file, so the way in sends it to
      // the door, where an Admin is asked. The route itself is public and never asks for a context,
      // so this refusal never runs for it: see the two tests of what the route answers, below.
      ['/api/company-file/info', 'file', 'agent'],
      // The raw transaction log cannot be masked: never for an agent.
      ['/api/transaction-log/download', 'file', 'hard_floor'],
      ['/api/agents', 'admin', 'hard_floor'],
      ['/api/agent-requests', 'read', 'hard_floor'],
    ];
    for (const [routePath, cls, availability] of cases) {
      // The registry still files each one where this test expects it.
      const op = operationForRoute('GET', routePath);
      expect(op, routePath).toMatchObject({ classified: true, class: cls, availability });
      request('GET', concrete(routePath), { token });
      if (cls === 'read' && availability === 'agent') expect((await getServerContext()).agent?.id, routePath).toBe(agentId);
      else if (availability === 'agent') await refusedWith(getServerContext(), agentUseDoorMessage(op!.id));
      else await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    }
    // A GET with no hand-written classification is refused, even on a route that is a plain read:
    // it goes through the door, where it is class admin and a person is asked.
    probe.unclassified.add('/api/accounts');
    try {
      request('GET', '/api/accounts', { token });
      await refusedWith(getServerContext(), agentUseDoorMessage('accounts.list'));
    } finally {
      probe.unclassified.delete('/api/accounts');
    }
    request('GET', '/api/accounts', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });

  it("the company file's name: an agent's own request gets nothing of it, not even the folder", async () => {
    // The registry classes it file (classes/admin.ts), but the route is public and never calls
    // getServerContext, so the way-in check above does not run for it. The route itself refuses any
    // request that carries Authorization (an agent's token), before it reads anything; the app's own
    // window and the desktop shell never send one, nor does an approved run through the door.
    expect(operationForRoute('GET', '/api/company-file/info')).toMatchObject({ rule: 'public', class: 'file' });
    for (const auth of [{ token }, { auth: 'Bearer not-a-token' }, { auth: 'Basic eDp5' }]) {
      request('GET', '/api/company-file/info', auth);
      const res = await companyFileInfoGET();
      expect(res.status, JSON.stringify(auth)).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ error: 'This is not available to agents.', code: 'FORBIDDEN' });
      const showsAFolder = Object.values(body).filter((v) => typeof v === 'string' && v.includes(ROOT));
      expect(showsAFolder).toEqual([]);
    }
    // The app's own window (no Authorization) still gets its answer.
    request('GET', '/api/company-file/info');
    const own = await companyFileInfoGET();
    expect(own.status).toBe(200);
    expect(await own.json()).toHaveProperty('fileName');
  });

  // Was a FINDING: an agent's own GET got the company file's name, whether it has a password or
  // protection, and its id, with nobody asked. The route now refuses every request that carries
  // Authorization.
  it("an agent's own request for the company file's name is refused, at the edge or in the route", async () => {
    const edge = middleware(
      new NextRequest('http://localhost:45123/api/company-file/info', { headers: { host: 'localhost:45123', authorization: `Bearer ${token}` } }),
    );
    const passedEdge = edge.status === 200 && edge.headers.get('x-middleware-next') === '1';
    request('GET', '/api/company-file/info', { token });
    const answered = passedEdge ? (await companyFileInfoGET()).ok : false;
    expect(answered, "the company file's name was answered to an agent with nobody asked").toBe(false);
  });

  it('hands the rule the registry lookup lib/net/agentOrigin.test.ts checks it with', () => {
    // agentOrigin.test.ts proves agentRouteAllowed with its own copy of this lookup. That proof is
    // worth something only if the way in passes the same one (and passes one at all: without it
    // only the door and the agent's own reads pass), so the two must agree on every route.
    const lookup: AgentRouteLookup = (p) => operationForPath('GET', p)?.operation ?? null;
    let directReads = 0;
    for (const op of allOperations()) {
      if (op.kind !== 'route') continue;
      const p = concrete(op.route);
      for (const method of ['GET', 'HEAD', op.method]) {
        const viaWayIn = agentRequestAllowed(p, method);
        expect(viaWayIn, `${method} ${op.route}`).toBe(agentRouteAllowed(p, method, lookup));
        if (viaWayIn && method === 'GET' && op.method === 'GET' && !AGENT_OWN_ROUTES.includes(op.route)) directReads++;
      }
    }
    // Not vacuous: plain reads do pass, which they could not without a lookup.
    expect(directReads).toBeGreaterThan(50);
    expect(agentRouteAllowed('/api/accounts', 'GET', null)).toBe(false);
    expect(agentRequestAllowed('/api/accounts', 'GET')).toBe(true);
  });

  it('nothing that is not a mapped API route, and nothing without the stamp', async () => {
    for (const routePath of ['/api/no-such-route', '/api', '/dashboard', '/users', '/', '/api/accounts/../users', '/api//accounts']) {
      request('GET', routePath, { token });
      await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    }
    // No stamp (middleware did not run): no access. Never "GET by default".
    request('GET', null, { token });
    await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    request(null, '/api/accounts', { token });
    await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
  });

  it("the agent's own reads are mapped API routes it may reach", async () => {
    const { API_ROUTE_PERMISSIONS } = await import('@/lib/permissions/routes');
    for (const p of AGENT_OWN_ROUTES) {
      expect(API_ROUTE_PERMISSIONS[p]?.GET, p).toBe('member');
      expect(agentRequestAllowed(concrete(p), 'GET'), p).toBe(true);
    }
    request('GET', '/api/agent/whoami', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
  });

  it('a paused agent is refused everything until a person resumes it', async () => {
    const paused = await createAgent(admin, { name: 'Paused', roleKeys: ['bookkeeper'], mode: 'post' });
    try {
      request('GET', '/api/accounts', { token: paused.token });
      expect((await getServerContext()).agent?.name).toBe('Paused');
      await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, paused.agent.id));
      for (const [method, routePath] of [['GET', '/api/accounts'], ['GET', '/api/agent/whoami'], ['POST', AGENT_ACTION_ROUTE]]) {
        request(method, routePath, { token: paused.token });
        const err = await refusedWith(getServerContext(), AGENT_PAUSED_MESSAGE);
        expect(err.details).toMatchObject({ agent: true, paused: true });
      }
      expect(AGENT_PAUSED_MESSAGE).toMatch(/Users & Roles > Agents/);
      // Other agents work on.
      request('GET', '/api/accounts', { token });
      expect((await getServerContext()).agent?.id).toBe(agentId);
      // Resumed: back to work.
      await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, paused.agent.id));
      request('GET', '/api/accounts', { token: paused.token });
      expect((await getServerContext()).agent?.name).toBe('Paused');
    } finally {
      await revokeAgent(admin, paused.agent.id);
    }
  });

  it("reads the pause and the preset from the agent's row when the agents service does not hand them over", async () => {
    const made = await createAgent(admin, { name: 'Older build', roleKeys: ['bookkeeper'], mode: 'post' });
    older.find = true;
    try {
      // The service answers without them; the way in reads the row.
      const [row] = await db.select({ preset: agents.preset }).from(agents).where(eq(agents.id, made.agent.id));
      request('GET', '/api/accounts', { token: made.token });
      expect((await getServerContext()).agent).toMatchObject({ name: 'Older build', preset: row.preset });
      // A pause on the row still refuses everything: the switch never fails open.
      await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, made.agent.id));
      for (const [method, routePath] of [['GET', '/api/accounts'], ['POST', AGENT_ACTION_ROUTE]]) {
        request(method, routePath, { token: made.token });
        const err = await refusedWith(getServerContext(), AGENT_PAUSED_MESSAGE);
        expect(err.details).toMatchObject({ agent: true, paused: true });
      }
      // A preset Ironbooks does not know is read as the default, as the policy engine reads it.
      await db.update(agents).set({ pausedAt: null, preset: 'not_a_preset' }).where(eq(agents.id, made.agent.id));
      request('GET', '/api/accounts', { token: made.token });
      expect((await getServerContext()).agent).toMatchObject({ name: 'Older build', preset: DEFAULT_PRESET });
    } finally {
      older.find = false;
      await revokeAgent(admin, made.agent.id);
    }
  });

  it('the context never carries a View flag or the closed-period right, whatever the role', async () => {
    // Full Access holds all three flags and is not Admin.
    expect(builtinRole('full_access')!.flags).toEqual({ sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true });
    const full = await createAgent(admin, { name: 'Full access', roleKeys: ['full_access'], mode: 'read_only' });
    try {
      const vendor = await createVendor(admin, { displayName: 'Masked Vendor Co', taxId: '123-45-6789', accountNumber: '9876543210' });
      for (const [method, routePath] of [['GET', '/api/accounts'], ['GET', `/api/vendors/${vendor.id}`], ['POST', AGENT_ACTION_ROUTE]]) {
        request(method, routePath, { token: full.token });
        const ctx = await getServerContext();
        expect(ctx.access!.flags, routePath).toEqual({ sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false });
        expect(ctx.closingDateOverride).toBe(false);
      }
      // A direct read of the vendor: the tax id and the account number come back masked.
      request('GET', `/api/vendors/${vendor.id}`, { token: full.token });
      const res = await vendorGET(new NextRequest(`http://localhost:45123/api/vendors/${vendor.id}`, { headers: { authorization: `Bearer ${full.token}` } }), {
        params: Promise.resolve({ id: vendor.id }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('123-45-6789');
      expect(text).not.toContain('9876543210');
      expect(JSON.parse(text).taxId).toMatch(/6789$/);
    } finally {
      await revokeAgent(admin, full.agent.id);
    }
  });

  it('an agent may hold the Admin role, but its own requests never reach Users & Roles or the agents', async () => {
    // Made the way D1 allows, through the real agents service: the Admin role as its ceiling.
    const boss = await createAgent(admin, { name: 'Admin agent', roleKeys: ['admin'], mode: 'read_only' });
    try {
      request('GET', '/api/accounts', { token: boss.token });
      const ctx = await getServerContext();
      expect(ctx.agent?.name).toBe('Admin agent');
      expect(ctx.access!.roleKeys).toEqual(['admin']);
      // Changed on purpose: its own request never acts as an Admin (agentDirectAccess). Admin is
      // its ceiling at the door, where the policy decides; here nobody is asked. So it does not see
      // the whole audit trail the way an Admin does, and has no Users & Roles or File Utilities.
      expect(ctx.access!.isAdmin).toBe(false);
      expect(ctx.access!.permissions.users).toEqual([]);
      expect(ctx.access!.permissions.file_utilities).toEqual([]);
      expect(ctx.access!.permissions.banking).toEqual(fullAccess().permissions.banking);
      expect(seesWholeLog(ctx.access)).toBe(false);
      for (const kind of ['user', 'role', 'agent', 'password_policy', 'company_restore', 'sandbox']) {
        expect(canSeeAuditEntry(ctx.access, kind, null, null), kind).toBe(false);
      }
      expect(canSeeAuditEntry(ctx.access, 'customer', null, null)).toBe(true);
      // Still read-only, still masked.
      expect(ctx.readOnly).toBe(true);
      expect(ctx.role).toBe('viewer');
      expect(isReadOnlyDb(ctx.db)).toBe(true);
      expect(ctx.access!.flags).toEqual({ sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false });
      // Users & Roles and File Utilities: their reads are refused here and named as door operations.
      // Behind the door they are classed admin (Users & Roles) or file (the backup history), so an
      // Admin is asked every time (plan 4.2; lib/permissions/agentAccess.test.ts proves the policy
      // side). Here: the direct refusal, and the class that makes the door ask.
      for (const [routePath, cls] of [
        ['/api/users', 'admin'],
        [`/api/users/${ownerId}`, 'admin'],
        ['/api/users/password-policy', 'admin'],
        ['/api/users/permissions-report', 'admin'],
        ['/api/roles', 'admin'],
        [`/api/roles/${ID}`, 'admin'],
        ['/api/backups', 'file'],
      ] as const) {
        expect(operationForPath('GET', routePath)?.operation.class, routePath).toBe(cls);
        request('GET', routePath, { token: boss.token });
        await refusedWith(getServerContext(), /^Ask for this through run_operation/);
      }
      request('POST', '/api/users', { token: boss.token });
      await refusedWith(getServerContext(), agentUseDoorMessage('users.create'));
      // The agents and their approvals: the hard floor, not even through the door.
      for (const [method, routePath] of [
        ['GET', '/api/agents'],
        ['GET', `/api/agents/${agentId}`],
        ['GET', `/api/agents/${agentId}/grants`],
        ['GET', '/api/agent-requests'],
        ['GET', '/api/agent-requests/count'],
        ['POST', '/api/agents'],
        ['DELETE', `/api/agents/${agentId}`],
        ['POST', '/api/agents/pause-all'],
      ]) {
        request(method, routePath, { token: boss.token });
        await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
      }
      // The agents route itself refuses it too. The stamp names a read the agent may make, so the
      // way in lets it through and the handler's own guard is what answers.
      request('GET', '/api/accounts', { token: boss.token });
      const res = await agentsGET(new NextRequest('http://localhost:45123/api/agents', { headers: { authorization: `Bearer ${boss.token}` } }));
      expect(res.status).toBe(403);
      expect((await res.json()).details).toEqual({ personOnly: true });
    } finally {
      await revokeAgent(admin, boss.agent.id);
    }
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
    // Stamped the real way, the way in refuses each one.
    for (const [method, routePath] of [['GET', '/api/agents'], ['POST', '/api/agents'], ['DELETE', `/api/agents/${agentId}`]]) {
      request(method, routePath, { token });
      await refusedWith(getServerContext(), AGENT_NOT_AVAILABLE_MESSAGE);
    }
    // Stamped as a read the agent may make (as if the way in had let it pass), each handler's own
    // guard refuses it: the 403 is the handler's, not the way in's.
    for (const [method, stamp] of [['GET', '/api/accounts'], ['POST', AGENT_ACTION_ROUTE]]) {
      request(method, stamp, { token });
      const list = await agentsGET(new NextRequest('http://localhost:45123/api/agents', { headers }));
      expect(list.status, stamp).toBe(403);
      expect((await list.json()).details, stamp).toEqual({ personOnly: true });
      request(method, stamp, { token });
      const post = await agentsPOST(new NextRequest('http://localhost:45123/api/agents', { method: 'POST', headers, body: JSON.stringify({ name: 'Child', roleKeys: ['view_only'], mode: 'read_only' }) }));
      expect(post.status, stamp).toBe(403);
      expect((await post.json()).details, stamp).toEqual({ personOnly: true });
      request(method, stamp, { token });
      const del = await agentDELETE(new NextRequest(`http://localhost:45123/api/agents/${agentId}`, { method: 'DELETE', headers }), { params: Promise.resolve({ id: agentId }) });
      expect(del.status, stamp).toBe(403);
      expect((await del.json()).details, stamp).toEqual({ personOnly: true });
    }
    request('GET', '/api/accounts', { token });
    expect((await getServerContext()).agent?.id).toBe(agentId);
    // Nothing was made, and the agent was not removed.
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.name, 'Child'))).toEqual([]);
    const [self] = await db.select({ revokedAt: agents.revokedAt }).from(agents).where(eq(agents.id, agentId));
    expect(self.revokedAt).toBeNull();
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
      // No connector settings (paths of the host computer) from afar: the list either says none or,
      // as app/api/agents/route.ts now has it, never carries them at all.
      expect(list.connection ?? null).toBeNull();
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
    expect(info.agent).toEqual({ name: 'Reader', mode: 'post', modeLabel: 'Post', canChangeBooks: true, canProposeChanges: true, roles: ['Bookkeeper'] });
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
