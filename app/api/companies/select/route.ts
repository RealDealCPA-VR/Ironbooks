/**
 * POST /api/companies/select  — set the active company (cookie read by getServerContext).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { companies, userCompanies } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getSessionUserId } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { stampLastOpened } from '../[id]/manage';

export async function POST(req: NextRequest) {
  // Require a session and verify the caller is a member of the company before pointing
  // their active-company cookie at it. (getServerContext also re-validates membership, but
  // gating here stops an unauthenticated/non-member caller from planting the cookie at all.)
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 401 });
  }
  const { companyId } = await req.json();
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required', code: 'VALIDATION' }, { status: 400 });
  }
  const db = await getDb();
  const [membership] = await db
    .select({ companyId: userCompanies.companyId })
    .from(userCompanies)
    .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, companyId)));
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!c) {
    return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  // Recency ordering for the companies page: stamp settings.lastOpenedAt on every open.
  await stampLastOpened(db, companyId);
  const res = NextResponse.json({ ok: true, company: c });
  res.cookies.set(COMPANY_COOKIE, companyId, {
    httpOnly: true,
    secure: cookieSecure(originFromHeaders(req.headers)),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
