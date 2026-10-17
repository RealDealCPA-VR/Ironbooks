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

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();

    const asOfParam = req.nextUrl.searchParams.get('asOf');
    let asOf: Date | undefined;
    if (asOfParam) {
      asOf = new Date(asOfParam);
      if (isNaN(asOf.getTime())) {
        return NextResponse.json({ error: 'Invalid asOf date.' }, { status: 400 });
      }
    }

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
