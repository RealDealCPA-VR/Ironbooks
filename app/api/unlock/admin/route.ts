/**
 * POST /api/unlock/admin — "Forgot the file password?" on the unlock screen.
 * Body: { login, password, totp? }
 *
 * A forgotten company-file password must never lock the file's own Admin out of their books
 * (QuickBooks Desktop has no separate "open file" password: the Admin's password is the gate).
 * An Admin of every company in the file signs in here with their own user name and password
 * (and authenticator code when two-step sign-in is on); the file password is removed, the file
 * is unlocked for this launch, and the Admin can set a new file password in Company File.
 *
 * Only for files NOT protected with passwords (encrypted files use the recovery key,
 * /api/auth/recover, which can also clear the file password), only on the computer that has the
 * file open, and rate-limited like sign-in.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, sealedMode, withDamagedFileAccess } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { UNLOCK_COOKIE, createUnlockToken, verifyPasswordTimed } from '@/lib/auth';
import { verifyTotp } from '@/lib/totp';
import { requireFileAdmin } from '@/lib/services/access';
import { getFileLockStatus, removeFilePasswordAsFileAdmin } from '@/lib/services/fileLock';
import { readProtection } from '@/lib/services/fileProtection';
import { logTransaction } from '@/lib/services/transactionLog';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';

const USE_RECOVERY_KEY =
  "This company file is protected with passwords. Use the company file's recovery key to remove the file password.";

export async function POST(req: NextRequest) {
  return withDamagedFileAccess(() => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const totp = typeof body.totp === 'string' ? body.totp.trim() : '';
  if (!login || !password) {
    return NextResponse.json({ error: "Enter an Admin's user name and password.", code: 'VALIDATION' }, { status: 400 });
  }
  const origin = originFromHeaders(req.headers);
  if (origin.remote) {
    return NextResponse.json(
      { error: 'Do this on the computer that has the company file open.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }
  // An encrypted file (or one still sealed on this computer) has a recovery key for this.
  if (sealedMode()) return NextResponse.json({ error: USE_RECOVERY_KEY, code: 'VALIDATION', details: { useRecoveryKey: true } }, { status: 400 });

  const limiter = loginLimiter();
  const keys = attemptKeys('unlock-admin', login, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body: tooMany, retryAfter } = tooManyAttempts(gate.retryAfterMs);
    return NextResponse.json(tooMany, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  const fail = (error: string) => {
    limiter.recordFailure(keys, Date.now(), weights);
    return NextResponse.json({ error, code: 'FORBIDDEN' }, { status: 403 });
  };
  try {
    const db = await getDb();
    if (await readProtection(db)) {
      return NextResponse.json({ error: USE_RECOVERY_KEY, code: 'VALIDATION', details: { useRecoveryKey: true } }, { status: 400 });
    }
    const [user] = await db.select().from(users).where(eq(users.email, login));
    // An unknown user name costs the same bcrypt work as a wrong password.
    if (!(await verifyPasswordTimed(password, user?.passwordHash)) || !user) {
      return fail('Invalid user name or password.');
    }
    if (user.totpEnabled && user.totpSecret) {
      if (!totp) return NextResponse.json({ requires2fa: true });
      if (!verifyTotp(user.totpSecret, totp, Date.now())) return fail('Invalid authentication code.');
    }
    try {
      await requireFileAdmin({ db, userId: user.id });
    } catch {
      return fail('Only an Admin of every company in this file can remove a forgotten file password.');
    }
    limiter.recordSuccess(keys.slice(0, -1));

    const companyName = (await getFileLockStatus(db)).companyName;
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as typeof db;
      const removed = await removeFilePasswordAsFileAdmin(tx);
      if (removed) {
        await logTransaction(tx, {
          userId: user.id,
          action: 'update',
          entityType: 'company_file',
          entityId: user.id,
          summary: `"${user.name}" signed in as Admin to remove a forgotten company file password`,
          data: { new: { filePasswordRemoved: true, viaAdminSignIn: true } },
        });
      }
    });

    const res = NextResponse.json({ ok: true, companyName });
    res.cookies.set(UNLOCK_COOKIE, createUnlockToken(), {
      httpOnly: true,
      secure: cookieSecure(origin),
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return res;
  } catch (err) {
    return routeError(err, 'POST /api/unlock/admin');
  } finally {
    gate.release();
  }
}
