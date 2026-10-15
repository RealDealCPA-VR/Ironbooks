/**
 * POST /api/auth/change-password — the signed-in person changes their own password (gapsb K).
 * Body: { currentPassword, newPassword }. The file's password policy applies (length, letters +
 * numbers, symbol, no reuse of recent passwords). This is also how an expired password (or one an
 * Admin asked to be changed) is replaced: such a session is refused everywhere else
 * (getServerContext), so this route uses getSessionGate. Wrong current passwords are rate-limited
 * like sign-in.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { changeOwnPassword } from '@/lib/services/passwordPolicy';
import { changePasswordSchema } from '@/lib/validation/users';
import { zodErrorBody } from '@/lib/validation/helpers';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest) {
  let gate;
  try {
    gate = await getSessionGate();
  } catch (err) {
    if (err instanceof ServiceError) return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    throw err;
  }
  const { db, userId } = gate;
  if (!userId) return NextResponse.json({ error: 'Authentication required.', code: 'FORBIDDEN' }, { status: 401 });

  const parsed = changePasswordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });

  const origin = originFromHeaders(req.headers);
  const limiter = loginLimiter();
  const keys = attemptKeys('change-password', userId, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const attempt = limiter.begin(keys, Date.now(), weights);
  if (!attempt.allowed) {
    const { body, retryAfter } = tooManyAttempts(attempt.retryAfterMs);
    return NextResponse.json(body, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    await changeOwnPassword(db, userId, parsed.data);
    limiter.recordSuccess(keys.slice(0, -1));
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ServiceError && /current password is not correct/.test(err.message)) {
      limiter.recordFailure(keys, Date.now(), weights);
    }
    return routeError(err, 'POST /api/auth/change-password');
  } finally {
    attempt.release();
  }
}
