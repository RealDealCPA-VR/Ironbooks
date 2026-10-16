/**
 * Request/server context resolution. Server components and API route handlers call
 * `getServerContext()` to obtain a ServiceContext (db + current company + current user).
 *
 * Resolution order:
 *  1. Authenticated session (lib/auth) → the user + their selected/first company.
 *  2. Fallback: `ensureDevCompany` (first-run / dev / no session), still honoring a selected
 *     company cookie if present.
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getDb, LedgerDamagedError, type DB } from '@/lib/db';
import { ensureDevCompany, verifyClosingDatePassword } from '@/lib/services/company';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { resolveAccess, PERMISSION_DENIED_PREFIX } from '@/lib/services/access';
import { fullAccess, legacyRoleFor } from '@/lib/permissions/model';
import { enforceRequestPermission, enforceSelfRoute } from '@/lib/permissions/enforce';
import { enforceFeatureGate } from '@/lib/featureGate';
import { enforceAccountantCopyGate } from '@/lib/services/accountantCopy/routeGate';
import { companies, userCompanies, users } from '@/lib/db/schema';
import { getSessionInfo, hasValidUnlockCookie } from '@/lib/auth';
import { assertSessionAllowed } from '@/lib/services/sessions';
import { assertPasswordChangeNotRequired } from '@/lib/services/passwordPolicy';
import { PASSWORD_CHANGE_REQUIRED_MESSAGE } from '@/lib/passwordPolicy';
import { getRequestOrigin } from '@/lib/net/requestInfo';
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
 * port). No Host header (outside a request scope, scripts, tests) counts as loopback.
 */
export function isLoopbackHostHeader(host: string | null | undefined): boolean {
  if (host === null || host === undefined) return true;
  const h = host.trim().toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d*$/, '');
  if (name === 'localhost' || name === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

async function requestHostIsLoopback(): Promise<boolean> {
  try {
    const h = await headers();
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
 */
async function resolveClosingDateOverride(db: DB, companyId: string): Promise<boolean> {
  let supplied: string | null = null;
  try {
    const h = await headers();
    supplied = h.get(CLOSING_PASSWORD_HEADER);
  } catch {
    return false;
  }
  if (supplied === null) return false;
  return verifyClosingDatePassword(db, companyId, supplied);
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
export async function getSessionGate(opts: SessionGateOptions = {}): Promise<SessionGate> {
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
        access.flags.closedPeriod && (await resolveClosingDateOverride(db, companyId));
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
  if ((await getRequestOrigin()).remote) {
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
