/**
 * GET /api/payroll/state-wage-worksheet?state=CA&year=2026&quarter=1
 *   — state quarterly wage worksheet: per-employee wages, excess over the SUI wage base,
 *     taxable wages, SUI accrued, SDI and state income tax withheld.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { stateWageWorksheet } from '@/lib/services/payrollReports';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const now = new Date();
    const year = Number(sp.get('year') ?? now.getUTCFullYear());
    const quarter = Number(sp.get('quarter') ?? Math.floor(now.getUTCMonth() / 3) + 1);
    return NextResponse.json(
      await stateWageWorksheet(ctx, { state: sp.get('state') ?? '', year, quarter: quarter as 1 | 2 | 3 | 4 }),
    );
  } catch (err) {
    return routeError(err, 'payroll/state-wage-worksheet');
  }
}
