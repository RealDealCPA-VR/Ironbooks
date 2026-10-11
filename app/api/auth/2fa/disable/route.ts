/** POST /api/auth/2fa/disable — turn off 2FA (requires a valid current code). */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { getSessionUserId } from '@/lib/auth';
import { verifyTotp } from '@/lib/totp';
import { logTransaction } from '@/lib/services/transactionLog';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
  const { token } = await req.json();
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (user?.totpEnabled && user.totpSecret && !verifyTotp(user.totpSecret, String(token ?? ''), Date.now())) {
    return NextResponse.json({ error: 'Invalid code', code: 'FORBIDDEN' }, { status: 400 });
  }
  await db.update(users).set({ totpEnabled: false, totpSecret: null }).where(eq(users.id, userId));
  await logTransaction(db, {
    userId,
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: `Turned off two-factor sign-in for user "${user?.name ?? userId}"`,
    data: { old: { totpEnabled: Boolean(user?.totpEnabled) }, new: { totpEnabled: false } },
  });
  return NextResponse.json({ ok: true, enabled: false });
}
