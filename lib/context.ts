/**
 * Request/server context resolution. Server components and API route handlers call
 * `getServerContext()` to obtain a ServiceContext (db + current company + current user).
 *
 * Resolution order:
 *  0. An open service scope (`runWithServiceContext`, agent full access): its own context, checked
 *     against the route map on the scope's own path, and nothing is read from the request.
 *  1. Authenticated session (lib/auth) → the user + their selected/first company.
 *  2. Fallback: `ensureDevCompany` (first-run / dev / no session), still honoring a selected
 *     company cookie if present.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getDb, LedgerDamagedError, resolveDataDir, type DB } from '@/lib/db';
import { AGENT_NOT_AVAILABLE_MESSAGE, getAgentContext } from '@/lib/agentContext';
import { hasAuthorization } from '@/lib/net/agentToken';
import { notePersonSignedIn } from '@/lib/agent/endpointFile';
import { syncAgentEndpoint } from '@/lib/services/agents';
import { ensureDevCompany, verifyClosingDatePassword } from '@/lib/services/company';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { resolveAccess, PERMISSION_DENIED_PREFIX } from '@/lib/services/access';
import { fullAccess, legacyRoleFor } from '@/lib/permissions/model';
import type { EffectiveAccess } from '@/lib/permissions/model';
import { authorizeRequest, enforceRequestPermission, enforceSelfRoute } from '@/lib/permissions/enforce';
import {
  HTTP_METHODS,
  ROUTE_METHOD_HEADER,
  ROUTE_PATH_HEADER,
  apiRuleFor,
  type HttpMethod,
} from '@/lib/permissions/routes';
import { enforceFeatureGate, featureOffError } from '@/lib/featureGate';
import { blockingFeatureGate, featureGateForApi, resolveCompanyPreferences } from '@/lib/preferences';
import { assertAccountantCopyAllowsPath, enforceAccountantCopyGate } from '@/lib/services/accountantCopy/routeGate';
import { companies, userCompanies, users } from '@/lib/db/schema';
import { getSessionInfo, hasValidUnlockCookie } from '@/lib/auth';
import { assertSessionAllowed } from '@/lib/services/sessions';
import { assertPasswordChangeNotRequired } from '@/lib/services/passwordPolicy';
import { PASSWORD_CHANGE_REQUIRED_MESSAGE } from '@/lib/passwordPolicy';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { isLoopbackHostHeader } from '@/lib/net/loopbackHost';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { ensureSandboxEnvSynced } from '@/lib/services/sandboxState';

export const COMPANY_COOKIE = 'bka_company';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** FORBIDDEN message for a deactivated member (login route + lib/client.ts match it). */
export const DEACTIVATED_MESSAGE =
  'Your user account has been deactivated for this company. Contact your administrator.';

/**
 * FORBIDDEN message for a user whose every active company in this file has been archived
 * (login route + lib/client.ts isAuthError + getPageContext match it).
 */
export const ARCHIVED_ONLY_MESSAGE =
  'Every company you belong to in this file has been archived. Contact your administrator.';

/** True when a company row's settings mark it archived (soft-deleted, settings.archived). */
export function isArchivedCompany(settings: unknown): boolean {
  return Boolean(
    settings && typeof settings === 'object' && (settings as { archived?: unknown }).archived === true,
  );
}

/** Header carrying the closing-date password for this request (QB Set Closing Date override). */
export const CLOSING_PASSWORD_HEADER = 'x-closing-password';

/**
 * True when the request's Host header names a loopback host (localhost / 127.x / [::1], any
 * port). No Host header (outside a request scope, scripts, tests) counts as loopback. Lives in an
 * edge-safe module so middleware.ts applies the very same rule to every request.
 */
export { isLoopbackHostHeader };

// ---------------------------------------------------------------------------
// Service scope (agent full access, AGENT_ACCESS.md): run a route handler for an agent in-process
// ---------------------------------------------------------------------------

/**
 * Marks the synthetic header set of a service scope with where its request came from. A real
 * request can send this header too (middleware.ts does not remove it), so requestHeaders() drops
 * it from a real request: read through requestHeaders(), it only ever comes from a scope. Still a
 * label, never proof: decisions ask inServiceScope(), which no request can change.
 */
