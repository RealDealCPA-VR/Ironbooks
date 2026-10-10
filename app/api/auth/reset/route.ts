/**
 * POST /api/auth/reset — complete a password reset with a valid, unexpired token.
 * Body: { token, password }
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth';
import { logTransaction } from '@/lib/services/transactionLog';

export async function POST(req: NextRequest) {
  const { token, password } = await req.json();
  if (!token || !password || password.length < 6) {
    return NextResponse.json(
      { error: 'A valid token and a new password (min 6 chars) are required.', code: 'VALIDATION' },
      { status: 400 },
    );
  }
  const db = await getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.resetToken, token), gt(users.resetExpires, new Date())));
  if (!user) {
    return NextResponse.json({ error: 'Invalid or expired reset token.', code: 'FORBIDDEN' }, { status: 400 });
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), resetToken: null, resetExpires: null })
    .where(eq(users.id, user.id));
  // Running transaction log: user/security changes are logged (never the password itself).
  await logTransaction(db, {
    userId: user.id,
    action: 'update',
    entityType: 'user',
    entityId: user.id,
    summary: `Reset the password for user "${user.name}"`,
    data: { new: { email: user.email, passwordChanged: true } },
  });
  return NextResponse.json({ ok: true });
}
