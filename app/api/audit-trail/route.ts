/**
 * GET /api/audit-trail — paginated, filterable audit log for the active company.
 *
 * Query params:
 *   entityType  — filter by entity type (e.g. "account", "journal_entry")
 *   action      — filter by action ("create" | "update" | "delete" | "void" | "llm_correction")
 *   from        — ISO date string lower bound (inclusive)
 *   to          — ISO date string upper bound (inclusive)
 *   limit       — max rows per page (default 50, max 200)
 *   offset      — skip N rows (default 0)
 *
 * Response: { rows: AuditLogRow[], total: number }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listAuditLogs } from '@/lib/services/auditTrail';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { queryDate } from '@/lib/validation/helpers';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[audit-trail] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const entityType = searchParams.get('entityType') ?? undefined;
    const action = searchParams.get('action') ?? undefined;
    const limitRaw = Number(searchParams.get('limit') ?? '50');
    const offsetRaw = Number(searchParams.get('offset') ?? '0');

    // A real calendar day or an exact instant (what the window sends); a day that does not exist
    // (2026-02-30, which new Date rolled over to March 2) is a 400 (queryDate throws VALIDATION).
    const from = queryDate(searchParams, 'from');
    const to = queryDate(searchParams, 'to');
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 50 : limitRaw), 200);
    const offset = Math.max(0, isNaN(offsetRaw) ? 0 : offsetRaw);

    const result = await listAuditLogs(ctx, { entityType, action, from, to, limit, offset });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
