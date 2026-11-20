/**
 * The service scope (agent full access, AGENT_ACCESS.md; plan 5.2 item 1): how the bridge
 * (lib/agent/bridge.ts) runs a route handler for an agent in-process, with the agent's own context
 * and a synthetic request in place of the request the bridge happens to run in.
 *
 * A module of its own, apart from lib/context.ts, so that the helpers that decide on a request's
 * headers (lib/net/requestInfo.ts getRequestOrigin, lib/permissions/enforce.ts currentRequestInfo)
 * can read requestHeaders() without an import cycle through lib/context.ts, and therefore see the
 * synthetic set inside a scope instead of the request the bridge runs in, perhaps the approving
 * person's. lib/context.ts re-exports everything here that callers used to import from it;
 * getServerContext, getPageContext and getSessionGate read the open scope through
 * currentServiceScope().
 *
 * Nothing a request carries reaches the store: no header, cookie, query or body is read to decide
 * whether a scope is open or what is in it, and nothing here opens a scope except
 * runWithServiceContext, after checking the context and the request it was given. That is the
 * guarantee: no REQUEST can reach the store. Code running in this process can (by design): the
 * store lives on globalThis under a registered symbol so that every copy of this module shares it
 * (see serviceScopeStore), and code that looks it up there could open a scope of its own without
 * these checks. Neither this module nor lib/context.ts exports it.
 *
 * Kept free of database and service imports, so the request helpers above can depend on it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { headers } from 'next/headers';
import { HTTP_METHODS, ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER, type HttpMethod } from '@/lib/permissions/routes';
import type { EffectiveAccess } from '@/lib/permissions/model';
import { ServiceError } from '@/lib/services/errors';
import type { ServiceContext } from '@/lib/services/_base';
// A type only (erased when compiled): lib/context.ts imports this module, never the other way round.
import type { SessionGate } from '@/lib/context';

/** Header carrying the closing-date password for this request (QB Set Closing Date override). */
export const CLOSING_PASSWORD_HEADER = 'x-closing-password';

/**
 * Marks the synthetic header set of a service scope with where its request came from. A real
 * request that sends this header loses it in middleware.ts, and requestHeaders() drops it too (for
 * the times middleware did not run), so read through requestHeaders() it only ever comes from a
 * scope. Still a label, never proof: decisions ask inServiceScope(), which no request can change.
 * lib/net/requestInfo.ts gives a header set carrying it the trust of an agent, never the app's.
 */
export const SERVICE_ORIGIN_HEADER = 'x-bka-origin';
export const SERVICE_ORIGIN_AGENT = 'agent';

/** Refusal for work a scope left running after it ended (a timer, a promise nobody awaited). */
export const SERVICE_SCOPE_ENDED_MESSAGE = 'This agent request has already finished.';

/**
 * Refusal for a scope whose context was changed after it opened (who it runs as, its access, its
 * company or approval). Only a bug in this process can do that, never a request.
 */
export const SERVICE_SCOPE_CHANGED_MESSAGE =
  'This agent request changed while it was running, so it was stopped. Send the request again.';

/**
 * The only headers the bridge may add to a scope's synthetic set (lower case). Any other name is
 * refused before the work runs: a forwarded cookie, Authorization, launch pass, proxy secret,
 * remote address or Host would carry the trust of the request the bridge runs in (perhaps the
 * approving person's window) into the agent's work. x-expected-updated-at is
 * lib/services/concurrency.ts EXPECTED_VERSION_HEADER (record locking).
 */
export const SERVICE_SCOPE_HEADERS: readonly string[] = Object.freeze([
  CLOSING_PASSWORD_HEADER,
  'x-expected-updated-at',
  'content-type',
  'accept',
  'accept-language',
]);

