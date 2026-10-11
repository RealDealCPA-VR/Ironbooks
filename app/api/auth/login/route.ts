/**
 * POST /api/auth/login — verify credentials, start a session, select the user's company.
 * Body: { email, password }
 *
 * Multi-user hosting: attempts are rate-limited per account, per client address and globally
 * (lib/net/rateLimit.ts), and every sign-in creates a server-side session (user_sessions) whose
 * id is bound into the signed cookie — that is what powers "Who is logged in", admin sign-out
 * and single-user mode.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users, userCompanies, companies } from '@/lib/db/schema';
import { verifyPassword, createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import { verifyTotp } from '@/lib/totp';
import { COMPANY_COOKIE } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { startSession } from '@/lib/services/sessions';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';

export async function POST(req: NextRequest) {
  const { email, password, totp } = await req.json().catch(() => ({}));
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    return NextResponse.json({ error: 'Email and password are required.', code: 'VALIDATION' }, { status: 400 });
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

    const db = await getDb();
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

    // Find a company for this user (membership first, else owned).
    const [membership] = await db
      .select({ companyId: userCompanies.companyId })
      .from(userCompanies)
      .where(eq(userCompanies.userId, user.id))
      .limit(1);
    let companyId = membership?.companyId;
    if (!companyId) {
      const [owned] = await db.select({ id: companies.id }).from(companies).where(eq(companies.ownerId, user.id)).limit(1);
      companyId = owned?.id;
    }

    const session = await startSession(db, {
      userId: user.id,
      companyId: companyId ?? null,
      remoteAddr: origin.addr,
      userAgent: origin.userAgent,
      viaHost: origin.remote,
    });

    const res = NextResponse.json({ id: user.id, name: user.name, email: user.email, companyId });
    const opts = { httpOnly: true, secure: cookieSecure(origin), sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 };
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id, 'user', session.id), opts);
    if (companyId) res.cookies.set(COMPANY_COOKIE, companyId, opts);
    return res;
  }
}
