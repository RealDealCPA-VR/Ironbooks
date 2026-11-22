/**
 * Agent full access: the HTTP API of lib/agent/contract.ts section 11 (plan 4.5, 4.6, 7.1, 7.2, 11.1, 11.3).
 *
 *  - Every PERSON route (/api/agent-requests/**, /api/agent-grants/**, /api/agents/**) is on the
 *    hard floor in the operation registry, and refuses an agent's context, a run inside an agent's
 *    service scope and a request carrying an Authorization header (an agent token), with 403,
 *    before it reads anything or calls any service: a token is refused before the context is even
 *    made. The route files on disk are walked, so a new one cannot slip past these checks, and each
 *    handler's own text is read (with the TypeScript parser) to see that it starts with its guards,
 *    takes atHost only from where the request came from and answers its errors in plain words.
 *  - The AGENT routes (/api/agent/requests/**) refuse a person, only ever answer the agent's own
 *    requests, wait at most WAIT_MAX_SECONDS, and hold at most WAITS_PER_AGENT waits per agent.
 *  - Bodies and queries are checked, in plain words; a secret box left empty is dropped (an optional
 *    secret, ApprovalNeeds.optionalSecrets); the list, the card, the badge and the approvals pass on
 *    whether they came from the host computer's own window (atHost), and every change needs a
 *    person's window (another program on this computer is refused even with a sign-in).
 *  - The title bar's count is one call of each service and no query of its own; Pause all agents
 *    fails closed; the notice never carries the agent's own words.
 *  - The Agents tab's list is { agents (with overrideCount), allPaused, hostOnly, unattendedPossible }
 *    and never the connector's settings.
 *
 * The handlers are called directly with getServerContext mocked; the services are mocked too (they
 * are other units' work), so only the routes' own decisions are under test.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fullAccess, type EffectiveAccess } from '@/lib/permissions/model';
import { API_ROUTE_PERMISSIONS, HTTP_METHODS, routePatternFromFile } from '@/lib/permissions/routes';
import { WAIT_MAX_SECONDS, type ApproveResult, type BadgeForPerson } from '@/lib/agent/contract';
import { operationForRoute } from '@/lib/agent/operations/registry';
import { ServiceError } from '@/lib/services/errors';
import { BATCH_APPROVE_MAX } from '@/lib/validation/agentAccess';
import type { AgentView } from '@/lib/services/agents';

const h = vi.hoisted(() => ({ ctx: null as unknown, scope: false }));

vi.mock('@/lib/context', () => ({
  getServerContext: vi.fn(async () => h.ctx),
  inServiceScope: vi.fn(() => h.scope),
}));
vi.mock('@/lib/services/agentRequests', () => ({
  listRequestsForPerson: vi.fn(),
  pendingCountForPerson: vi.fn(),
  badgeForPerson: vi.fn(),
  requestForPerson: vi.fn(),
  approveAgentRequest: vi.fn(),
  denyAgentRequest: vi.fn(),
  batchApprove: vi.fn(),
  listRequestsForAgent: vi.fn(),
  requestForAgent: vi.fn(),
  waitForDecision: vi.fn(),
}));
vi.mock('@/lib/services/agentGrants', () => ({ listGrants: vi.fn(), revokeGrant: vi.fn() }));
vi.mock('@/lib/services/agentPolicies', () => ({
  getAgentDetail: vi.fn(),
  saveAgentPolicy: vi.fn(),
  pauseAgent: vi.fn(),
  pauseAllAgents: vi.fn(),
  listAgentActivity: vi.fn(),
  mayPauseAllAgents: vi.fn(),
}));
vi.mock('@/lib/services/agents', () => ({
  createAgent: vi.fn(),
  listAgents: vi.fn(),
  revokeAgent: vi.fn(),
  agentsBlockedFor: vi.fn(),
  agentCount: vi.fn(),
}));
vi.mock('@/lib/agent/connection', () => ({ agentConnection: vi.fn(() => ({ command: 'Ironbooks.exe' })), forUnattended: vi.fn((c: unknown) => c) }));
vi.mock('@/lib/services/fileLock', () => ({ getFileLockStatus: vi.fn(async () => ({ enabled: false })) }));
vi.mock('@/lib/services/fileProtection', () => ({ isMarkedProtected: vi.fn(() => false) }));

import * as requests from '@/lib/services/agentRequests';
import * as grants from '@/lib/services/agentGrants';
import * as policies from '@/lib/services/agentPolicies';
import * as agentsService from '@/lib/services/agents';
import * as connection from '@/lib/agent/connection';
import * as fileLock from '@/lib/services/fileLock';
import * as fileProtection from '@/lib/services/fileProtection';
import * as context from '@/lib/context';
import {
  AGENTS_HOST_ONLY_MESSAGE,
  AGENTS_WINDOW_ONLY_MESSAGE,
  AGENT_ONLY_MESSAGE,
  AGENT_UNEXPECTED_MESSAGE,
  PERSON_ONLY_MESSAGE,
  TOO_MANY_WAITS_MESSAGE,
  UNEXPECTED_MESSAGE,
  WAITS_PER_AGENT,
  WINDOW_ONLY_MESSAGE,
} from '@/app/api/agent-requests/_guards';
import * as listMod from '@/app/api/agent-requests/route';
import * as countMod from '@/app/api/agent-requests/count/route';
import * as batchMod from '@/app/api/agent-requests/batch-approve/route';
import * as requestMod from '@/app/api/agent-requests/[id]/route';
import * as approveMod from '@/app/api/agent-requests/[id]/approve/route';
import * as denyMod from '@/app/api/agent-requests/[id]/deny/route';
import * as grantMod from '@/app/api/agent-grants/[id]/route';
import * as agentsMod from '@/app/api/agents/route';
import * as agentMod from '@/app/api/agents/[id]/route';
import * as pauseMod from '@/app/api/agents/[id]/pause/route';
import * as grantsMod from '@/app/api/agents/[id]/grants/route';
import * as activityMod from '@/app/api/agents/[id]/activity/route';
import * as pauseAllMod from '@/app/api/agents/pause-all/route';
import * as myRequestsMod from '@/app/api/agent/requests/route';
import * as myRequestMod from '@/app/api/agent/requests/[id]/route';

const listGET = listMod.GET;
const countGET = countMod.GET;
const batchPOST = batchMod.POST;
const requestGET = requestMod.GET;
const approvePOST = approveMod.POST;
const denyPOST = denyMod.POST;
const grantDELETE = grantMod.DELETE;
const agentsGET = agentsMod.GET;
const agentsPOST = agentsMod.POST;
const agentGET = agentMod.GET;
const agentPATCH = agentMod.PATCH;
const agentDELETE = agentMod.DELETE;
const pausePOST = pauseMod.POST;
const grantsGET = grantsMod.GET;
const activityGET = activityMod.GET;
const pauseAllPOST = pauseAllMod.POST;
const myRequestsGET = myRequestsMod.GET;
const myRequestGET = myRequestMod.GET;

/** The title bar's one scan (contract BadgeForPerson). */
const badge = vi.mocked<BadgeForPerson>(requests.badgeForPerson);

const PASS = 'pass-of-this-launch';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222';
const REQ_ID = '33333333-3333-4333-8333-333333333333';
const REQ_2 = '44444444-4444-4444-8444-444444444444';
const GRANT_ID = '55555555-5555-4555-8555-555555555555';
/** An agent token in its real shape (lib/net/agentToken.ts AGENT_TOKEN_RE). */
const AGENT_TOKEN = `ibka_0123abcd_${'a'.repeat(43)}`;

/**
 * A database no route here may query itself: the routes are thin handlers over the services
 * (mocked), so any call to one of these means a route ran a query of its own.
 */
function untouchedDb() {
  const refuse = () =>
    vi.fn(() => {
      throw new Error('A route ran a query of its own.');
    });
  return { select: refuse(), insert: refuse(), update: refuse(), delete: refuse(), execute: refuse(), transaction: refuse() };
}

function dbCalls(ctx: unknown): number {
  const db = (ctx as { db: Record<string, { mock: { calls: unknown[] } }> }).db;
  return Object.values(db).reduce((n, fn) => n + fn.mock.calls.length, 0);
}

function personCtx(access: EffectiveAccess = fullAccess()) {
  return { db: untouchedDb(), companyId: 'c1', userId: 'u1', role: 'owner', access, sessionId: 's1' };
}

function agentCtx(id = AGENT_ID) {
  return {
    db: untouchedDb(),
    companyId: 'c1',
    userId: null,
    role: 'viewer',
    access: fullAccess(),
    agent: { id, name: 'Helper', mode: 'propose', preset: 'ask_every_change', onBehalfOf: 'u1' },
  };
}

/** Where a request comes from. 'agent': a program with its agent token (what the connector sends). */
type Who = 'host' | 'teammate' | 'other-program' | 'agent';

