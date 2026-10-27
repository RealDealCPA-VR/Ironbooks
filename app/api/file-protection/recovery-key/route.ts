/**
 * POST /api/file-protection/recovery-key { password } -> { recoveryKey } — Company > Security:
 * make a new recovery key for the protected company file (lib/services/fileProtection.ts
 * regenerateRecoveryKey). The old key stops opening the file from its next save (older backups and
 * copies keep the key they were made with). An Admin of every company, with their password
 * (rate-limited like sign-in); the new key is in this answer only, once.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionGate } from '@/lib/context';
import { protectionStatus, regenerateRecoveryKey } from '@/lib/services/fileProtection';
import { ServiceError } from '@/lib/services/_base';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest) {
  try {
    const { db, userId } = await getSessionGate();
    if (!userId) return NextResponse.json({ error: 'Authentication required.', code: 'FORBIDDEN' }, { status: 401 });
    const origin = originFromHeaders(req.headers);
    if (origin.remote) {
      return NextResponse.json({ error: 'Make a new recovery key on the computer that has the company file open.', code: 'FORBIDDEN' }, { status: 403 });
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
      const { recoveryKey } = await regenerateRecoveryKey({ db, userId }, { password: typeof body.password === 'string' ? body.password : '' });
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
    return routeError(err, 'POST /api/file-protection/recovery-key');
  }
}
