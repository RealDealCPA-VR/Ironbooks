/**
 * POST /api/auth/request-reset — issue a password-reset token.
 * Body: { email }. Desktop app has no mail server, so in the offline desktop build the token is
 * returned directly — but ONLY as single-user self-recovery (see below). Otherwise always 200
 * with a generic message to avoid email enumeration.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { eq, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hasValidUnlockCookie } from '@/lib/auth';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, resetLimiter, tooManyResets } from '@/lib/net/rateLimit';
import { invalidJsonBody, readJsonObject } from '@/lib/routeErrors';

const MULTI_USER_RESET_MESSAGE =
  'This company file has more than one user, so passwords cannot be reset from this screen. ' +
  'Ask an Admin to reset your password in Users & Roles.';

export async function POST(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const generic = { ok: true, message: 'If that account exists, a reset token has been generated.' };
  if (!email) return NextResponse.json(generic);

  // Rate limit: every reset REQUEST counts (per account, per address, and globally).
  const origin = originFromHeaders(req.headers);
  const limiter = resetLimiter();
  const keys = attemptKeys('reset-request', email, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body: tooMany, retryAfter } = tooManyResets(gate.retryAfterMs);
    return NextResponse.json(tooMany, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    limiter.recordFailure(keys, Date.now(), weights);
    const db = await getDb();

    // The file password (if set) gates everything in the file, password resets included.
    const lock = await getFileLockStatus(db);
    if (lock.enabled && !(await hasValidUnlockCookie())) {
      return NextResponse.json(
        { error: 'This company file is locked. Unlock it to continue.', code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    // SECURITY: the offline desktop build (BKA_OFFLINE=1, server on 127.0.0.1) hands the token
    // straight back. That is only safe as single-user self-recovery: on a file with several
    // users, anyone at this machine (e.g. a restricted clerk) could otherwise reset the owner's
    // password. With more than one real user, an Admin resets passwords in Users & Roles
    // (/api/users/[id]/reset-password, which enforces assertCanManageUser).
    const offlineLocal = process.env.BKA_OFFLINE === '1' && !origin.remote;
    if (offlineLocal) {
      const realUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(ne(users.passwordHash, 'dev'))
        .limit(2);
      if (realUsers.length > 1) {
        return NextResponse.json({ error: MULTI_USER_RESET_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
      }
    }

    const [user] = await db.select().from(users).where(eq(users.email, email));
    // The seeded demo user (sentinel hash 'dev') is not a real account and can't be "recovered".
    if (!user || user.passwordHash === 'dev') return NextResponse.json(generic);

    const token = crypto.randomBytes(24).toString('hex');
    await db
      .update(users)
      .set({ resetToken: token, resetExpires: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(users.id, user.id));

    // SECURITY: never return the reset token in the HTTP response on a networked deployment —
    // anyone who knows an email could take over the account. The token is logged server-side so
    // a local operator can retrieve it; a hosted deployment should email a reset link instead.
    console.log(`[auth/request-reset] reset token for ${user.email}: ${token}`);
    // Multi-user hosting: a request relayed from another machine is NOT local, so it never gets
    // the token even in the desktop build (anyone on the tailnet could otherwise take over).
    if (offlineLocal) return NextResponse.json({ ...generic, token });
    return NextResponse.json(generic);
  } finally {
    gate.release();
  }
}
