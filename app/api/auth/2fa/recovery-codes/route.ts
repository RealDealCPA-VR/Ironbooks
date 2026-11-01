/**
 * Own two-factor RECOVERY codes (prefsperms; lib/services/recoveryCodes.ts).
 *
 *   GET  → { enabled, remaining }   is two-factor sign-in on, and how many unused codes are left
 *   POST { token } → { recoveryCodes }  ten NEW codes (every old one stops working); needs a
 *        current 6-digit code from the authenticator app — a stolen session cookie alone can't
 *        mint codes. Attempts are rate-limited like sign-in.
 *
 * Mapped 'self' (lib/permissions/routes.ts): any signed-in user, for their own login only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { users } from '@/lib/db/schema';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { verifyTotp } from '@/lib/totp';
import { issueRecoveryCodes, recoveryCodesLeft } from '@/lib/services/recoveryCodes';
import { logTransaction } from '@/lib/services/transactionLog';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';

async function gateOrError() {
  try {
    return { gate: await getSessionGate() };
  } catch (err) {
    if (err instanceof ServiceError) {
      return { error: NextResponse.json({ error: err.message, code: err.code }, { status: 403 }) };
    }
    throw err;
  }
}

export async function GET() {
  const r = await gateOrError();
  if (r.error) return r.error;
  const { db, userId } = r.gate;
  if (!userId) return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
  const [user] = await db.select({ on: users.totpEnabled }).from(users).where(eq(users.id, userId));
  const enabled = Boolean(user?.on);
  return NextResponse.json({ enabled, remaining: enabled ? await recoveryCodesLeft(db, userId) : 0 });
}

export async function POST(req: NextRequest) {
  const r = await gateOrError();
  if (r.error) return r.error;
  const { db, userId } = r.gate;
  if (!userId) return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
  const { token } = (await req.json().catch(() => null)) ?? {};
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user?.totpEnabled || !user.totpSecret) {
    return NextResponse.json(
      { error: 'Two-factor sign-in is off. Turn it on first; you get recovery codes when you do.', code: 'VALIDATION' },
      { status: 400 },
    );
  }
  const origin = originFromHeaders(req.headers);
  const limiter = loginLimiter();
  const keys = attemptKeys('2fa-recovery', userId, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body, retryAfter } = tooManyAttempts(gate.retryAfterMs);
    return NextResponse.json(body, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    if (!verifyTotp(user.totpSecret, String(token ?? ''), Date.now())) {
      limiter.recordFailure(keys, Date.now(), weights);
      return NextResponse.json(
        { error: 'Enter the current 6-digit code from your authenticator app.', code: 'FORBIDDEN' },
        { status: 400 },
      );
    }
    limiter.recordSuccess(keys.slice(0, -1));
  } finally {
    gate.release();
  }
  const recoveryCodes = await issueRecoveryCodes(db, userId);
  await logTransaction(db, {
    userId,
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: `Made new two-factor recovery codes for user "${user.name}"`,
    data: { new: { recoveryCodesRenewed: true } },
  });
  return NextResponse.json({ ok: true, recoveryCodes });
}
