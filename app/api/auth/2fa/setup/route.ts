/**
 * POST /api/auth/2fa/setup { currentPassword } — generate a TOTP secret for the current user (not
 * yet enabled). The current password is required (rate-limited like sign-in), as for changing the
 * password or the challenge question: a session cookie alone must not be able to enrol someone
 * else's authenticator and lock the real owner out.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { and, eq } from 'drizzle-orm';
import { users } from '@/lib/db/schema';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { generateSecret, otpauthUrl } from '@/lib/totp';

export async function POST(req: NextRequest) {
  // File lock, file-bound session and deactivation checks (lib/context.ts getSessionGate).
  let gate;
  try {
    gate = await getSessionGate();
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    }
    throw err;
  }
  const { db, userId } = gate;
  if (!userId) return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
  if (user.totpEnabled) {
    return NextResponse.json(
      {
        error:
          'Two-factor sign-in is already on. To use a new authenticator, turn it off first (that needs a code from your current authenticator app), then set it up again.',
        code: 'CONFLICT',
      },
      { status: 409 },
    );
  }
  const body = ((await req.json().catch(() => null)) ?? {}) as { currentPassword?: unknown };
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const origin = originFromHeaders(req.headers);
  const limiter = loginLimiter();
  const keys = attemptKeys('2fa-setup', userId, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const attempt = limiter.begin(keys, Date.now(), weights);
  if (!attempt.allowed) {
    const { body: tooMany, retryAfter } = tooManyAttempts(attempt.retryAfterMs);
    return NextResponse.json(tooMany, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      limiter.recordFailure(keys, Date.now(), weights);
      return NextResponse.json({ error: 'The current password is not correct.', code: 'FORBIDDEN' }, { status: 403 });
    }
    limiter.recordSuccess(keys.slice(0, -1));
  } finally {
    attempt.release();
  }

  // While two-factor sign-in is ON, the stored secret is the live second factor: replacing it would
  // lock the person out of their authenticator app, and would hand whoever holds just the session
  // cookie a secret they can make codes from (and then turn 2FA off with). Turning it off needs a
  // current code (/api/auth/2fa/disable); only then can a new authenticator be set up.
  const secret = generateSecret();
  const updated = await db
    .update(users)
    .set({ totpSecret: secret })
    .where(and(eq(users.id, userId), eq(users.totpEnabled, false)))
    .returning({ id: users.id });
  if (!updated.length) {
    return NextResponse.json(
      {
        error:
          'Two-factor sign-in is already on. To use a new authenticator, turn it off first (that needs a code from your current authenticator app), then set it up again.',
        code: 'CONFLICT',
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ secret, otpauthUrl: otpauthUrl(secret, user.email) });
}
