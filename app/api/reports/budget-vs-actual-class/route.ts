/**
 * GET /api/reports/budget-vs-actual-class
 *
 * Budget vs Actual broken down by (account, class) pairs.
 *
 * Query params:
 *   budgetId  UUID — required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { budgetVsActualByClass } from '@/lib/services/classReports';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;

    const budgetId = sp.get('budgetId');
    if (!budgetId) {
      return NextResponse.json({ error: 'budgetId query parameter is required.' }, { status: 400 });
    }

    const report = await budgetVsActualByClass(ctx, budgetId);
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
  console.error('[reports/budget-vs-actual-class] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
