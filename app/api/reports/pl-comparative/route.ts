/**
 * GET /api/reports/pl-comparative
 *
 * Returns a comparative Profit & Loss for two date ranges.
 *
 * Query params (all ISO date strings, required):
 *   from       — current period start (inclusive)
 *   to         — current period end   (inclusive)
 *   priorFrom  — prior period start   (inclusive)
 *   priorTo    — prior period end     (inclusive)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { profitAndLossComparative } from '@/lib/services/reportsComparative';
import { serviceErrorStatus } from '@/lib/routeErrors';

function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[reports/pl-comparative] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    const fromStr      = sp.get('from');
    const toStr        = sp.get('to');
    const priorFromStr = sp.get('priorFrom');
    const priorToStr   = sp.get('priorTo');

    if (!fromStr || !toStr || !priorFromStr || !priorToStr) {
      return NextResponse.json(
        { error: 'Query params from, to, priorFrom, and priorTo are all required.' },
        { status: 400 },
      );
    }

    const from      = new Date(fromStr);
    const to        = new Date(toStr);
    const priorFrom = new Date(priorFromStr);
    const priorTo   = new Date(priorToStr);

    if ([from, to, priorFrom, priorTo].some((d) => isNaN(d.getTime()))) {
      return NextResponse.json(
        { error: 'One or more date params are not valid ISO date strings.' },
        { status: 400 },
      );
    }

    const ctx = await getServerContext();
    const report = await profitAndLossComparative(ctx, { from, to, priorFrom, priorTo });
    return NextResponse.json(report);
  } catch (err) {
    return mapError(err);
  }
}
