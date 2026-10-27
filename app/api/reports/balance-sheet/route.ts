/**
 * GET /api/reports/balance-sheet
 *   ?asOf=YYYY-MM-DD (optional, default today)
 *   ?compareTo=YYYY-MM-DD (optional) — returns the comparative balance sheet
 *   (current vs prior columns + change) when present.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { balanceSheet } from '@/lib/services/reports';
import { balanceSheetComparative } from '@/lib/services/reportsExtra';
import { endOfToday } from '@/lib/services/reportEngine';
import { parseDateParam, reportError } from '../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const params = req.nextUrl.searchParams;
    // No asOf = the end of TODAY on this computer's calendar (as every report): it used to run
    // with no date at all (post-dated entries counted) or, with compareTo, as of the UTC moment —
    // already tomorrow in US evenings.
    const asOf = parseDateParam(params.get('asOf'), 'asOf') ?? endOfToday();
    const compareTo = parseDateParam(params.get('compareTo'), 'compareTo');
    if (compareTo) {
      const report = await balanceSheetComparative(ctx, asOf, compareTo);
      return NextResponse.json(report);
    }
    const report = await balanceSheet(ctx, asOf);
    return NextResponse.json(report);
  } catch (err) {
    return reportError(err, 'balance-sheet');
  }
}
