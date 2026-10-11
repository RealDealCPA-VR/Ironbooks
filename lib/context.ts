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
import { getDb, type DB } from '@/lib/db';
import { ensureDevCompany, verifyClosingDatePassword } from '@/lib/services/company';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { getRole } from '@/lib/services/rbac';
import { companies, userCompanies, users } from '@/lib/db/schema';
import { getSessionInfo, hasValidUnlockCookie } from '@/lib/auth';
import { assertSessionAllowed } from '@/lib/services/sessions';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';

export const COMPANY_COOKIE = 'bka_company';

/** Header carrying the closing-date password for this request (QB Set Closing Date override). */
export const CLOSING_PASSWORD_HEADER = 'x-closing-password';

async function selectedCompanyCookie(): Promise<string | undefined> {
  try {
    const store = await cookies();
    return store.get(COMPANY_COOKIE)?.value || undefined;
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

export async function getServerContext(): Promise<ServiceContext> {
  const db = await getDb();

  // File-open password (QB-style company file lock). Enforced here so it covers EVERY API route
  // and server render — even when the file has no user accounts (the standalone-file-password
  // model, where getServerContext would otherwise fall open for first-run seeding). Page
  // navigation is additionally redirected to /unlock by middleware for a friendly prompt.
  const lock = await getFileLockStatus(db);
  if (lock.enabled && !(await hasValidUnlockCookie())) {
    // lib/client.ts isFileLockError and getPageContext below string-match this exact message —
    // don't reword it without updating both.
    throw new ServiceError('FORBIDDEN', 'This company file is locked. Unlock it to continue.');
  }

  // Verified cookie + live server-side session (multi-user hosting: revocable, see lib/auth).
  const session = await getSessionInfo();
  const userId = session?.userId ?? null;

  if (userId) {
    const sel = await selectedCompanyCookie();
    let companyId: string | undefined;
    if (sel) {
      const [m] = await db
        .select({ companyId: userCompanies.companyId })
        .from(userCompanies)
        .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, sel)));
      if (m) companyId = sel;
    }
    if (!companyId) {
      const [m] = await db
        .select({ companyId: userCompanies.companyId })
        .from(userCompanies)
        .where(eq(userCompanies.userId, userId))
        .limit(1);
      companyId = m?.companyId;
    }
    if (!companyId) {
      const [owned] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.ownerId, userId))
        .limit(1);
      companyId = owned?.id;
    }
    if (companyId) {
      // Multi-user: while an admin holds single-user mode for this company, other sessions are refused.
      await assertSessionAllowed(db, session?.sessionId, companyId);
      // RBAC: load the member's role so the service layer can reject viewer mutations
      // centrally (writeAudit/inTransaction in lib/services/_base.ts).
      const role = (await getRole({ db, companyId, userId })) ?? undefined;
      const closingDateOverride = await resolveClosingDateOverride(db, companyId);
      return { db, companyId, userId, role, closingDateOverride, sessionId: session?.sessionId };
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
  const allowDevFallback = process.env.BKA_ALLOW_DEV_FALLBACK === '1';
  if (!allowDevFallback) {
    const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
    if (anyUser) {
      throw new ServiceError('FORBIDDEN', 'Authentication required.');
    }
  }
  const fb = await ensureDevCompany(db);
  // First-run/dev fallback acts as the company owner.
  const closingDateOverride = await resolveClosingDateOverride(db, fb.companyId);
  return { db, companyId: fb.companyId, userId: fb.userId, role: 'owner', closingDateOverride };
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
    if (err instanceof ServiceError && err.code === 'FORBIDDEN') {
      // Same message coupling as lib/client.ts isFileLockError — keep the three in sync.
      if (/company file is locked/i.test(err.message)) {
        redirect('/unlock?next=' + encodeURIComponent(nextPath));
      }
      if (err.message === 'Authentication required.') {
        redirect('/login?next=' + encodeURIComponent(nextPath));
      }
    }
    throw err;
  }
}
