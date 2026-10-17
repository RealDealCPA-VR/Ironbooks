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
 *   from   ISO date string — P&L range start (pl only, optional)
 *   to     ISO date string — P&L range end   (pl only, optional)
 *   asOf   ISO date string — Balance Sheet as-of date (bs only, optional)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { consolidatedPL, consolidatedBalanceSheet } from '@/lib/services/consolidation';
import { queryDate } from '@/lib/validation/helpers';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;

    const type = (sp.get('type') ?? 'pl').toLowerCase();

    if (type === 'bs') {
      const asOf = queryDate(sp, 'asOf');
      const result = await consolidatedBalanceSheet(ctx, asOf);
      return NextResponse.json(result);
    }

    // Default: P&L
    const from = queryDate(sp, 'from');
    const to = queryDate(sp, 'to');
    const result = await consolidatedPL(ctx, from || to ? { from, to } : undefined);
    return NextResponse.json(result);
  } catch (err) {
    return mapError(err);
  }
}

function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT'
              ? 409
              : 500;
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[reports/consolidated] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
