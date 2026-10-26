/**
 * GET /api/reports/sales-tax-by-agency
 *
 * Query params:
 *   from  — ISO date string (inclusive start), optional
 *   to    — ISO date string (inclusive end), optional
 *
 * Returns { rows: AgencyTaxRow[], total: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { salesTaxByAgency } from '@/lib/services/combinedTax';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { parseDateParam } from '../_lib';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[sales-tax-by-agency] error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const fromStr = searchParams.get('from');
    const toStr = searchParams.get('to');

    // Real calendar days only (400 otherwise): new Date('2026-02-30') rolled over to March 2.
    const range: { from?: Date; to?: Date } = {};
    const from = parseDateParam(fromStr, 'from');
    const to = parseDateParam(toStr, 'to');
    if (from) range.from = from;
    if (to) range.to = to;

    return NextResponse.json(await salesTaxByAgency(ctx, range));
  } catch (err) {
    return errorResponse(err);
  }
}
