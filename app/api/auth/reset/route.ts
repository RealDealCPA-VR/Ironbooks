/**
 * POST /api/auth/reset — complete a password reset with a valid, unexpired token.
 * Body: { token, password }
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hasValidUnlockCookie, MIN_PASSWORD_LENGTH } from '@/lib/auth';
import { ServiceError } from '@/lib/services/_base';
import { assertPasswordAllowed, storeUserPassword } from '@/lib/services/passwordPolicy';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { endUserSessions } from '@/lib/services/sessions';
import { logTransaction } from '@/lib/services/transactionLog';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, resetLimiter, tooManyResets } from '@/lib/net/rateLimit';
import { invalidJsonBody, readJsonObject } from '@/lib/routeErrors';

export async function POST(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const { token, password } = body;
  if (
    typeof token !== 'string' ||
    !token ||
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH
  ) {
    return NextResponse.json(
      {
        error: `A valid token and a new password (min ${MIN_PASSWORD_LENGTH} chars) are required.`,
        code: 'VALIDATION',
      },
      { status: 400 },
    );
  }

  // Rate limit wrong-token guesses (per address and globally).
  const origin = originFromHeaders(req.headers);
  const limiter = resetLimiter();
  const keys = attemptKeys('reset', null, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body: tooMany, retryAfter } = tooManyResets(gate.retryAfterMs);
    return NextResponse.json(tooMany, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    const db = await getDb();
    const lock = await getFileLockStatus(db);
    if (lock.enabled && !(await hasValidUnlockCookie())) {
      return NextResponse.json(
        { error: 'This company file is locked. Unlock it to continue.', code: 'FORBIDDEN' },
        { status: 403 },
      );
    }
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.resetToken, token), gt(users.resetExpires, new Date())));
    if (!user) {
      limiter.recordFailure(keys, Date.now(), weights);
      return NextResponse.json({ error: 'Invalid or expired reset token.', code: 'FORBIDDEN' }, { status: 400 });
    }
    // gapsb K: the file's password policy (incl. "don't reuse the last N passwords").
    try {
      await assertPasswordAllowed(db, password, { userId: user.id });
    } catch (err) {
      if (err instanceof ServiceError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
      }
      throw err;
    }
    // New hash + change date; clears the token and any "must change" flag.
    await storeUserPassword(db, user.id, password);
    // Whoever held the old password is signed out everywhere (server-side session rows).
    await endUserSessions(db, user.id, 'password_reset');
    // Running transaction log: user/security changes are logged (never the password itself).
    await logTransaction(db, {
      userId: user.id,
      action: 'update',
      entityType: 'user',
      entityId: user.id,
      summary: `Reset the password for user "${user.name}"`,
      data: { new: { email: user.email, passwordChanged: true } },
    });
    return NextResponse.json({ ok: true });
  } finally {
    gate.release();
  }
}
