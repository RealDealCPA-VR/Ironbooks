/**
 * Agent full access: the service-context scope (lib/context.ts runWithServiceContext,
 * requestHeaders, inServiceScope, outsideServiceScope; plan §5.2 item 1).
 *
 * The real getServerContext / getSessionGate run here, on a real company file, with next/headers
 * standing in for a request the way lib/agentContext.test.ts does. The stand-in counts its reads,
 * and which of them happened inside a scope, so "never touches cookies, the session or
 * next/headers" is proved, not assumed.
 *
 * What is proved:
 *  - inside a scope, the context is exactly the one given, and the request is never read;
 *  - a scope opens only for a whole agent context (access, role, agent), a known method, a path
 *    without a query, and headers from the short list: nothing that carries trust;
 *  - inside a scope the route map, the feature switches and the Accountant's Copy gate are checked
 *    on the scope's own path and method, against the agent's access;
 *  - nothing a request carries (headers, cookies) opens a scope or reaches a scoped context, and
 *    the module hands out no way to reach the scope store; a real request's forged origin label
 *    is dropped;
 *  - two scopes running at the same time each see only their own context and headers, and a
 *    person's request running alongside them still gets the person's context and real headers;
 *  - the scope is gone once its work settles (resolved or thrown), and work it left running is
 *    refused rather than taken for the request it ran in; outsideServiceScope starts work that
 *    does not carry it;
 *  - a scope cannot be opened inside another;
 *  - a second copy of the module (Next can load one twice) sees the same scope, and the store
 *    cannot be swapped out;
 *  - requestHeaders() gives the synthetic set: stamped path and method, origin "agent", and an
 *    x-closing-password only when one was given;
 *  - getSessionGate (a person's own account) refuses inside a scope unless given a gate value, and
 *    then answers only on a 'self' route;
 *  - sign-out refuses inside a scope and leaves the person's cookie alone;
 *  - people's requests behave as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  reads: { headers: 0, cookies: 0, scoped: 0 },
  /** Set to lib/context's inServiceScope once it is imported: counts reads made inside a scope. */
  inScope: (() => false) as () => boolean,
}));
vi.mock('next/headers', () => ({
  cookies: async () => {
    h.reads.cookies++;
    if (h.inScope()) h.reads.scoped++;
    return { get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) };
  },
  headers: async () => {
    h.reads.headers++;
    if (h.inScope()) h.reads.scoped++;
    return new Headers([...h.headers.entries()]);
  },
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-context-scope');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'context-scope-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;
delete process.env.BKA_COMPANY_FILE;
delete process.env.BKA_ALLOW_DEV_FALLBACK;
delete process.env.PORT;

import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import * as contextModule from '@/lib/context';
import {
  CLOSING_PASSWORD_HEADER,
  COMPANY_COOKIE,
  SERVICE_ORIGIN_HEADER,
  SERVICE_SCOPE_ENDED_MESSAGE,
  getPageContext,
  getServerContext,
  getSessionGate,
  inServiceScope,
  outsideServiceScope,
  requestHeaders,
  runWithServiceContext,
  type ServiceScopeOptions,
  type SessionGate,
} from '@/lib/context';
import { AGENT_NOT_AVAILABLE_MESSAGE } from '@/lib/agentContext';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { fullAccess, withoutAreas } from '@/lib/permissions/model';
import { PERMISSION_DENIED_PREFIX } from '@/lib/services/access';
import { LAUNCH_PASS_HEADER } from '@/lib/net/launchPass';
import { PROXY_SECRET_HEADER } from '@/lib/net/loopbackHost';
import { REMOTE_ADDR_HEADER } from '@/lib/net/requestInfo';
import { createCompany } from '@/lib/services/company';
import { resetAgentEndpointState } from '@/lib/agent/endpointFile';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { POST as logoutPOST } from '@/app/api/auth/logout/route';

h.inScope = inServiceScope;

let db: DB;
let ownerId: string;
let companyId: string;
let ctxA: ServiceContext;
let ctxB: ServiceContext;

const OPTS: ServiceScopeOptions = { path: '/api/estimates', method: 'POST' };

/** A request as middleware would hand it on: stamped path + method, plus headers and cookies. */
function request(
  method: string,
  routePath: string,
  opts: { user?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {},
) {
  h.headers.clear();
  h.cookies.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.headers.set('host', 'localhost:45123');
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.headers.set(k.toLowerCase(), v);
  for (const [k, v] of Object.entries(opts.cookies ?? {})) h.cookies.set(k, v);
  if (opts.user) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(opts.user, 'user'));
    h.cookies.set(COMPANY_COOKIE, companyId);
  }
}

function resetReads() {
  h.reads.headers = 0;
  h.reads.cookies = 0;
  h.reads.scoped = 0;
}

function expectNoReads() {
  expect(h.reads).toEqual({ headers: 0, cookies: 0, scoped: 0 });
}

async function refusedWith(p: Promise<unknown>, message: string): Promise<ServiceError> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, 'the call was let through').toBeInstanceOf(ServiceError);
  const se = err as ServiceError;
  expect(se.code).toBe('FORBIDDEN');
  expect(se.message).toBe(message);
  return se;
}