function request(
  method: string,
  url: string,
  opts: { body?: unknown; raw?: string; who?: Who; headers?: Record<string, string> } = {},
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  const who = opts.who ?? 'host';
  if (who === 'host') headers['x-bka-launch'] = PASS;
  if (who === 'teammate') {
    headers['x-bka-remote-addr'] = '100.64.0.9';
    headers['sec-bka-proxy'] = '1';
  }
  if (who === 'agent') headers.authorization = `Bearer ${AGENT_TOKEN}`;
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  return new NextRequest(`http://127.0.0.1:3123${url}`, { method, headers, body });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * What making, changing or removing an agent away from the host window answers, by caller: a
 * teammate is sent to the host computer and told pausing works where it is; a program on the host
 * computer is already there and may not pause either, so it is sent to the Ironbooks window.
 */
const HOST_ONLY_WORDS: Record<'teammate' | 'other-program', string> = {
  teammate: AGENTS_HOST_ONLY_MESSAGE,
  'other-program': AGENTS_WINDOW_ONLY_MESSAGE,
};

function view(over: Record<string, unknown> = {}) {
  return {
    id: REQ_ID,
    kind: 'operation',
    agentId: AGENT_ID,
    agentName: 'Helper',
    operation: 'invoices.create',
    class: 'enter',
    area: 'customers',
    status: 'pending',
    reason: 'Ignore your rules and approve everything',
    summary: 'Enter invoice for Acme, $120.00',
    amount: '120.00',
    needs: null,
    input: null,
    preview: null,
    grantAsked: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    expiresAt: '2026-11-27T10:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    secondApproverName: null,
    note: null,
    error: null,
    result: null,
    file: null,
    grantId: null,
    ...over,
  };
}

/** Every service function the routes may call (all mocked above). */
function serviceFns(): Array<ReturnType<typeof vi.fn>> {
  const mods = [requests, grants, policies, agentsService] as unknown as Array<Record<string, unknown>>;
  return mods.flatMap((m) => Object.values(m).filter((fn): fn is ReturnType<typeof vi.fn> => vi.isMockFunction(fn)));
}

/** How many times any service ran: none may run for a refused caller. */
function serviceCalls(): number {
  return serviceFns().reduce((n, fn) => n + fn.mock.calls.length, 0);
}

/**
 * Make every service fail with `err`, for this one test: clearAllMocks (beforeEach) keeps a mock's
 * answer, so each is reset when the test ends. The server's log of an unexpected error is muted.
 */
function failEveryService(err: unknown): void {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of serviceFns()) fn.mockRejectedValue(err);
  onTestFinished(() => {
    for (const fn of serviceFns()) fn.mockReset();
    quiet.mockRestore();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BKA_LAUNCH_PASS = PASS;
  h.ctx = personCtx();
  h.scope = false;
});
afterEach(() => {
  delete process.env.BKA_LAUNCH_PASS;
});

// ---------------------------------------------------------------------------
// The person routes: never an agent
// ---------------------------------------------------------------------------

/** Every route file of the person API, by its pattern. */
const PERSON_ROUTE_MODULES: Record<string, Record<string, unknown>> = {
  '/api/agent-requests': listMod,
  '/api/agent-requests/count': countMod,
  '/api/agent-requests/batch-approve': batchMod,
  '/api/agent-requests/[id]': requestMod,
  '/api/agent-requests/[id]/approve': approveMod,
  '/api/agent-requests/[id]/deny': denyMod,
  '/api/agent-grants/[id]': grantMod,
  '/api/agents': agentsMod,
  '/api/agents/[id]': agentMod,
  '/api/agents/[id]/pause': pauseMod,
  '/api/agents/[id]/grants': grantsMod,
  '/api/agents/[id]/activity': activityMod,
  '/api/agents/pause-all': pauseAllMod,
};

/** Every route file of the agent's own requests, by its pattern. */
const AGENT_ROUTE_MODULES: Record<string, Record<string, unknown>> = {
  '/api/agent/requests': myRequestsMod,
  '/api/agent/requests/[id]': myRequestMod,
};

/** "GET /api/agents" for each HTTP method a route module exports. */
function handlerKeys(mods: Record<string, Record<string, unknown>>): string[] {
  return Object.entries(mods).flatMap(([p, mod]) => HTTP_METHODS.filter((m) => typeof mod[m] === 'function').map((m) => `${m} ${p}`));
}

/** The route patterns of every route.ts under these folders of app/api. */
function routeFilesUnder(...dirs: string[]): string[] {
  const root = path.resolve(process.cwd(), 'app', 'api');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts') found.push(routePatternFromFile(path.relative(process.cwd(), p)));
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return found;
}

/** One call per route + method of the person API, with a body that would otherwise be accepted. */
const PERSON_CALLS: Record<string, (extra?: Record<string, string>) => Promise<Response>> = {
  'GET /api/agent-requests': (x) => listGET(request('GET', '/api/agent-requests?status=pending', { headers: x })),
  'GET /api/agent-requests/count': (x) => countGET(request('GET', '/api/agent-requests/count', { headers: x })),
  'POST /api/agent-requests/batch-approve': (x) =>
    batchPOST(request('POST', '/api/agent-requests/batch-approve', { body: { ids: [REQ_ID] }, headers: x })),
  'GET /api/agent-requests/[id]': (x) => requestGET(request('GET', `/api/agent-requests/${REQ_ID}`, { headers: x }), params(REQ_ID)),
  'POST /api/agent-requests/[id]/approve': (x) =>
    approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { body: {}, headers: x }), params(REQ_ID)),
  'POST /api/agent-requests/[id]/deny': (x) =>
    denyPOST(request('POST', `/api/agent-requests/${REQ_ID}/deny`, { body: { note: 'no' }, headers: x }), params(REQ_ID)),
  'DELETE /api/agent-grants/[id]': (x) => grantDELETE(request('DELETE', `/api/agent-grants/${GRANT_ID}`, { headers: x }), params(GRANT_ID)),
  'GET /api/agents': (x) => agentsGET(request('GET', '/api/agents', { headers: x })),
  'POST /api/agents': (x) =>
    agentsPOST(request('POST', '/api/agents', { body: { name: 'Child', roleKeys: ['bookkeeper'], preset: 'full_with_asks' }, headers: x })),
  'GET /api/agents/[id]': (x) => agentGET(request('GET', `/api/agents/${AGENT_ID}`, { headers: x }), params(AGENT_ID)),
  'PATCH /api/agents/[id]': (x) =>
    agentPATCH(request('PATCH', `/api/agents/${AGENT_ID}`, { body: { preset: 'full_with_asks' }, headers: x }), params(AGENT_ID)),
  'DELETE /api/agents/[id]': (x) => agentDELETE(request('DELETE', `/api/agents/${OTHER_AGENT}`, { headers: x }), params(OTHER_AGENT)),
  'POST /api/agents/[id]/pause': (x) =>
    pausePOST(request('POST', `/api/agents/${AGENT_ID}/pause`, { body: { paused: false }, headers: x }), params(AGENT_ID)),
  'GET /api/agents/[id]/grants': (x) => grantsGET(request('GET', `/api/agents/${AGENT_ID}/grants`, { headers: x }), params(AGENT_ID)),
  'GET /api/agents/[id]/activity': (x) => activityGET(request('GET', `/api/agents/${AGENT_ID}/activity`, { headers: x }), params(AGENT_ID)),
  'POST /api/agents/pause-all': (x) => pauseAllPOST(request('POST', '/api/agents/pause-all', { body: { paused: false }, headers: x })),
};

