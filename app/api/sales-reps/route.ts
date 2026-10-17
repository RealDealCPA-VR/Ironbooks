/**
 * GET  /api/sales-reps  — list sales reps for the active company.
 * POST /api/sales-reps  — create a new sales rep.
 *
 * Query params for GET:
 *   ?includeInactive=true  — include deactivated reps.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listSalesReps, createSalesRep } from '@/lib/services/salesReps';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject, assertStringFields } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[sales-reps] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const includeInactive = searchParams.get('includeInactive') === 'true';
    const reps = await listSalesReps(ctx, { includeInactive });
    return NextResponse.json(reps);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    assertStringFields(body, ['name', 'email']);
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required', code: 'VALIDATION' }, { status: 400 });
    }
    const rep = await createSalesRep(ctx, {
      name: body.name,
      email: body.email ?? null,
      commissionRate: body.commissionRate ?? 0,
    });
    return NextResponse.json(rep, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