/** What the bridge would build from an agent's clamped access: not the person, not their company. */
function agentCtx(company: string, over: Partial<ServiceContext> = {}): ServiceContext {
  return {
    db,
    companyId: company,
    userId: null,
    role: 'accountant',
    closingDateOverride: false,
    access: fullAccess(),
    agent: { id: `agent-of-${company}`, name: 'Bookkeeping agent', mode: 'post' },
    ...over,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetAgentEndpointState();
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'owner@scope.test', name: 'Sam Scope', passwordHash: 'x' }).returning();
  ownerId = owner.id;
  companyId = (await createCompany(db, { name: 'Scope Co', ownerId })).id;
  const companyA = (await createCompany(db, { name: 'Agent A Co', ownerId })).id;
  const companyB = (await createCompany(db, { name: 'Agent B Co', ownerId })).id;
  ctxA = agentCtx(companyA, { role: 'viewer' });
  ctxB = agentCtx(companyB, { closingDateOverride: true });
});

afterAll(async () => {
  resetAgentEndpointState();
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  resetReads();
});

describe('inside a scope', () => {
  it('returns exactly the given context and never reads the request', async () => {
    // The real request around it is a signed-in person, with an agent header and a closing-date
    // password on top: none of it may show through.
    request('GET', '/api/accounts', {
      user: ownerId,
      headers: { authorization: 'Bearer not-a-token', [CLOSING_PASSWORD_HEADER]: 'the person typed this' },
    });
    resetReads();
    const [a, b, answer] = await runWithServiceContext(ctxA, OPTS, async () => {
      expect(inServiceScope()).toBe(true);
      return [await getServerContext(), await getPageContext('/invoices'), 'done'] as const;
    });
    expect(a).toBe(ctxA);
    expect(b).toBe(ctxA);
    expect(answer).toBe('done');
    expectNoReads();
  });

  it('also when fn is not async', async () => {
    const got = await runWithServiceContext(ctxA, OPTS, () => 42);
    expect(got).toBe(42);
  });

  it("checks the route map on the scope's own path and method, against the agent's access", async () => {
    // A person who may do everything is signed in around it: their rights must not count.
    request('POST', '/api/estimates', { user: ownerId });
    resetReads();
    const narrow = agentCtx(ctxA.companyId, { access: withoutAreas(fullAccess(), ['customers']) });
    await runWithServiceContext(narrow, OPTS, async () => {
      const err = await getServerContext().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('FORBIDDEN');
      expect((err as ServiceError).message.startsWith(PERMISSION_DENIED_PREFIX)).toBe(true);
    });
    // A route the map does not know is refused, whatever the access.
    await runWithServiceContext(ctxA, { path: '/api/no-such-route', method: 'GET' }, async () => {
      await refusedWith(getServerContext(), 'No permission mapping exists for GET /api/no-such-route. Access denied.');
    });
    expectNoReads();
  });

  it('a save to a feature that is turned off is refused, in the scope company', async () => {
    const off = (await createCompany(db, { name: 'No Estimates Co', ownerId })).id;
    const [row] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, off));
    await db
      .update(companies)
      .set({ settings: { ...((row?.settings as Record<string, unknown>) ?? {}), estimatesEnabled: false } })
      .where(eq(companies.id, off));
    await runWithServiceContext(agentCtx(off), OPTS, async () => {
      const err = await getServerContext().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).details).toMatchObject({ featureOff: true });
    });
    // Reads stay open, as for a person.
    await runWithServiceContext(agentCtx(off), { path: '/api/estimates', method: 'GET' }, async () => {
      expect((await getServerContext()).companyId).toBe(off);
    });
    // The other companies keep their estimates.
    await runWithServiceContext(ctxB, OPTS, async () => {
      expect(await getServerContext()).toBe(ctxB);
    });
  });
});

