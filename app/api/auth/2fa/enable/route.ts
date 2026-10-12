/** POST /api/auth/2fa/enable — verify a code against the pending secret and turn 2FA on. */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { users } from '@/lib/db/schema';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { verifyTotp } from '@/lib/totp';
import { logTransaction } from '@/lib/services/transactionLog';

export async function POST(req: NextRequest) {
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
  const { token } = (await req.json().catch(() => null)) ?? {};
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user?.totpSecret) {
    return NextResponse.json({ error: 'Run setup first', code: 'VALIDATION' }, { status: 400 });
  }
  if (!verifyTotp(user.totpSecret, String(token ?? ''), Date.now())) {
    return NextResponse.json({ error: 'Invalid code', code: 'FORBIDDEN' }, { status: 400 });
  }
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId));
  await logTransaction(db, {
    userId,
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: `Turned on two-factor sign-in for user "${user.name}"`,
    data: { old: { totpEnabled: false }, new: { totpEnabled: true } },
  });
  return NextResponse.json({ ok: true, enabled: true });
}