export const SERVICE_ORIGIN_HEADER = 'x-bka-origin';
export const SERVICE_ORIGIN_AGENT = 'agent';

/** Refusal for work a scope left running after it ended (a timer, a promise nobody awaited). */
export const SERVICE_SCOPE_ENDED_MESSAGE = 'This agent request has already finished.';

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

interface ServiceScope {
  readonly ctx: ServiceContext;
  /** ctx.access as it was when the scope opened: the route map is checked against this. */
  readonly access: EffectiveAccess;
  readonly gate: SessionGate | null;
  /** The stamped path and method (upper case) the scope stands for. */
  readonly path: string;
  readonly method: HttpMethod;
  /** The synthetic header set, lower-case names. Copied out fresh for every reader. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** False once fn has settled: anything it left running can no longer get the context. */
  open: boolean;
}

/**
 * The scope store. Only runWithServiceContext opens a scope in it, it is not exported, and no
 * header, cookie, query or body is ever read to decide whether a scope is open.
 *
 * It is kept on globalThis under a registered symbol, not in a module variable, because Next can
 * load this module more than once in one process (the bridge's bundle and a route's, a rebuild
 * during `next dev`; lib/db/index.ts and lib/effects.ts do the same for this reason). With a store
 * per copy, a handler would find no scope, and getServerContext would build the context of the
 * request the bridge runs in, perhaps the approving person's, on the global database instead of
 * the bridge's transaction. Once set, the property can be neither replaced nor removed, so no
 * later copy or other code can swap in a store of its own.
 */
const SERVICE_SCOPE_KEY = Symbol.for('ironbooks.agent.serviceScope');

function serviceScopeStore(): AsyncLocalStorage<ServiceScope> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const existing = g[SERVICE_SCOPE_KEY];
  if (existing instanceof AsyncLocalStorage) return existing as AsyncLocalStorage<ServiceScope>;
  const store = new AsyncLocalStorage<ServiceScope>();
  Object.defineProperty(g, SERVICE_SCOPE_KEY, { value: store, enumerable: false, writable: false, configurable: false });
  return store;
}

const serviceScope = serviceScopeStore();

/**
 * Run `fn` with `ctx` as THE context: while it runs (and everything it awaits), getServerContext
 * and getPageContext return `ctx` as given, without reading cookies, the session or next/headers;
 * requestHeaders() returns the synthetic header set built from `opts`; getSessionGate refuses
 * unless `opts.gate` was given. The bridge builds `ctx` from the agent's clamped access (or a
 * transaction of it), so a handler run here can never act as the person whose request the bridge
 * happens to run in.
 *
 * `ctx` must be an agent's: with its `access`, `role` and `agent`. lib/services/_base.ts reads a
 * context without `access` or `role` as a trusted internal one with no limits, so a bridge bug
 * that left them out would run handlers unrestricted. It throws instead, before `fn` runs.
 *
 * What the scope checks itself, on every getServerContext, on the scope's own path and method:
 * the route map against `ctx.access` (a second check after the bridge's policy, plan 11.3), the
 * Preferences feature switches and the Accountant's Copy gate. What it does NOT check, and the
 * bridge must have settled before opening it, because they are about the person signed in or the
 * file rather than the request: the company-file password, single-user mode, a password that must
 * be changed, a practice copy, the agent's policy and approval. getAgentContext settles the first
 * ones at the door for the agent's own request.
 *
 * Until lib/net/requestInfo.ts (getRequestOrigin) and lib/permissions/enforce.ts
 * (currentRequestInfo) read requestHeaders(), a handler or service that calls them inside a scope
 * still sees the request the bridge runs in, not the synthetic one.
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
  const access = agentScopeAccess(ctx);
  const request = syntheticRequest(opts);
  const scope: ServiceScope = { ctx, access, gate: opts.gate ?? null, ...request, open: true };
  try {
    return await serviceScope.run(scope, fn);
  } finally {
    scope.open = false;
  }
}

/** The agent's access, after checking `ctx` is a whole agent context. Throws otherwise. */
function agentScopeAccess(ctx: ServiceContext): EffectiveAccess {
  if (!ctx || typeof ctx !== 'object' || !ctx.db || typeof ctx.companyId !== 'string') {
    throw new Error('An agent request needs a company context to run in.');
  }
  if (!ctx.access || typeof ctx.access !== 'object' || !ctx.role) {
    throw new Error("An agent request needs the agent's own access and role to run with.");
  }
  if (!ctx.agent || typeof ctx.agent !== 'object' || typeof ctx.agent.id !== 'string' || !ctx.agent.id) {
    throw new Error('An agent request needs the agent it runs for.');
  }
  return ctx.access;
}

