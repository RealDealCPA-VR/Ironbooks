/**
 * Agent access at the edge (middleware.ts, lib/net/agentToken.ts, lib/permissions/agentAccess.ts):
 * what a request with an Authorization header may even attempt, before any token is looked at.
 *
 *  - no pages, and nothing but GET / HEAD on the API at the edge (the way in then refuses HEAD);
 *  - people's requests (no Authorization header) pass exactly as before;
 *  - the token parser accepts only a well-formed agent token;
 *  - what an agent's own request reaches (agentRouteAllowed), as the rules are now: the one door
 *    (POST /api/agent/actions), the agent's own reads, and GETs the registry classes as plain reads
 *    open to agents, GET only (HEAD is refused). Without the registry's lookup only the door and the
 *    agent's own reads pass;
 *  - the agent's ceiling keeps the roles' Admin, areas and flags (D1, plan 5.3), while the access its
 *    own request works with drops Users & Roles, File Utilities, the flags and Admin.
 * lib/permissions/agentAccess.test.ts holds the full rule; this file checks the edge's side of it.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';
import {
  AGENT_ACTION_ROUTE,
  AGENT_DOOR_ONLY_AREAS,
  AGENT_MODES,
  AGENT_OWN_ROUTES,
  agentDirectAccess,
  agentMayPropose,
  agentMayWrite,
  agentRouteAllowed,
  clampForAgent,
  type AgentRouteLookup,
} from '@/lib/permissions/agentAccess';
import { fullAccess } from '@/lib/permissions/model';
import { operationForPath } from '@/lib/agent/operations/registry';
import { AGENT_TOKEN_RE, bearerAgentToken, hasAuthorization, tokenFileTag } from './agentToken';

const ID = '11111111-2222-4333-8444-555555555555';
/** A concrete path for a route pattern ("/api/invoices/[id]" -> "/api/invoices/1111…"). */
const concrete = (pattern: string) => pattern.replace(/\[\.\.\.[^\]]+\]/g, 'a/b').replace(/\[[^\]]+\]/g, ID);
/**
 * The lookup the way in hands over: the registry's operation for GET on the path. A copy, so this
 * file need not load the way in; lib/agentContext.test.ts checks that agentRequestAllowed and
 * agentRouteAllowed with this same lookup agree on every route.
 */
const registry: AgentRouteLookup = (p) => operationForPath('GET', p)?.operation ?? null;

const TOKEN = `ibka_0123abcd_${'A'.repeat(43)}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };

function send(method: string, pathname: string, headers: Record<string, string> = {}, cookies = '') {
  return middleware(new NextRequest(`http://localhost:45123${pathname}`, { method, headers: { host: 'localhost:45123', ...(cookies ? { cookie: cookies } : {}), ...headers } }));
}
/** True when middleware let the request continue to the route (stamped), not refused or redirected. */
function continued(res: Response) {
  return res.status === 200 && res.headers.get('x-middleware-next') === '1';
}

