/**
 * GET /api/reports/cash-flow
 *
 * Query params:
 *   from  ISO date string (optional) — period start.
 *   to    ISO date string (optional) — period end.
 *
 * Returns a CashFlowReport using the indirect method:
 *   Operating = net income +/- working-capital changes (AR, AP, Inventory)
 *   Investing  = net fixed-asset activity
 *   Financing  = net equity activity
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { cashFlow } from '@/lib/services/reportsExtra';
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

    const report = await cashFlow(ctx, { from, to });
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[cash-flow] Unexpected error', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