describe('opening a scope', () => {
  it('needs a known method, an absolute path without a query and a company context', async () => {
    const fn = vi.fn(async () => 'ran');
    await expect(runWithServiceContext(ctxA, { path: '/api/x', method: 'TRACE' }, fn)).rejects.toThrow(/methods GET, POST/);
    await expect(runWithServiceContext(ctxA, { path: 'api/x', method: 'GET' }, fn)).rejects.toThrow(/starting with "\/"/);
    await expect(runWithServiceContext(ctxA, { path: '/api/accounts?all=1', method: 'GET' }, fn)).rejects.toThrow(/without a query/);
    await expect(runWithServiceContext({} as ServiceContext, OPTS, fn)).rejects.toThrow(/company context/);
    expect(fn).not.toHaveBeenCalled();
    expect(inServiceScope()).toBe(false);
  });

  it("needs the agent's access, role and the agent itself: never a context read as trusted", async () => {
    const fn = vi.fn(async () => 'ran');
    const noAccess: ServiceContext = { ...ctxA, access: undefined };
    const noRole: ServiceContext = { ...ctxA, role: undefined };
    const noAgent: ServiceContext = { ...ctxA, agent: undefined };
    await expect(runWithServiceContext(noAccess, OPTS, fn)).rejects.toThrow("needs the agent's own access and role");
    await expect(runWithServiceContext(noRole, OPTS, fn)).rejects.toThrow("needs the agent's own access and role");
    await expect(runWithServiceContext(noAgent, OPTS, fn)).rejects.toThrow('needs the agent it runs for');
    await expect(
      runWithServiceContext({ ...ctxA, agent: { id: '', name: 'x', mode: 'post' } }, OPTS, fn),
    ).rejects.toThrow('needs the agent it runs for');
    expect(fn).not.toHaveBeenCalled();
    expect(inServiceScope()).toBe(false);
  });

  it('refuses every header that is not on the short list, before the work runs', async () => {
    const fn = vi.fn(async () => 'ran');
    const carriesTrust = [
      'cookie',
      'Authorization',
      LAUNCH_PASS_HEADER,
      PROXY_SECRET_HEADER,
      REMOTE_ADDR_HEADER,
      'sec-bka-proxy',
      'host',
      'x-forwarded-proto',
      ROUTE_PATH_HEADER,
      ROUTE_METHOD_HEADER,
      SERVICE_ORIGIN_HEADER,
    ];
    for (const name of carriesTrust) {
      await expect(runWithServiceContext(ctxA, { ...OPTS, headers: { [name]: 'x' } }, fn)).rejects.toThrow(
        `An agent request cannot carry the header "${name}".`,
      );
    }
    await expect(
      runWithServiceContext(ctxA, { ...OPTS, headers: new Headers({ accept: 'x' }) as unknown as Record<string, string> }, fn),
    ).rejects.toThrow(/plain list of names and values/);
    expect(fn).not.toHaveBeenCalled();
    expect(inServiceScope()).toBe(false);
  });
});