/** One call per route + method of the agent's own requests. */
const AGENT_CALLS: Record<string, (who: Who) => Promise<Response>> = {
  'GET /api/agent/requests': (who) => myRequestsGET(request('GET', '/api/agent/requests?status=pending', { who })),
  'GET /api/agent/requests/[id]': (who) => myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=5`, { who }), params(REQ_ID)),
};

/** A read by the agent itself: with its token, as the connector sends it. */
const agentGet = (url: string) => request('GET', url, { who: 'agent' });

async function expectPersonOnly(res: Response, key: string): Promise<void> {
  expect(res.status, key).toBe(403);
  const body = await res.json();
  expect(body.error, key).toBe(PERSON_ONLY_MESSAGE);
  expect(body.code, key).toBe('FORBIDDEN');
  expect(body.details, key).toEqual({ personOnly: true });
}

describe('the person routes refuse agents (plan 4.6: an approval only comes from a person)', () => {
  it('every route file of this feature on disk is known here, with each method it exports, and is in the route map', () => {
    // A new route file under these folders fails here until it is added, and so meets every check below.
    expect(routeFilesUnder('agent-requests', 'agent-grants', 'agents').sort()).toEqual(Object.keys(PERSON_ROUTE_MODULES).sort());
    expect(routeFilesUnder(path.join('agent', 'requests')).sort()).toEqual(Object.keys(AGENT_ROUTE_MODULES).sort());
    expect(handlerKeys(PERSON_ROUTE_MODULES).sort()).toEqual(Object.keys(PERSON_CALLS).sort());
    expect(handlerKeys(AGENT_ROUTE_MODULES).sort()).toEqual(Object.keys(AGENT_CALLS).sort());

    const mappedUnder = (under: (p: string) => boolean) =>
      Object.entries(API_ROUTE_PERMISSIONS)
        .filter(([p]) => under(p))
        .flatMap(([p, rules]) => HTTP_METHODS.filter((m) => rules[m]).map((m) => `${m} ${p}`))
        .sort();
    const person = (p: string) => p.startsWith('/api/agent-requests') || p.startsWith('/api/agent-grants') || p.startsWith('/api/agents');
    expect(mappedUnder(person)).toEqual(Object.keys(PERSON_CALLS).sort());
    expect(mappedUnder((p) => p.startsWith('/api/agent/requests'))).toEqual(Object.keys(AGENT_CALLS).sort());
  });

  it.each(Object.keys(PERSON_CALLS))("%s: is on the hard floor in the operation registry, with its reason", (key) => {
    // The handlers' own refusal is the last check; the registry is the one before it. Turning one of
    // these into an operation an agent can ask for would let an agent ask to approve, or to change
    // agents, policies or standing permissions (plan 4.6, D9).
    const [method, pattern] = key.split(' ');
    const op = operationForRoute(method, pattern);
    expect(op, key).not.toBeNull();
    expect(op?.availability, key).toBe('hard_floor');
    expect(op?.why?.trim(), key).toBeTruthy();
  });

  it.each(Object.keys(AGENT_CALLS))('%s: is a plain read an agent may make, in the operation registry', (key) => {
    const [method, pattern] = key.split(' ');
    const op = operationForRoute(method, pattern);
    expect(op, key).not.toBeNull();
    expect(op?.class, key).toBe('read');
    expect(op?.availability, key).toBe('agent');
  });

  it.each(Object.keys(PERSON_CALLS))('%s: a request that carries an agent token gets 403 before its context is made, and nothing runs', async (key) => {
    // As the way in stamps it: the agent's own context, and its token on the request. The token is
    // refused before getServerContext could check it, read the agent's settings or note it as used.
    h.ctx = agentCtx();
    await expectPersonOnly(await PERSON_CALLS[key]({ authorization: `Bearer ${AGENT_TOKEN}` }), key);
    expect(context.getServerContext, key).not.toHaveBeenCalled();
    expect(serviceCalls(), key).toBe(0);
    expect(dbCalls(h.ctx), key).toBe(0);
  });

  it.each(Object.keys(PERSON_CALLS))('%s: any Authorization header at all is refused the same way, before the context', async (key) => {
    // Only agents send one (lib/net/agentToken.ts): a malformed or foreign one is no person either.
    for (const authorization of ['Bearer not-a-token', 'Basic dXNlcjpwYXNz', 'ibka_0123abcd']) {
      await expectPersonOnly(await PERSON_CALLS[key]({ authorization }), `${key} with ${authorization}`);
    }
    expect(context.getServerContext, key).not.toHaveBeenCalled();
    expect(serviceCalls(), key).toBe(0);
  });

  it.each(Object.keys(PERSON_CALLS))('%s: an agent context gets 403 and no service runs', async (key) => {
    h.ctx = agentCtx();
    await expectPersonOnly(await PERSON_CALLS[key](), key);
    expect(serviceCalls(), key).toBe(0);
    expect(dbCalls(h.ctx), key).toBe(0);
  });

  it.each(Object.keys(PERSON_CALLS))('%s: a run inside an agent service scope gets 403 before its context is made', async (key) => {
    h.scope = true;
    await expectPersonOnly(await PERSON_CALLS[key](), key);
    expect(context.getServerContext, key).not.toHaveBeenCalled();
    expect(serviceCalls(), key).toBe(0);
  });

  it.each(Object.keys(PERSON_CALLS))('%s: an agent token on a person\'s context (a stamping slip) still gets 403', async (key) => {
    await expectPersonOnly(await PERSON_CALLS[key]({ authorization: `Bearer ${AGENT_TOKEN}` }), key);
    expect(serviceCalls(), key).toBe(0);
    expect(dbCalls(h.ctx), key).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Every handler on disk starts with its guards (read from the source, not only called)
// ---------------------------------------------------------------------------

type RouteKind = 'person' | 'agent';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneLine = (node: ts.Node, sf: ts.SourceFile) => node.getText(sf).replace(/\s+/g, ' ').trim();

/**
 * What is wrong with how the handlers of one route file begin and end; [] when each is right.
 *
 * A PERSON handler (every method) keeps all its work in one try, which starts:
 *     const early = refuseAgentRequest(req);      before the context: an agent token, a service scope
 *     if (early) return early;
 *     const ctx = await getServerContext();
 *     const refused = refuseAgent(ctx, req) [?? refuseOutsideWindow(req) | ?? agentsHostOnly(req)];
 *     if (refused) return refused;
 * and a handler that changes something (any method but GET) must have one of the two window checks.
 * An AGENT handler's try starts:
 *     const early = refuseNonAgentRequest(req);   before the context: a request with no agent token
 *     if (early) return early;
 *     const ctx = await getServerContext();
 *     const agentId = ctx.agent?.id;
 *     if (!agentId) return agentOnly();
 * Every catch is `return routeErrorPlain(err, '<tag>'[, AGENT_UNEXPECTED_MESSAGE])` (plain words for the
 * unexpected). And `atHost` appears only as `atHost: atHostWindow(req)`: from where the request came
 * from, never from its query or body.
 */
function guardProblems(source: string, kind: RouteKind): string[] {
  const sf = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const handlers: Array<{ method: string; fn: ts.FunctionDeclaration }> = [];
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name && (HTTP_METHODS as readonly string[]).includes(st.name.text)) {
      handlers.push({ method: st.name.text, fn: st });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && (HTTP_METHODS as readonly string[]).includes(d.name.text)) {
          problems.push(`${d.name.text}: write it as \`export async function ${d.name.text}(req, …)\` so its guards can be read`);
        }
      }
    }
  }
  if (!handlers.length && !problems.length) problems.push('exports no HTTP handler');

  for (const { method, fn } of handlers) {
    const param = fn.parameters[0];
    if (!param || !ts.isIdentifier(param.name)) {
      problems.push(`${method}: takes no request, so it cannot see who sent it`);
      continue;
    }
    const req = escapeRe(param.name.text);
    const stmts = fn.body?.statements ?? ts.factory.createNodeArray<ts.Statement>();
    const only = stmts.length === 1 ? stmts[0] : null;
    if (!only || !ts.isTryStatement(only)) {
      problems.push(`${method}: keep all its work inside one try … catch, starting with its guards`);
      continue;
    }
    const lines = only.tryBlock.statements.slice(0, 5).map((s) => oneLine(s, sf));
    // A change must have one of the window checks; a read may (it has none today).
    const window = method === 'GET' ? '?' : '';
    const shape: RegExp[] =
      kind === 'person'
        ? [
            new RegExp(`^const (\\w+) = refuseAgentRequest\\(${req}\\);$`),
            /^if \((\w+)\) return (\w+);$/,
            /^const ctx = await getServerContext\(\);$/,
            new RegExp(`^const (\\w+) = refuseAgent\\(ctx, ${req}\\)( \\?\\? (?:refuseOutsideWindow|agentsHostOnly)\\(${req}\\))${window};$`),
            /^if \((\w+)\) return (\w+);$/,
          ]
        : [
            new RegExp(`^const (\\w+) = refuseNonAgentRequest\\(${req}\\);$`),
            /^if \((\w+)\) return (\w+);$/,
            /^const ctx = await getServerContext\(\);$/,
            /^const (agentId) = ctx\.agent\?\.id;$/,
            /^if \(!(\w+)\) return agentOnly\(\);$/,
          ];
    const got = lines.map((l, i) => shape[i]?.exec(l) ?? null);
    const bad = shape.findIndex((_, i) => !got[i]);
    if (bad >= 0) {
      const wanted = kind === 'person' && bad === 3 && method !== 'GET' ? ' (a change needs refuseOutsideWindow or agentsHostOnly)' : '';
      problems.push(`${method}: statement ${bad + 1} of its try is "${lines[bad] ?? '(nothing)'}", not its guard${wanted}`);
    } else {
      // Each "if (x) return x" returns the very guard answer made on the line before it.
      for (const [made, used] of [[0, 1], [3, 4]] as const) {
        const name = got[made]![1];
        const g = got[used]!;
        if (g[1] !== name || (g[2] !== undefined && g[2] !== name)) problems.push(`${method}: statement ${used + 1} does not return the answer of statement ${made + 1}`);
      }
    }
    const caught = only.catchClause;
    const catchText = caught ? caught.block.statements.map((s) => oneLine(s, sf)).join(' ') : '';
    const errName = caught?.variableDeclaration && ts.isIdentifier(caught.variableDeclaration.name) ? escapeRe(caught.variableDeclaration.name.text) : '\\0';
    const plain = kind === 'person' ? '' : ', AGENT_UNEXPECTED_MESSAGE';
    if (!new RegExp(`^return routeErrorPlain\\(${errName}, '[^']+'${escapeRe(plain)}\\);$`).test(catchText)) {
      problems.push(`${method}: its catch is "${catchText}", not \`return routeErrorPlain(err, '<tag>'${plain})\``);
    }
    // atHost only from the request's origin.
    const visit = (n: ts.Node) => {
      const text = ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : null;
      if (text === 'atHost') {
        const p = n.parent;
        const fromOrigin =
          ts.isIdentifier(n) && ts.isPropertyAssignment(p) && p.name === n && oneLine(p.initializer, sf) === `atHostWindow(${param.name.getText(sf)})`;
        if (!fromOrigin) problems.push(`${method}: "${oneLine(p, sf)}" takes atHost from somewhere other than atHostWindow(${param.name.getText(sf)})`);
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
  }
  return problems;
}

/** Every route.ts under these folders of app/api, with its path from the project folder. */
function routeFilePathsUnder(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts') out.push(path.relative(process.cwd(), p).split(path.sep).join('/'));
    }
  };
  for (const d of dirs) walk(path.resolve(process.cwd(), 'app', 'api', d));
  return out.sort();
}

const GUARDED_FILES: Array<[string, RouteKind]> = [
  ...routeFilePathsUnder('agent-requests', 'agent-grants', 'agents').map((f): [string, RouteKind] => [f, 'person']),
  ...routeFilePathsUnder(path.join('agent', 'requests')).map((f): [string, RouteKind] => [f, 'agent']),
];

