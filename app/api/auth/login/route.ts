/**
 * POST /api/auth/login — verify credentials, start a session, select the user's company.
 * Body: { email, password, totp? } — `email` is the user's login (an email or a user name).
 *
 * Per-company-file login: the file password (if set) must be entered first (/unlock), the user
 * must have an ACTIVE membership in a company of this file, and the issued session token is
 * bound to this company file (lib/auth companyFileId).
 *
 * Multi-user hosting: attempts are rate-limited per account, per client address and globally
 * (lib/net/rateLimit.ts), and every sign-in creates a server-side session (user_sessions) whose
 * id is bound into the signed cookie — that is what powers "Who is logged in", admin sign-out
 * and single-user mode.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, withDamagedFileAccess } from '@/lib/db';
import { users, userCompanies, companies } from '@/lib/db/schema';
import {
  verifyPassword,
  createSessionToken,
  hasValidUnlockCookie,
  SESSION_COOKIE,
} from '@/lib/auth';
import { verifyTotp } from '@/lib/totp';
import { ARCHIVED_ONLY_MESSAGE, COMPANY_COOKIE, DEACTIVATED_MESSAGE, isArchivedCompany } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { startSession } from '@/lib/services/sessions';
import { loginSchema } from '@/lib/validation/users';
import { passwordStatusAtSignIn } from '@/lib/services/passwordPolicy';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';

// Signing in (and unlocking the file) must work even when the company file's ledger is damaged
// (lib/db/index.ts refuses it everywhere else): it is the only way to reach Back Up and Restore
// and replace the file with a good backup. Nothing here reads or writes the ledger.
export async function POST(req: NextRequest) {
  return withDamagedFileAccess(() => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Email and password are required.', code: 'VALIDATION' }, { status: 400 });
  }
  const { email, password, totp } = parsed.data;

  const db = await getDb();
  // The company-file password gates the file BEFORE any user login (QB order). Same message as
  // getServerContext so lib/client.ts sends the browser to /unlock.
  const lock = await getFileLockStatus(db);
  if (lock.enabled && !(await hasValidUnlockCookie())) {
    return NextResponse.json(
      { error: 'This company file is locked. Unlock it to continue.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }

  const origin = originFromHeaders(req.headers);
  const limiter = loginLimiter();
  const keys = attemptKeys('login', email, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  // Admitted BEFORE the slow password hash and released after it, so parallel guesses count.
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body, retryAfter } = tooManyAttempts(gate.retryAfterMs);
    return NextResponse.json(body, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    return await signIn();
  } catch (err) {
    if (err instanceof ServiceError) {
      // e.g. the 40-user seat limit (lib/services/sessions.assertSeatAvailable).
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'CONFLICT' ? 409 : 403 });
    }
    throw err;
  } finally {
    gate.release();
  }

  async function signIn(): Promise<NextResponse> {
    const fail = (message: string) => {
      limiter.recordFailure(keys, Date.now(), weights);
      return NextResponse.json({ error: message, code: 'FORBIDDEN' }, { status: 401 });
    };

    const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return fail('Invalid email or password.');
    }

    // Second factor (TOTP) when enabled.
    if (user.totpEnabled && user.totpSecret) {
      if (!totp) {
        return NextResponse.json({ requires2fa: true });
      }
      if (!verifyTotp(user.totpSecret, String(totp), Date.now())) {
        return fail('Invalid authentication code.');
      }
    }
    limiter.recordSuccess(keys.slice(0, -1)); // keep the global counter

    // Find a company for this user (ACTIVE membership first, else owned).
    // Archived (soft-deleted) companies are never picked (same rule as getServerContext).
    const memberships = await db
      .select({
        companyId: userCompanies.companyId,
        isActive: userCompanies.isActive,
        settings: companies.settings,
      })
      .from(userCompanies)
      .innerJoin(companies, eq(companies.id, userCompanies.companyId))
      .where(eq(userCompanies.userId, user.id));
    const activeMemberships = memberships.filter((m) => m.isActive);
    let companyId = activeMemberships.find((m) => !isArchivedCompany(m.settings))?.companyId;
    if (!companyId && activeMemberships.length) {
      // Every company this user is active in has been archived — no session.
      return NextResponse.json({ error: ARCHIVED_ONLY_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
    }
    if (!companyId && memberships.length) {
      // Deactivated in every company of this file (Users & Roles) — no session.
      return NextResponse.json({ error: DEACTIVATED_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
    }
    if (!companyId) {
      const owned = await db
        .select({ id: companies.id, settings: companies.settings })
        .from(companies)
        .where(eq(companies.ownerId, user.id));
      companyId = owned.find((c) => !isArchivedCompany(c.settings))?.id;
    }

    // gapsb K: an old password still signs in; when it has expired (file password policy) or an
    // Admin asked for a new one, the session can only choose a new password (/change-password).
    const passwordChange = await passwordStatusAtSignIn(db, user);

    const session = await startSession(db, {
      userId: user.id,
      companyId: companyId ?? null,
      remoteAddr: origin.addr,
      userAgent: origin.userAgent,
      viaHost: origin.remote,
    });

    const res = NextResponse.json({
      id: user.id,
      name: user.name,
      email: user.email,
      companyId,
      ...(passwordChange ? { mustChangePassword: true, passwordChangeReason: passwordChange } : {}),
    });
    const opts = { httpOnly: true, secure: cookieSecure(origin), sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 };
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id, 'user', session.id), opts);
    if (companyId) res.cookies.set(COMPANY_COOKIE, companyId, opts);
    return res;
  }
}