describe('nothing a request carries opens a scope', () => {
  const FORGED = {
    [SERVICE_ORIGIN_HEADER]: 'agent',
    'x-bka-service-scope': '1',
    'x-bka-scope': 'open',
    'x-bka-internal': 'guess',
    [CLOSING_PASSWORD_HEADER]: 'guess',
  };
  const FORGED_COOKIES = { bka_scope: '1', bka_service_scope: 'agent', 'x-bka-origin': 'agent' };

  it('without a session: refused as today, after reading the real request', async () => {
    request('GET', '/api/accounts', { headers: FORGED, cookies: FORGED_COOKIES });
    expect(inServiceScope()).toBe(false);
    await refusedWith(getServerContext(), 'Authentication required.');
    expect(h.reads.headers).toBeGreaterThan(0);
    expect(h.reads.cookies).toBeGreaterThan(0);
    expect(h.reads.scoped).toBe(0);
    // requestHeaders() is the real request's, without the forged origin label: through it, that
    // label only ever comes from a scope. Everything else the request sent is still there.
    const real = await requestHeaders();
    expect(real.get(SERVICE_ORIGIN_HEADER)).toBeNull();
    expect(real.get('x-bka-service-scope')).toBe('1');
    expect(real.get(CLOSING_PASSWORD_HEADER)).toBe('guess');
    expect(real.get(ROUTE_PATH_HEADER)).toBe('/api/accounts');
    expect(inServiceScope()).toBe(false);
  });

  it("with a person's session: the person's own context, never a scoped one", async () => {
    request('GET', '/api/accounts', { user: ownerId, headers: FORGED, cookies: FORGED_COOKIES });
    const ctx = await getServerContext();
    expect(ctx).not.toBe(ctxA);
    expect(ctx.companyId).toBe(companyId);
    expect(ctx.userId).toBe(ownerId);
    expect(ctx.agent).toBeUndefined();
  });

  it("the gate reads the person's request, not a scope", async () => {
    request('POST', '/api/auth/2fa/setup', { headers: FORGED, cookies: FORGED_COOKIES });
    await expect(getSessionGate()).resolves.toMatchObject({ userId: null });
    request('POST', '/api/auth/2fa/setup', { user: ownerId, headers: FORGED });
    await expect(getSessionGate()).resolves.toMatchObject({ userId: ownerId });
  });

  it('the module hands out no way to reach the scope store', () => {
    for (const [name, value] of Object.entries(contextModule)) {
      expect(value instanceof AsyncLocalStorage, `lib/context exports ${name}`).toBe(false);
    }
  });
});

