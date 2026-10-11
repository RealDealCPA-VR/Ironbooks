/**
 * POST /api/auth/signup — create the first owner user + their company, then start a session.
 * Body: { name, email, password, companyName }
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { createCompany } from '@/lib/services/company';
import { hashPassword, createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { logTransaction } from '@/lib/services/transactionLog';
import { startSession } from '@/lib/services/sessions';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';

export async function POST(req: NextRequest) {
  const { name, email, password, companyName } = await req.json();
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    return NextResponse.json(
      { error: 'Name, email and a password (min 6 chars) are required.', code: 'VALIDATION' },
      { status: 400 },
    );
  }
  const db = await getDb();
  // Multi-user hosting: people connecting from other machines can never self-register into the
  // hosted company file (not even the first account — that would let a tailnet peer claim a
  // file whose owner works without sign-in). An admin adds them under Users instead.
  const origin = originFromHeaders(req.headers);
  if (origin.remote) {
    return NextResponse.json(
      { error: 'Ask an administrator of this company file to add you as a user.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (existing.length) {
    return NextResponse.json({ error: 'An account with that email already exists.', code: 'CONFLICT' }, { status: 409 });
  }

  const [user] = await db
    .insert(users)
    .values({ name: name.trim(), email: email.trim().toLowerCase(), passwordHash: await hashPassword(password) })
    .returning();
  await logTransaction(db, {
    userId: user.id,
    action: 'create',
    entityType: 'user',
    entityId: user.id,
    summary: `Created user "${user.name}" (${user.email})`,
    data: { new: { name: user.name, email: user.email } },
  });

  const company = await createCompany(db, { name: (companyName?.trim() || `${name}'s Company`), ownerId: user.id });

  const res = NextResponse.json({ id: user.id, name: user.name, email: user.email, companyId: company.id }, { status: 201 });
  const session = await startSession(db, {
    userId: user.id,
    companyId: company.id,
    remoteAddr: origin.addr,
    userAgent: origin.userAgent,
    viaHost: origin.remote,
  });
  const opts = { httpOnly: true, secure: cookieSecure(origin), sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 };
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id, 'user', session.id), opts);
  res.cookies.set(COMPANY_COOKIE, company.id, opts);
  return res;
}
