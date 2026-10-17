/**
 * GET /api/reports/profit-loss-cash
 *
 * Query params:
 *   from  ISO date string (optional) — period start (inclusive).
 *   to    ISO date string (optional) — period end (inclusive).
 *
 * Returns a ProfitAndLossCashBasis report: each invoice / bill income and expense line counted
 * when it is paid, pro-rata to the amount paid (lib/services/cashBasisLedger.ts).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { profitAndLossCashBasis } from '@/lib/services/cashBasisReports';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();

    const fromParam = req.nextUrl.searchParams.get('from');
    const toParam = req.nextUrl.searchParams.get('to');

    let from: Date | undefined;
    let to: Date | undefined;

    if (fromParam) {
      from = new Date(fromParam);
      if (isNaN(from.getTime())) {
        return NextResponse.json({ error: 'Invalid from date.' }, { status: 400 });
      }
    }
    if (toParam) {
      to = new Date(toParam);
      if (isNaN(to.getTime())) {
        return NextResponse.json({ error: 'Invalid to date.' }, { status: 400 });
      }
    }

    const report = await profitAndLossCashBasis(ctx, { from, to });
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[profit-loss-cash] Unexpected error', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