/** The request a service scope stands for. The bridge (lib/agent/bridge.ts) fills it in. */
export interface ServiceScopeOptions {
  /**
   * The API path the handler is run for ("/api/estimates/123"), stamped like middleware does: the
   * path alone, without a query.
   */
  path: string;
  /** Its method, stamped like middleware does. */
  method: string;
  /**
   * Further headers the handler may read, only names in SERVICE_SCOPE_HEADERS. Nothing of the real
   * request is copied in, so an x-closing-password is here only when the bridge puts it here (an
   * approving person typed it).
   */
  headers?: Record<string, string>;
  /**
   * What getSessionGate answers inside the scope. Routes that use the gate act on the signed-in
   * PERSON (their own 2FA, password, company files), so without an explicit value the gate refuses.
   */
  gate?: SessionGate;
}

/** What lib/context.ts reads of the open scope (currentServiceScope). Frozen. */
export interface ServiceScope {
  /**
   * The context given to runWithServiceContext, the very object. currentServiceScope refuses the
   * scope once it no longer matches what it was when the scope opened (ScopeSeal).
   */
  readonly ctx: ServiceContext;
  /**
   * A frozen copy of ctx.access taken when the scope opened: the route map is checked against this,
   * so a change made to ctx.access in place afterwards cannot widen that check.
   */
  readonly access: EffectiveAccess;
  readonly gate: SessionGate | null;
  /** The stamped path and method (upper case) the scope stands for. */
  readonly path: string;
  readonly method: HttpMethod;
}

/**
 * What decides who a scope's work runs as, and on what, as it was when the scope opened.
 * lib/services/_base.ts reads a context without `access` or `role` as trusted with no limits, and
 * reads ctx.access, ctx.role, ctx.agent and ctx.approval on every call, so the check made when the
 * scope opened is only worth something while they stay as they were: currentServiceScope compares
 * them on every read.
 */
interface ScopeSeal {
  readonly db: unknown;
  /** The access object itself: replacing it, even with an equal one, counts as a change. */
  readonly accessRef: EffectiveAccess;
  /** contextFingerprint(ctx) when the scope opened: a change made in place shows here. */
  readonly fingerprint: string;
}

interface ScopeState {
  readonly scope: ServiceScope;
  readonly seal: ScopeSeal;
  /** The synthetic header set, lower-case names. Copied out fresh for every reader. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** The same set without the closing-date password: what work left running after the end reads. */
  readonly endedHeaders: ReadonlyArray<readonly [string, string]>;
  /** False once fn has settled: anything it left running can no longer get the context. */
  open: boolean;
}

/**
 * The scope store. It is kept on globalThis under a registered symbol, not in a module variable,
 * because Next can load a module more than once in one process (the bridge's bundle and a route's,
 * a rebuild during `next dev`; lib/db/index.ts and lib/effects.ts do the same for this reason).
 * With a store per copy, a handler would find no scope, and getServerContext would build the
 * context of the request the bridge runs in, perhaps the approving person's, on the global database
 * instead of the bridge's transaction.
 *
 * A registered symbol is one any code in this process can look up (Symbol.for), so the store is
 * reachable from inside the process by design; what no one can do is reach it from a request. Once
 * this module has run, the property can be neither replaced nor removed, so no later copy or other
 * code can swap in a store of its own.
 */
const SERVICE_SCOPE_KEY = Symbol.for('ironbooks.agent.serviceScope');

function serviceScopeStore(): AsyncLocalStorage<ScopeState> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const held = Object.getOwnPropertyDescriptor(g, SERVICE_SCOPE_KEY);
  if (held && 'value' in held && held.value instanceof AsyncLocalStorage) {
    // An earlier copy of this module put it there (already locked), or other code did by plain
    // assignment: lock it in place either way, so that from now on it can only be this store.
    if (held.writable || held.configurable) {
      Object.defineProperty(g, SERVICE_SCOPE_KEY, { value: held.value, enumerable: false, writable: false, configurable: false });
    }
    return held.value as AsyncLocalStorage<ScopeState>;
  }
  const store = new AsyncLocalStorage<ScopeState>();
  // Whatever else holds the key (a value set by plain assignment, a getter) is replaced when its
  // property can still be redefined; when it cannot, defineProperty throws and this module does
  // not load. Either way only this store is ever used: fail closed.
  Object.defineProperty(g, SERVICE_SCOPE_KEY, { value: store, enumerable: false, writable: false, configurable: false });
  return store;
}

