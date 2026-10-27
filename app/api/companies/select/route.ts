/**
 * POST /api/companies/select  — set the active company (cookie read by getServerContext).
 */
import { NextRequest, NextResponse } from 'next/server';
import { companies, userCompanies } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { COMPANY_COOKIE, DEACTIVATED_MESSAGE, getSessionGate, isArchivedCompany } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { stampLastOpened } from '../[id]/manage';
import { stripSecrets } from '@/lib/permissions/mask';

export async function POST(req: NextRequest) {
  // Require a session (file lock, file binding and deactivation checked by getSessionGate) and
  // verify the caller is an ACTIVE member of the company before pointing their active-company
  // cookie at it. (getServerContext also re-validates membership, but gating here stops an
  // unauthenticated/non-member caller from planting the cookie at all.)
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
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const companyId = typeof body?.companyId === 'string' ? body.companyId : '';
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required', code: 'VALIDATION' }, { status: 400 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  const [membership] = await db
    .select({ companyId: userCompanies.companyId, isActive: userCompanies.isActive })
    .from(userCompanies)
    .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, companyId)));
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  if (membership.isActive === false) {
    return NextResponse.json({ error: DEACTIVATED_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
  }
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  // Archived (soft-deleted) companies can't be opened (same rule as getServerContext).
  if (!c || isArchivedCompany(c.settings)) {
    return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  // Recency ordering for the companies page: stamp settings.lastOpenedAt on every open.
  await stampLastOpened(db, companyId);
  const res = NextResponse.json({ ok: true, company: stripSecrets(c) });
  res.cookies.set(COMPANY_COOKIE, companyId, {
    httpOnly: true,
    secure: cookieSecure(originFromHeaders(req.headers)),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
