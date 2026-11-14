/**
 * POST /api/auth/2fa/enable — verify a code against the pending secret and turn 2FA on. The answer
 * carries the user's ten one-time recovery codes (the only time they can be read).
 *
 * Only while 2FA is OFF (setup → enable): once it is on, the stored secret is the live one, and
 * re-running this would let a hijacked session guess codes until it gets a fresh set of recovery
 * codes (and with them a way to switch the second factor off). Code guesses are rate-limited like
 * sign-in (per account, per address and globally), as on 2fa/disable and 2fa/recovery-codes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { users } from '@/lib/db/schema';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { verifyTotp } from '@/lib/totp';
import { logTransaction } from '@/lib/services/transactionLog';
import { issueRecoveryCodes } from '@/lib/services/recoveryCodes';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';

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
  const { token } = (await req.json().catch(() => null)) ?? {};
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (user?.totpEnabled) {
    return NextResponse.json({ error: 'Two-factor sign-in is already on.', code: 'CONFLICT' }, { status: 409 });
  }
  if (!user?.totpSecret) {
    return NextResponse.json({ error: 'Run setup first', code: 'VALIDATION' }, { status: 400 });
  }
  const origin = originFromHeaders(req.headers);
  const limiter = loginLimiter();
  const keys = attemptKeys('2fa-enable', userId, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const attempt = limiter.begin(keys, Date.now(), weights);
  if (!attempt.allowed) {
    const { body, retryAfter } = tooManyAttempts(attempt.retryAfterMs);
    return NextResponse.json(body, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    if (!verifyTotp(user.totpSecret, String(token ?? ''), Date.now())) {
      limiter.recordFailure(keys, Date.now(), weights);
      return NextResponse.json({ error: 'Invalid code', code: 'FORBIDDEN' }, { status: 400 });
    }
    limiter.recordSuccess(keys.slice(0, -1));
  } finally {
    attempt.release();
  }
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId));
  // prefsperms: ten one-time recovery codes, shown this once (lib/services/recoveryCodes.ts).
  const recoveryCodes = await issueRecoveryCodes(db, userId);
  await logTransaction(db, {
    userId,
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: `Turned on two-factor sign-in for user "${user.name}"`,
    data: { old: { totpEnabled: false }, new: { totpEnabled: true } },
  });
  return NextResponse.json({ ok: true, enabled: true, recoveryCodes });
}
