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

    const range: { from?: Date; to?: Date } = {};
    if (fromStr) {
      const d = new Date(fromStr);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid `from` date', code: 'VALIDATION' }, { status: 400 });
      }
      range.from = d;
    }
    if (toStr) {
      const d = new Date(toStr);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid `to` date', code: 'VALIDATION' }, { status: 400 });
      }
      range.to = d;
    }

    return NextResponse.json(await salesTaxByAgency(ctx, range));
  } catch (err) {
    return errorResponse(err);
  }
}