describe('middleware and the Authorization header', () => {
  it('lets an agent GET the API, stamped with the real path and method', () => {
    const res = send('GET', '/api/accounts', { ...AUTH, [ROUTE_PATH_HEADER]: '/api/users', [ROUTE_METHOD_HEADER]: 'GET' });
    expect(continued(res)).toBe(true);
    // The stamp is middleware's own: a path the caller claimed is overwritten.
    expect(res.headers.get(`x-middleware-request-${ROUTE_PATH_HEADER}`)).toBe('/api/accounts');
    expect(res.headers.get(`x-middleware-request-${ROUTE_METHOD_HEADER}`)).toBe('GET');
    // The edge lets HEAD by, stamped as HEAD; the way in refuses it (below), never the edge's word.
    const head = send('HEAD', '/api/accounts', AUTH);
    expect(continued(head)).toBe(true);
    expect(head.headers.get(`x-middleware-request-${ROUTE_METHOD_HEADER}`)).toBe('HEAD');
    expect(agentRouteAllowed('/api/accounts', 'HEAD', registry)).toBe(false);
  });

  it('refuses every other method on the API, for any Authorization header', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const headers of [AUTH, { authorization: 'Basic b3duZXI6eA==' }, { Authorization: 'Bearer junk' }]) {
        const res = send(method, '/api/accounts', headers);
        expect(res.status, `${method} ${JSON.stringify(headers)}`).toBe(403);
        expect((await res.json()).error).toBe('This is not available to agents.');
      }
    }
    // The one exception: a POST to the action route. Nothing else on that route, and no look-alike.
    expect(continued(send('POST', AGENT_ACTION_ROUTE, AUTH))).toBe(true);
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect(send(method, AGENT_ACTION_ROUTE, AUTH).status, method).toBe(403);
    for (const p of ['/api/agent/actions/', '/api/agent/actions/x', '/api/agent/Actions', '/api/agent/actionsx', '/api/agents']) {
      expect(send('POST', p, AUTH).status, p).toBe(403);
    }
    // Sign-in, unlock and reset take no Authorization header at all.
    for (const p of ['/api/auth/login', '/api/unlock', '/api/auth/request-reset', '/api/portal/login']) {
      expect(send('POST', p, AUTH).status, p).toBe(403);
    }
  });

  it('refuses pages, also with a full set of cookies', () => {
    const cookies = 'bka_unlock=x; bka_session=x; bka_launch=x';
    for (const p of ['/', '/dashboard', '/users', '/reports', '/login', '/unlock']) {
      expect(send('GET', p, AUTH, cookies).status, p).toBe(403);
    }
  });

  it('changes nothing for people', () => {
    expect(continued(send('GET', '/api/accounts'))).toBe(true);
    expect(continued(send('POST', '/api/accounts'))).toBe(true);
    expect(continued(send('POST', '/api/auth/login'))).toBe(true);
    expect(continued(send('GET', '/dashboard', {}, 'bka_unlock=x; bka_session=x'))).toBe(true);
    // No cookies: the usual redirect to /unlock, not a refusal.
    expect(send('GET', '/dashboard').status).toBe(307);
  });
});

