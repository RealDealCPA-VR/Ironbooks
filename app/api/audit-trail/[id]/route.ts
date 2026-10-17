/**
 * GET /api/audit-trail/[id] — single audit log entry including oldValues/newValues
 * (the list endpoint trims those for performance; this powers the before/after diff UI).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getAuditLog } from '@/lib/services/auditTrail';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[audit-trail/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getAuditLog(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}
