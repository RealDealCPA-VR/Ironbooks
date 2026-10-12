/**
 * GET  /api/landed-cost/:id — allocation with lines
 * POST /api/landed-cost/:id — { action: 'void' } (exact reversal; refused once the revalued
 *                             stock has moved)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getLandedCostAllocation, voidLandedCostAllocation } from '@/lib/services/landedCost';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT' || err.code === 'PERIOD_CLOSED'
              ? 409
              : 500;
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[landed-cost/:id]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getLandedCostAllocation(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== 'void') {
      return NextResponse.json({ error: 'action must be "void"', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(await voidLandedCostAllocation(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}
