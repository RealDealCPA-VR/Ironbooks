/**
 * POST /api/auth/signup — create the first owner user + their company, then start a session.
 * Body: { name, email, password, companyName }
 *
 * Users live inside the company file, and only its Admin adds more (Users & Roles), so self
 * sign-up is only open while the file has no real user yet (the seeded demo user, whose
 * password hash is the sentinel 'dev', doesn't count). The file password still applies.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { createCompany } from '@/lib/services/company';
import {
  hashPassword,
  createSessionToken,
  hasValidUnlockCookie,
  SESSION_COOKIE,
} from '@/lib/auth';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { COMPANY_COOKIE } from '@/lib/context';

export async function POST(req: NextRequest) {
  const { name, email, password, companyName } = await req.json();
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    return NextResponse.json(
      { error: 'Name, email and a password (min 6 chars) are required.', code: 'VALIDATION' },
      { status: 400 },
    );
  }
  const db = await getDb();
  const lock = await getFileLockStatus(db);
  if (lock.enabled && !(await hasValidUnlockCookie())) {
    return NextResponse.json(
      { error: 'This company file is locked. Unlock it to continue.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }
  const [realUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(ne(users.passwordHash, 'dev'))
    .limit(1);
  if (realUser) {
    return NextResponse.json(
      {
        error:
          'This company file already has users. Ask your administrator to add you in Users & Roles.',
        code: 'FORBIDDEN',
      },
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

  const company = await createCompany(db, { name: (companyName?.trim() || `${name}'s Company`), ownerId: user.id });

  const res = NextResponse.json({ id: user.id, name: user.name, email: user.email, companyId: company.id }, { status: 201 });
  const opts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 };
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), opts);
  res.cookies.set(COMPANY_COOKIE, company.id, opts);
  return res;
}