const serviceScope = serviceScopeStore();

/**
 * Run `fn` with `ctx` as THE context: while it runs (and everything it awaits), getServerContext
 * and getPageContext return `ctx` as given, without reading cookies, the session or next/headers;
 * requestHeaders() returns the synthetic header set built from `opts`, so getRequestOrigin and the
 * route stamps (lib/permissions/enforce.ts currentRequestInfo) are the scope's own; getSessionGate
 * refuses unless `opts.gate` was given. The bridge builds `ctx` from the agent's clamped access
 * (or a transaction of it), so a handler run here can never act as the person whose request the
 * bridge happens to run in.
 *
 * `ctx` must be an agent's: with its `access`, `role` and `agent`. lib/services/_base.ts reads a
 * context without `access` or `role` as a trusted internal one with no limits, so a bridge bug
 * that left them out would run handlers unrestricted. It throws instead, before `fn` runs. The
 * context must also stay as it was given: from then on every read of the scope checks that who it
 * runs as, its access (also a change made inside the access object), company, database and
 * approval are unchanged, and refuses it otherwise (SERVICE_SCOPE_CHANGED_MESSAGE).
 *
 * What getServerContext checks inside the scope, on every call, with the same functions a person's
 * request meets, on the scope's own path and method: the route map against `ctx.access` (a second
 * check after the bridge's policy, plan 11.3), the Preferences feature switches and the
 * Accountant's Copy gate. What it does NOT check, and the bridge must have settled before opening
 * it, because they are about the person signed in or the file rather than the request: the
 * company-file password, single-user mode, a password that must be changed, a practice copy, the
 * agent's policy and approval. getAgentContext settles the first ones at the door for the agent's
 * own request.
 *
 * The scope follows the async work started inside it, so process-wide work a handler starts on
 * first use (a scheduler's timer) must be started in outsideServiceScope (and outsideEffects,
 * lib/effects.ts), or every later tick counts as this agent request, long finished.
 *
 * The scope ends when `fn` settles, also when it throws. A scope cannot be opened inside another
 * (that would be a bridge bug, and one context silently replacing another is how a handler ends
 * up wider than intended), so it throws instead.
 */
export async function runWithServiceContext<T>(
  ctx: ServiceContext,
  opts: ServiceScopeOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (serviceScope.getStore()) throw new Error('One agent request cannot run inside another.');
  const problem = agentContextProblem(ctx);
  if (problem) throw new Error(problem);
  const seal = sealOf(ctx);
  const access = frozenCopy(seal.accessRef);
  const request = syntheticRequest(opts);
  const state: ScopeState = {
    scope: Object.freeze({ ctx, access, gate: opts.gate ?? null, path: request.path, method: request.method }),
    seal,
    headers: request.headers,
    endedHeaders: Object.freeze(request.headers.filter(([name]) => name !== CLOSING_PASSWORD_HEADER)),
    open: true,
  };
  try {
    return await serviceScope.run(state, fn);
  } finally {
    state.open = false;
  }
}

/** Why `ctx` is not a whole agent context, or null when it is. */
function agentContextProblem(ctx: ServiceContext): string | null {
  if (!ctx || typeof ctx !== 'object' || !ctx.db || typeof ctx.companyId !== 'string') {
    return 'An agent request needs a company context to run in.';
  }
  if (!ctx.access || typeof ctx.access !== 'object' || !ctx.role) {
    return "An agent request needs the agent's own access and role to run with.";
  }
  if (!ctx.agent || typeof ctx.agent !== 'object' || typeof ctx.agent.id !== 'string' || !ctx.agent.id) {
    return 'An agent request needs the agent it runs for.';
  }
  return null;
}

/**
 * Everything of `ctx` that decides who the work runs as and what it may do, as text, so a change
 * made in place (a role cleared, a right added inside the access) shows as a different text. The
 * database is compared by identity instead (ScopeSeal.db).
 */
function contextFingerprint(ctx: ServiceContext): string {
  return JSON.stringify([
    ctx.companyId,
    ctx.userId ?? null,
    ctx.role ?? null,
    ctx.closingDateOverride ?? null,
    ctx.sessionId ?? null,
    ctx.readOnly ?? null,
    ctx.access ?? null,
    ctx.agent ?? null,
    ctx.approval ?? null,
  ]);
}

