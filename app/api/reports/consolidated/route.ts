/**
 * GET /api/reports/consolidated
 *
 * Returns a combined (multi-company) financial report over the companies the signed-in user
 * may report on: the current company plus every other company in this file where the user is
 * an active member with permission to view financial reports (consolidation.ts
 * reportableCompanies). Other companies' books are never included.
 *
 * Query params:
 *   type   "pl" — Consolidated Profit & Loss (default)
 *          "bs" — Consolidated Balance Sheet
 *   from   ISO date string — P&L range start (pl only; default: start of the fiscal year of `to`)
 *   to     ISO date string — P&L range end   (pl only; default: today)
 *   asOf   ISO date string — Balance Sheet as-of date (bs only; default: today)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { consolidatedPL, consolidatedBalanceSheet } from '@/lib/services/consolidation';
import { queryDate } from '@/lib/validation/helpers';
import { dayStr, endOfToday, resolveRange } from '@/lib/services/reportEngine';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;

    const type = (sp.get('type') ?? 'pl').toLowerCase();

    // No dates = the same defaults as every other report (reportEngine): the Balance Sheet as
    // of today and the P&L for the fiscal year to date. With none, the P&L used to add up ALL
    // history and the Balance Sheet included post-dated entries, with no period on the page.
    if (type === 'bs') {
      const asOf = queryDate(sp, 'asOf') ?? endOfToday();
      const result = await consolidatedBalanceSheet(ctx, asOf);
      return NextResponse.json(result);
    }

    // Default: P&L
    const from = queryDate(sp, 'from');
    const to = queryDate(sp, 'to');
    const range = await resolveRange(ctx, { from: from ? dayStr(from) : undefined, to: to ? dayStr(to) : undefined });
    const result = await consolidatedPL(ctx, range);
    return NextResponse.json(result);
  } catch (err) {
    return mapError(err);
  }
}

function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[reports/consolidated] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
