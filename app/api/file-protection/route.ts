/**
 * Company > Security: protect the company file with passwords (lib/services/fileProtection.ts).
 *  GET  /api/file-protection  -> ProtectionStatus (who can open the file; Admins see every user)
 *  POST /api/file-protection  { password } -> { recoveryKey, status }
 *
 * Turning protection on needs an Admin of every company in the file and their own password (asked
 * again, rate-limited like sign-in). The answer carries the recovery key ONCE: the page shows it to
 * be printed or saved and never asks the server for it again. Acts on the whole FILE, through the
 * signed-in user's session ('self' in lib/permissions/routes.ts, getSessionGate).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionGate } from '@/lib/context';
import { enableProtection, protectionStatus } from '@/lib/services/fileProtection';
import { ServiceError } from '@/lib/services/_base';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const { db, userId } = await getSessionGate();
    if (!userId) return NextResponse.json({ error: 'Authentication required.', code: 'FORBIDDEN' }, { status: 401 });
    return NextResponse.json(await protectionStatus({ db, userId }));
  } catch (err) {
    return routeError(err, 'GET /api/file-protection');
  }
}

export async function POST(req: NextRequest) {
  try {
    const { db, userId } = await getSessionGate();
    if (!userId) return NextResponse.json({ error: 'Authentication required.', code: 'FORBIDDEN' }, { status: 401 });
    const origin = originFromHeaders(req.headers);
    if (origin.remote) {
      return NextResponse.json({ error: 'Protect the company file on the computer that has it open.', code: 'FORBIDDEN' }, { status: 403 });
    }
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const limiter = loginLimiter();
    const keys = attemptKeys('protect', userId, origin.addr);
    const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
    const gate = limiter.begin(keys, Date.now(), weights);
    if (!gate.allowed) {
      const { body: tooMany, retryAfter } = tooManyAttempts(gate.retryAfterMs);
      return NextResponse.json(tooMany, { status: 429, headers: { 'Retry-After': retryAfter } });
    }
    try {
      const { recoveryKey } = await enableProtection({ db, userId }, { password: typeof body.password === 'string' ? body.password : '' });
      limiter.recordSuccess(keys.slice(0, -1));
      return NextResponse.json({ ok: true, recoveryKey, status: await protectionStatus({ db, userId }) });
    } catch (err) {
      if (err instanceof ServiceError && (err.details as { wrongPassword?: boolean } | undefined)?.wrongPassword) {
        limiter.recordFailure(keys, Date.now(), weights);
      }
      throw err;
    } finally {
      gate.release();
    }
  } catch (err) {
    return routeError(err, 'POST /api/file-protection');
  }
}