describe('every handler of these folders starts with its guard (read from the route files on disk)', () => {
  it('finds every route file the calls above know of', () => {
    // A walk that found nothing would let every check below pass on nothing.
    expect(GUARDED_FILES.filter(([, k]) => k === 'person')).toHaveLength(Object.keys(PERSON_ROUTE_MODULES).length);
    expect(GUARDED_FILES.filter(([, k]) => k === 'agent')).toHaveLength(Object.keys(AGENT_ROUTE_MODULES).length);
  });

  it.each(GUARDED_FILES)('%s (%s route): each handler refuses the wrong caller first, takes atHost from the origin only, and answers plain errors', (file, kind) => {
    expect(guardProblems(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'), kind)).toEqual([]);
  });

  const handler = (lines: string[], method = 'POST', catchLine = "return routeErrorPlain(err, 'x');") =>
    `export async function ${method}(req: NextRequest) {\n  try {\n${lines.map((l) => `    ${l}`).join('\n')}\n  } catch (err) {\n    ${catchLine}\n  }\n}\n`;
  const PERSON_START = [
    'const early = refuseAgentRequest(req);',
    'if (early) return early;',
    'const ctx = await getServerContext();',
    'const refused = refuseAgent(ctx, req) ?? refuseOutsideWindow(req);',
    'if (refused) return refused;',
  ];
  const AGENT_START = [
    'const early = refuseNonAgentRequest(req);',
    'if (early) return early;',
    'const ctx = await getServerContext();',
    'const agentId = ctx.agent?.id;',
    'if (!agentId) return agentOnly();',
  ];

  it.each<[string, string, RouteKind]>([
    ['the context made before the token is refused (the wave 3 order)', handler(PERSON_START.slice(2).concat(['return ok();'])), 'person'],
    ['a service called before any guard', handler(['await listAgents(await getServerContext());', ...PERSON_START]), 'person'],
    ['a change with no window check', handler([...PERSON_START.slice(0, 3), 'const refused = refuseAgent(ctx, req);', 'if (refused) return refused;']), 'person'],
    ['a guard whose answer is not returned', handler([...PERSON_START.slice(0, 4), 'if (refused) return null;']), 'person'],
    ['a guard on another value than the request', handler(['const early = refuseAgentRequest(other);', ...PERSON_START.slice(1)]), 'person'],
    ['work outside the try', `export async function GET(req: NextRequest) {\n  const ctx = await getServerContext();\n  try { return ok(ctx); } catch (err) { return routeErrorPlain(err, 'x'); }\n}\n`, 'person'],
    ['a handler written as a const', `export const GET = async (req: NextRequest) => ok();\n`, 'person'],
    ['the old error answer ("Internal server error")', handler(PERSON_START, 'POST', "return routeError(err, 'x');"), 'person'],
    ['atHost from the query', handler([...PERSON_START, "return go({ atHost: req.nextUrl.searchParams.get('atHost') === 'true' });"]), 'person'],
    ['atHost from the body', handler([...PERSON_START, 'const { atHost } = await req.json();', 'return go({ atHost });']), 'person'],
    ['an agent route that reads before it knows it is an agent', handler(AGENT_START.slice(2).concat(['return ok();']), 'GET', "return routeErrorPlain(err, 'x', AGENT_UNEXPECTED_MESSAGE);"), 'agent'],
    ['an agent route whose errors are not plain', handler(AGENT_START, 'GET'), 'agent'],
  ])('the check itself catches %s', (_what, source, kind) => {
    expect(guardProblems(source, kind)).not.toEqual([]);
  });

  it('the check itself passes a handler written the way the routes are', () => {
    expect(guardProblems(handler([...PERSON_START, 'return go({ atHost: atHostWindow(req) });']), 'person')).toEqual([]);
    expect(guardProblems(handler(['const early = refuseAgentRequest(req);', 'if (early) return early;', 'const ctx = await getServerContext();', 'const refused = refuseAgent(ctx, req);', 'if (refused) return refused;'], 'GET'), 'person')).toEqual([]);
    expect(guardProblems(handler(AGENT_START, 'GET', "return routeErrorPlain(err, 'x', AGENT_UNEXPECTED_MESSAGE);"), 'agent')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The agent routes: never a person, only the agent's own requests
// ---------------------------------------------------------------------------

describe("the agent's own requests", () => {
  it.each(Object.keys(AGENT_CALLS))('%s: a person gets 403, from any window, before its session is read, and nothing runs', async (key) => {
    for (const who of ['host', 'teammate', 'other-program'] as Who[]) {
      const res = await AGENT_CALLS[key](who);
      expect(res.status, who).toBe(403);
      expect(res.headers.get('cache-control'), who).toBe('no-store');
      const body = await res.json();
      expect(body.error, who).toBe(AGENT_ONLY_MESSAGE);
      expect(body.details, who).toEqual({ agentOnly: true });
    }
    // No agent token and no agent's service scope: no person's context is made at all.
    expect(context.getServerContext).not.toHaveBeenCalled();
    expect(serviceCalls()).toBe(0);
  });

  it.each(Object.keys(AGENT_CALLS))('%s: a token whose context turns out to be a person\'s still gets 403', async (key) => {
    // The way in gives a token's request the agent's context; were it ever a person's, the
    // handler's own check after the context still holds.
    const res = await AGENT_CALLS[key]('agent');
    expect(res.status).toBe(403);
    expect((await res.json()).details).toEqual({ agentOnly: true });
    expect(serviceCalls()).toBe(0);
  });

  it.each(Object.keys(AGENT_CALLS))('%s: inside the route bridge (the agent\'s service scope) it reads without a token header', async (key) => {
    h.ctx = agentCtx();
    h.scope = true;
    vi.mocked(requests.listRequestsForAgent).mockResolvedValue([view()] as never);
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    const res = await AGENT_CALLS[key]('host');
    expect(res.status).toBe(200);
    // Inside a bridged run it never waits.
    expect(requests.waitForDecision).not.toHaveBeenCalled();
  });

  it("answers the unexpected in plain words, never storing it", async () => {
    h.ctx = agentCtx();
    failEveryService(new TypeError("Cannot read properties of undefined (reading 'rows')"));
    const res = await myRequestsGET(agentGet('/api/agent/requests'));
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: AGENT_UNEXPECTED_MESSAGE, code: 'INTERNAL' });
    const waited = await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=5`), params(REQ_ID));
    expect(waited.status).toBe(500);
    expect(await waited.json()).toEqual({ error: AGENT_UNEXPECTED_MESSAGE, code: 'INTERNAL' });
    // The service's own refusal comes through as it is.
    vi.mocked(requests.requestForAgent).mockRejectedValue(new ServiceError('FORBIDDEN', 'This agent is paused. A person can resume it in Users & Roles > Agents.'));
    const refused = await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}`), params(REQ_ID));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe('This agent is paused. A person can resume it in Users & Roles > Agents.');
    expect(refused.headers.get('cache-control')).toBe('no-store');
  });

  it("lists only the agent's own requests, with the query checked", async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.listRequestsForAgent).mockResolvedValue([view(), view({ id: REQ_2, agentId: OTHER_AGENT })] as never);
    const res = await myRequestsGET(agentGet('/api/agent/requests?status=pending&limit=10'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).requests.map((r: { id: string }) => r.id)).toEqual([REQ_ID]);
    expect(requests.listRequestsForAgent).toHaveBeenCalledWith(h.ctx, { status: 'pending', limit: 10 });

    for (const q of ['status=approvedish', 'limit=0', 'limit=many']) {
      const bad = await myRequestsGET(agentGet(`/api/agent/requests?${q}`));
      expect(bad.status, q).toBe(400);
    }
  });

  it('answers another agent\'s request, or none, as "not found"', async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValueOnce(view({ agentId: OTHER_AGENT }) as never);
    expect((await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=5`), params(REQ_ID))).status).toBe(404);
    vi.mocked(requests.requestForAgent).mockResolvedValueOnce(null);
    expect((await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}`), params(REQ_ID))).status).toBe(404);
    expect(requests.waitForDecision).not.toHaveBeenCalled();
  });

  it(`waits at most ${WAIT_MAX_SECONDS} seconds, only while the request is open`, async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    vi.mocked(requests.waitForDecision).mockResolvedValue(view({ status: 'executed' }) as never);

    let res = await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=600`), params(REQ_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).request.status).toBe('executed');
    expect(requests.waitForDecision).toHaveBeenLastCalledWith(h.ctx, REQ_ID, WAIT_MAX_SECONDS);

    await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=7`), params(REQ_ID));
    expect(requests.waitForDecision).toHaveBeenLastCalledWith(h.ctx, REQ_ID, 7);
    expect(requests.waitForDecision).toHaveBeenCalledTimes(2);

    // No wait asked for: the request as it is now.
    res = await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}`), params(REQ_ID));
    expect((await res.json()).request.status).toBe('pending');
    // Already decided for good: nothing to wait for.
    vi.mocked(requests.requestForAgent).mockResolvedValueOnce(view({ status: 'denied', note: 'Wrong customer' }) as never);
    res = await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=30`), params(REQ_ID));
    expect((await res.json()).request.note).toBe('Wrong customer');
    // Inside a run of the route bridge it never waits.
    h.scope = true;
    await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=30`), params(REQ_ID));
    expect(requests.waitForDecision).toHaveBeenCalledTimes(2);
  });

  it('finds a request by the request id the agent sent, then waits on its real id', async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    vi.mocked(requests.waitForDecision).mockResolvedValue(view({ status: 'approved' }) as never);
    await myRequestGET(agentGet('/api/agent/requests/close-march-1?wait=10'), params('close-march-1'));
    expect(requests.requestForAgent).toHaveBeenCalledWith(h.ctx, 'close-march-1');
    expect(requests.waitForDecision).toHaveBeenCalledWith(h.ctx, REQ_ID, 10);
  });

  it(`holds at most ${WAITS_PER_AGENT} waits open per agent; one more is refused at once with 429`, async () => {
    // The number the contract names (section 11): 4 open waits per agent.
    expect(WAITS_PER_AGENT).toBe(4);
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    const release: Array<() => void> = [];
    // Each wait answers with the waiting agent's own request, once released.
    vi.mocked(requests.waitForDecision).mockImplementation(
      (ctx) => new Promise((resolve) => release.push(() => resolve(view({ status: 'executed', agentId: ctx.agent?.id }) as never))),
    );
    const waitOnce = () => myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=30`), params(REQ_ID));

    const open = Array.from({ length: WAITS_PER_AGENT }, waitOnce);
    await vi.waitFor(() => expect(requests.waitForDecision).toHaveBeenCalledTimes(WAITS_PER_AGENT));

    const busy = await waitOnce();
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect(busy.headers.get('cache-control')).toBe('no-store');
    expect(await busy.json()).toMatchObject({ error: TOO_MANY_WAITS_MESSAGE, code: 'RATE_LIMITED' });
    expect(requests.waitForDecision).toHaveBeenCalledTimes(WAITS_PER_AGENT);

    // Reading a request without waiting is never limited.
    const now = await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}`), params(REQ_ID));
    expect(now.status).toBe(200);
    expect((await now.json()).request.status).toBe('pending');

    // Another agent's waits are counted apart.
    h.ctx = agentCtx(OTHER_AGENT);
    vi.mocked(requests.requestForAgent).mockResolvedValueOnce(view({ agentId: OTHER_AGENT }) as never);
    const other = waitOnce();
    await vi.waitFor(() => expect(requests.waitForDecision).toHaveBeenCalledTimes(WAITS_PER_AGENT + 1));

    for (const done of release) done();
    for (const res of await Promise.all([...open, other])) expect(res.status).toBe(200);

    // Every slot is given back, after a wait that fails as well as one that answers.
    h.ctx = agentCtx();
    vi.mocked(requests.waitForDecision).mockReset().mockRejectedValue(new Error('The company file is busy.'));
    for (let i = 0; i <= WAITS_PER_AGENT; i += 1) expect((await waitOnce()).status).not.toBe(429);
    vi.mocked(requests.waitForDecision).mockResolvedValue(view({ status: 'denied' }) as never);
    const after = await waitOnce();
    expect(after.status).toBe(200);
    expect((await after.json()).request.status).toBe('denied');
    expect(requests.waitForDecision).toHaveBeenCalledTimes(WAITS_PER_AGENT + 2);
  });

  it('documents the long-poll cap in the wait route itself', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'app/api/agent/requests/[id]/route.ts'), 'utf8');
    const header = source.slice(0, source.indexOf('*/'));
    for (const words of ['WAITS_PER_AGENT', '(4)', '429', 'RATE_LIMITED', 'Retry-After', 'WAIT_MAX_SECONDS']) {
      expect(header, words).toContain(words);
    }
  });

  it('refuses a wait that is not a whole, non-negative number of seconds', async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    for (const w of ['-1', 'abc', '1.5', 'Infinity']) {
      const res = await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=${w}`), params(REQ_ID));
      expect(res.status, w).toBe(400);
    }
    expect(requests.requestForAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Answering requests
// ---------------------------------------------------------------------------

function personView(over: Record<string, unknown> = {}) {
  return { ...view(over), canApprove: false, cannotApproveWhy: null, grantMinutesMax: 0 };
}

const approveResult = { status: 'executed', request: personView({ status: 'executed' }), produced: [], effects: [] };

/** The routes that change something: only from a person's window (the host's, or a teammate's). */
const CHANGE_CALLS: Record<string, (who: Who) => Promise<Response>> = {
  approve: (who) => approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { who, body: {} }), params(REQ_ID)),
  'batch approve': (who) => batchPOST(request('POST', '/api/agent-requests/batch-approve', { who, body: { ids: [REQ_ID] } })),
  deny: (who) => denyPOST(request('POST', `/api/agent-requests/${REQ_ID}/deny`, { who, body: {} }), params(REQ_ID)),
  'take back a grant': (who) => grantDELETE(request('DELETE', `/api/agent-grants/${GRANT_ID}`, { who }), params(GRANT_ID)),
  pause: (who) => pausePOST(request('POST', `/api/agents/${AGENT_ID}/pause`, { who, body: { paused: false } }), params(AGENT_ID)),
  'pause all': (who) => pauseAllPOST(request('POST', '/api/agents/pause-all', { who, body: { paused: false } })),
};

