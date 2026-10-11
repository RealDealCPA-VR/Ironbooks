/** POST /api/auth/2fa/setup — generate a TOTP secret for the current user (not yet enabled). */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
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

  const secret = generateSecret();
  await db.update(users).set({ totpSecret: secret }).where(eq(users.id, userId));
  return NextResponse.json({ secret, otpauthUrl: otpauthUrl(secret, user.email) });
}
