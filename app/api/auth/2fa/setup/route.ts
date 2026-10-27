/** POST /api/auth/2fa/setup — generate a TOTP secret for the current user (not yet enabled). */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { users } from '@/lib/db/schema';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { generateSecret, otpauthUrl } from '@/lib/totp';

export async function POST() {
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
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });

  // While two-factor sign-in is ON, the stored secret is the live second factor: replacing it would
  // lock the person out of their authenticator app, and would hand whoever holds just the session
  // cookie a secret they can make codes from (and then turn 2FA off with). Turning it off needs a
  // current code (/api/auth/2fa/disable); only then can a new authenticator be set up.
  const secret = generateSecret();
  const updated = await db
    .update(users)
    .set({ totpSecret: secret })
    .where(and(eq(users.id, userId), eq(users.totpEnabled, false)))
    .returning({ id: users.id });
  if (!updated.length) {
    return NextResponse.json(
      {
        error:
          'Two-factor sign-in is already on. To use a new authenticator, turn it off first (that needs a code from your current authenticator app), then set it up again.',
        code: 'CONFLICT',
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ secret, otpauthUrl: otpauthUrl(secret, user.email) });
}
