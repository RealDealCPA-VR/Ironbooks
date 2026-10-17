/**
 * GET /api/reports/pl-by-class
 *
 * Profit & Loss by Class — returns a matrix of revenue/expense accounts as rows
 * and classes as columns.
 *
 * Query params:
 *   from   ISO date string — inclusive start (optional).
 *   to     ISO date string — inclusive end (optional).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { profitAndLossByClass } from '@/lib/services/classReports';
import { queryDate } from '@/lib/validation/helpers';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;

    const from = queryDate(sp, 'from');
    const to = queryDate(sp, 'to');

    const report = await profitAndLossByClass(ctx, { from, to });
    return NextResponse.json(report);
  } catch (err) {
    return mapError(err);
  }
}

function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[reports/pl-by-class] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
