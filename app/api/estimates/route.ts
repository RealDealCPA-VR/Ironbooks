/**
 * GET  /api/estimates  — list estimates for the active company.
 * POST /api/estimates  — create a new estimate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listEstimates, createEstimate } from '@/lib/services/estimates';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createEstimateSchema } from '@/lib/validation/estimates';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[estimates] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(_req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const data = await listEstimates(ctx);
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createEstimateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const estimate = await createEstimate(ctx, parsed.data);

    return NextResponse.json(estimate, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