describe('the token parser', () => {
  const H = (v?: string) => new Headers(v === undefined ? {} : { authorization: v });

  it('accepts a well-formed agent token and nothing else', () => {
    expect(TOKEN).toMatch(AGENT_TOKEN_RE);
    expect(bearerAgentToken(H(`Bearer ${TOKEN}`))).toBe(TOKEN);
    expect(bearerAgentToken(H(`bearer   ${TOKEN} `))).toBe(TOKEN);
    expect(tokenFileTag(TOKEN)).toBe('0123abcd');
    for (const bad of [
      undefined,
      '',
      TOKEN, // no scheme
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ibka_0123ABCD_${'A'.repeat(43)}`, // the tag is lowercase hex
      `Bearer ibka_0123abcd_${'A'.repeat(42)}!`,
      `Bearer ${TOKEN} extra`,
      'Bearer ',
    ]) {
      expect(bearerAgentToken(H(bad)), String(bad)).toBeNull();
    }
  });

  it('sees any Authorization header, whatever is in it', () => {
    expect(hasAuthorization(H())).toBe(false);
    expect(hasAuthorization(H('   '))).toBe(false);
    expect(hasAuthorization(H('Basic x'))).toBe(true);
    expect(hasAuthorization(H('junk'))).toBe(true);
    expect(hasAuthorization(new Headers({ AUTHORIZATION: 'x' }))).toBe(true);
  });
});

describe('what an agent may reach', () => {
  it("its own reads, GET only: HEAD is refused (it runs the GET handler and no agent needs it)", () => {
    expect(AGENT_OWN_ROUTES.length).toBeGreaterThan(0);
    for (const p of AGENT_OWN_ROUTES) {
      const path = concrete(p);
      expect(agentRouteAllowed(path, 'GET'), p).toBe(true);
      expect(agentRouteAllowed(path, 'get'), p).toBe(true);
      // The same with the registry's lookup: an own read never needs it.
      expect(agentRouteAllowed(path, 'GET', registry), p).toBe(true);
      for (const m of ['HEAD', 'head', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '']) {
        expect(agentRouteAllowed(path, m), `${m} ${p}`).toBe(false);
        expect(agentRouteAllowed(path, m, registry), `${m} ${p} (registry)`).toBe(false);
      }
      // Every own route exists in the map with a GET rule that is not public or self.
      const rule = API_ROUTE_PERMISSIONS[p]?.GET;
      expect(rule, p).toBeDefined();
      expect(rule, p).not.toBe('public');
      expect(rule, p).not.toBe('self');
    }
  });

  it('without the registry, only the door and its own reads: everything else is closed', () => {
    expect(agentRouteAllowed(AGENT_ACTION_ROUTE, 'POST')).toBe(true);
    for (const m of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) expect(agentRouteAllowed(AGENT_ACTION_ROUTE, m), m).toBe(false);
    const open = new Set<string>([...AGENT_OWN_ROUTES, AGENT_ACTION_ROUTE]);
    const others = Object.keys(API_ROUTE_PERMISSIONS).filter((p) => !open.has(p));
    expect(others.length).toBeGreaterThan(400);
    for (const p of others) {
      expect(agentRouteAllowed(concrete(p), 'GET'), p).toBe(false);
      expect(agentRouteAllowed(concrete(p), 'POST'), p).toBe(false);
    }
    for (const p of [null, undefined, '', '/', '/dashboard', '/api', '/apix/accounts', '/api/accounts/../users', '/api/accounts/x/y/z']) {
      expect(agentRouteAllowed(p, 'GET'), String(p)).toBe(false);
      expect(agentRouteAllowed(p, 'GET', registry), `${String(p)} (registry)`).toBe(false);
    }
    expect(agentRouteAllowed('/api/accounts', null)).toBe(false);
    expect(agentRouteAllowed('/api/accounts', null, registry)).toBe(false);
  });

  it('with the registry, a GET it classes as a plain read open to agents; HEAD and every change still refused', () => {
    // Reads a bookkeeper needs every day.
    for (const p of ['/api/accounts', '/api/customers', `/api/invoices/${ID}`, '/api/reports/std/profit-loss']) {
      expect(agentRouteAllowed(p, 'GET', registry), p).toBe(true);
      expect(agentRouteAllowed(p, 'HEAD', registry), `HEAD ${p}`).toBe(false);
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(agentRouteAllowed(p, m, registry), `${m} ${p}`).toBe(false);
    }
    // Not a plain read, or not for agents: through the door, or not at all.
    for (const p of ['/api/backup', '/api/network-policy', '/api/reports/1099-xml', `/api/attachments/${ID}`, '/api/auth/me', '/api/agents', '/api/agent-requests']) {
      expect(agentRouteAllowed(p, 'GET', registry), p).toBe(false);
    }
  });

  it('nothing of Users & Roles or File Utilities, even with the registry', () => {
    expect(AGENT_DOOR_ONLY_AREAS).toEqual(['users', 'file_utilities']);
    for (const p of AGENT_OWN_ROUTES) {
      const rule = API_ROUTE_PERMISSIONS[p].GET;
      if (rule && typeof rule === 'object') expect(AGENT_DOOR_ONLY_AREAS, p).not.toContain(rule.area);
    }
    for (const [pattern, rules] of Object.entries(API_ROUTE_PERMISSIONS)) {
      const rule = rules.GET;
      if (!rule || typeof rule !== 'object' || !AGENT_DOOR_ONLY_AREAS.includes(rule.area)) continue;
      expect(agentRouteAllowed(concrete(pattern), 'GET', registry), pattern).toBe(false);
    }
  });

  it("the ceiling keeps the roles' Admin, areas and flags; the agent's own request gets none of them", () => {
    // The ceiling (D1, plan 5.3): the door asks within it, so it is the roles' access as it is.
    const ceiling = clampForAgent(fullAccess());
    expect(ceiling.isAdmin).toBe(true);
    expect(ceiling.roleKeys).toEqual(['admin']);
    for (const area of AGENT_DOOR_ONLY_AREAS) expect(ceiling.permissions[area].length, area).toBeGreaterThan(0);
    expect(ceiling.flags).toEqual(fullAccess().flags);
    // Admin only with the Admin role itself.
    expect(clampForAgent({ ...fullAccess(), roleKeys: ['bookkeeper'] }).isAdmin).toBe(false);
    // The access of the agent's own request: no Admin, no door-only areas, no flags.
    const direct = agentDirectAccess(fullAccess());
    expect(direct.isAdmin).toBe(false);
    for (const area of AGENT_DOOR_ONLY_AREAS) expect(direct.permissions[area], area).toEqual([]);
    expect(Object.values(direct.flags).some(Boolean)).toBe(false);
    expect(direct.permissions.banking.length).toBeGreaterThan(0);
    // The original is not changed.
    expect(fullAccess().isAdmin).toBe(true);
    // Only Post enters changes itself; Propose asks; Read only neither.
    expect(AGENT_MODES.map((m) => [m, agentMayWrite(m), agentMayPropose(m)])).toEqual([['read_only', false, false], ['propose', false, true], ['post', true, true]]);
  });
});
