/**
 * POST /api/unlock — open the company-file lock.
 *
 * Verifies a submitted file password (or passes straight through when the file has no password)
 * and, on success, sets the signed `bka_unlock` cookie that getServerContext + middleware require.
 * Uses the database directly (NOT getServerContext), since the whole point is to run before the
 * file is unlocked.
 *
 * A company file protected with passwords that still has to be decrypted (lib/db/sealed.ts): its
 * file password is inside the encrypted file, so this answers ok with a "sign-in screen only"
 * token (lib/auth createUnlockToken pre) — the sign-in decrypts the file and then asks for the
 * file password on the same screen (app/api/auth/login).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDb, sealedMode, withDamagedFileAccess, withSealedAccess } from '@/lib/db';
import { getFileLockStatus, verifyFilePassword } from '@/lib/services/fileLock';
import { readProtection } from '@/lib/services/fileProtection';
import { UNLOCK_COOKIE, createUnlockToken } from '@/lib/auth';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';

// Signing in (and unlocking the file) must work even when the company file's ledger is damaged
// (lib/db/index.ts refuses it everywhere else): it is the only way to reach Back Up and Restore
// and replace the file with a good backup. Nothing here reads or writes the ledger.
export async function POST(req: NextRequest) {
  return withDamagedFileAccess(() => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const sealed = sealedMode();
  if (sealed === 'extract' || sealed === 'conflict') {
    const origin = originFromHeaders(req.headers);
    const res = NextResponse.json({ ok: true, sealed: true });
    res.cookies.set(UNLOCK_COOKIE, createUnlockToken({ pre: true }), {
      httpOnly: true,
      secure: cookieSecure(origin),
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return res;
  }
  // The working copy already on this computer ('key'): its file password is readable before sign-in.
  const db = sealed === 'key' ? await withSealedAccess(() => getDb()) : await getDb();

  let password = '';
  try {
    const body = await req.json();
    if (typeof body?.password === 'string') password = body.password;
  } catch {
    /* empty / non-JSON body → treated as an empty password (only succeeds when unprotected) */
  }

  const status = await getFileLockStatus(db);
  // For "Forgot the file password?": an encrypted file is opened with its recovery key; any other
  // file by an Admin signing in (/api/unlock/admin).
  const recovery = status.enabled ? (sealed === 'key' || (await readProtection(db)) ? 'recovery-key' : 'admin') : undefined;
  // The unlock screen asks with an EMPTY password every time it loads (a file without a password
  // opens straight through). On a protected file that probe is not a guess: answer "protected"
  // without counting it, or a few page loads would lock the person out before they typed anything.
  if (status.enabled && !password) {
    return NextResponse.json({ ok: false, enabled: true, companyName: status.companyName, recovery }, { status: 401 });
  }
  // File-password guessing is rate-limited like sign-in (the file password is one shared secret,
  // so the "account" key is the file itself).
  const origin = originFromHeaders(req.headers);
  const limiter = loginLimiter();
  const keys = attemptKeys('unlock', status.enabled ? 'file' : null, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  let ok = !status.enabled;
  if (status.enabled) {
    // Admitted before the slow password hash, released after (parallel guesses count).
    const gate = limiter.begin(keys, Date.now(), weights);
    if (!gate.allowed) {
      const { body, retryAfter } = tooManyAttempts(gate.retryAfterMs);
      return NextResponse.json({ ok: false, enabled: true, ...body }, { status: 429, headers: { 'Retry-After': retryAfter } });
    }
    try {
      ok = await verifyFilePassword(db, password);
      if (!ok) limiter.recordFailure(keys, Date.now(), weights);
    } finally {
      gate.release();
    }
  }
  if (!ok) {
    return NextResponse.json(
      { ok: false, enabled: true, companyName: status.companyName, recovery },
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
