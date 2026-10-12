/**
 * POST /api/auth/request-reset — issue a password-reset token.
 * Body: { email }. Desktop app has no mail server, so the token is returned directly (in a hosted
 * deployment you would email a link instead). Always 200 to avoid email enumeration.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { originFromHeaders } from '@/lib/net/requestInfo';

export async function POST(req: NextRequest) {
  const { email } = await req.json();
  const db = await getDb();
  const generic = { ok: true, message: 'If that account exists, a reset token has been generated.' };
  if (!email?.trim()) return NextResponse.json(generic);

  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (!user) return NextResponse.json(generic);

  const token = crypto.randomBytes(24).toString('hex');
  await db
    .update(users)
    .set({ resetToken: token, resetExpires: new Date(Date.now() + 60 * 60 * 1000) })
    .where(eq(users.id, user.id));

  // SECURITY: never return the reset token in the HTTP response on a networked deployment —
  // anyone who knows an email could take over the account. Only the offline desktop build
  // (server bound to 127.0.0.1, BKA_OFFLINE=1) surfaces it for local convenience. In all
  // cases the token is logged server-side so a local operator can retrieve it; a hosted
  // deployment should email a reset link instead.
  console.log(`[auth/request-reset] reset token for ${user.email}: ${token}`);
  // Multi-user hosting: a request relayed from another machine is NOT local, so it never gets
  // the token even in the desktop build (anyone on the tailnet could otherwise take over).
  if (process.env.BKA_OFFLINE === '1' && !originFromHeaders(req.headers).remote) {
    return NextResponse.json({ ...generic, token });
  }
  return NextResponse.json(generic);
}