/**
 * The stamps and the synthetic header set. Stamps come from opts.path and opts.method only; a
 * header name the bridge may not set (SERVICE_SCOPE_HEADERS), stamps included, is refused.
 */
function syntheticRequest(opts: ServiceScopeOptions): Pick<ServiceScope, 'path' | 'method' | 'headers'> {
  if (!opts || typeof opts !== 'object') throw new Error('An agent request needs the path and method it stands for.');
  const method = typeof opts.method === 'string' ? opts.method.toUpperCase() : '';
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    throw new Error(`An agent request needs one of the methods ${HTTP_METHODS.join(', ')}.`);
  }
  if (typeof opts.path !== 'string' || !opts.path.startsWith('/')) {
    throw new Error('An agent request needs the path it stands for, starting with "/".');
  }
  if (/[?#]/.test(opts.path)) throw new Error('An agent request needs the path alone, without a query.');
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
  return { path: opts.path, method: method as HttpMethod, headers: [...h.entries()] };
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

/** The open scope, or undefined outside one. A scope that already ended is refused. */
function openServiceScope(): ServiceScope | undefined {
  const scope = serviceScope.getStore();
  if (scope && !scope.open) throw new ServiceError('FORBIDDEN', SERVICE_SCOPE_ENDED_MESSAGE);
  return scope;
}

/**
 * The scope's context, after the checks getServerContext makes on a person's request that do not
 * depend on who is signed in, made on the scope's own path and method: the route map against the
 * agent's access, the Preferences feature switches and the Accountant's Copy gate (the last two
 * read through ctx.db, the bridge's transaction). enforceRequestPermission, enforceFeatureGate and
 * enforceAccountantCopyGate are not called here: they read the stamps through next/headers
 * (lib/permissions/enforce.ts currentRequestInfo), which would judge the request the bridge runs
 * in. The feature-switch lookup is lib/featureGate.ts enforceFeatureGate's, on these stamps.
 */
async function scopedContext(scope: ServiceScope): Promise<ServiceContext> {
  const { ctx, access, path, method } = scope;
  authorizeRequest({ path, method }, access);
  if (method !== 'GET') {
    if (featureGateForApi(path)) {
      const [row] = await ctx.db
        .select({ settings: companies.settings })
        .from(companies)
        .where(eq(companies.id, ctx.companyId));
      const gate = blockingFeatureGate(path, resolveCompanyPreferences(row?.settings ?? {}), method);
      if (gate) throw featureOffError(gate);
    }
    await assertAccountantCopyAllowsPath(ctx.db, ctx.companyId, path);
  }
  return ctx;
}

/**
 * lib/permissions/enforce.ts enforceSelfRoute on the scope's own path and method: a gate value
 * given to a scope still only answers routes mapped 'self' or 'public'. A route mapped to an area
 * that asked the gate would skip its area check.
 */
function assertScopedSelfRoute({ path, method }: ServiceScope): void {
  if (path !== '/api' && !path.startsWith('/api/')) return;
  const rule = apiRuleFor(path, method);
  if (rule === 'self' || rule === 'public') return;
  if (rule === null) {
    throw new ServiceError('FORBIDDEN', `No permission mapping exists for ${method} ${path}. Access denied.`);
  }
  throw new ServiceError('FORBIDDEN', `${method} ${path} must be authorized through getServerContext.`);
}

export type RequestHeaders = Awaited<ReturnType<typeof headers>>;

/**
 * The headers to make decisions on: the synthetic set inside a service scope, else the request's
 * own (next/headers). Outside a request it throws, exactly like headers(), so callers keep their
 * "not inside a request" fallbacks. Each call inside a scope gets its own copy, so a handler that
 * changes what it got cannot change what the next reader sees. A real request that sends the
 * scope's own label (SERVICE_ORIGIN_HEADER) gets it dropped; nothing else of it changes.
 */
export async function requestHeaders(): Promise<RequestHeaders> {
  const scope = serviceScope.getStore();
  if (scope) return new Headers(scope.headers as Array<[string, string]>) as RequestHeaders;
  const h = await headers();
  if (h.get(SERVICE_ORIGIN_HEADER) === null) return h;
  const copy = new Headers(h);
  copy.delete(SERVICE_ORIGIN_HEADER);
  return copy as RequestHeaders;
}

async function requestHostIsLoopback(): Promise<boolean> {
  try {
    const h = await requestHeaders();
    return isLoopbackHostHeader(h.get('host'));
  } catch {
    return true; // not inside a request (tests, scripts)
  }
}

async function selectedCompanyCookie(): Promise<string | undefined> {
  try {
    const store = await cookies();
    const value = store.get(COMPANY_COOKIE)?.value;
    // Only a well-formed company id is ever looked up; anything else (tampered / stale garbage)
    // is ignored and the user's first active membership is used instead.
    return value && UUID_RE.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * If the request carries an x-closing-password header, verify it against the company's
 * closing-date password hash. A valid password (or any explicit attempt when no password is
 * configured) unlocks postings dated on/before the closing date for THIS request only.
 *
 * Guesses are rate-limited like sign-in (per person, per address and globally — review round 5):
 * this was the one password with no attempt limit, so a user with the closed-period right but not
 * the password (an Accountant, an External Accountant) could try passwords until one worked.
 */
async function resolveClosingDateOverride(db: DB, companyId: string, userId?: string | null): Promise<boolean> {
  let supplied: string | null = null;
  try {
    const h = await requestHeaders();
    supplied = h.get(CLOSING_PASSWORD_HEADER);
  } catch {
    return false;
  }
  if (supplied === null) return false;
  const origin = await getRequestOrigin();
  const limiter = loginLimiter();
  // Only signed-in people can guess, so the person (in this company) is the key, plus the global
  // cap — not the address: everyone working on this computer shares 'local', and one person's
  // wrong guesses must not lock the others out.
  const keys = attemptKeys('closing-password', `${companyId}:${userId ?? ''}`, origin.addr).filter((k) => !k.includes(':addr:'));
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { retryAfter } = tooManyAttempts(gate.retryAfterMs);
    const secs = Number(retryAfter);
    throw new ServiceError(
      'FORBIDDEN',
      `Too many wrong closing-date passwords. Try again in ${secs < 90 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minutes`}.`,
      { rateLimited: true, retryAfterSeconds: secs },
    );
  }
  try {
    const ok = await verifyClosingDatePassword(db, companyId, supplied);
    if (ok) limiter.recordSuccess(keys.slice(0, -1));
    else limiter.recordFailure(keys, Date.now(), weights);
    return ok;
  } finally {
    gate.release();
  }
}

/**
 * File-open password (QB-style company file lock). Enforced by getServerContext AND
 * getSessionGate so it covers EVERY API route and server render — even when the file has no
 * user accounts (the standalone-file-password model, where getServerContext would otherwise
 * fall open for first-run seeding). Page navigation is additionally redirected to /unlock by
 * middleware for a friendly prompt.
 */
async function assertFileUnlocked(db: DB): Promise<void> {
  const lock = await getFileLockStatus(db);
  if (lock.enabled && !(await hasValidUnlockCookie())) {
    // lib/client.ts isFileLockError and getPageContext below string-match this exact message —
    // don't reword it without updating both.
    throw new ServiceError('FORBIDDEN', 'This company file is locked. Unlock it to continue.');
  }
}

export interface SessionGate {
  db: DB;
  /** Verified session user (token bound to THIS company file), or null without a session. */
  userId: string | null;
  /** The live server-side session id, when the cookie carries one. */
  sessionId?: string;
}

export interface SessionGateOptions {
  /**
   * gapsb K: let a session whose password must be changed (expired / an Admin asked) through.
   * Only /api/auth/change-password sets this — every other 'self' route (2FA, company select,
   * company file management) is refused with PASSWORD_CHANGE_REQUIRED_MESSAGE, exactly like
   * getServerContext. (/api/auth/logout doesn't use the gate at all, so signing out always works.)
   */
  allowPasswordChangeRequired?: boolean;
}

/**
 * The central gate for API routes mapped 'self' in lib/permissions/routes.ts (company-file
 * management, the caller's own 2FA settings) — routes that act on the USER rather than on the
 * active company, so they can't take a company-scoped getServerContext. It still applies every
 * file-level check getServerContext does:
 *  - the request must be mapped 'self'/'public' in the route map (unmapped → denied);
 *  - the company-file password (file lock);
 *  - the session token's file binding (verifySessionToken rejects other files' sessions);
 *  - a user deactivated in every company of this file is refused (DEACTIVATED_MESSAGE);
 *  - a session whose password must be changed is refused (PASSWORD_CHANGE_REQUIRED_MESSAGE)
 *    unless the caller opts out (only /api/auth/change-password does).
 * Per-company authorization (e.g. rename needs company:modify) stays with the handler, which
 * resolves the caller's effective permissions in the company named by the URL.
 */
/**
 * The request's headers when it carries an Authorization header (an agent, AGENT_ACCESS.md), else
 * null. The app's own window and the desktop shell never send one.
 */
async function authorizationRequestHeaders(): Promise<{ get(name: string): string | null } | null> {
  try {
    const h = await requestHeaders();
    return hasAuthorization(h) ? h : null;
  } catch {
    return null; // not inside a request (tests, scripts)
  }
}

/**
 * A person's verified sign-in reached this company file: agents may work from now on in this run
 * (lib/agentContext.ts), and the first time, the file's agent endpoint is published if it has
 * agents (lib/services/agents.ts). Never fails the request.
 */
async function notePersonAtWork(db: DB): Promise<void> {
  try {
    let host: string | null = null;
    try {
      host = (await requestHeaders()).get('host');
    } catch {
      /* not inside a request */
    }
    if (notePersonSignedIn(resolveDataDir(), host)) await syncAgentEndpoint(db);
  } catch {
    /* agent access is an extra; a person's request never depends on it */
  }
}

export async function getSessionGate(opts: SessionGateOptions = {}): Promise<SessionGate> {
  // Inside a service scope (an agent's request run by the bridge) the cookies in reach are those
  // of whoever's request the bridge runs in, perhaps the person approving it. A 'self' route acts
  // on THAT person's own account, so it is refused, without reading the request, unless the
  // bridge opened the scope with an explicit gate value, and then only on a 'self' or 'public'
  // route, as enforceSelfRoute does for a person.
  const scope = openServiceScope();
  if (scope) {
    if (!scope.gate) throw new ServiceError('FORBIDDEN', AGENT_NOT_AVAILABLE_MESSAGE);
    assertScopedSelfRoute(scope);
    return scope.gate;
  }
  // 'self' routes act on a person's own account: never for an agent, and never on the cookies a
  // request with an Authorization header carries.
  if (await authorizationRequestHeaders()) throw new ServiceError('FORBIDDEN', 'Authentication required.');
  await enforceSelfRoute();
  const db = await getDb();
  await assertFileUnlocked(db);
  // Verified cookie + live server-side session (multi-user hosting: a signed-out session is refused).
  const session = await getSessionInfo();
  const userId = session?.userId ?? null;
  if (!userId) return { db, userId: null };
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) throw new ServiceError('FORBIDDEN', 'Authentication required.');
  const memberships = await db
    .select({ isActive: userCompanies.isActive })
    .from(userCompanies)
    .where(eq(userCompanies.userId, userId));
  if (memberships.length && !memberships.some((m) => m.isActive !== false)) {
    throw new ServiceError('FORBIDDEN', DEACTIVATED_MESSAGE);
  }
  if (!opts.allowPasswordChangeRequired) await assertPasswordChangeNotRequired(db, userId);
  return { db, userId, sessionId: session?.sessionId };
}

export async function getServerContext(): Promise<ServiceContext> {
  // PDFs printed from a sandbox / training file are stamped (lib/pdf/sandboxStamp.ts).
  ensureSandboxEnvSynced();
  // An agent's request run in-process by the bridge: the context it was given, exactly, once the
  // scope's own path and method pass the route map and the save gates (scopedContext). Nothing
  // below runs (no cookies, no session, no next/headers): the bridge built that context from the
  // agent's own, already checked one.
  const scope = openServiceScope();
  if (scope) return scopedContext(scope);
  // A request with an Authorization header is an agent (AGENT_ACCESS.md) or nothing: it gets the
  // agent's own, read-only context and never falls through to the cookie session below.
  const agentHeaders = await authorizationRequestHeaders();
  if (agentHeaders) return getAgentContext(agentHeaders);
  const db = await getDb();

  await assertFileUnlocked(db);

  // Verified cookie + live server-side session (multi-user hosting: revocable, see lib/auth).
  const session = await getSessionInfo();
  const userId = session?.userId ?? null;

  if (userId) {
    // gapsb K: a password that must be changed (expired / Admin asked) blocks everything except
    // choosing a new one (/api/auth/change-password uses getSessionGate with
    // allowPasswordChangeRequired; the gate refuses it on every other 'self' route).
    await assertPasswordChangeNotRequired(db, userId);
    // Only ACTIVE memberships select a company (deactivated users are locked out).
    // Archived (soft-deleted) companies are never selected — not from a stale cookie, not as the
    // fallback (lib/context isArchivedCompany; archiving lives in app/api/companies/[id]/manage.ts).
    const activeRows = await db
      .select({ companyId: userCompanies.companyId, settings: companies.settings })
      .from(userCompanies)
      .innerJoin(companies, eq(companies.id, userCompanies.companyId))
      .where(and(eq(userCompanies.userId, userId), eq(userCompanies.isActive, true)));
    const usable = activeRows.filter((r) => !isArchivedCompany(r.settings));
    const sel = await selectedCompanyCookie();
    let companyId: string | undefined =
      (sel && usable.find((r) => r.companyId === sel)?.companyId) || usable[0]?.companyId;
    if (!companyId) {
      // Every active membership is in an archived company: no usable company in this file.
      if (activeRows.length) throw new ServiceError('FORBIDDEN', ARCHIVED_ONLY_MESSAGE);
      const [anyMembership] = await db
        .select({ companyId: userCompanies.companyId })
        .from(userCompanies)
        .where(eq(userCompanies.userId, userId))
        .limit(1);
      if (anyMembership) throw new ServiceError('FORBIDDEN', DEACTIVATED_MESSAGE);
      const owned = await db
        .select({ id: companies.id, settings: companies.settings })
        .from(companies)
        .where(eq(companies.ownerId, userId));
      companyId = owned.find((c) => !isArchivedCompany(c.settings))?.id;
    }
    if (companyId) {
      // Multi-user: while an admin holds single-user mode for this company, other sessions are refused.
      await assertSessionAllowed(db, session?.sessionId, companyId);
      // Enterprise roles & permissions: resolve the member's effective permissions (union of
      // their roles) and authorize THIS request against the declarative route map
      // (lib/permissions/routes.ts). Every API route obtains its context here, so enforcement
      // can't be skipped by forgetting a check in a handler.
      const resolved = await resolveAccess(db, companyId, userId);
      if (!resolved.active) throw new ServiceError('FORBIDDEN', DEACTIVATED_MESSAGE);
      const access = resolved.access;
      await enforceRequestPermission(access);
      // Preferences feature switches: saves to a turned-off feature are refused (lib/featureGate.ts).
      await enforceFeatureGate(db, companyId);
      // Accountant's Copy: only saves that can travel back to the client (accountantCopy/routeGate.ts).
      await enforceAccountantCopyGate(db, companyId);
      // Legacy 4-level role, still read by the view-only guard in _base.ts and a few services.
      const role = legacyRoleFor(access, resolved.isOwner);
      // The closing-date password only unlocks closed periods for users whose roles allow
      // modifying transactions on/before the closing date (QB Enterprise parity).
      const closingDateOverride =
        access.flags.closedPeriod && (await resolveClosingDateOverride(db, companyId, userId));
      await notePersonAtWork(db);
      return { db, companyId, userId, role, closingDateOverride, access, sessionId: session?.sessionId };
    }
  }

  // No valid authenticated session.
  //
  // SECURITY: never honor a client-supplied bka_company cookie here and never impersonate
  // an existing tenant. Doing so previously let an unauthenticated caller hit any API route
  // as an arbitrary company's owner (the API layer is not gated by middleware).
  //
  // The only legitimate session-less path is genuine first-run/seed, before any account
  // exists, so onboarding can boot. Once any user exists, fail closed (HTTP 403 via the
  // route error handlers). An explicit BKA_ALLOW_DEV_FALLBACK=1 re-opens the old dev behavior.
  //
  // Requests from OTHER machines (through the multi-user host proxy) never get the first-run /
  // dev fallback — the host must be set up locally, with a real account, before it is shared.
  // Neither do other programs on this computer: without the desktop shell's per-launch pass they
  // count as remote too (lib/net/launchPass.ts).
  if ((await getRequestOrigin()).remote) {
    throw new ServiceError('FORBIDDEN', 'Authentication required.');
  }
  // A single company file (the desktop app's company files, lib/services/companyFileSave.ts) is
  // set up by its Admin on /signup and is otherwise only used signed in: no first-run fallback,
  // which would put a "Demo Company" and a demo user into the person's new file.
  if (process.env.BKA_COMPANY_FILE) {
    throw new ServiceError('FORBIDDEN', 'Authentication required.');
  }
  // DNS-rebinding guard: a web page whose name resolves to 127.0.0.1 reaches this server with
  // ITS host name in the Host header. The session-less owner fallback only answers requests
  // addressed to a loopback host (the desktop shell and `next dev` use 127.0.0.1 / localhost).
  if (!(await requestHostIsLoopback())) {
    throw new ServiceError('FORBIDDEN', 'Authentication required.');
  }
  const allowDevFallback = process.env.BKA_ALLOW_DEV_FALLBACK === '1';
  if (!allowDevFallback) {
    const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
    if (anyUser) {
      throw new ServiceError('FORBIDDEN', 'Authentication required.');
    }
  }
  const fb = await ensureDevCompany(db);
  // First-run/dev fallback acts as the company owner (Admin). The route map still applies, so
  // an unmapped API route is refused even here.
  const access = fullAccess();
  await enforceRequestPermission(access);
  await enforceFeatureGate(db, fb.companyId);
  await enforceAccountantCopyGate(db, fb.companyId);
  const closingDateOverride = await resolveClosingDateOverride(db, fb.companyId);
  return {
    db,
    companyId: fb.companyId,
    userId: fb.userId,
    role: 'owner',
    closingDateOverride,
    access,
  };
}

/**
 * `getServerContext` for server-component pages. Middleware only checks cookie PRESENCE, so a
 * present-but-invalid cookie (e.g. a stale bka_unlock cookie after an Electron relaunch, or an
 * expired bka_session) reaches SSR, where the FORBIDDEN throw would land in the generic error
 * boundary with no way to re-prompt. Client-component pages recover via lib/client.ts
 * (isFileLockError → /unlock); this wrapper gives server-rendered pages the same friendly
 * redirect to /unlock (file lock) or /login (auth), preserving the requested path in ?next=.
 * Any other error is rethrown. Note redirect() throws NEXT_REDIRECT, so it must escape the catch.
 */
export async function getPageContext(nextPath: string): Promise<ServiceContext> {
  try {
    return await getServerContext();
  } catch (err) {
    // Damaged company file (ledgerGuards checkLedgerHealth refused it on open): a plain
    // "restore a backup" screen instead of the generic error page.
    if (err instanceof LedgerDamagedError) redirect('/damaged-file');
    if (err instanceof ServiceError && err.code === 'FORBIDDEN') {
      // Same message coupling as lib/client.ts isFileLockError — keep the three in sync.
      if (/company file is locked/i.test(err.message)) {
        redirect('/unlock?next=' + encodeURIComponent(nextPath));
      }
      if (
        err.message === 'Authentication required.' ||
        err.message === DEACTIVATED_MESSAGE ||
        err.message === ARCHIVED_ONLY_MESSAGE
      ) {
        redirect('/login?next=' + encodeURIComponent(nextPath));
      }
      if (err.message === PASSWORD_CHANGE_REQUIRED_MESSAGE) {
        redirect('/change-password?next=' + encodeURIComponent(nextPath));
      }
      // Role lacks access to this page (lib/permissions/routes.ts PAGE_AREAS).
      if (err.message.startsWith(PERMISSION_DENIED_PREFIX)) {
        redirect('/forbidden?from=' + encodeURIComponent(nextPath));
      }
    }
    throw err;
  }
}
