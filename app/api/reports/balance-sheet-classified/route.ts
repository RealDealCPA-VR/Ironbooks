/**
 * GET /api/reports/balance-sheet-classified
 *
 * Query params:
 *   asOf  ISO date string (optional) — defaults to all-time.
 *
 * Returns a classified Balance Sheet with Current / Non-Current sub-sections
 * for assets and Current / Long-Term for liabilities.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { parseDateInput } from '@/lib/validation/helpers';
import { balanceSheetClassified } from '@/lib/services/balanceSheetClassified';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();

    const asOfParam = req.nextUrl.searchParams.get('asOf');
    let asOf: Date | undefined;
    if (asOfParam) {
      asOf = parseDateInput(asOfParam) ?? undefined; // a real calendar day (2026-02-30 is refused)
      if (!asOf) {
        return NextResponse.json({ error: 'Invalid asOf date.' }, { status: 400 });
      }
    }

    const report = await balanceSheetClassified(ctx, asOf);
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[balance-sheet-classified] Unexpected error', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
