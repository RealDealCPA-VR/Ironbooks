/**
 * GET /api/reports/commissions
 * Query params:
 *   ?from=YYYY-MM-DD  — start of date range (inclusive)
 *   ?to=YYYY-MM-DD    — end of date range (inclusive)
 *
 * Returns per-rep commission report rows and totals.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { commissionReport } from '@/lib/services/salesReps';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { parseRange } from '../_lib';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[reports/commissions] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    // parseRange answers 400 for an unparseable date (a raw new Date('garbage') reached the query
    // as Invalid Date → RangeError → 500).
    const range = parseRange(req.nextUrl.searchParams);

    const report = await commissionReport(ctx, range);
    return NextResponse.json(report);
  } catch (err) {
    return errorResponse(err);
  }
}
