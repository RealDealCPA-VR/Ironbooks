/**
 * Agent full access: the HTTP API of lib/agent/contract.ts section 11 (plan 4.5, 4.6, 7.1, 7.2, 11.1).
 *
 *  - Every PERSON route (/api/agent-requests/**, /api/agent-grants/**, /api/agents/**) refuses an
 *    agent's context, a run inside an agent's service scope and a request carrying an
 *    Authorization header, with 403, before it reads anything or calls any service.
 *  - The AGENT routes (/api/agent/requests/**) refuse a person, only ever answer the agent's own
 *    requests, and wait at most WAIT_MAX_SECONDS.
 *  - Bodies and queries are checked; the approvals pass on whether they came from the host
 *    computer's own window, and every change needs a person's window (another program on this
 *    computer is refused even with a sign-in).
 *
 * The handlers are called directly with getServerContext mocked; the services are mocked too (they
 * are other units' work), so only the routes' own decisions are under test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fullAccess, type EffectiveAccess } from '@/lib/permissions/model';
import { API_ROUTE_PERMISSIONS, HTTP_METHODS, routePatternFromFile } from '@/lib/permissions/routes';
import { WAIT_MAX_SECONDS } from '@/lib/agent/contract';
import { ADMIN_CLASSES } from '@/lib/agent/operations/classes/admin';

const h = vi.hoisted(() => ({ ctx: null as unknown, scope: false }));

vi.mock('@/lib/context', () => ({
  getServerContext: vi.fn(async () => h.ctx),
  inServiceScope: vi.fn(() => h.scope),
}));
vi.mock('@/lib/services/agentRequests', () => ({
  listRequestsForPerson: vi.fn(),
  pendingCountForPerson: vi.fn(),
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
vi.mock('@/lib/services/agents', () => ({ createAgent: vi.fn(), listAgents: vi.fn(), revokeAgent: vi.fn(), agentsBlockedFor: vi.fn() }));
vi.mock('@/lib/agent/connection', () => ({ agentConnection: vi.fn(() => ({ command: 'Ironbooks.exe' })), forUnattended: vi.fn((c: unknown) => c) }));
vi.mock('@/lib/services/fileLock', () => ({ getFileLockStatus: vi.fn(async () => ({ enabled: false })) }));
vi.mock('@/lib/services/fileProtection', () => ({ isMarkedProtected: vi.fn(() => false) }));

import * as requests from '@/lib/services/agentRequests';
import * as grants from '@/lib/services/agentGrants';
import * as policies from '@/lib/services/agentPolicies';
import * as agentsService from '@/lib/services/agents';
import {
  AGENT_ONLY_MESSAGE,
  PERSON_ONLY_MESSAGE,
  TOO_MANY_WAITS_MESSAGE,
  WAITS_PER_AGENT,
  WINDOW_ONLY_MESSAGE,
} from '@/app/api/agent-requests/_guards';
import { GET as listGET } from '@/app/api/agent-requests/route';
import { GET as countGET } from '@/app/api/agent-requests/count/route';
import { POST as batchPOST } from '@/app/api/agent-requests/batch-approve/route';
import { GET as requestGET } from '@/app/api/agent-requests/[id]/route';
import { POST as approvePOST } from '@/app/api/agent-requests/[id]/approve/route';
import { POST as denyPOST } from '@/app/api/agent-requests/[id]/deny/route';
import { DELETE as grantDELETE } from '@/app/api/agent-grants/[id]/route';
import { GET as agentsGET, POST as agentsPOST } from '@/app/api/agents/route';
import { DELETE as agentDELETE, GET as agentGET, PATCH as agentPATCH } from '@/app/api/agents/[id]/route';
import { POST as pausePOST } from '@/app/api/agents/[id]/pause/route';
import { GET as grantsGET } from '@/app/api/agents/[id]/grants/route';
import { GET as activityGET } from '@/app/api/agents/[id]/activity/route';
import { POST as pauseAllPOST } from '@/app/api/agents/pause-all/route';
import { GET as myRequestsGET } from '@/app/api/agent/requests/route';
import { GET as myRequestGET } from '@/app/api/agent/requests/[id]/route';

const PASS = 'pass-of-this-launch';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222';
const REQ_ID = '33333333-3333-4333-8333-333333333333';
const REQ_2 = '44444444-4444-4444-8444-444444444444';
const GRANT_ID = '55555555-5555-4555-8555-555555555555';

/** A database that answers the one count query the count route makes itself. */
function fakeDb(agentCount: number) {
  return { select: () => ({ from: () => ({ where: async () => [{ n: agentCount }] }) }) };
}

