/**
 * GET /api/reports/balance-sheet-cash
 *
 * Query params:
 *   asOf  ISO date string (optional) — defaults to all-time.
 *
 * Returns a cash-basis Balance Sheet: income and expenses on unpaid invoices / bills are left
 * out of earnings and out of A/R / A/P (balanced adjustments, lib/services/cashBasisLedger.ts).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { balanceSheetCashBasis } from '@/lib/services/balanceSheetCashBasis';
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

    const report = await balanceSheetCashBasis(ctx, asOf);
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[balance-sheet-cash] Unexpected error', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