describe('two scopes at the same time', () => {
  it("each sees only its own context and headers, and a person's request alongside sees only theirs", async () => {
    request('GET', '/api/accounts', { user: ownerId });
    resetReads();
    const run = (ctx: ServiceContext, routePath: string, delays: number[]) =>
      runWithServiceContext(ctx, { path: routePath, method: 'GET', headers: { accept: `application/x-${ctx.companyId}` } }, async () => {
        const seen: Array<[string, string | null, string | null]> = [];
        for (const d of delays) {
          await sleep(d);
          const c = await getServerContext();
          const hh = await requestHeaders();
          seen.push([c.companyId, hh.get('accept'), hh.get(ROUTE_PATH_HEADER)]);
        }
        return seen;
      });
    // The person's request, in its own async chain, between the scopes' steps.
    const person = async (delays: number[]) => {
      const seen: Array<[string | null, string, string | null, string | null, boolean]> = [];
      for (const d of delays) {
        await sleep(d);
        const c = await getServerContext();
        const hh = await requestHeaders();
        seen.push([c.userId, c.companyId, hh.get(ROUTE_PATH_HEADER), hh.get(SERVICE_ORIGIN_HEADER), inServiceScope()]);
      }
      return seen;
    };
    const all = Promise.all([
      run(ctxA, '/api/accounts', [5, 1, 7, 0, 3]),
      run(ctxB, '/api/customers', [1, 6, 0, 4, 2]),
      person([2, 3, 1, 5, 0]),
    ]);
    // The caller, meanwhile, is not in either.
    expect(inServiceScope()).toBe(false);
    const [a, b, p] = await all;
    expect(a).toEqual(Array(5).fill([ctxA.companyId, `application/x-${ctxA.companyId}`, '/api/accounts']));
    expect(b).toEqual(Array(5).fill([ctxB.companyId, `application/x-${ctxB.companyId}`, '/api/customers']));
    expect(p).toEqual(Array(5).fill([ownerId, companyId, '/api/accounts', null, false]));
    // Only the person's chain read the request; the scopes never did.
    expect(h.reads.headers).toBeGreaterThan(0);
    expect(h.reads.cookies).toBeGreaterThan(0);
    expect(h.reads.scoped).toBe(0);
  });
});

