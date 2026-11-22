/**
 * Agent full access: the service-context scope (lib/serviceScope.ts runWithServiceContext,
 * requestHeaders, inServiceScope, outsideServiceScope, re-exported by lib/context.ts; plan §5.2
 * item 1 and §11.3).
 *
 * The real getServerContext / getSessionGate run here, on a real company file, with next/headers
 * standing in for a request the way lib/agentContext.test.ts does. The stand-in counts its reads,
 * and which of them happened inside a scope, so "never touches cookies, the session or
 * next/headers" is proved, not assumed.
 *
 * What is proved:
 *  - inside a scope, the context is exactly the one given, and the request is never read;
 *  - a scope opens only for a whole agent context (access, role, agent), a known method, a path
 *    middleware could have stamped (no query, no "." / ".." / empty parts, no backslash), and
 *    headers from the short list: nothing that carries trust;
 *  - the context must stay as it was given: a role or access cleared, a right added inside the
 *    access, the access swapped, is refused on the next read of the scope, and the route map is
 *    checked against a frozen copy of the access taken when the scope opened;
 *  - inside a scope the route map, the feature switches and the Accountant's Copy gate are checked
 *    on the scope's own path and method, against the agent's access, and a scope whose checks
 *    would read another request's path is refused;
 *  - nothing a request carries (headers, cookies) opens a scope or reaches a scoped context, and
 *    neither module exports the scope store (code inside the process can look it up through its
 *    registered symbol, by design; a request cannot); a real request's forged origin label is
 *    dropped, and could only lower its own trust;
 *  - several scopes running at the same time each see only their own context, headers, origin and
 *    route stamps, and a person's request running alongside them still gets the person's own;
 *  - the request helpers (lib/net/requestInfo.ts getRequestOrigin, lib/permissions/enforce.ts
 *    currentRequestInfo) see the scope's request, never the one the bridge runs in;
 *  - the scope is gone once its work settles (resolved or thrown), and work it left running is
 *    refused rather than taken for the request it ran in, and no longer reads the closing-date
 *    password; outsideServiceScope starts work that does not carry it;
 *  - a scope cannot be opened inside another;
 *  - a second copy of the modules (Next can load one twice) sees the same scope, and the store
 *    cannot be swapped out;
 *  - requestHeaders() gives the synthetic set: stamped path and method, origin "agent", and an
 *    x-closing-password only when one was given;
 *  - a closing-date password the bridge already checked (closingPasswordCheckedInScope) is
 *    recognised only inside an open, unchanged scope opened as checked, and only for the password
 *    its own headers carry; nothing a request carries makes it so;
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
import { accountantCopies, companies, users } from '@/lib/db/schema';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import * as contextModule from '@/lib/context';
import * as serviceScopeModule from '@/lib/serviceScope';
import { currentRequestInfo } from '@/lib/permissions/enforce';
import {
  CLOSING_PASSWORD_HEADER,
  COMPANY_COOKIE,
  SERVICE_ORIGIN_HEADER,
  SERVICE_SCOPE_CHANGED_MESSAGE,
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
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER, apiRuleFor } from '@/lib/permissions/routes';
import { fullAccess, withoutAreas } from '@/lib/permissions/model';
import { PERMISSION_DENIED_PREFIX } from '@/lib/services/access';
import { LAUNCH_PASS_ENV, LAUNCH_PASS_HEADER } from '@/lib/net/launchPass';
import { PROXY_SECRET_HEADER } from '@/lib/net/loopbackHost';
import { REMOTE_ADDR_HEADER, UNVERIFIED_LOCAL_ADDR, getRequestOrigin, originFromHeaders } from '@/lib/net/requestInfo';
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

  it("an Accountant's Copy refuses a save it cannot send back, in the scope company", async () => {
    const copyCo = (await createCompany(db, { name: 'Accountant Copy Co', ownerId })).id;
    await db.insert(accountantCopies).values({
      companyId: copyCo,
      side: 'accountant',
      status: 'open',
      dividingDate: '2026-12-31',
      fileToken: 'context-scope-copy',
    });
    // The request around it is a save the copy would carry back: it must not count.
    request('POST', '/api/estimates', { user: ownerId });
    resetReads();
    const expire = { path: '/api/estimates/expire', method: 'POST' };
    await runWithServiceContext(agentCtx(copyCo), expire, async () => {
      const err = await getServerContext().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('FORBIDDEN');
      expect((err as ServiceError).details).toMatchObject({ accountantCopy: true });
    });
    // What the copy carries back goes through, and reads stay open.
    await runWithServiceContext(agentCtx(copyCo), OPTS, async () => {
      expect((await getServerContext()).companyId).toBe(copyCo);
    });
    await runWithServiceContext(agentCtx(copyCo), { path: '/api/accounts', method: 'GET' }, async () => {
      expect((await getServerContext()).companyId).toBe(copyCo);
    });
    // A company that is not in a copy keeps the route.
    await runWithServiceContext(ctxB, expire, async () => {
      expect(await getServerContext()).toBe(ctxB);
    });
    expectNoReads();
  });

  it('is refused when the route checks would read another request than the scope', async () => {
    // A copy of lib/context.ts whose route checks read the request the bridge runs in (as they did
    // through next/headers before lib/serviceScope.ts): the agent must not be judged on the
    // person's route, which here would let a save through for an agent without Customers, and
    // answer the gate on an area route because the person's route is a 'self' one.
    vi.resetModules();
    vi.doMock('@/lib/permissions/enforce', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/lib/permissions/enforce')>();
      const { headers } = await import('next/headers');
      const currentRequestInfo = async () => {
        const hh = await headers();
        return { path: hh.get(ROUTE_PATH_HEADER), method: (hh.get(ROUTE_METHOD_HEADER) || 'GET').toUpperCase() };
      };
      return {
        ...real,
        currentRequestInfo,
        enforceRequestPermission: async (access: Parameters<typeof real.authorizeRequest>[1]) =>
          real.authorizeRequest(await currentRequestInfo(), access),
        enforceSelfRoute: async () => {
          const { path, method } = await currentRequestInfo();
          const rule = path ? apiRuleFor(path, method) : null;
          if (rule !== 'self' && rule !== 'public') throw new Error(`${method} ${path} is not a self route.`);
        },
      };
    });
    try {
      const copy = await import('@/lib/context');
      request('GET', '/api/accounts', { user: ownerId });
      const narrow = agentCtx(ctxA.companyId, { access: withoutAreas(fullAccess(), ['customers']) });
      const err = await runWithServiceContext(narrow, OPTS, () =>
        copy.getServerContext().then(
          () => null,
          (e: unknown) => e,
        ),
      );
      // Another copy of the modules, so another ServiceError class: compare code and message.
      expect(err).toMatchObject({
        code: 'FORBIDDEN',
        message: 'This agent request could not be checked against the route it stands for, so it was refused.',
      });
      const gate: SessionGate = { db, userId: null };
      request('POST', '/api/auth/2fa/setup', { user: ownerId });
      const gateErr = await runWithServiceContext(ctxA, { ...OPTS, gate }, () =>
        copy.getSessionGate().then(
          () => null,
          (e: unknown) => e,
        ),
      );
      expect(gateErr).toMatchObject({ code: 'FORBIDDEN', message: (err as Error).message });
    } finally {
      vi.doUnmock('@/lib/permissions/enforce');
      vi.resetModules();
    }
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

  it('needs a path middleware could have stamped: no "." or ".." parts, no empty parts, no backslash, no encoded slash', async () => {
    const fn = vi.fn(async () => 'ran');
    // The route map skips empty parts and takes ".." for an id; a parsed URL never holds these.
    const dots = ['/api/customers/../users', '/api/./customers', '/api/customers/%2e%2E/users', '/api/customers/.%2e', '/api/customers/%2E'];
    const empty = ['/api//customers', '/api/customers/', '/'];
    const raw = ['/api/customers\\..\\users', '/api/customers/a b', '/api/customers/a\u0000', '/api/customers/a\u007f'];
    // Whatever decodes the path once would read these as two parts: another route than the handler's.
    const encoded = ['/api/customers/a%2Fb', '/api/customers/a%2fb', '/api/customers/a%5Cb', '/api/customers/a%5c..%5cusers', '/api/customers%2F..%2Fusers'];
    for (const p of dots) await expect(runWithServiceContext(ctxA, { path: p, method: 'GET' }, fn), p).rejects.toThrow('without "." or ".." parts');
    for (const p of empty) await expect(runWithServiceContext(ctxA, { path: p, method: 'GET' }, fn), p).rejects.toThrow('without empty parts');
    for (const p of raw) await expect(runWithServiceContext(ctxA, { path: p, method: 'GET' }, fn), p).rejects.toThrow('without backslashes');
    for (const p of encoded) await expect(runWithServiceContext(ctxA, { path: p, method: 'GET' }, fn), p).rejects.toThrow('without encoded slashes or backslashes');
    expect(fn).not.toHaveBeenCalled();
    expect(inServiceScope()).toBe(false);
    // Other encoded characters stay inside their one part, as in a real request's pathname: an
    // encoded "%" ("%25", which is not a slash) and a space are let through and judged as that route.
    const stamped = await runWithServiceContext(ctxA, { path: '/api/customers/a%252Fb%20c', method: 'GET' }, async () => {
      expect((await getServerContext()).companyId).toBe(ctxA.companyId);
      return (await currentRequestInfo())?.path;
    });
    expect(stamped).toBe('/api/customers/a%252Fb%20c');
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

describe('the context must stay as it was given', () => {
  /** A context of its own (never the shared ctxA), with an access narrower than full. */
  const own = () => agentCtx(ctxA.companyId, { access: withoutAreas(fullAccess(), ['customers']) });
  const refusedAsChanged = (p: Promise<unknown>) => refusedWith(p, SERVICE_SCOPE_CHANGED_MESSAGE);

  it('a role or access cleared after the scope opened is refused, never read as trusted', async () => {
    for (const clear of [
      (c: ServiceContext) => void (c.role = undefined),
      (c: ServiceContext) => void (c.access = undefined),
      (c: ServiceContext) => void (c.agent = undefined),
    ]) {
      const ctx = own();
      await runWithServiceContext(ctx, { path: '/api/accounts', method: 'GET' }, async () => {
        expect(await getServerContext()).toBe(ctx);
        clear(ctx);
        await refusedAsChanged(getServerContext());
        await refusedAsChanged(getPageContext('/invoices'));
        expect(() => serviceScopeModule.currentServiceScope()).toThrow(SERVICE_SCOPE_CHANGED_MESSAGE);
      });
    }
  });

  it('a right added inside the access, or the access swapped for an equal one, is refused', async () => {
    const widen = own();
    await runWithServiceContext(widen, { path: '/api/accounts', method: 'GET' }, async () => {
      expect(await getServerContext()).toBe(widen);
      widen.access!.permissions.customers = ['view', 'create', 'modify', 'delete', 'print'];
      await refusedAsChanged(getServerContext());
    });
    for (const change of [
      (c: ServiceContext) => void (c.access!.isAdmin = !c.access!.isAdmin),
      (c: ServiceContext) => void (c.access!.flags.fullAccountNumbers = !c.access!.flags.fullAccountNumbers),
      (c: ServiceContext) => void c.access!.roleKeys.push('another-role'),
    ]) {
      const ctx = own();
      await runWithServiceContext(ctx, { path: '/api/accounts', method: 'GET' }, async () => {
        change(ctx);
        await refusedAsChanged(getServerContext());
      });
    }
    const swapped = own();
    await runWithServiceContext(swapped, { path: '/api/accounts', method: 'GET' }, async () => {
      swapped.access = structuredClone(swapped.access);
      await refusedAsChanged(getServerContext());
    });
  });

  it('who it runs as, its company, database, closing-date override and approval are sealed too', async () => {
    const changes: Array<(c: ServiceContext) => void> = [
      (c) => void (c.role = 'owner'),
      (c) => void (c.companyId = companyId),
      (c) => void (c.userId = ownerId),
      (c) => void (c.closingDateOverride = true),
      (c) => void (c.agent!.mode = 'post'),
      (c) => void (c.agent!.id = 'another-agent'),
      (c) => void (c.approval = { approvedBy: ownerId, requestId: null, grantId: null }),
      (c) => void (c.db = {} as DB),
    ];
    for (const change of changes) {
      const ctx = agentCtx(ctxA.companyId, { role: 'viewer', agent: { id: 'sealed-agent', name: 'Sealed', mode: 'read_only' } });
      await runWithServiceContext(ctx, { path: '/api/accounts', method: 'GET' }, async () => {
        change(ctx);
        await refusedAsChanged(getServerContext());
      });
    }
    // The gate refuses as well.
    const gated = own();
    await runWithServiceContext(gated, { path: '/api/auth/2fa/setup', method: 'POST', gate: { db, userId: null } }, async () => {
      gated.role = undefined;
      await refusedAsChanged(getSessionGate());
    });
  });

  it('the route map is checked against a frozen copy of the access taken when the scope opened', async () => {
    const ctx = own();
    await runWithServiceContext(ctx, OPTS, async () => {
      const scope = serviceScopeModule.currentServiceScope()!;
      expect(scope.access).not.toBe(ctx.access);
      expect(scope.access).toEqual(ctx.access);
      expect(Object.isFrozen(scope.access)).toBe(true);
      expect(Object.isFrozen(scope.access.permissions)).toBe(true);
      expect(Object.isFrozen(scope.access.permissions.customers)).toBe(true);
      expect(Reflect.set(scope.access.permissions, 'customers', ['view', 'create', 'modify', 'delete', 'print'])).toBe(false);
      // Customers is still taken away: the save is refused on the route map, as at the start.
      const err = await getServerContext().then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as ServiceError).message.startsWith(PERMISSION_DENIED_PREFIX)).toBe(true);
    });
  });

  it('a context left exactly as given keeps working, read after read', async () => {
    const ctx = own();
    await runWithServiceContext(ctx, { path: '/api/accounts', method: 'GET' }, async () => {
      for (let i = 0; i < 3; i++) {
        await sleep(1);
        expect(await getServerContext()).toBe(ctx);
      }
    });
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

  it('neither module exports the scope store', async () => {
    // What is proved here is "not exported, and not reachable from a request". Code inside the
    // process can still look the store up through its registered symbol (Symbol.for), by design:
    // that is how every copy of lib/serviceScope.ts shares it (see 'one store for the whole process').
    for (const [file, mod] of [
      ['lib/context', contextModule],
      ['lib/serviceScope', serviceScopeModule],
    ] as const) {
      for (const [name, value] of Object.entries(mod)) {
        expect(value instanceof AsyncLocalStorage, `${file} exports ${name}`).toBe(false);
      }
    }
    // What lib/context.ts reads of an open scope cannot be changed by whoever reads it.
    await runWithServiceContext(ctxA, OPTS, async () => {
      const scope = serviceScopeModule.currentServiceScope();
      expect(scope?.ctx).toBe(ctxA);
      expect(Object.isFrozen(scope)).toBe(true);
      expect(Reflect.set(scope as object, 'path', '/api/users')).toBe(false);
      expect(serviceScopeModule.currentServiceScope()?.path).toBe(OPTS.path);
    });
    expect(serviceScopeModule.currentServiceScope()).toBeUndefined();
  });

  it("a forged origin label only ever lowers the forger's own trust", async () => {
    // Read straight from a request's headers (no middleware, no requestHeaders()), it counts as an
    // agent's, never the app's.
    expect(originFromHeaders(new Headers({ [SERVICE_ORIGIN_HEADER]: 'agent' }))).toMatchObject({
      remote: true,
      addr: UNVERIFIED_LOCAL_ADDR,
    });
    // Through requestHeaders() it is dropped, so the request is judged as it would be without it.
    request('GET', '/api/accounts', { headers: { [SERVICE_ORIGIN_HEADER]: 'agent' } });
    expect(await getRequestOrigin()).toMatchObject({ remote: false, addr: 'local' });
  });
});

