/**
 * GET /api/dashboard — aggregated dashboard insights in one round trip.
 *
 * Query params:
 *   asOf  ISO date string (optional) — defaults to now. Useful for tests/backdated views.
 *
 * Returns DashboardInsights (see lib/services/dashboard.ts): fiscal-YTD KPIs,
 * A/R aging totals, A/P due soon, 6-month P&L trend, overdue invoices, bills due
 * this week, low-stock count, and the latest reconciliation status.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getDashboardInsights } from '@/lib/services/dashboard';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { parseDateParam } from '../reports/_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();

    // A real calendar day (2026-02-30 is refused), taken as that day on this computer's calendar:
    // the dashboard reads "today" from the moment in local time, and UTC midnight of the day is
    // still the evening before west of UTC (the dashboard ran a day early).
    const day = parseDateParam(req.nextUrl.searchParams.get('asOf'), 'asOf');
    const asOf = day ? new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12) : undefined;

    const insights = await getDashboardInsights(ctx, asOf);
    return NextResponse.json(insights);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[dashboard] Unexpected error', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
