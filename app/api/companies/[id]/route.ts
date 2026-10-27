/**
 * PATCH  /api/companies/[id]  — rename a company file (Company & Preferences: modify).
 * DELETE /api/companies/[id]  — archive (soft-delete) a company file (Company: delete;
 *                               ?confirm=<exact company name> required; refuses the
 *                               caller's only active company). See manage.ts for why
 *                               this is a soft delete rather than a hard cascade.
 *
 * SECURITY: middleware excludes /api from the session check, so these handlers fail closed
 * themselves (mirrors app/api/companies/route.ts). No first-run carve-out here — managing an
 * existing company always requires a session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionGate } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { archiveCompany, renameCompany } from './manage';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { stripSecrets } from '@/lib/permissions/mask';
import { assertSessionAllowed } from '@/lib/services/sessions';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[companies/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    // File lock, file-bound session and deactivation checks (lib/context.ts getSessionGate);
    // manage.ts then checks the caller's effective permissions in the company named by the URL.
    const { db, userId, sessionId } = await getSessionGate();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 401 });
    }
    const { id } = await params;
    // Single-user mode keeps everyone but its holder out of the company — renaming it included.
    await assertSessionAllowed(db, sessionId, id);
    const body = await req.json().catch(() => null);
    if (typeof body?.name !== 'string') {
      return NextResponse.json({ error: 'name is required', code: 'VALIDATION' }, { status: 400 });
    }
    const company = await renameCompany(db, userId, id, body.name);
    return NextResponse.json(stripSecrets(company));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    // File lock, file-bound session and deactivation checks (lib/context.ts getSessionGate);
    // manage.ts then checks the caller's effective permissions in the company named by the URL.
    const { db, userId, sessionId } = await getSessionGate();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized', code: 'FORBIDDEN' }, { status: 401 });
    }
    const { id } = await params;
    // …and archiving it (lib/services/sessions.ts assertSessionAllowed).
    await assertSessionAllowed(db, sessionId, id);
    // api.del sends no body, so the typed-name confirmation travels as ?confirm=.
    const confirm = new URL(req.url).searchParams.get('confirm') ?? '';
    const company = await archiveCompany(db, userId, id, confirm);
    return NextResponse.json(stripSecrets(company));
  } catch (err) {
    return errorResponse(err);
  }
}
