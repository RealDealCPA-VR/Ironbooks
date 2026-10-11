/**
 * GET  /api/companies  — list the caller's company files
 * POST /api/companies  — create a new company (seeds a default Chart of Accounts)
 *
 * SECURITY: middleware excludes /api from the session check, so these handlers must fail
 * closed themselves (mirrors app/api/companies/select/route.ts and lib/context.ts). The only
 * session-less path allowed is genuine first-run — before any user account exists — so
 * onboarding can boot (or an explicit BKA_ALLOW_DEV_FALLBACK=1).
 */
import { NextRequest, NextResponse } from 'next/server';
import type { DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import {
  listCompanies,
  listCompaniesForUser,
  createCompany,
  ensureDevCompany,
} from '@/lib/services/company';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' || err.code === 'UNBALANCED' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[companies] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** First-run carve-out: allow session-less access only before any user exists. */
async function allowFirstRun(db: DB): Promise<boolean> {
  if (process.env.BKA_ALLOW_DEV_FALLBACK === '1') return true;
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  return !anyUser;
}

export async function GET(req: NextRequest) {
  try {
    // File lock, file-bound session and deactivation checks (lib/context.ts getSessionGate).
    const { db, userId } = await getSessionGate();
    if (userId) {
      // Scope to the caller's ACTIVE memberships — never list other tenants' company files.
      // Archived (soft-deleted) files are hidden by default; ?includeArchived=1 overrides.
      const includeArchived = req.nextUrl.searchParams.get('includeArchived') === '1';
      return NextResponse.json(
        await listCompaniesForUser(db, userId, { excludeArchived: !includeArchived }),
      );
    }
    if (!(await allowFirstRun(db))) {
      return NextResponse.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 401 });
    }
    await ensureDevCompany(db); // first run: guarantee at least one
    return NextResponse.json(await listCompanies(db));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { db, userId: sessionUserId } = await getSessionGate();
    if (!sessionUserId && !(await allowFirstRun(db))) {
      return NextResponse.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 401 });
    }
    const body = await req.json().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'Company name is required', code: 'VALIDATION' }, { status: 400 });
    }
    // Owner = the authenticated user; first-run only, fall back to the seeded dev user.
    const ownerId = sessionUserId ?? (await ensureDevCompany(db)).userId;
    const company = await createCompany(db, { name, ownerId });
    return NextResponse.json(company, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
