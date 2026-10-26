/**
 * GET /api/reports/ap-aging
 *
 * Query params:
 *   asOf  ISO date string (optional) — defaults to today.
 *
 * Returns an AgingReport with one row per vendor that has outstanding bills.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { apAging } from '@/lib/services/reportsExtra';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { parseDateParam } from '../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();

    // Strict: a day that does not exist (2026-02-30) is a 400, never rolled over to March.
    const asOf = parseDateParam(req.nextUrl.searchParams.get('asOf'), 'asOf');

    const report = await apAging(ctx, asOf);
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[ap-aging] Unexpected error', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
