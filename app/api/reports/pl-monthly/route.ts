/**
 * GET /api/reports/pl-monthly
 *
 * Returns a 12-column monthly Profit & Loss for a calendar year.
 *
 * Query params:
 *   year  — 4-digit calendar year (required, e.g. 2025)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { profitAndLossByMonth } from '@/lib/services/reportsComparative';
import { serviceErrorStatus } from '@/lib/routeErrors';

function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[reports/pl-monthly] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const yearStr = sp.get('year');

    if (!yearStr) {
      return NextResponse.json({ error: 'Query param year is required.' }, { status: 400 });
    }

    const year = parseInt(yearStr, 10);
    if (isNaN(year) || year < 1900 || year > 2200) {
      return NextResponse.json(
        { error: 'year must be a valid 4-digit calendar year.' },
        { status: 400 },
      );
    }

    const ctx = await getServerContext();
    const report = await profitAndLossByMonth(ctx, year);
    return NextResponse.json(report);
  } catch (err) {
    return mapError(err);
  }
}
