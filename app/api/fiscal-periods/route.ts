/**
 * GET  /api/fiscal-periods  — list closed/open periods
 * POST /api/fiscal-periods  — close a period ({periodStart, periodEnd})
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listPeriods, closePeriod } from '@/lib/services/fiscalPeriods';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';
import { parseDateInput } from '@/lib/validation/helpers';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
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
    const body = await requireJsonObject(req);
    // Real calendar days only: new Date('2026-02-30') rolls over to March 2.
    const periodStart = typeof body.periodStart === 'string' ? parseDateInput(body.periodStart) : null;
    const periodEnd = typeof body.periodEnd === 'string' ? parseDateInput(body.periodEnd) : null;
    if (!periodStart || !periodEnd) {
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
