/**
 * GET /api/income-tracker?customerId=&asOf=YYYY-MM-DD — Income Tracker bars + rows (wave2 sales C9).
 * asOf (default today) rebuilds every bucket for that day: documents dated later are left out and
 * balances / statuses are the ones they had on that day.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { incomeTracker } from '@/lib/services/incomeTracker';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId') || undefined;
    const raw = req.nextUrl.searchParams.get('asOf');
    let asOf: Date | undefined;
    if (raw) {
      asOf = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
      if (Number.isNaN(asOf.getTime())) {
        return NextResponse.json({ error: 'asOf must be a date (YYYY-MM-DD).', code: 'VALIDATION' }, { status: 400 });
      }
    }
    return NextResponse.json(await incomeTracker(ctx, { customerId, asOf }));
  } catch (err) {
    return routeError(err, 'GET /api/income-tracker');
  }
}