describe('the scope ends when its work settles', () => {
  it('after fn resolves', async () => {
    await runWithServiceContext(ctxA, OPTS, async () => {
      await sleep(1);
      expect(inServiceScope()).toBe(true);
    });
    expect(inServiceScope()).toBe(false);
    request('GET', '/api/accounts');
    await refusedWith(getServerContext(), 'Authentication required.');
    expect(h.reads.headers).toBeGreaterThan(0);
  });

  it('after fn throws, also synchronously', async () => {
    const boom = new Error('the handler failed');
    await expect(
      runWithServiceContext(ctxA, OPTS, async () => {
        await sleep(1);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(inServiceScope()).toBe(false);
    await expect(
      runWithServiceContext(ctxA, OPTS, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(inServiceScope()).toBe(false);
    request('GET', '/api/accounts', { user: ownerId });
    expect((await getServerContext()).userId).toBe(ownerId);
  });

  it('work it left running is refused, never taken for the request it ran in', async () => {
    // The request the scope runs in is a signed-in person (as when a person approves).
    request('GET', '/api/accounts', { user: ownerId });
    resetReads();
    let late!: Promise<Record<string, unknown>>;
    await runWithServiceContext(ctxA, OPTS, async () => {
      late = new Promise((resolve) => {
        setTimeout(async () => {
          resolve({
            inScope: inServiceScope(),
            ctx: await getServerContext().then(() => 'let through', (e: Error) => e.message),
            page: await getPageContext('/invoices').then(() => 'let through', (e: Error) => e.message),
            gate: await getSessionGate().then(() => 'let through', (e: Error) => e.message),
            origin: (await requestHeaders()).get(SERVICE_ORIGIN_HEADER),
          });
        }, 20);
      });
    });
    expect(await late).toEqual({
      inScope: true,
      ctx: SERVICE_SCOPE_ENDED_MESSAGE,
      page: SERVICE_SCOPE_ENDED_MESSAGE,
      gate: SERVICE_SCOPE_ENDED_MESSAGE,
      origin: 'agent',
    });
    expectNoReads();
  });

  it('process-wide work started in outsideServiceScope does not carry the scope', async () => {
    let inside!: boolean;
    let tick!: Promise<boolean>;
    await runWithServiceContext(ctxA, OPTS, async () => {
      inside = outsideServiceScope(() => inServiceScope());
      // A scheduler's first tick, started by the first request that needs it.
      tick = outsideServiceScope(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(inServiceScope()), 10)));
      expect(inServiceScope()).toBe(true);
      expect(await getServerContext()).toBe(ctxA);
    });
    expect(inside).toBe(false);
    expect(await tick).toBe(false);
  });
});

describe('nesting', () => {
  it('is refused, the inner work never runs, and the outer scope is untouched', async () => {
    const inner = vi.fn(async () => 'inner');
    await runWithServiceContext(ctxA, OPTS, async () => {
      await expect(runWithServiceContext(ctxB, OPTS, inner)).rejects.toThrow('One agent request cannot run inside another.');
      expect(inner).not.toHaveBeenCalled();
      expect(await getServerContext()).toBe(ctxA);
    });
  });
});

describe('one store for the whole process', () => {
  it('a second copy of the module (Next can load one twice) sees the same scope, both ways', async () => {
    vi.resetModules();
    const copy = await import('@/lib/context');
    expect(copy.runWithServiceContext).not.toBe(runWithServiceContext);
    request('GET', '/api/accounts', { user: ownerId });
    resetReads();
    await runWithServiceContext(ctxA, OPTS, async () => {
      expect(copy.inServiceScope()).toBe(true);
      expect(await copy.getServerContext()).toBe(ctxA);
      expect((await copy.requestHeaders()).get(SERVICE_ORIGIN_HEADER)).toBe('agent');
      await expect(copy.runWithServiceContext(ctxB, OPTS, async () => 'inner')).rejects.toThrow(
        'One agent request cannot run inside another.',
      );
    });
    await copy.runWithServiceContext(ctxB, OPTS, async () => {
      expect(inServiceScope()).toBe(true);
      expect(await getServerContext()).toBe(ctxB);
    });
    expect(copy.inServiceScope()).toBe(false);
    expectNoReads();
  });

  it('the store cannot be replaced or removed', () => {
    const key = Symbol.for('ironbooks.agent.serviceScope');
    expect(Object.getOwnPropertyDescriptor(globalThis, key)).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: false,
    });
    expect(Reflect.set(globalThis, key, new AsyncLocalStorage())).toBe(false);
    expect(Reflect.defineProperty(globalThis, key, { value: new AsyncLocalStorage() })).toBe(false);
    expect(Reflect.deleteProperty(globalThis, key)).toBe(false);
  });
});

describe('requestHeaders()', () => {
  it('is the synthetic set in a scope: stamps, origin, no closing-date password unless given', async () => {
    request('POST', '/api/somewhere-else', {
      user: ownerId,
      headers: { [CLOSING_PASSWORD_HEADER]: 'the person typed this', authorization: 'Bearer x', [LAUNCH_PASS_HEADER]: 'pass' },
    });
    resetReads();
    await runWithServiceContext(ctxA, { path: '/api/company/closing-date', method: 'patch' }, async () => {
      const hh = await requestHeaders();
      expect([...hh.entries()]).toEqual(
        [
          [ROUTE_METHOD_HEADER, 'PATCH'],
          [ROUTE_PATH_HEADER, '/api/company/closing-date'],
          [SERVICE_ORIGIN_HEADER, 'agent'],
        ].sort(([x], [y]) => x.localeCompare(y)),
      );
      expect(hh.get(CLOSING_PASSWORD_HEADER)).toBeNull();
      expect(hh.get('cookie')).toBeNull();
      expect(hh.get(LAUNCH_PASS_HEADER)).toBeNull();
      // A handler changing its copy changes nothing for the next reader.
      hh.set(CLOSING_PASSWORD_HEADER, 'added by a handler');
      expect((await requestHeaders()).get(CLOSING_PASSWORD_HEADER)).toBeNull();
    });
    expectNoReads();
  });

  it('carries the closing-date password when the bridge gives one', async () => {
    await runWithServiceContext(
      ctxB,
      { path: '/api/journal-entries', method: 'POST', headers: { 'X-Closing-Password': 'typed by the approver' } },
      async () => {
        const hh = await requestHeaders();
        expect(hh.get(CLOSING_PASSWORD_HEADER)).toBe('typed by the approver');
        expect(hh.get(ROUTE_PATH_HEADER)).toBe('/api/journal-entries');
        expect(hh.get(ROUTE_METHOD_HEADER)).toBe('POST');
        expect(hh.get(SERVICE_ORIGIN_HEADER)).toBe('agent');
      },
    );
    expectNoReads();
  });

  it("is the request's own outside a scope", async () => {
    request('GET', '/api/accounts', { headers: { [CLOSING_PASSWORD_HEADER]: 'pw' } });
    const hh = await requestHeaders();
    expect(hh.get(CLOSING_PASSWORD_HEADER)).toBe('pw');
    expect(h.reads.headers).toBe(1);
  });
});

describe('getSessionGate in a scope', () => {
  it("refuses: it acts on the signed-in person's own account", async () => {
    request('POST', '/api/auth/2fa/setup', { user: ownerId });
    resetReads();
    await runWithServiceContext(ctxA, { path: '/api/auth/2fa/setup', method: 'POST' }, async () => {
      await refusedWith(getSessionGate(), AGENT_NOT_AVAILABLE_MESSAGE);
      await refusedWith(getSessionGate({ allowPasswordChangeRequired: true }), AGENT_NOT_AVAILABLE_MESSAGE);
    });
    expectNoReads();
  });

  it("answers the explicit gate value the scope was opened with, on a 'self' route only", async () => {
    const gate: SessionGate = { db, userId: null };
    request('POST', '/api/auth/2fa/setup', { user: ownerId });
    resetReads();
    await runWithServiceContext(ctxA, { path: '/api/auth/2fa/setup', method: 'POST', gate }, async () => {
      expect(await getSessionGate()).toBe(gate);
    });
    // A route mapped to an area must go through getServerContext, as for a person.
    await runWithServiceContext(ctxA, { ...OPTS, gate }, async () => {
      await refusedWith(getSessionGate(), 'POST /api/estimates must be authorized through getServerContext.');
    });
    await runWithServiceContext(ctxA, { path: '/api/no-such-route', method: 'POST', gate }, async () => {
      await refusedWith(getSessionGate(), 'No permission mapping exists for POST /api/no-such-route. Access denied.');
    });
    expectNoReads();
  });
});

describe('sign-out', () => {
  it("refuses in a scope and leaves the person's cookie alone", async () => {
    request('POST', '/api/auth/logout', { user: ownerId });
    resetReads();
    const res = await runWithServiceContext(ctxA, { path: '/api/auth/logout', method: 'POST' }, () => logoutPOST());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: AGENT_NOT_AVAILABLE_MESSAGE, code: 'FORBIDDEN' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expectNoReads();
  });

  it('works for a person as before', async () => {
    request('POST', '/api/auth/logout', { user: ownerId });
    const res = await logoutPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });
});

describe("people's requests behave as before", () => {
  it('the closing-date password is read from the request', async () => {
    request('GET', '/api/accounts', { user: ownerId });
    expect((await getServerContext()).closingDateOverride).toBe(false);
    // No closing-date password is set for this company, so any explicit attempt unlocks.
    request('GET', '/api/accounts', { user: ownerId, headers: { [CLOSING_PASSWORD_HEADER]: 'anything' } });
    expect((await getServerContext()).closingDateOverride).toBe(true);
  });

  it('a request with an Authorization header is still an agent, never the cookie it carries', async () => {
    request('GET', '/api/accounts', { user: ownerId, headers: { authorization: 'Bearer not-a-token' } });
    const err = await refusedWith(getServerContext(), 'Authentication required.');
    expect(err.details).toMatchObject({ agent: true });
    request('POST', '/api/auth/2fa/setup', { user: ownerId, headers: { authorization: 'Bearer not-a-token' } });
    await refusedWith(getSessionGate(), 'Authentication required.');
  });
});