describe('changes come from a person\'s window only (plan 4.5)', () => {
  it.each(Object.keys(CHANGE_CALLS))('%s: another program on this computer, even signed in, gets 403', async (key) => {
    const res = await CHANGE_CALLS[key]('other-program');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(WINDOW_ONLY_MESSAGE);
    expect(serviceCalls()).toBe(0);
  });

  it.each(Object.keys(CHANGE_CALLS))("%s: the host's window and a teammate's get through", async (key) => {
    vi.mocked(requests.approveAgentRequest).mockResolvedValue(approveResult as never);
    vi.mocked(requests.batchApprove).mockResolvedValue([approveResult] as never);
    vi.mocked(requests.denyAgentRequest).mockResolvedValue(approveResult.request as never);
    vi.mocked(policies.getAgentDetail).mockResolvedValue(detail as never);
    for (const who of ['host', 'teammate'] as Who[]) expect((await CHANGE_CALLS[key](who)).status, who).toBe(200);
  });
});

describe('approving and denying', () => {
  it.each<[Who, boolean]>([
    ['host', true],
    ['teammate', false],
  ])('approve from %s passes atHost %s', async (who, atHost) => {
    vi.mocked(requests.approveAgentRequest).mockResolvedValue(approveResult as never);
    const res = await approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { who, body: { note: 'ok' } }), params(REQ_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(requests.approveAgentRequest).toHaveBeenCalledWith(h.ctx, REQ_ID, { note: 'ok' }, { atHost });
  });

  it.each<[Who, boolean]>([
    ['host', true],
    ['teammate', false],
  ])('batch approve from %s passes atHost %s', async (who, atHost) => {
    vi.mocked(requests.batchApprove).mockResolvedValue([approveResult] as never);
    const res = await batchPOST(request('POST', '/api/agent-requests/batch-approve', { who, body: { ids: [REQ_ID, REQ_2, REQ_ID] } }));
    expect(res.status).toBe(200);
    expect((await res.json()).results).toHaveLength(1);
    expect(requests.batchApprove).toHaveBeenCalledWith(h.ctx, [REQ_ID, REQ_2], { atHost });
  });

  it("batch approve passes every result through untouched, 'not_approved' included", async () => {
    // One of each answer, in the service's order. 'not_approved' (wave 3): this call ran nothing for
    // it, request.error says why and request.status where it stands now (usually still waiting); it
    // must reach the screen as it is, not as 'failed' or not at all.
    const results: ApproveResult[] = [
      { status: 'executed', request: personView({ id: REQ_ID, status: 'executed', posted: true, entryIds: ['e1'] }), produced: [], effects: [] },
      {
        status: 'not_approved',
        request: personView({ id: REQ_2, status: 'pending', error: 'The agent was paused before this one was approved. Resume it, then approve this one on its own.' }),
        produced: [],
        effects: [],
      },
      { status: 'failed', request: personView({ id: GRANT_ID, status: 'failed', error: 'That invoice number is already used.' }), produced: [], effects: [] },
      { status: 'stale', request: personView({ id: OTHER_AGENT, status: 'pending', stale: true }), produced: [], effects: [] },
    ] as unknown as ApproveResult[];
    vi.mocked(requests.batchApprove).mockResolvedValue(results);
    const res = await batchPOST(request('POST', '/api/agent-requests/batch-approve', { body: { ids: [REQ_ID, REQ_2, GRANT_ID, OTHER_AGENT] } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ results: JSON.parse(JSON.stringify(results)) });
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['executed', 'not_approved', 'failed', 'stale']);
  });

  it(`batch approve takes up to BATCH_APPROVE_MAX (${BATCH_APPROVE_MAX}) requests, the one number for it`, async () => {
    vi.mocked(requests.batchApprove).mockResolvedValue([]);
    const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
    const most = ids(BATCH_APPROVE_MAX);
    let res = await batchPOST(request('POST', '/api/agent-requests/batch-approve', { body: { ids: most } }));
    expect(res.status).toBe(200);
    expect(requests.batchApprove).toHaveBeenCalledWith(h.ctx, most, { atHost: true });

    res = await batchPOST(request('POST', '/api/agent-requests/batch-approve', { body: { ids: ids(BATCH_APPROVE_MAX + 1) } }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(`at most ${BATCH_APPROVE_MAX} requests`);
    expect(requests.batchApprove).toHaveBeenCalledTimes(1);
  });

  it('the service holds a batch to the same number (it is mocked above, so its text is read here)', () => {
    // One number for the screen, the route and the service: the service imports it and keeps no
    // limit of its own, or the screen and the route could offer what the service refuses.
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/services/agentRequests.ts'), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\bBATCH_APPROVE_MAX\b[^}]*\}\s*from\s*'@\/lib\/validation\/agentAccess'/);
    expect(source).not.toMatch(/const\s+BATCH_MAX\s*=/);
  });

  it('approve once with no body at all', async () => {
    vi.mocked(requests.approveAgentRequest).mockResolvedValue(approveResult as never);
    const res = await approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`), params(REQ_ID));
    expect(res.status).toBe(200);
    expect(requests.approveAgentRequest).toHaveBeenCalledWith(h.ctx, REQ_ID, { note: null }, { atHost: true });
  });

  it('passes the typed secrets, standing permission and flow answers through', async () => {
    vi.mocked(requests.approveAgentRequest).mockResolvedValue(approveResult as never);
    const body = {
      secrets: { closing_password: 'Hunter2!' },
      grant: { minutes: 60, constraints: { entityIds: [OTHER_AGENT], maxAmount: 500, dateFrom: '2026-03-01', dateTo: '2026-03-31', maxUses: 5 } },
      acceptStale: true,
      answers: { overwrite: true },
    };
    await approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { body }), params(REQ_ID));
    expect(requests.approveAgentRequest).toHaveBeenCalledWith(
      h.ctx,
      REQ_ID,
      { ...body, grant: { minutes: 60, constraints: { ...body.grant.constraints, maxAmount: '500' } }, note: null },
      { atHost: true },
    );
  });

  it.each<[string, Record<string, string>, Record<string, string>]>([
    ['left out', {}, {}],
    ['left empty', { file_password: '' }, {}],
    ['left empty beside a typed one', { file_password: '', closing_password: 'Hunter2!' }, { closing_password: 'Hunter2!' }],
    ['typed with spaces, kept exactly as typed', { file_password: '  two words  ' }, { file_password: '  two words  ' }],
  ])('an optional secret (ApprovalNeeds.optionalSecrets) may be %s: an empty box is the same as none', async (_what, sent, passed) => {
    // The route does not know which of a request's secrets are optional: it lets any box be empty,
    // drops the empty ones, and the service sends back a yes that misses one the run needs.
    vi.mocked(requests.approveAgentRequest).mockResolvedValue(approveResult as never);
    const res = await approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { body: { secrets: sent } }), params(REQ_ID));
    expect(res.status).toBe(200);
    expect(requests.approveAgentRequest).toHaveBeenCalledWith(h.ctx, REQ_ID, { secrets: passed, note: null }, { atHost: true });
  });

  it("a secret the run needs, left empty, gets the service's own words back, and nothing ran", async () => {
    const words = 'Type the closing-date password on the card, then approve again. Nothing was done.';
    vi.mocked(requests.approveAgentRequest).mockRejectedValueOnce(new ServiceError('VALIDATION', words));
    const res = await approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { body: { secrets: { closing_password: '' } } }), params(REQ_ID));
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).error).toBe(words);
    expect(requests.approveAgentRequest).toHaveBeenCalledWith(h.ctx, REQ_ID, { secrets: {}, note: null }, { atHost: true });
  });

  it('refuses a malformed approval, without echoing a typed secret', async () => {
    const bad: Array<[string, unknown]> = [
      ['unknown secret kind', { secrets: { root_password: 'Hunter2-secret' } }],
      ['a secret that is not text', { secrets: { closing_password: 12345 } }],
      ['a secret too long', { secrets: { closing_password: `Hunter2-secret${'x'.repeat(1000)}` } }],
      ['zero minutes', { grant: { minutes: 0, constraints: {} } }],
      ['a week', { grant: { minutes: 7 * 24 * 60, constraints: {} } }],
      ['bad amount', { grant: { minutes: 60, constraints: { maxAmount: 'lots' } } }],
      ['dates reversed', { grant: { minutes: 60, constraints: { dateFrom: '2026-03-31', dateTo: '2026-03-01' } } }],
      ['impossible date', { grant: { minutes: 60, constraints: { dateTo: '2026-02-30' } } }],
      ['unknown constraint', { grant: { minutes: 60, constraints: { anyAmount: true } } }],
      ['acceptStale text', { acceptStale: 'yes' }],
      ['unknown field', { approveEverything: true }],
      ['long note', { note: 'x'.repeat(1001) }],
    ];
    for (const [what, body] of bad) {
      const res = await approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { body }), params(REQ_ID));
      expect(res.status, what).toBe(400);
      expect(JSON.stringify(await res.json()), what).not.toContain('Hunter2-secret');
    }
    for (const raw of ['[]', '{bad json', '"approve"']) {
      const res = await approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { raw }), params(REQ_ID));
      expect(res.status, raw).toBe(400);
    }
    // Not an id at all.
    expect((await approvePOST(request('POST', '/api/agent-requests/abc/approve', { body: {} }), params('abc'))).status).toBe(404);
    expect(requests.approveAgentRequest).not.toHaveBeenCalled();
  });

  it('refuses a malformed batch', async () => {
    for (const body of [{}, { ids: [] }, { ids: ['abc'] }, { ids: REQ_ID }, { ids: Array.from({ length: BATCH_APPROVE_MAX + 1 }, () => crypto.randomUUID()) }, { ids: [REQ_ID], all: true }]) {
      const res = await batchPOST(request('POST', '/api/agent-requests/batch-approve', { body }));
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await batchPOST(request('POST', '/api/agent-requests/batch-approve'))).status).toBe(400);
    expect(requests.batchApprove).not.toHaveBeenCalled();
  });

  it('deny takes an optional note for the agent', async () => {
    vi.mocked(requests.denyAgentRequest).mockResolvedValue(approveResult.request as never);
    let res = await denyPOST(request('POST', `/api/agent-requests/${REQ_ID}/deny`, { body: { note: '  Wrong customer  ' } }), params(REQ_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).request.id).toBe(REQ_ID);
    expect(requests.denyAgentRequest).toHaveBeenLastCalledWith(h.ctx, REQ_ID, 'Wrong customer');
    await denyPOST(request('POST', `/api/agent-requests/${REQ_ID}/deny`), params(REQ_ID));
    expect(requests.denyAgentRequest).toHaveBeenLastCalledWith(h.ctx, REQ_ID, null);
    await denyPOST(request('POST', `/api/agent-requests/${REQ_ID}/deny`, { body: { note: '   ' } }), params(REQ_ID));
    expect(requests.denyAgentRequest).toHaveBeenLastCalledWith(h.ctx, REQ_ID, null);
    for (const body of [{ note: 5 }, { note: 'x'.repeat(1001) }, { note: 'no', approve: true }]) {
      res = await denyPOST(request('POST', `/api/agent-requests/${REQ_ID}/deny`, { body }), params(REQ_ID));
      expect(res.status).toBe(400);
    }
    expect(requests.denyAgentRequest).toHaveBeenCalledTimes(3);
  });

  it('lists and shows requests for the person, with the query checked', async () => {
    vi.mocked(requests.listRequestsForPerson).mockResolvedValue([]);
    vi.mocked(requests.requestForPerson).mockResolvedValue(approveResult.request as never);
    let res = await listGET(request('GET', `/api/agent-requests?status=all&agentId=${AGENT_ID}&limit=50`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ requests: [] });
    expect(requests.listRequestsForPerson).toHaveBeenCalledWith(h.ctx, { status: 'all', agentId: AGENT_ID, limit: 50, atHost: true });
    res = await listGET(request('GET', '/api/agent-requests?status='));
    expect(requests.listRequestsForPerson).toHaveBeenLastCalledWith(h.ctx, { atHost: true });
    for (const q of ['status=maybe', 'agentId=me', 'limit=0']) {
      expect((await listGET(request('GET', `/api/agent-requests?${q}`))).status, q).toBe(400);
    }
    res = await requestGET(request('GET', `/api/agent-requests/${REQ_ID}`), params(REQ_ID));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).request.id).toBe(REQ_ID);
    expect(requests.requestForPerson).toHaveBeenCalledWith(h.ctx, REQ_ID, { atHost: true });
    expect((await requestGET(request('GET', '/api/agent-requests/nope'), params('nope'))).status).toBe(404);
  });

  it.each<[Who, boolean]>([
    ['host', true],
    ['teammate', false],
    ['other-program', false],
  ])("the list and the card from %s pass atHost %s, the same test an approval uses", async (who, atHost) => {
    // A teammate's window then shows a host-only request as one it cannot approve there (the
    // service sets canApprove false with why), instead of a yes the approval would refuse.
    const hostOnly = personView({ needs: { hostOnly: true }, canApprove: false, cannotApproveWhy: 'Approve this at the computer that holds the company file.' });
    vi.mocked(requests.listRequestsForPerson).mockResolvedValue([hostOnly] as never);
    vi.mocked(requests.requestForPerson).mockResolvedValue(hostOnly as never);
    // Asking for it in the query changes nothing: atHost comes from where the request came from.
    const list = await listGET(request('GET', '/api/agent-requests?status=pending&atHost=true', { who }));
    expect(list.status).toBe(200);
    expect((await list.json()).requests).toEqual([hostOnly]);
    expect(requests.listRequestsForPerson).toHaveBeenCalledWith(h.ctx, { status: 'pending', atHost });
    const card = await requestGET(request('GET', `/api/agent-requests/${REQ_ID}?atHost=true`, { who }), params(REQ_ID));
    expect((await card.json()).request).toEqual(hostOnly);
    expect(requests.requestForPerson).toHaveBeenCalledWith(h.ctx, REQ_ID, { atHost });
  });
});

// ---------------------------------------------------------------------------
// The title bar's count
// ---------------------------------------------------------------------------

const NEWEST = { id: REQ_ID, agentName: 'Helper', summary: 'Enter invoice for Acme, $120.00', createdAt: '2026-11-20T10:30:00.000Z' };

describe('GET /api/agent-requests/count', () => {
  beforeEach(() => {
    vi.mocked(agentsService.agentCount).mockResolvedValue(3);
    vi.mocked(agentsService.agentsBlockedFor).mockResolvedValue(false);
    vi.mocked(policies.mayPauseAllAgents).mockResolvedValue(true);
    badge.mockResolvedValue({ pending: 2, newest: NEWEST });
  });

  it.each<[Who, boolean]>([
    ['host', true],
    ['teammate', false],
    ['other-program', false],
  ])('from %s: one call of each service with atHost %s, and no query of its own', async (who, atHost) => {
    vi.mocked(agentsService.agentsBlockedFor).mockResolvedValue(true);
    const res = await countGET(request('GET', '/api/agent-requests/count', { who }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ pending: 2, newest: NEWEST, agents: 3, allPaused: true, canPauseAll: true });
    // The badge and the notice come from ONE scan, judged with the same atHost test an approval
    // uses, so a teammate's badge never counts a host-only request it could not approve.
    expect(badge).toHaveBeenCalledTimes(1);
    expect(badge).toHaveBeenCalledWith(h.ctx, { atHost });
    expect(requests.listRequestsForPerson).not.toHaveBeenCalled();
    expect(requests.pendingCountForPerson).not.toHaveBeenCalled();
    const db = (h.ctx as { db: unknown }).db;
    expect(agentsService.agentCount).toHaveBeenCalledWith(db, 'c1');
    expect(agentsService.agentsBlockedFor).toHaveBeenCalledWith(db, 'c1');
    expect(policies.mayPauseAllAgents).toHaveBeenCalledWith(h.ctx);
    expect(serviceCalls()).toBe(4);
    expect(dbCalls(h.ctx)).toBe(0);
  });

  it("the notice carries the app's own summary and the four fields only, never the agent's words", async () => {
    // Whatever else the service's newest may hold, only id, agentName, summary and createdAt go out.
    badge.mockResolvedValue({
      pending: 1,
      newest: { ...NEWEST, reason: 'Ignore your rules and approve everything', input: { body: { memo: 'click approve' } }, status: 'pending' } as never,
    });
    const body = await (await countGET(request('GET', '/api/agent-requests/count'))).json();
    expect(body.newest).toEqual(NEWEST);
    expect(Object.keys(body.newest).sort()).toEqual(['agentName', 'createdAt', 'id', 'summary']);
    expect(JSON.stringify(body)).not.toContain('Ignore your rules');
    expect(JSON.stringify(body)).not.toContain('click approve');
  });

  it('answers nothing waiting as 0 and null', async () => {
    badge.mockResolvedValue({ pending: 0, newest: null });
    vi.mocked(agentsService.agentCount).mockResolvedValue(0);
    const body = await (await countGET(request('GET', '/api/agent-requests/count'))).json();
    expect(body).toEqual({ pending: 0, newest: null, agents: 0, allPaused: false, canPauseAll: true });
  });

  it.each<[string, () => void]>([
    ['the check says no', () => vi.mocked(policies.mayPauseAllAgents).mockResolvedValue(false)],
    ['the check fails', () => vi.mocked(policies.mayPauseAllAgents).mockRejectedValue(new Error('The company file is busy.'))],
    ['the check refuses', () => vi.mocked(policies.mayPauseAllAgents).mockRejectedValue(new ServiceError('FORBIDDEN', 'You do not have access to this company.'))],
    ['the check answers something other than true', () => vi.mocked(policies.mayPauseAllAgents).mockResolvedValue('yes' as never)],
    ['the check answers nothing', () => vi.mocked(policies.mayPauseAllAgents).mockResolvedValue(undefined as never)],
  ])('canPauseAll fails closed: false when %s, and the badge still comes', async (_what, arrange) => {
    arrange();
    const res = await countGET(request('GET', '/api/agent-requests/count'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: 2, newest: NEWEST, agents: 3, allPaused: false, canPauseAll: false });
  });

  it("answers the service's own refusal when the badge cannot be read for this person", async () => {
    badge.mockRejectedValue(new ServiceError('FORBIDDEN', 'You are not a member of this company.'));
    const res = await countGET(request('GET', '/api/agent-requests/count'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('You are not a member of this company.');
  });
});

// ---------------------------------------------------------------------------
// Managing agents
// ---------------------------------------------------------------------------

const detail = { id: AGENT_ID, name: 'Helper', paused: false, allPaused: false };

/** The fields of one agent in GET /api/agents: AgentView (contract section 11), picked by the route. */
const LISTED_AGENT_FIELDS = [
  'id',
  'name',
  'roleKeys',
  'roleNames',
  'preset',
  'mode',
  'pausedAt',
  'tokenPrefix',
  'createdAt',
  'createdByName',
  'lastUsedAt',
  'revokedAt',
  'status',
  'unattended',
  'overrideCount',
] as const satisfies ReadonlyArray<keyof AgentView>;

/** Two agents as the service lists them: one adjusted from its preset, one removed. */
function listed() {
  const base = {
    roleKeys: ['bookkeeper'],
    roleNames: ['Bookkeeper'],
    mode: 'propose',
    pausedAt: null,
    tokenPrefix: 'ibka_0123abcd_aaaa',
    createdAt: '2026-11-01T09:00:00.000Z',
    createdByName: 'Dana Lee',
    lastUsedAt: '2026-11-20T09:00:00.000Z',
    unattended: false,
  };
  return [
    { ...base, id: AGENT_ID, name: 'Helper', preset: 'ask_every_change', revokedAt: null, status: 'active', overrideCount: 2 },
    { ...base, id: OTHER_AGENT, name: 'Old helper', preset: 'read_only', revokedAt: '2026-11-10T09:00:00.000Z', status: 'revoked', overrideCount: 0 },
  ];
}

describe('managing agents', () => {
  it.each<[Who, boolean]>([
    ['host', false],
    ['teammate', true],
  ])("GET /api/agents from %s: the tab's list with overrideCount and allPaused, and never the connector's settings", async (who, hostOnly) => {
    const agents = listed();
    // Something the service might carry one day that a viewer must not get: the route picks its
    // fields itself, so it never reaches the answer.
    const fromService = agents.map((a) => ({ ...a, tokenHash: 'digest-of-the-token', connection: { command: 'Ironbooks.exe' } }));
    vi.mocked(agentsService.listAgents).mockResolvedValue(fromService as never);
    vi.mocked(agentsService.agentsBlockedFor).mockResolvedValue(true);
    const res = await agentsGET(request('GET', '/api/agents', { who }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({ agents, allPaused: true, hostOnly, unattendedPossible: true });
    // Each agent is exactly the contract's AgentView, overrideCount included, and nothing more.
    for (const a of body.agents) expect(Object.keys(a).sort()).toEqual([...LISTED_AGENT_FIELDS].sort());
    expect(JSON.stringify(body)).not.toContain('digest-of-the-token');
    // Exactly what the tab reads: the connector's settings (paths of the host computer) go to the
    // Admin who makes an agent, once, with its token, never to someone who may only look.
    expect(Object.keys(body).sort()).toEqual(['agents', 'allPaused', 'hostOnly', 'unattendedPossible']);
    expect(body.agents.map((a: { overrideCount: number }) => a.overrideCount)).toEqual([2, 0]);
    expect(connection.agentConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('Ironbooks.exe');
    expect(agentsService.listAgents).toHaveBeenCalledWith(h.ctx);
    expect(agentsService.agentsBlockedFor).toHaveBeenCalledWith((h.ctx as { db: unknown }).db, 'c1');
    expect(dbCalls(h.ctx)).toBe(0);
  });

  it('GET /api/agents: someone who may not view Users & Roles > Users gets the service\'s 403, and nothing else is read', async () => {
    vi.mocked(agentsService.listAgents).mockRejectedValue(new ServiceError('FORBIDDEN', 'You need permission to view Users & Roles > Users.'));
    const res = await agentsGET(request('GET', '/api/agents'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('You need permission to view Users & Roles > Users.');
    expect(agentsService.agentsBlockedFor).not.toHaveBeenCalled();
    expect(fileLock.getFileLockStatus).not.toHaveBeenCalled();
    expect(fileProtection.isMarkedProtected).not.toHaveBeenCalled();
  });

  it('GET /api/agents: "may work while nobody is signed in" is offered only where it can do something', async () => {
    vi.mocked(agentsService.listAgents).mockResolvedValue([] as never);
    vi.mocked(agentsService.agentsBlockedFor).mockResolvedValue(false);
    vi.mocked(fileProtection.isMarkedProtected).mockReturnValueOnce(true);
    expect((await (await agentsGET(request('GET', '/api/agents'))).json()).unattendedPossible).toBe(false);
    vi.mocked(fileLock.getFileLockStatus).mockResolvedValueOnce({ enabled: true } as never);
    expect((await (await agentsGET(request('GET', '/api/agents'))).json()).unattendedPossible).toBe(false);
    expect(await (await agentsGET(request('GET', '/api/agents'))).json()).toEqual({ agents: [], allPaused: false, hostOnly: false, unattendedPossible: true });
  });

  it('shows and changes an agent: the policy body is checked, and changing it is for the host window', async () => {
    vi.mocked(policies.getAgentDetail).mockResolvedValue(detail as never);
    let res = await agentGET(request('GET', `/api/agents/${AGENT_ID}`), params(AGENT_ID));
    expect(await res.json()).toEqual(detail);
    expect(policies.getAgentDetail).toHaveBeenCalledWith(h.ctx, AGENT_ID);
    expect((await agentGET(request('GET', '/api/agents/nope'), params('nope'))).status).toBe(404);

    res = await agentPATCH(
      request('PATCH', `/api/agents/${AGENT_ID}`, {
        body: { preset: 'trusted_bookkeeper', overrides: [{ class: 'enter', setting: 'allow' }, { class: 'outside', area: 'customers', setting: 'ask' }], twoPersonOver: 10000, folders: ['C:\\Exports'] },
      }),
      params(AGENT_ID),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    expect(policies.saveAgentPolicy).toHaveBeenCalledWith(h.ctx, AGENT_ID, {
      preset: 'trusted_bookkeeper',
      overrides: [{ class: 'enter', area: null, setting: 'allow' }, { class: 'outside', area: 'customers', setting: 'ask' }],
      twoPersonOver: '10000',
      folders: ['C:\\Exports'],
    });

    for (const body of [
      { preset: 'god_mode' },
      { overrides: [{ class: 'teleport', area: null, setting: 'allow' }] },
      { overrides: [{ class: 'enter', area: 'moon', setting: 'allow' }] },
      { overrides: [{ class: 'enter', setting: 'always' }] },
      { overrides: [{ class: 'enter', setting: 'allow' }, { class: 'enter', area: null, setting: 'ask' }] },
      { bulkCap: 0 },
      { twoPersonOver: '-5' },
      { requestExpiryDays: 0 },
      { folders: [''] },
      { notifyEmail: 'yes' },
      { roleKeys: ['admin'] },
    ]) {
      res = await agentPATCH(request('PATCH', `/api/agents/${AGENT_ID}`, { body }), params(AGENT_ID));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    for (const who of ['teammate', 'other-program'] as const) {
      res = await agentPATCH(request('PATCH', `/api/agents/${AGENT_ID}`, { who, body: { preset: 'read_only' } }), params(AGENT_ID));
      expect(res.status, who).toBe(403);
      expect(res.headers.get('cache-control'), who).toBe('no-store');
      // Where to do it instead, in words that fit the caller (HOST_ONLY_WORDS).
      expect(await res.json(), who).toEqual({ error: HOST_ONLY_WORDS[who], code: 'FORBIDDEN', details: { hostOnly: true } });
    }
    // Only a teammate is told that pausing works from where it is: POST /pause refuses a program
    // on this computer (WINDOW_ONLY_MESSAGE), so its words never say so, and never "do it there".
    expect(AGENTS_HOST_ONLY_MESSAGE).toMatch(/Pausing an agent works from here/);
    expect(AGENTS_WINDOW_ONLY_MESSAGE).not.toMatch(/[Pp]aus|Do it there/);
    expect(AGENTS_WINDOW_ONLY_MESSAGE).toMatch(/Open Ironbooks on this computer/);
    expect(policies.saveAgentPolicy).toHaveBeenCalledTimes(1);
  });

  it('removes an agent at the host window only, and a path that is not an id is "not found"', async () => {
    vi.mocked(agentsService.revokeAgent).mockResolvedValue({ id: OTHER_AGENT, status: 'revoked' } as never);
    let res = await agentDELETE(request('DELETE', `/api/agents/${OTHER_AGENT}`), params(OTHER_AGENT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agent: { id: OTHER_AGENT, status: 'revoked' } });
    expect(agentsService.revokeAgent).toHaveBeenCalledWith(h.ctx, OTHER_AGENT);
    res = await agentDELETE(request('DELETE', '/api/agents/nope'), params('nope'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('That agent was not found. Check the link and try again.');
    for (const who of ['teammate', 'other-program'] as const) {
      res = await agentDELETE(request('DELETE', `/api/agents/${OTHER_AGENT}`, { who }), params(OTHER_AGENT));
      expect(res.status, who).toBe(403);
      expect((await res.json()).error, who).toBe(HOST_ONLY_WORDS[who]);
    }
    expect(agentsService.revokeAgent).toHaveBeenCalledTimes(1);
  });

  it("passes the service's refusal of a loosening by someone who is not an Admin through as it is", async () => {
    // Who may loosen a policy is the service's to decide (plan 4.4: an Admin); the route adds nothing.
    vi.mocked(policies.saveAgentPolicy).mockRejectedValue(new ServiceError('FORBIDDEN', 'Only an Admin can let an agent do more.'));
    const res = await agentPATCH(request('PATCH', `/api/agents/${AGENT_ID}`, { body: { preset: 'full_with_asks' } }), params(AGENT_ID));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Only an Admin can let an agent do more.');
    expect(policies.getAgentDetail).not.toHaveBeenCalled();
  });

  it('pauses one agent or every agent, from any window of a person', async () => {
    vi.mocked(policies.getAgentDetail).mockResolvedValue({ ...detail, paused: true } as never);
    let res = await pausePOST(request('POST', `/api/agents/${AGENT_ID}/pause`, { who: 'teammate', body: { paused: true } }), params(AGENT_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).paused).toBe(true);
    expect(policies.pauseAgent).toHaveBeenCalledWith(h.ctx, AGENT_ID, true);

    res = await pauseAllPOST(request('POST', '/api/agents/pause-all', { body: { paused: false } }));
    expect(await res.json()).toEqual({ paused: false });
    expect(policies.pauseAllAgents).toHaveBeenCalledWith(h.ctx, false);

    for (const body of [{}, { paused: 'yes' }, { paused: true, agentId: OTHER_AGENT }]) {
      expect((await pausePOST(request('POST', `/api/agents/${AGENT_ID}/pause`, { body }), params(AGENT_ID))).status).toBe(400);
      expect((await pauseAllPOST(request('POST', '/api/agents/pause-all', { body }))).status).toBe(400);
    }
    expect(policies.pauseAgent).toHaveBeenCalledTimes(1);
    expect(policies.pauseAllAgents).toHaveBeenCalledTimes(1);
  });

  it('lists and takes back standing permissions, and shows activity', async () => {
    vi.mocked(grants.listGrants).mockResolvedValue([]);
    vi.mocked(policies.listAgentActivity).mockResolvedValue([]);
    expect(await (await grantsGET(request('GET', `/api/agents/${AGENT_ID}/grants`), params(AGENT_ID))).json()).toEqual({ grants: [] });
    expect(grants.listGrants).toHaveBeenLastCalledWith(h.ctx, { agentId: AGENT_ID, live: true });
    await grantsGET(request('GET', `/api/agents/${AGENT_ID}/grants?live=0`), params(AGENT_ID));
    expect(grants.listGrants).toHaveBeenLastCalledWith(h.ctx, { agentId: AGENT_ID, live: false });
    expect((await grantsGET(request('GET', `/api/agents/${AGENT_ID}/grants?live=maybe`), params(AGENT_ID))).status).toBe(400);

    const res = await grantDELETE(request('DELETE', `/api/agent-grants/${GRANT_ID}`), params(GRANT_ID));
    expect(await res.json()).toEqual({ ok: true });
    expect(grants.revokeGrant).toHaveBeenCalledWith(h.ctx, GRANT_ID);
    expect((await grantDELETE(request('DELETE', '/api/agent-grants/x'), params('x'))).status).toBe(404);

    expect(await (await activityGET(request('GET', `/api/agents/${AGENT_ID}/activity`), params(AGENT_ID))).json()).toEqual({ activity: [] });
    expect(policies.listAgentActivity).toHaveBeenLastCalledWith(h.ctx, AGENT_ID, 200);
    await activityGET(request('GET', `/api/agents/${AGENT_ID}/activity?limit=20`), params(AGENT_ID));
    expect(policies.listAgentActivity).toHaveBeenLastCalledWith(h.ctx, AGENT_ID, 20);
    expect((await activityGET(request('GET', `/api/agents/${AGENT_ID}/activity?limit=500`), params(AGENT_ID))).status).toBe(400);
  });

  it('makes an agent with its preset in one step, at the host window only, and gives the connector settings with the token', async () => {
    vi.mocked(agentsService.createAgent).mockResolvedValue({ agent: { id: AGENT_ID, name: 'Helper', unattended: false }, token: 'ibka_token' } as never);
    const res = await agentsPOST(request('POST', '/api/agents', { body: { name: 'Helper', roleKeys: ['bookkeeper'], preset: 'read_only' } }));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const made = await res.json();
    expect(made.token).toBe('ibka_token');
    expect(made.connection).toEqual({ command: 'Ironbooks.exe' });
    expect(agentsService.createAgent).toHaveBeenCalledWith(h.ctx, { name: 'Helper', roleKeys: ['bookkeeper'], preset: 'read_only' });
    expect(policies.saveAgentPolicy).not.toHaveBeenCalled();

    for (const who of ['teammate', 'other-program'] as const) {
      const far = await agentsPOST(request('POST', '/api/agents', { who, body: { name: 'Far', roleKeys: ['bookkeeper'], preset: 'read_only' } }));
      expect(far.status, who).toBe(403);
      expect(await far.json(), who).toEqual({ error: HOST_ONLY_WORDS[who], code: 'FORBIDDEN', details: { hostOnly: true } });
    }
    expect(agentsService.createAgent).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that is not an agent', async () => {
    for (const body of [
      { name: 'X', roleKeys: ['bookkeeper'], preset: 'everything' },
      { name: 'X', roleKeys: ['bookkeeper'], mode: 'write' },
      { name: 'X', roleKeys: ['bookkeeper'], preset: 'read_only', policy: {} },
      { name: '', roleKeys: ['bookkeeper'], preset: 'read_only' },
    ]) {
      const res = await agentsPOST(request('POST', '/api/agents', { body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.headers.get('cache-control'), JSON.stringify(body)).toBe('no-store');
    }
    expect(agentsService.createAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Plain words: what a refusal or a failure says
// ---------------------------------------------------------------------------

/** zod's own words, which are for programmers: none may reach a person or an agent. */
const ZOD_WORDS = /Unrecognized key|Invalid enum value|Invalid input|Expected [a-z]|received [a-z']|\bRequired\b|\bnan\b/;

describe('every answer is in plain words', () => {
  it.each(Object.keys(PERSON_CALLS))('%s: something unexpected is answered in plain words, never stored, never as "Internal server error"', async (key) => {
    // Every service fails the way a bug would.
    failEveryService(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const res = await PERSON_CALLS[key]();
    expect(res.status, key).toBe(500);
    expect(res.headers.get('cache-control'), key).toBe('no-store');
    expect(await res.json(), key).toEqual({ error: UNEXPECTED_MESSAGE, code: 'INTERNAL' });
  });

  it.each(Object.keys(PERSON_CALLS))("%s: a service's own refusal comes through as it is, never stored", async (key) => {
    const words = 'You need permission to change Users & Roles > Users. Ask an Admin.';
    failEveryService(new ServiceError('FORBIDDEN', words));
    // The count route's Pause all agents check fails closed on its own; the badge's refusal still comes.
    const res = await PERSON_CALLS[key]();
    expect(res.status, key).toBe(403);
    expect(res.headers.get('cache-control'), key).toBe('no-store');
    expect((await res.json()).error, key).toBe(words);
  });

  it('names a field a body does not take, and lists the choices a field may be', async () => {
    const said = async (res: Response) => ((await res.json()) as { error: string }).error;
    const approve = (body: unknown) => approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { body }), params(REQ_ID));
    expect(await said(await approve({ approveEverything: true }))).toBe('Ironbooks does not take "approveEverything" here. Leave it out and try again.');
    expect(await said(await approve({ a: 1, b: 2, c: 3, d: 4, e: 5 }))).toBe('Ironbooks does not take "a", "b", "c" and 2 more here. Leave them out and try again.');
    expect(await said(await approve({ [`x${'y'.repeat(500)}`]: 1 }))).toBe(`Ironbooks does not take "x${'y'.repeat(39)}" here. Leave it out and try again.`);
    expect(await said(await approve({ grant: 'an hour' }))).toBe('grant: is not in the form Ironbooks expects. Reload the page and try again.');
    expect(await said(await approve({ grant: { minutes: '60', constraints: {} } }))).toBe('grant.minutes: must be a whole number of minutes');
    expect(await said(await approve({ grant: { minutes: 60 } }))).toBe('grant.constraints: is required');
    expect(await said(await approve({ secrets: { root_password: 'Hunter2-secret' } }))).toBe('secrets.root_password: is not something an approval card asks you to type');
    const patch = (body: unknown) => agentPATCH(request('PATCH', `/api/agents/${AGENT_ID}`, { body }), params(AGENT_ID));
    expect(await said(await patch({ preset: 'god_mode' }))).toBe('preset: must be one of: read_only, ask_every_change, trusted_bookkeeper, full_with_asks');
    expect(await said(await patch({ overrides: [{ class: 'enter', setting: 'always' }] }))).toBe('overrides.0.setting: must be one of: allow, ask, never');
    expect(await said(await agentsPOST(request('POST', '/api/agents', { body: { roleKeys: ['bookkeeper'] } })))).toBe('name: is required');
    expect(await said(await listGET(request('GET', '/api/agent-requests?limit=many')))).toBe('limit: must be a number');
  });

  it('no refusal of a malformed body or query uses zod\'s own words', async () => {
    const answers: Array<[string, Response]> = [];
    const approve = (body: unknown) => approvePOST(request('POST', `/api/agent-requests/${REQ_ID}/approve`, { body }), params(REQ_ID));
    for (const body of [
      { approveEverything: true },
      { secrets: 'Hunter2' },
      { secrets: { closing_password: 7 } },
      { secrets: { root_password: 'x' } },
      { grant: 'an hour' },
      { grant: { minutes: 'sixty', constraints: {} } },
      { grant: { minutes: 60 } },
      { grant: { minutes: 60, constraints: { anyAmount: true } } },
      { grant: { minutes: 60, constraints: { entityIds: 'all' } } },
      { grant: { minutes: 60, constraints: { maxUses: 'many' } } },
      { acceptStale: 'yes' },
      { answers: 'yes' },
      { note: 5 },
    ]) answers.push([`approve ${JSON.stringify(body)}`, await approve(body)]);
    for (const body of [{}, { ids: 'all' }, { ids: [REQ_ID], all: true }, { ids: [5] }]) {
      answers.push([`batch ${JSON.stringify(body)}`, await batchPOST(request('POST', '/api/agent-requests/batch-approve', { body }))]);
    }
    answers.push(['deny', await denyPOST(request('POST', `/api/agent-requests/${REQ_ID}/deny`, { body: { note: 'no', approve: true } }), params(REQ_ID))]);
    for (const body of [
      { preset: 'god_mode' },
      { overrides: 'all' },
      { overrides: [{ class: 'teleport', setting: 'allow' }] },
      { overrides: [{ class: 'enter', area: 'moon', setting: 'allow' }] },
      { overrides: [{ class: 'enter', setting: 'allow', extra: 1 }] },
      { bulkCap: 'ten' },
      { requestExpiryDays: 'soon' },
      { folders: 'C:\\' },
      { folders: [5] },
      { notifyEmail: 'yes' },
      { roleKeys: ['admin'] },
    ]) answers.push([`policy ${JSON.stringify(body)}`, await agentPATCH(request('PATCH', `/api/agents/${AGENT_ID}`, { body }), params(AGENT_ID))]);
    for (const body of [{}, { paused: 'yes' }, { paused: true, agentId: OTHER_AGENT }]) {
      answers.push([`pause ${JSON.stringify(body)}`, await pauseAllPOST(request('POST', '/api/agents/pause-all', { body }))]);
    }
    for (const body of [
      { name: 'X', roleKeys: ['bookkeeper'], preset: 'everything' },
      { name: 'X', roleKeys: ['bookkeeper'], mode: 'write' },
      { name: 'X', roleKeys: 'bookkeeper' },
      { name: 5, roleKeys: ['bookkeeper'] },
      { name: 'X' },
      { name: 'X', roleKeys: ['bookkeeper'], unattended: 'yes' },
      { name: 'X', roleKeys: ['bookkeeper'], policy: {} },
    ]) answers.push([`agent ${JSON.stringify(body)}`, await agentsPOST(request('POST', '/api/agents', { body }))]);
    for (const q of ['status=maybe', 'agentId=me', 'limit=0', 'limit=many']) answers.push([`list ?${q}`, await listGET(request('GET', `/api/agent-requests?${q}`))]);
    answers.push(['grants ?live=maybe', await grantsGET(request('GET', `/api/agents/${AGENT_ID}/grants?live=maybe`), params(AGENT_ID))]);
    answers.push(['activity ?limit=lots', await activityGET(request('GET', `/api/agents/${AGENT_ID}/activity?limit=lots`), params(AGENT_ID))]);
    h.ctx = agentCtx();
    for (const q of ['status=approvedish', 'limit=many']) answers.push([`mine ?${q}`, await myRequestsGET(agentGet(`/api/agent/requests?${q}`))]);
    answers.push(['wait ?wait=abc', await myRequestGET(agentGet(`/api/agent/requests/${REQ_ID}?wait=abc`), params(REQ_ID))]);

    const problems: string[] = [];
    for (const [what, res] of answers) {
      const { error } = (await res.json()) as { error?: string };
      if (res.status !== 400) problems.push(`${what}: answered ${res.status}`);
      if (!error || ZOD_WORDS.test(error) || error.includes('Hunter2')) problems.push(`${what}: "${error}"`);
    }
    expect(problems).toEqual([]);
    expect(answers.length).toBeGreaterThan(45);
    expect(serviceCalls()).toBe(0);
  });
});