/** The seal of a whole agent context (agentContextProblem passed). Throws when it cannot be taken. */
function sealOf(ctx: ServiceContext): ScopeSeal {
  let fingerprint: string;
  try {
    fingerprint = contextFingerprint(ctx);
  } catch {
    throw new Error("An agent request needs a context that can be checked while it runs, and this one cannot.");
  }
  return Object.freeze({ db: ctx.db, accessRef: ctx.access!, fingerprint });
}

/** True while `ctx` is still a whole agent context and exactly as it was when the scope opened. */
function sealHolds(ctx: ServiceContext, seal: ScopeSeal): boolean {
  if (agentContextProblem(ctx)) return false;
  if (ctx.db !== seal.db || ctx.access !== seal.accessRef) return false;
  try {
    return contextFingerprint(ctx) === seal.fingerprint;
  } catch {
    return false;
  }
}

/** A deep copy that nobody can change: what the route map is checked against. */
function frozenCopy<T>(value: T): T {
  let copy: T;
  try {
    copy = structuredClone(value);
  } catch {
    throw new Error("An agent request needs the agent's own access as plain data.");
  }
  const freeze = (v: unknown): void => {
    if (!v || typeof v !== 'object' || Object.isFrozen(v)) return;
    Object.freeze(v);
    for (const key of Object.keys(v)) freeze((v as Record<string, unknown>)[key]);
  };
  freeze(copy);
  return copy;
}

/**
 * The stamps and the synthetic header set. Stamps come from opts.path and opts.method only; a
 * header name the bridge may not set (SERVICE_SCOPE_HEADERS), stamps included, is refused.
 */
