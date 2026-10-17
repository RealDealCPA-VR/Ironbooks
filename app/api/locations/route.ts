/**
 * GET  /api/locations  — list active locations for the current company.
 * POST /api/locations  — create a new location.
 *
 * POST body: { name: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listLocations, createLocation } from '@/lib/services/dimensions';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createLocationSchema } from '@/lib/validation/dimensions';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[locations] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const list = await listLocations(ctx);
    return NextResponse.json(list);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createLocationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const loc = await createLocation(ctx, parsed.data);
    return NextResponse.json(loc, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
