/**
 * GET /api/budgets/[id]/vs-actual  — budget-vs-actual comparison report.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { budgetVsActual } from '@/lib/services/budgets';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

interface RouteParams {
  params: Promise<{ id: string }>;
}

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[budgets/[id]/vs-actual] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const report = await budgetVsActual(ctx, id);
    return NextResponse.json(report);
  } catch (err) {
    return errorResponse(err);
  }
}