describe('several scopes at the same time', () => {
  it("each sees only its own context, headers, origin and stamps, and a person's request alongside sees only theirs", async () => {
    // The person's request is the app's own window, with this run's launch pass.
    process.env[LAUNCH_PASS_ENV] = 'launch-pass-of-this-run';
    request('GET', '/api/accounts', { user: ownerId, headers: { [LAUNCH_PASS_HEADER]: 'launch-pass-of-this-run' } });
    resetReads();
    type Seen = [string, string | null, string | null, string | null, string | null, boolean];
    const run = (ctx: ServiceContext, routePath: string, method: string, delays: number[]) =>
      runWithServiceContext(ctx, { path: routePath, method, headers: { accept: `application/x-${ctx.companyId}` } }, async () => {
        const seen: Seen[] = [];
        for (const d of delays) {
          await sleep(d);
          const c = await getServerContext();
          const hh = await requestHeaders();
          const info = await currentRequestInfo();
          const origin = await getRequestOrigin();
          seen.push([c.companyId, hh.get('accept'), hh.get(ROUTE_PATH_HEADER), info?.path ?? null, info?.method ?? null, origin.remote]);
        }
        return seen;
      });
    // The person's request, in its own async chain, between the scopes' steps.
    const person = async (delays: number[]) => {
      const seen: Array<[string | null, string, string | null, string | null, string | null, boolean, boolean]> = [];
      for (const d of delays) {
        await sleep(d);
        const c = await getServerContext();
        const hh = await requestHeaders();
        const info = await currentRequestInfo();
        const origin = await getRequestOrigin();
        seen.push([c.userId, c.companyId, hh.get(ROUTE_PATH_HEADER), hh.get(SERVICE_ORIGIN_HEADER), info?.path ?? null, origin.remote, inServiceScope()]);
      }
      return seen;
    };
    // A third agent works in the person's own company, on a save.
    const ctxC = agentCtx(companyId);
    try {
      const all = Promise.all([
        run(ctxA, '/api/accounts', 'GET', [5, 1, 7, 0, 3]),
        run(ctxB, '/api/customers', 'GET', [1, 6, 0, 4, 2]),
        run(ctxC, '/api/estimates', 'POST', [3, 0, 4, 2, 6]),
        person([2, 3, 1, 5, 0]),
      ]);
      // The caller, meanwhile, is not in any.
      expect(inServiceScope()).toBe(false);
      const [a, b, c, p] = await all;
      const own = (ctx: ServiceContext, route: string, method: string) =>
        Array(5).fill([ctx.companyId, `application/x-${ctx.companyId}`, route, route, method, true]);
      expect(a).toEqual(own(ctxA, '/api/accounts', 'GET'));
      expect(b).toEqual(own(ctxB, '/api/customers', 'GET'));
      expect(c).toEqual(own(ctxC, '/api/estimates', 'POST'));
      expect(p).toEqual(Array(5).fill([ownerId, companyId, '/api/accounts', null, '/api/accounts', false, false]));
    } finally {
      delete process.env[LAUNCH_PASS_ENV];
    }
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
    let during!: string | null;
    let duringArchive!: Array<string | null>;
    const archive = ['x-ironbooks-login', 'x-ironbooks-password', 'x-ironbooks-recovery-key'];
    const opened = {
      ...OPTS,
      headers: {
        [CLOSING_PASSWORD_HEADER]: 'typed by the approver',
        'x-ironbooks-login': 'dana@books.test',
        'x-ironbooks-password': 'c2VjcmV0LXR5cGVk',
        'x-ironbooks-recovery-key': 'RK-1234-5678',
        accept: 'application/json',
      },
    };
    await runWithServiceContext(ctxA, opened, async () => {
      during = (await requestHeaders()).get(CLOSING_PASSWORD_HEADER);
      const now = await requestHeaders();
      duringArchive = archive.map((n) => now.get(n));
      late = new Promise((resolve) => {
        setTimeout(async () => {
          const hh = await requestHeaders();
          resolve({
            inScope: inServiceScope(),
            ctx: await getServerContext().then(() => 'let through', (e: Error) => e.message),
            page: await getPageContext('/invoices').then(() => 'let through', (e: Error) => e.message),
            gate: await getSessionGate().then(() => 'let through', (e: Error) => e.message),
            // Still the agent's request (origin and stamps), so still judged as the agent...
            origin: hh.get(SERVICE_ORIGIN_HEADER),
            path: hh.get(ROUTE_PATH_HEADER),
            method: hh.get(ROUTE_METHOD_HEADER),
            info: await currentRequestInfo(),
            remote: (await getRequestOrigin()).remote,
            // ...but every secret the approver typed was for the request, which is over.
            password: hh.get(CLOSING_PASSWORD_HEADER),
            archive: archive.map((n) => hh.get(n)),
            accept: hh.get('accept'),
          });
        }, 20);
      });
    });
    expect(during).toBe('typed by the approver');
    expect(duringArchive).toEqual(['dana@books.test', 'c2VjcmV0LXR5cGVk', 'RK-1234-5678']);
    expect(await late).toEqual({
      inScope: true,
      ctx: SERVICE_SCOPE_ENDED_MESSAGE,
      page: SERVICE_SCOPE_ENDED_MESSAGE,
      gate: SERVICE_SCOPE_ENDED_MESSAGE,
      origin: 'agent',
      path: OPTS.path,
      method: OPTS.method,
      info: { path: OPTS.path, method: OPTS.method },
      remote: true,
      password: null,
      archive: [null, null, null],
      accept: 'application/json',
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
  it('a second copy of the modules (Next can load one twice) sees the same scope, both ways', async () => {
    vi.resetModules();
    const copy = await import('@/lib/context');
    const scopeCopy = await import('@/lib/serviceScope');
    const enforceCopy = await import('@/lib/permissions/enforce');
    const originCopy = await import('@/lib/net/requestInfo');
    expect(copy.runWithServiceContext).not.toBe(runWithServiceContext);
    expect(scopeCopy.requestHeaders).not.toBe(requestHeaders);
    expect(enforceCopy.currentRequestInfo).not.toBe(currentRequestInfo);
    // The request the bridge runs in is a signed-in person's, on another route.
    request('GET', '/api/accounts', { user: ownerId });
    resetReads();
    await runWithServiceContext(ctxA, OPTS, async () => {
      expect(copy.inServiceScope()).toBe(true);
      expect(scopeCopy.inServiceScope()).toBe(true);
      expect(scopeCopy.currentServiceScope()?.ctx).toBe(ctxA);
      expect(await copy.getServerContext()).toBe(ctxA);
      expect((await copy.requestHeaders()).get(SERVICE_ORIGIN_HEADER)).toBe('agent');
      expect((await scopeCopy.requestHeaders()).get(ROUTE_PATH_HEADER)).toBe(OPTS.path);
      expect(await enforceCopy.currentRequestInfo()).toEqual({ path: OPTS.path, method: OPTS.method });
      expect((await originCopy.getRequestOrigin()).remote).toBe(true);
      await expect(copy.runWithServiceContext(ctxB, OPTS, async () => 'inner')).rejects.toThrow(
        'One agent request cannot run inside another.',
      );
      await expect(scopeCopy.runWithServiceContext(ctxB, OPTS, async () => 'inner')).rejects.toThrow(
        'One agent request cannot run inside another.',
      );
    });
    await copy.runWithServiceContext(ctxB, OPTS, async () => {
      expect(inServiceScope()).toBe(true);
      expect(await getServerContext()).toBe(ctxB);
    });
    await scopeCopy.runWithServiceContext(ctxB, { path: '/api/customers', method: 'GET' }, async () => {
      expect(await getServerContext()).toBe(ctxB);
      expect(await currentRequestInfo()).toEqual({ path: '/api/customers', method: 'GET' });
      expect(await copy.getServerContext()).toBe(ctxB);
    });
    expect(copy.inServiceScope()).toBe(false);
    expect(scopeCopy.inServiceScope()).toBe(false);
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

  it("carries a backup's or a copy's user name, password and recovery key when the bridge gives them, and only then", async () => {
    // The request around it is a person's carrying their own: none of it shows through.
    request('POST', '/api/backups/restore', {
      user: ownerId,
      headers: { 'x-ironbooks-login': 'person', 'x-ironbooks-password': 'cGVyc29u', 'x-ironbooks-recovery-key': 'RK-PERSON' },
    });
    resetReads();
    const names = ['x-ironbooks-login', 'x-ironbooks-password', 'x-ironbooks-recovery-key'];
    const read = async () => {
      const hh = await requestHeaders();
      return names.map((n) => hh.get(n));
    };
    expect(await runWithServiceContext(ctxA, { path: '/api/backups/restore', method: 'POST' }, read)).toEqual([null, null, null]);
    const given = { 'X-Ironbooks-Login': 'dana@books.test', 'x-ironbooks-password': 'ZGFuYS1wdw', 'x-ironbooks-recovery-key': 'RK-1111' };
    expect(await runWithServiceContext(ctxA, { path: '/api/backups/restore', method: 'POST', headers: given }, read)).toEqual([
      'dana@books.test',
      'ZGFuYS1wdw',
      'RK-1111',
    ]);
    expectNoReads();
  });

  it('the secrets a scope may carry are exactly the ones lib/agent/guards.ts applySecrets hands back', async () => {
    const { SECRET_HEADERS } = await import('@/lib/agent/guards');
    expect([...serviceScopeModule.SERVICE_SCOPE_SECRET_HEADERS].sort()).toEqual([...SECRET_HEADERS].sort());
    for (const name of serviceScopeModule.SERVICE_SCOPE_SECRET_HEADERS) expect(serviceScopeModule.SERVICE_SCOPE_HEADERS).toContain(name);
    expect(contextModule.SERVICE_SCOPE_SECRET_HEADERS).toBe(serviceScopeModule.SERVICE_SCOPE_SECRET_HEADERS);
  });
});

describe('the request helpers inside a scope', () => {
  it("origin and route stamps are the scope's own, never the request the bridge runs in", async () => {
    process.env[LAUNCH_PASS_ENV] = 'launch-pass-of-this-run';
    try {
      // The request around it is the app's own window: this run's launch pass, a signed-in person,
      // another route.
      request('GET', '/api/accounts', {
        user: ownerId,
        headers: { [LAUNCH_PASS_HEADER]: 'launch-pass-of-this-run', 'user-agent': 'Ironbooks window' },
      });
      expect(await getRequestOrigin()).toEqual({ remote: false, addr: 'local', https: false, userAgent: 'Ironbooks window' });
      expect(await currentRequestInfo()).toEqual({ path: '/api/accounts', method: 'GET' });
      resetReads();
      await runWithServiceContext(ctxA, { path: '/api/estimates', method: 'post' }, async () => {
        // An agent's trust, as at the door: never the app window's.
        expect(await getRequestOrigin()).toEqual({ remote: true, addr: UNVERIFIED_LOCAL_ADDR, https: false, userAgent: null });
        expect(await currentRequestInfo()).toEqual({ path: '/api/estimates', method: 'POST' });
      });
      expectNoReads();
    } finally {
      delete process.env[LAUNCH_PASS_ENV];
    }
  });

  it('the re-exports from lib/context are the very same as lib/serviceScope', () => {
    for (const name of [
      'CLOSING_PASSWORD_HEADER',
      'SERVICE_ORIGIN_AGENT',
      'SERVICE_ORIGIN_HEADER',
      'SERVICE_SCOPE_CHANGED_MESSAGE',
      'SERVICE_SCOPE_ENDED_MESSAGE',
      'SERVICE_SCOPE_HEADERS',
      'inServiceScope',
      'outsideServiceScope',
      'requestHeaders',
      'runWithServiceContext',
    ] as const) {
      expect(contextModule[name], name).toBe(serviceScopeModule[name]);
    }
    expect(CLOSING_PASSWORD_HEADER).toBe('x-closing-password');
    expect(serviceScopeModule.SERVICE_SCOPE_HEADERS).toContain(CLOSING_PASSWORD_HEADER);
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

describe('the closing-date password limiter (lib/closingPasswordLimiter.ts), shared by every way in', () => {
  const resetLimiter = () => {
    (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
  };
  beforeEach(resetLimiter);
  afterAll(resetLimiter);

  it("wrong guesses lock it; a locked one refuses before the password is looked at, also for the person's own x-closing-password", async () => {
    const { limitClosingPasswordGuess } = await import('@/lib/closingPasswordLimiter');
    const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const original = company.settings;
    const { hashPassword } = await import('@/lib/auth');
    await db
      .update(companies)
      .set({ settings: { ...((original ?? {}) as Record<string, unknown>), closingDatePasswordHash: await hashPassword('right-pw-9') } })
      .where(eq(companies.id, companyId));
    try {
      request('GET', '/api/accounts', { user: ownerId });
      const who = { companyId, userId: ownerId };
      const verify = vi.fn(async () => false);
      let lockedAt = -1;
      for (let i = 0; i < 10 && lockedAt < 0; i++) {
        try {
          expect(await limitClosingPasswordGuess(who, verify)).toBe(false);
        } catch (err) {
          lockedAt = i;
          // (A copy of the module: the "one store" test above reloads them, so compare by shape.)
          expect(err).toMatchObject({ name: expect.any(String), code: 'FORBIDDEN', details: { rateLimited: true } });
          expect((err as ServiceError).message).toMatch(/^Too many wrong closing-date passwords\. Try again in /);
        }
      }
      expect(lockedAt).toBeGreaterThan(1);
      expect(verify).toHaveBeenCalledTimes(lockedAt);
      // Locked: the right password is not even looked at, and the person's own save is refused too.
      const right = vi.fn(async () => true);
      await expect(limitClosingPasswordGuess(who, right)).rejects.toMatchObject({ details: { rateLimited: true } });
      expect(right).not.toHaveBeenCalled();
      request('GET', '/api/accounts', { user: ownerId, headers: { [CLOSING_PASSWORD_HEADER]: 'right-pw-9' } });
      await expect(getServerContext()).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rateLimited: true } });
      // Another person in the same company is not locked out by these guesses.
      expect(await limitClosingPasswordGuess({ companyId, userId: 'someone-else' }, async () => true)).toBe(true);
    } finally {
      await db.update(companies).set({ settings: original }).where(eq(companies.id, companyId));
    }
  });

  it("a right password goes through and the person's own save gets the override, as before", async () => {
    const { limitClosingPasswordGuess } = await import('@/lib/closingPasswordLimiter');
    request('GET', '/api/accounts', { user: ownerId });
    expect(await limitClosingPasswordGuess({ companyId, userId: ownerId }, async () => true)).toBe(true);
    request('GET', '/api/accounts', { user: ownerId, headers: { [CLOSING_PASSWORD_HEADER]: 'anything' } });
    expect((await getServerContext()).closingDateOverride).toBe(true);
  });
});

describe('a closing-date password the bridge already checked (closingPasswordCheckedInScope)', () => {
  const { closingPasswordCheckedInScope } = serviceScopeModule;
  const checked: ServiceScopeOptions = { ...OPTS, headers: { [CLOSING_PASSWORD_HEADER]: 'right-pw' }, closingPasswordChecked: true };

  it('is true only inside a scope opened as checked, and only for the very password its headers carry', async () => {
    const seen = await runWithServiceContext(ctxA, checked, async () => [
      closingPasswordCheckedInScope('right-pw'),
      closingPasswordCheckedInScope('right-pwX'),
      closingPasswordCheckedInScope('Right-pw'),
      closingPasswordCheckedInScope(''),
    ]);
    expect(seen).toEqual([true, false, false, false]);
    // A scope that carries the password but was not opened as checked: the route counts it as always.
    const unchecked = await runWithServiceContext(ctxA, { ...checked, closingPasswordChecked: false }, async () => closingPasswordCheckedInScope('right-pw'));
    expect(unchecked).toBe(false);
    // Checked, but with no password in its headers: nothing to match.
    const empty = await runWithServiceContext(ctxA, { ...OPTS, closingPasswordChecked: true }, async () => closingPasswordCheckedInScope('right-pw'));
    expect(empty).toBe(false);
    // Outside any scope (a person's own request): never.
    request('PATCH', '/api/company/closing-date', { user: ownerId, headers: { [CLOSING_PASSWORD_HEADER]: 'right-pw' } });
    expect(closingPasswordCheckedInScope('right-pw')).toBe(false);
  });

  it('is false for work the scope left running, and once its context changed', async () => {
    let late!: Promise<boolean>;
    await runWithServiceContext(ctxA, checked, async () => {
      late = new Promise((resolve) => setTimeout(() => resolve(closingPasswordCheckedInScope('right-pw')), 20));
    });
    expect(await late).toBe(false);
    const changing = agentCtx(ctxA.companyId);
    const afterChange = await runWithServiceContext(changing, checked, async () => {
      changing.role = 'admin';
      return closingPasswordCheckedInScope('right-pw');
    });
    expect(afterChange).toBe(false);
  });

  it('nothing a request carries makes it true: the option is the bridge\'s, never a header', async () => {
    request('PATCH', '/api/company/closing-date', {
      user: ownerId,
      headers: { [CLOSING_PASSWORD_HEADER]: 'right-pw', 'x-bka-closing-checked': '1', closingPasswordChecked: 'true' },
    });
    expect(closingPasswordCheckedInScope('right-pw')).toBe(false);
    await expect(
      runWithServiceContext(ctxA, { ...OPTS, headers: { closingPasswordChecked: 'true' } }, async () => closingPasswordCheckedInScope('right-pw')),
    ).rejects.toThrow(/cannot carry the header/);
  });
});