function syntheticRequest(opts: ServiceScopeOptions): {
  path: string;
  method: HttpMethod;
  headers: ReadonlyArray<readonly [string, string]>;
} {
  if (!opts || typeof opts !== 'object') throw new Error('An agent request needs the path and method it stands for.');
  const method = typeof opts.method === 'string' ? opts.method.toUpperCase() : '';
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    throw new Error(`An agent request needs one of the methods ${HTTP_METHODS.join(', ')}.`);
  }
  if (typeof opts.path !== 'string' || !opts.path.startsWith('/')) {
    throw new Error('An agent request needs the path it stands for, starting with "/".');
  }
  if (/[?#]/.test(opts.path)) throw new Error('An agent request needs the path alone, without a query.');
  const pathProblem = stampedPathProblem(opts.path);
  if (pathProblem) throw new Error(pathProblem);
  const given = opts.headers ?? {};
  if (typeof given !== 'object' || Array.isArray(given) || given instanceof Headers) {
    throw new Error('The headers of an agent request must be a plain list of names and values.');
  }
  const h = new Headers();
  for (const [name, value] of Object.entries(given)) {
    if (!SERVICE_SCOPE_HEADERS.includes(name.toLowerCase())) {
      throw new Error(`An agent request cannot carry the header "${name}".`);
    }
    if (typeof value !== 'string') throw new Error(`The header "${name}" of an agent request must be text.`);
    h.set(name, value);
  }
  h.set(ROUTE_PATH_HEADER, opts.path);
  h.set(ROUTE_METHOD_HEADER, method);
  h.set(SERVICE_ORIGIN_HEADER, SERVICE_ORIGIN_AGENT);
  return { path: opts.path, method: method as HttpMethod, headers: Object.freeze([...h.entries()]) };
}

/** A segment that is "." or "..", also written with %2e: a URL parser removes those. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
/** Characters a parsed URL path never holds as they are: a backslash, controls, a space. */
const NOT_IN_A_PARSED_PATH = /[\\\u0000- \u007f]/;

/**
 * Why `path` could not be a stamp middleware.ts would set (nextUrl.pathname of a real request), or
 * null when it could. The route map (lib/permissions/routes.ts matchRoutePattern) skips empty
 * segments and takes ".." for an id, and the Accountant's Copy allow-list compares the start of
 * the path, so a stamp no real request could carry might be judged as another route than the one
 * the handler serves. The bridge builds its paths so they always pass (lib/agent/bridge.ts
 * buildPath refuses "." and ".." and encodes every value); this is the second line.
 *
 * An encoded slash or backslash inside a segment (%2F, %5C) is let through: buildPath encodes a
 * value's "/" and "\" exactly so, a real request's pathname keeps them encoded too, and nothing on
 * the way to the route checks decodes them, so they stay inside their one segment.
 */
function stampedPathProblem(path: string): string | null {
  if (NOT_IN_A_PARSED_PATH.test(path)) {
    return 'An agent request needs a path without backslashes, spaces or control characters.';
  }
  const segments = path.slice(1).split('/');
  if (segments.some((s) => s === '')) return 'An agent request needs a path without empty parts ("//" or a "/" at the end).';
  if (segments.some((s) => DOT_SEGMENT.test(s))) return 'An agent request needs a path without "." or ".." parts.';
  return null;
}

/**
 * True while code runs inside a service scope, for the bridge and the effects outbox. Work a scope
 * left running after it ended still counts as inside: it must never be taken for the request the
 * scope was opened in (an email it sends would otherwise go out at once, even from a dry run).
 */
export function inServiceScope(): boolean {
  return serviceScope.getStore() !== undefined;
}

/**
 * Run `fn` outside any service scope. Only for code that starts process-wide work while handling a
 * request (a scheduler's timer, an autosave loop started by the first request that needs it):
 * work started inside a scope carries the scope with it, so every later tick would count as an
 * agent request that has already finished. In here that work belongs to the request the bridge
 * runs in, exactly as when a person's request starts it. Never for the operation's own work, and
 * never to get a context: in here getServerContext reads the request the bridge runs in. Pair it
 * with outsideEffects (lib/effects.ts), which does the same for the effects outbox.
 */
export function outsideServiceScope<T>(fn: () => T): T {
  return serviceScope.exit(fn);
}

/**
 * The open scope, or undefined outside one, for lib/context.ts. A scope that already ended is
 * refused: work it left running must not be taken for the request it ran in, nor get the context.
 * So is a scope whose context was changed after it opened (ScopeSeal), checked again on every
 * call: a context that lost its access or role would read as trusted with no limits.
 */
export function currentServiceScope(): ServiceScope | undefined {
  const state = serviceScope.getStore();
  if (!state) return undefined;
  if (!state.open) throw new ServiceError('FORBIDDEN', SERVICE_SCOPE_ENDED_MESSAGE);
  if (!sealHolds(state.scope.ctx, state.seal)) throw new ServiceError('FORBIDDEN', SERVICE_SCOPE_CHANGED_MESSAGE);
  return state.scope;
}

export type RequestHeaders = Awaited<ReturnType<typeof headers>>;

/**
 * The headers to make decisions on: the synthetic set inside a service scope, else the request's
 * own (next/headers). Outside a request it throws, exactly like headers(), so callers keep their
 * "not inside a request" fallbacks. Each call inside a scope gets its own copy, so a handler that
 * changes what it got cannot change what the next reader sees. A real request that sends the
 * scope's own label (SERVICE_ORIGIN_HEADER) gets it dropped; nothing else of it changes.
 *
 * Work a scope left running after it ended still gets the synthetic set (stamps, origin "agent"),
 * so it is still judged as the agent's, but without the closing-date password an approver typed:
 * that was for the request, which is over. It does not throw there: getRequestOrigin and
 * currentRequestInfo take a throw for "not inside a request", which means local trust and no route
 * checks, so a throw would let that work through rather than stop it.
 */
export async function requestHeaders(): Promise<RequestHeaders> {
  const state = serviceScope.getStore();
  if (state) return new Headers((state.open ? state.headers : state.endedHeaders) as Array<[string, string]>) as RequestHeaders;
  const h = await headers();
  if (h.get(SERVICE_ORIGIN_HEADER) == null) return h;
  const copy = new Headers(h);
  copy.delete(SERVICE_ORIGIN_HEADER);
  return copy as RequestHeaders;
}
