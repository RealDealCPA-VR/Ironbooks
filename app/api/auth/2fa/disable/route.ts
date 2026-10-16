/** POST /api/auth/2fa/disable — turn off 2FA (requires a valid current code). */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { users } from '@/lib/db/schema';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { verifyTotp } from '@/lib/totp';
import { logTransaction } from '@/lib/services/transactionLog';
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
  if (user?.totpEnabled && user.totpSecret) {
    // Code guesses are rate-limited like sign-in (per account, per address and globally), so a
    // hijacked session can't brute-force the 6-digit code to strip the second factor.
    const origin = originFromHeaders(req.headers);
    const limiter = loginLimiter();
    const keys = attemptKeys('2fa-disable', userId, origin.addr);
    const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
    const gate = limiter.begin(keys, Date.now(), weights);
    if (!gate.allowed) {
      const { body, retryAfter } = tooManyAttempts(gate.retryAfterMs);
      return NextResponse.json(body, { status: 429, headers: { 'Retry-After': retryAfter } });
    }
    try {
      if (!verifyTotp(user.totpSecret, String(token ?? ''), Date.now())) {
        limiter.recordFailure(keys, Date.now(), weights);
        return NextResponse.json({ error: 'Invalid code', code: 'FORBIDDEN' }, { status: 400 });
      }
      limiter.recordSuccess(keys.slice(0, -1));
    } finally {
      gate.release();
    }
  }
  await db.update(users).set({ totpEnabled: false, totpSecret: null }).where(eq(users.id, userId));
  await logTransaction(db, {
    userId,
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: `Turned off two-factor sign-in for user "${user?.name ?? userId}"`,
    data: { old: { totpEnabled: Boolean(user?.totpEnabled) }, new: { totpEnabled: false } },
  });
  return NextResponse.json({ ok: true, enabled: false });
}
