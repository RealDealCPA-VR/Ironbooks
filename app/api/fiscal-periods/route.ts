/**
 * GET  /api/fiscal-periods  — list closed/open periods
 * POST /api/fiscal-periods  — close a period ({periodStart, periodEnd})
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listPeriods, closePeriod } from '@/lib/services/fiscalPeriods';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[fiscal-periods] error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listPeriods(ctx));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json();
    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);
    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      return NextResponse.json(
        { error: 'periodStart and periodEnd must be valid dates', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (periodStart > periodEnd) {
      return NextResponse.json(
        { error: 'periodStart must be on or before periodEnd', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const period = await closePeriod(ctx, { periodStart, periodEnd });
    return NextResponse.json(period, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
