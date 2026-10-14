/** POST /api/portal/login — employee self-service login. Body: { email, password } */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { employees } from '@/lib/db/schema';
import { verifyPassword, createPortalToken, PORTAL_COOKIE } from '@/lib/auth';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';

export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}));
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    return NextResponse.json({ error: 'Email and password are required.', code: 'VALIDATION' }, { status: 400 });
  }
  // Rate-limited like the main sign-in (lib/net/rateLimit.ts).
  const origin = originFromHeaders(req.headers);
  const limiter = loginLimiter();
  const keys = attemptKeys('portal', email, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  // Admitted before the slow password hash, released after (parallel guesses count).
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body, retryAfter } = tooManyAttempts(gate.retryAfterMs);
    return NextResponse.json(body, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    const db = await getDb();
    const matches = await db.select().from(employees).where(eq(employees.email, email.trim().toLowerCase()));
    for (const emp of matches) {
      if (emp.portalPasswordHash && emp.isActive && (await verifyPassword(password, emp.portalPasswordHash))) {
        limiter.recordSuccess(keys.slice(0, -1));
        const res = NextResponse.json({ id: emp.id, name: `${emp.firstName} ${emp.lastName}` });
        res.cookies.set(PORTAL_COOKIE, createPortalToken(emp.id, emp.portalPasswordHash), {
          httpOnly: true,
          secure: cookieSecure(origin),
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 30,
        });
        return res;
      }
    }
    limiter.recordFailure(keys, Date.now(), weights);
    return NextResponse.json({ error: 'Invalid email or password.', code: 'FORBIDDEN' }, { status: 401 });
  } finally {
    gate.release();
  }
}
