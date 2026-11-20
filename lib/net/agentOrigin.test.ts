/**
 * Agent access at the edge (middleware.ts, lib/net/agentToken.ts, lib/permissions/agentAccess.ts):
 * what a request with an Authorization header may even attempt, before any token is looked at.
 *
 *  - no pages, and nothing but GET / HEAD on the API;
 *  - people's requests (no Authorization header) pass exactly as before;
 *  - the token parser accepts only a well-formed agent token;
 *  - the agent route list is closed: GET only, listed patterns only, never a page.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';
import { AGENT_DENIED_AREAS, AGENT_READ_ROUTES, agentMayWrite, agentRouteAllowed, clampForAgent, AGENT_MODES } from '@/lib/permissions/agentAccess';
import { fullAccess } from '@/lib/permissions/model';
import { AGENT_TOKEN_RE, bearerAgentToken, hasAuthorization, tokenFileTag } from './agentToken';

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
    expect(continued(send('HEAD', '/api/accounts', AUTH))).toBe(true);
  });

  it('refuses every other method on the API, for any Authorization header', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const headers of [AUTH, { authorization: 'Basic b3duZXI6eA==' }, { Authorization: 'Bearer junk' }]) {
        const res = send(method, '/api/accounts', headers);
        expect(res.status, `${method} ${JSON.stringify(headers)}`).toBe(403);
        expect((await res.json()).error).toBe('This is not available to agents.');
      }
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
  it('only reads on the listed routes', () => {
    for (const p of AGENT_READ_ROUTES) {
      const concrete = p.replace(/\[[^\]]+\]/g, '11111111-2222-4333-8444-555555555555');
      expect(agentRouteAllowed(concrete, 'GET'), p).toBe(true);
      expect(agentRouteAllowed(concrete, 'get'), p).toBe(true);
      expect(agentRouteAllowed(concrete, 'HEAD'), p).toBe(true);
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '']) expect(agentRouteAllowed(concrete, m), `${m} ${p}`).toBe(false);
      // Every listed route exists in the map with a GET rule that is not public or self.
      const rule = API_ROUTE_PERMISSIONS[p]?.GET;
      expect(rule, p).toBeDefined();
      expect(rule, p).not.toBe('public');
      expect(rule, p).not.toBe('self');
    }
  });

  it('nothing else: the list is closed', () => {
    const allowed = new Set(AGENT_READ_ROUTES);
    const others = Object.keys(API_ROUTE_PERMISSIONS).filter((p) => !allowed.has(p));
    expect(others.length).toBeGreaterThan(400);
    for (const p of others) {
      const concrete = p.replace(/\[\.\.\.[^\]]+\]/g, 'a/b').replace(/\[[^\]]+\]/g, 'x1');
      expect(agentRouteAllowed(concrete, 'GET'), p).toBe(false);
    }
    for (const p of [null, undefined, '', '/', '/dashboard', '/api', '/apix/accounts', '/api/accounts/../users', '/api/accounts/x/y/z']) {
      expect(agentRouteAllowed(p, 'GET'), String(p)).toBe(false);
    }
    expect(agentRouteAllowed('/api/accounts', null)).toBe(false);
  });

  it('no route on the list belongs to Users & Roles or File Utilities', () => {
    for (const p of AGENT_READ_ROUTES) {
      const rule = API_ROUTE_PERMISSIONS[p].GET;
      if (rule && typeof rule === 'object') expect(AGENT_DENIED_AREAS, p).not.toContain(rule.area);
    }
  });

  it('an Admin-wide access is cut down for an agent, and no mode writes yet', () => {
    const access = clampForAgent(fullAccess());
    expect(access.isAdmin).toBe(false);
    expect(access.roleKeys).toEqual([]);
    for (const area of AGENT_DENIED_AREAS) expect(access.permissions[area]).toEqual([]);
    expect(Object.values(access.flags).some(Boolean)).toBe(false);
    expect(access.permissions.banking.length).toBeGreaterThan(0);
    // The original is not changed.
    expect(fullAccess().isAdmin).toBe(true);
    for (const mode of AGENT_MODES) expect(agentMayWrite(mode)).toBe(false);
  });
});
