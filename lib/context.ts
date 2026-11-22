/**
 * Request/server context resolution. Server components and API route handlers call
 * `getServerContext()` to obtain a ServiceContext (db + current company + current user).
 *
 * Resolution order:
 *  0. An open service scope (`runWithServiceContext`, agent full access, lib/serviceScope.ts): its
 *     own context, checked with the route map, the feature switches and the Accountant's Copy gate
 *     on the scope's own path and method, and nothing is read from the request.
 *  1. Authenticated session (lib/auth) → the user + their selected/first company.
 *  2. Fallback: `ensureDevCompany` (first-run / dev / no session), still honoring a selected
 *     company cookie if present.
 */
import { cookies } from 'next/headers';
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
import { currentRequestInfo, enforceRequestPermission, enforceSelfRoute } from '@/lib/permissions/enforce';
import { enforceFeatureGate } from '@/lib/featureGate';
import { enforceAccountantCopyGate } from '@/lib/services/accountantCopy/routeGate';
import {
  CLOSING_PASSWORD_HEADER,
  SERVICE_ORIGIN_AGENT,
  SERVICE_ORIGIN_HEADER,
  SERVICE_SCOPE_CHANGED_MESSAGE,
  SERVICE_SCOPE_ENDED_MESSAGE,
  SERVICE_SCOPE_HEADERS,
  SERVICE_SCOPE_SECRET_HEADERS,
  currentServiceScope,
  inServiceScope,
  outsideServiceScope,
  requestHeaders,
  runWithServiceContext,
  type ServiceScope,
} from '@/lib/serviceScope';
import { companies, userCompanies, users } from '@/lib/db/schema';
import { getSessionInfo, hasValidUnlockCookie } from '@/lib/auth';
import { assertSessionAllowed } from '@/lib/services/sessions';
import { assertPasswordChangeNotRequired } from '@/lib/services/passwordPolicy';
import { PASSWORD_CHANGE_REQUIRED_MESSAGE } from '@/lib/passwordPolicy';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { isLoopbackHostHeader } from '@/lib/net/loopbackHost';
import { limitClosingPasswordGuess } from '@/lib/closingPasswordLimiter';
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
 * The store, runWithServiceContext, requestHeaders(), inServiceScope() and outsideServiceScope()
 * live in lib/serviceScope.ts: one store for every copy of the module Next loads, and one the
 * request helpers (lib/net/requestInfo.ts, lib/permissions/enforce.ts) can read without an import
 * cycle through this file. Re-exported here, so existing imports keep working.
 */
export {
  CLOSING_PASSWORD_HEADER,
  SERVICE_ORIGIN_AGENT,
  SERVICE_ORIGIN_HEADER,
  SERVICE_SCOPE_CHANGED_MESSAGE,
  SERVICE_SCOPE_ENDED_MESSAGE,
  SERVICE_SCOPE_HEADERS,
  SERVICE_SCOPE_SECRET_HEADERS,
  inServiceScope,
  outsideServiceScope,
  requestHeaders,
  runWithServiceContext,
};
export type { RequestHeaders, ServiceScopeOptions } from '@/lib/serviceScope';

/**
 * The scope's context, after the checks getServerContext makes on a person's request that do not
 * depend on who is signed in, with the very same functions: the route map against the agent's
 * access (scope.access, a frozen copy taken when the scope opened), the Preferences feature
 * switches and the Accountant's Copy gate, the last two read through ctx.db (the bridge's
 * transaction). They read the path and method through lib/permissions/enforce.ts
 * currentRequestInfo, which inside a scope is the scope's own stamps (lib/serviceScope.ts
 * requestHeaders), never the request the bridge runs in.
 *
 * currentServiceScope checked the context was still as it was when the scope opened; the checks
 * here wait on the database, so it is asked once more before the context is handed out.
 */
async function scopedContext(scope: ServiceScope): Promise<ServiceContext> {
  const { ctx, access } = scope;
  await assertScopeStamps(scope);
  await enforceRequestPermission(access);
  await enforceFeatureGate(ctx.db, ctx.companyId);
  await enforceAccountantCopyGate(ctx.db, ctx.companyId);
  currentServiceScope();
  return ctx;
}

/**
 * The checks above judge whatever path and method currentRequestInfo reads. Make sure that is the
 * scope's own before relying on it: were it ever to read the request the bridge runs in (a copy of
 * a module that does not see the scope, a helper changed back to next/headers), the agent would
 * be judged on the person's route. Refused, never let through.
 */
async function assertScopeStamps(scope: ServiceScope): Promise<void> {
  const info = await currentRequestInfo();
  if (info?.path !== scope.path || info.method !== scope.method) {
    throw new ServiceError('FORBIDDEN', 'This agent request could not be checked against the route it stands for, so it was refused.');
  }
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
 * Guesses are rate-limited like sign-in (per person in this company and globally — review round
 * 5), with the same limiter and keys as the other ways in (lib/closingPasswordLimiter.ts): this
 * was the one password with no attempt limit, so a user with the closed-period right but not the
 * password (an Accountant, an External Accountant) could try passwords until one worked.
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
  return limitClosingPasswordGuess({ companyId, userId }, () => verifyClosingDatePassword(db, companyId, supplied));
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
  // route: enforceSelfRoute, the check a person meets, on the scope's own path and method.
  const scope = currentServiceScope();
  if (scope) {
    if (!scope.gate) throw new ServiceError('FORBIDDEN', AGENT_NOT_AVAILABLE_MESSAGE);
    await assertScopeStamps(scope);
    await enforceSelfRoute();
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
  // scope's own path and method pass the route map, the feature switches and the Accountant's Copy
  // gate (scopedContext). Nothing below runs (no cookies, no session, no next/headers): the bridge
  // built that context from the agent's own, already checked one.
  const scope = currentServiceScope();
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
