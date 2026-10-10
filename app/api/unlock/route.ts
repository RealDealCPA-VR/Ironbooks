/**
 * POST /api/unlock — open the company-file lock.
 *
 * Verifies a submitted file password (or passes straight through when the file has no password)
 * and, on success, sets the signed `bka_unlock` cookie that getServerContext + middleware require.
 * Uses the database directly (NOT getServerContext), since the whole point is to run before the
 * file is unlocked.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFileLockStatus, verifyFilePassword } from '@/lib/services/fileLock';
import { UNLOCK_COOKIE, createUnlockToken } from '@/lib/auth';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';

export async function POST(req: NextRequest) {
  const db = await getDb();

  let password = '';
  try {
    const body = await req.json();
    if (typeof body?.password === 'string') password = body.password;
  } catch {
    /* empty / non-JSON body → treated as an empty password (only succeeds when unprotected) */
  }

  const status = await getFileLockStatus(db);
  // File-password guessing is rate-limited like sign-in (the file password is one shared secret,
  // so the "account" key is the file itself).
  const origin = originFromHeaders(req.headers);
  const limiter = loginLimiter();
  const keys = attemptKeys('unlock', status.enabled ? 'file' : null, origin.addr);
  if (status.enabled) {
    const gate = limiter.check(keys);
    if (!gate.allowed) {
      const { body, retryAfter } = tooManyAttempts(gate.retryAfterMs);
      return NextResponse.json({ ok: false, enabled: true, ...body }, { status: 429, headers: { 'Retry-After': retryAfter } });
    }
  }
  const ok = !status.enabled || (await verifyFilePassword(db, password));
  if (!ok) {
    limiter.recordFailure(keys, Date.now(), { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT });
    return NextResponse.json(
      { ok: false, enabled: true, companyName: status.companyName },
      { status: 401 },
    );
  }

  if (status.enabled) limiter.recordSuccess(keys.slice(0, -1));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(UNLOCK_COOKIE, createUnlockToken(), {
    httpOnly: true,
    secure: cookieSecure(origin),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return res;
}