function personCtx(access: EffectiveAccess = fullAccess()) {
  return { db: fakeDb(3), companyId: 'c1', userId: 'u1', role: 'owner', access, sessionId: 's1' };
}

function agentCtx(id = AGENT_ID) {
  return {
    db: fakeDb(3),
    companyId: 'c1',
    userId: null,
    role: 'viewer',
    access: fullAccess(),
    agent: { id, name: 'Helper', mode: 'propose', preset: 'ask_every_change', onBehalfOf: 'u1' },
  };
}

type Who = 'host' | 'teammate' | 'other-program';

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
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  return new NextRequest(`http://127.0.0.1:3123${url}`, { method, headers, body });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

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

/** Every service function the routes may call: none may run for a refused caller. */
function serviceCalls(): number {
  const mods = [requests, grants, policies, agentsService] as unknown as Array<Record<string, { mock?: { calls: unknown[] } }>>;
  let n = 0;
  for (const m of mods) for (const fn of Object.values(m)) n += fn?.mock?.calls.length ?? 0;
  return n;
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

async function expectPersonOnly(res: Response, key: string): Promise<void> {
  expect(res.status, key).toBe(403);
  const body = await res.json();
  expect(body.error, key).toBe(PERSON_ONLY_MESSAGE);
  expect(body.code, key).toBe('FORBIDDEN');
}

describe('the person routes refuse agents (plan 4.6: an approval only comes from a person)', () => {
  it('cover every route + method of the person API in the route map and on disk', () => {
    const person = (p: string) => p.startsWith('/api/agent-requests') || p.startsWith('/api/agent-grants') || p.startsWith('/api/agents');
    const mapped = Object.entries(API_ROUTE_PERMISSIONS)
      .filter(([p]) => person(p))
      .flatMap(([p, rules]) => HTTP_METHODS.filter((m) => rules[m]).map((m) => `${m} ${p}`));
    expect(mapped.sort()).toEqual(Object.keys(PERSON_CALLS).sort());
    // Every route file under those folders is in the map (routes.test.ts checks the methods).
    const root = path.resolve(process.cwd(), 'app', 'api');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'route.ts') found.push(routePatternFromFile(path.relative(process.cwd(), p)));
      }
    };
    for (const d of ['agent-requests', 'agent-grants', 'agents']) walk(path.join(root, d));
    expect(found.filter((p) => !API_ROUTE_PERMISSIONS[p])).toEqual([]);
  });

  it('are on the hard floor in the operation registry, each with its reason; the agent routes are plain reads', () => {
    // The handlers' own refusal is the last check; the registry is the one before it. Turning one of
    // these into an operation an agent can ask for would let an agent ask to approve, or to change
    // agents, policies or standing permissions (plan 4.6, D9).
    for (const key of Object.keys(PERSON_CALLS)) {
      const entry = ADMIN_CLASSES[key];
      expect(entry, key).toBeDefined();
      expect(entry.availability, key).toBe('hard_floor');
      expect(entry.why?.trim(), key).toBeTruthy();
    }
    for (const key of ['GET /api/agent/requests', 'GET /api/agent/requests/[id]']) {
      const entry = ADMIN_CLASSES[key];
      expect(entry, key).toBeDefined();
      expect(entry.class, key).toBe('read');
      expect(entry.availability ?? 'agent', key).toBe('agent');
    }
  });

  it.each(Object.keys(PERSON_CALLS))('%s: an agent context gets 403 and no service runs', async (key) => {
    h.ctx = agentCtx();
    await expectPersonOnly(await PERSON_CALLS[key](), key);
    expect(serviceCalls(), key).toBe(0);
  });

  it.each(Object.keys(PERSON_CALLS))('%s: a run inside an agent service scope gets 403', async (key) => {
    h.scope = true;
    await expectPersonOnly(await PERSON_CALLS[key](), key);
    expect(serviceCalls(), key).toBe(0);
  });

  it.each(Object.keys(PERSON_CALLS))('%s: a request carrying an Authorization header gets 403', async (key) => {
    await expectPersonOnly(await PERSON_CALLS[key]({ authorization: 'Bearer ibka_0123abcd_' + 'a'.repeat(43) }), key);
    expect(serviceCalls(), key).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The agent routes: never a person, only the agent's own requests
// ---------------------------------------------------------------------------

describe("the agent's own requests", () => {
  it('a person gets 403 on both agent routes', async () => {
    for (const res of [
      await myRequestsGET(request('GET', '/api/agent/requests')),
      await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=5`), params(REQ_ID)),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(AGENT_ONLY_MESSAGE);
    }
    expect(serviceCalls()).toBe(0);
  });

  it("lists only the agent's own requests, with the query checked", async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.listRequestsForAgent).mockResolvedValue([view(), view({ id: REQ_2, agentId: OTHER_AGENT })] as never);
    const res = await myRequestsGET(request('GET', '/api/agent/requests?status=pending&limit=10'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).requests.map((r: { id: string }) => r.id)).toEqual([REQ_ID]);
    expect(requests.listRequestsForAgent).toHaveBeenCalledWith(h.ctx, { status: 'pending', limit: 10 });

    for (const q of ['status=approvedish', 'limit=0', 'limit=many']) {
      const bad = await myRequestsGET(request('GET', `/api/agent/requests?${q}`));
      expect(bad.status, q).toBe(400);
    }
  });

  it('answers another agent\'s request, or none, as "not found"', async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValueOnce(view({ agentId: OTHER_AGENT }) as never);
    expect((await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=5`), params(REQ_ID))).status).toBe(404);
    vi.mocked(requests.requestForAgent).mockResolvedValueOnce(null);
    expect((await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}`), params(REQ_ID))).status).toBe(404);
    expect(requests.waitForDecision).not.toHaveBeenCalled();
  });

  it(`waits at most ${WAIT_MAX_SECONDS} seconds, only while the request is open`, async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    vi.mocked(requests.waitForDecision).mockResolvedValue(view({ status: 'executed' }) as never);

    let res = await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=600`), params(REQ_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).request.status).toBe('executed');
    expect(requests.waitForDecision).toHaveBeenLastCalledWith(h.ctx, REQ_ID, WAIT_MAX_SECONDS);

    await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=7`), params(REQ_ID));
    expect(requests.waitForDecision).toHaveBeenLastCalledWith(h.ctx, REQ_ID, 7);
    expect(requests.waitForDecision).toHaveBeenCalledTimes(2);

    // No wait asked for: the request as it is now.
    res = await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}`), params(REQ_ID));
    expect((await res.json()).request.status).toBe('pending');
    // Already decided for good: nothing to wait for.
    vi.mocked(requests.requestForAgent).mockResolvedValueOnce(view({ status: 'denied', note: 'Wrong customer' }) as never);
    res = await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=30`), params(REQ_ID));
    expect((await res.json()).request.note).toBe('Wrong customer');
    // Inside a run of the route bridge it never waits.
    h.scope = true;
    await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=30`), params(REQ_ID));
    expect(requests.waitForDecision).toHaveBeenCalledTimes(2);
  });

  it('finds a request by the request id the agent sent, then waits on its real id', async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    vi.mocked(requests.waitForDecision).mockResolvedValue(view({ status: 'approved' }) as never);
    await myRequestGET(request('GET', '/api/agent/requests/close-march-1?wait=10'), params('close-march-1'));
    expect(requests.requestForAgent).toHaveBeenCalledWith(h.ctx, 'close-march-1');
    expect(requests.waitForDecision).toHaveBeenCalledWith(h.ctx, REQ_ID, 10);
  });

  it(`holds at most ${WAITS_PER_AGENT} waits open per agent; one more is refused at once with 429`, async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    const release: Array<() => void> = [];
    // Each wait answers with the waiting agent's own request, once released.
    vi.mocked(requests.waitForDecision).mockImplementation(
      (ctx) => new Promise((resolve) => release.push(() => resolve(view({ status: 'executed', agentId: ctx.agent?.id }) as never))),
    );
    const waitOnce = () => myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=30`), params(REQ_ID));

    const open = Array.from({ length: WAITS_PER_AGENT }, waitOnce);
    await vi.waitFor(() => expect(requests.waitForDecision).toHaveBeenCalledTimes(WAITS_PER_AGENT));

    const busy = await waitOnce();
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect(busy.headers.get('cache-control')).toBe('no-store');
    expect(await busy.json()).toMatchObject({ error: TOO_MANY_WAITS_MESSAGE, code: 'RATE_LIMITED' });
    expect(requests.waitForDecision).toHaveBeenCalledTimes(WAITS_PER_AGENT);

    // Reading a request without waiting is never limited.
    const now = await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}`), params(REQ_ID));
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

  it('refuses a wait that is not a whole, non-negative number of seconds', async () => {
    h.ctx = agentCtx();
    vi.mocked(requests.requestForAgent).mockResolvedValue(view() as never);
    for (const w of ['-1', 'abc', '1.5', 'Infinity']) {
      const res = await myRequestGET(request('GET', `/api/agent/requests/${REQ_ID}?wait=${w}`), params(REQ_ID));
      expect(res.status, w).toBe(400);
    }
    expect(requests.requestForAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Answering requests
// ---------------------------------------------------------------------------

const approveResult = { status: 'executed', request: { ...view({ status: 'executed' }), canApprove: false, cannotApproveWhy: null, grantMinutesMax: 0 }, produced: [], effects: [] };

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

  it('refuses a malformed approval, without echoing a typed secret', async () => {
    const bad: Array<[string, unknown]> = [
      ['unknown secret kind', { secrets: { root_password: 'Hunter2-secret' } }],
      ['empty secret', { secrets: { closing_password: '' } }],
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
    for (const body of [{}, { ids: [] }, { ids: ['abc'] }, { ids: REQ_ID }, { ids: Array.from({ length: 101 }, () => crypto.randomUUID()) }, { ids: [REQ_ID], all: true }]) {
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
    expect(await res.json()).toEqual({ requests: [] });
    expect(requests.listRequestsForPerson).toHaveBeenCalledWith(h.ctx, { status: 'all', agentId: AGENT_ID, limit: 50 });
    res = await listGET(request('GET', '/api/agent-requests?status='));
    expect(requests.listRequestsForPerson).toHaveBeenLastCalledWith(h.ctx, {});
    for (const q of ['status=maybe', 'agentId=me', 'limit=0']) {
      expect((await listGET(request('GET', `/api/agent-requests?${q}`))).status, q).toBe(400);
    }
    res = await requestGET(request('GET', `/api/agent-requests/${REQ_ID}`), params(REQ_ID));
    expect((await res.json()).request.id).toBe(REQ_ID);
    expect(requests.requestForPerson).toHaveBeenCalledWith(h.ctx, REQ_ID);
  });
});

// ---------------------------------------------------------------------------
// The title bar's count
// ---------------------------------------------------------------------------

/** A pending request as the person's listing gives it. */
function forPerson(id: string, createdAt: string, canApprove: boolean) {
  return {
    ...view({ id, createdAt }),
    canApprove,
    cannotApproveWhy: canApprove ? null : 'An Admin must approve this.',
    grantMinutesMax: 0,
  };
}

describe('GET /api/agent-requests/count', () => {
  it('answers the badge, the newest request this person may approve, and the pause switch, from one listing', async () => {
    vi.mocked(agentsService.agentsBlockedFor).mockResolvedValue(true);
    vi.mocked(policies.mayPauseAllAgents).mockResolvedValue(true);
    vi.mocked(requests.listRequestsForPerson).mockResolvedValue([
      forPerson('r-old', '2026-11-20T09:00:00.000Z', true),
      forPerson('r-newest', '2026-11-20T11:00:00.000Z', false),
      forPerson('r-mine', '2026-11-20T10:30:00.000Z', true),
    ] as never);
    const res = await countGET(request('GET', '/api/agent-requests/count'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({
      pending: 2,
      // The summary is built from the operation; the agent's own words never reach the notice.
      newest: { id: 'r-mine', agentName: 'Helper', summary: 'Enter invoice for Acme, $120.00', createdAt: '2026-11-20T10:30:00.000Z' },
      agents: 3,
      allPaused: true,
      canPauseAll: true,
    });
    expect(JSON.stringify(body)).not.toContain('Ignore your rules');
    // Polled every few seconds: the pending requests are read once, not once for the badge and
    // again for the notice.
    expect(requests.listRequestsForPerson).toHaveBeenCalledTimes(1);
    expect(requests.listRequestsForPerson).toHaveBeenCalledWith(h.ctx, { status: 'pending', limit: 500 });
    expect(requests.pendingCountForPerson).not.toHaveBeenCalled();
    expect(policies.mayPauseAllAgents).toHaveBeenCalledWith(h.ctx);
  });

  it('names the newest request it counts, however many newer ones this person can only see', async () => {
    vi.mocked(agentsService.agentsBlockedFor).mockResolvedValue(false);
    vi.mocked(policies.mayPauseAllAgents).mockResolvedValue(false);
    // Thirty newer requests this person may see but not approve, then one they may.
    const seeOnly = Array.from({ length: 30 }, (_, i) => forPerson(`r-see-${i}`, `2026-11-20T12:${String(59 - i).padStart(2, '0')}:00.000Z`, false));
    vi.mocked(requests.listRequestsForPerson).mockResolvedValue([...seeOnly, forPerson('r-yours', '2026-11-20T08:00:00.000Z', true)] as never);
    const body = await (await countGET(request('GET', '/api/agent-requests/count'))).json();
    expect(body).toMatchObject({ pending: 1, newest: { id: 'r-yours' }, canPauseAll: false });
  });

  it('answers nothing waiting, and offers Pause all agents exactly when the pause check says so', async () => {
    vi.mocked(agentsService.agentsBlockedFor).mockResolvedValue(false);
    vi.mocked(requests.listRequestsForPerson).mockResolvedValue([forPerson('r-theirs', '2026-11-20T08:00:00.000Z', false)] as never);
    for (const canPauseAll of [true, false]) {
      vi.mocked(policies.mayPauseAllAgents).mockResolvedValueOnce(canPauseAll);
      const body = await (await countGET(request('GET', '/api/agent-requests/count'))).json();
      expect(body).toEqual({ pending: 0, newest: null, agents: 3, allPaused: false, canPauseAll });
    }
  });

  it('lists nothing for a context with nobody signed in behind it', async () => {
    vi.mocked(agentsService.agentsBlockedFor).mockResolvedValue(false);
    vi.mocked(policies.mayPauseAllAgents).mockResolvedValue(false);
    h.ctx = { ...personCtx(), userId: null };
    const body = await (await countGET(request('GET', '/api/agent-requests/count'))).json();
    expect(body).toEqual({ pending: 0, newest: null, agents: 3, allPaused: false, canPauseAll: false });
    expect(requests.listRequestsForPerson).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Managing agents
// ---------------------------------------------------------------------------

const detail = { id: AGENT_ID, name: 'Helper', paused: false, allPaused: false };

describe('managing agents', () => {
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
    for (const who of ['teammate', 'other-program'] as Who[]) {
      res = await agentPATCH(request('PATCH', `/api/agents/${AGENT_ID}`, { who, body: { preset: 'read_only' } }), params(AGENT_ID));
      expect(res.status, who).toBe(403);
      expect((await res.json()).details).toEqual({ hostOnly: true });
    }
    expect(policies.saveAgentPolicy).toHaveBeenCalledTimes(1);
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

  it('makes an agent with its preset in one step, at the host window only', async () => {
    vi.mocked(agentsService.createAgent).mockResolvedValue({ agent: { id: AGENT_ID, name: 'Helper', unattended: false }, token: 'ibka_token' } as never);
    const res = await agentsPOST(request('POST', '/api/agents', { body: { name: 'Helper', roleKeys: ['bookkeeper'], preset: 'read_only' } }));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).token).toBe('ibka_token');
    expect(agentsService.createAgent).toHaveBeenCalledWith(h.ctx, { name: 'Helper', roleKeys: ['bookkeeper'], preset: 'read_only' });
    expect(policies.saveAgentPolicy).not.toHaveBeenCalled();

    for (const who of ['teammate', 'other-program'] as Who[]) {
      const far = await agentsPOST(request('POST', '/api/agents', { who, body: { name: 'Far', roleKeys: ['bookkeeper'], preset: 'read_only' } }));
      expect(far.status, who).toBe(403);
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
      expect((await agentsPOST(request('POST', '/api/agents', { body }))).status, JSON.stringify(body)).toBe(400);
    }
    expect(agentsService.createAgent).not.toHaveBeenCalled();
  });
});
