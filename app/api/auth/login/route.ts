/**
 * POST /api/auth/login — verify credentials, start a session, select the user's company.
 * Body: { email, password, totp? } — `email` is the user's login (an email or a user name).
 *
 * Per-company-file login: the file password (if set) must be entered first (/unlock), the user
 * must have an ACTIVE membership in a company of this file, and the issued session token is
 * bound to this company file (lib/auth companyFileId).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users, userCompanies, companies } from '@/lib/db/schema';
import {
  verifyPassword,
  createSessionToken,
  hasValidUnlockCookie,
  SESSION_COOKIE,
} from '@/lib/auth';
import { verifyTotp } from '@/lib/totp';
import { COMPANY_COOKIE, DEACTIVATED_MESSAGE } from '@/lib/context';
import { getFileLockStatus } from '@/lib/services/fileLock';

export async function POST(req: NextRequest) {
  const { email, password, totp } = await req.json();
  if (!email?.trim() || !password) {
    return NextResponse.json({ error: 'Email and password are required.', code: 'VALIDATION' }, { status: 400 });
  }
  const db = await getDb();
  // The company-file password gates the file BEFORE any user login (QB order). Same message as
  // getServerContext so lib/client.ts sends the browser to /unlock.
  const lock = await getFileLockStatus(db);
  if (lock.enabled && !(await hasValidUnlockCookie())) {
    return NextResponse.json(
      { error: 'This company file is locked. Unlock it to continue.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: 'Invalid email or password.', code: 'FORBIDDEN' }, { status: 401 });
  }

  // Second factor (TOTP) when enabled.
  if (user.totpEnabled && user.totpSecret) {
    if (!totp) {
      return NextResponse.json({ requires2fa: true });
    }
    if (!verifyTotp(user.totpSecret, String(totp), Date.now())) {
      return NextResponse.json({ error: 'Invalid authentication code.', code: 'FORBIDDEN' }, { status: 401 });
    }
  }

  // Find a company for this user (ACTIVE membership first, else owned).
  const memberships = await db
    .select({ companyId: userCompanies.companyId, isActive: userCompanies.isActive })
    .from(userCompanies)
    .where(eq(userCompanies.userId, user.id));
  let companyId = memberships.find((m) => m.isActive)?.companyId;
  if (!companyId && memberships.length) {
    // Deactivated in every company of this file (Users & Roles) — no session.
    return NextResponse.json({ error: DEACTIVATED_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
  }
  if (!companyId) {
    const [owned] = await db.select({ id: companies.id }).from(companies).where(eq(companies.ownerId, user.id)).limit(1);
    companyId = owned?.id;
  }

  const res = NextResponse.json({ id: user.id, name: user.name, email: user.email, companyId });
  const opts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 };
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), opts);
  if (companyId) res.cookies.set(COMPANY_COOKIE, companyId, opts);
  return res;
}
