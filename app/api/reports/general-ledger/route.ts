/**
 * GET /api/reports/general-ledger
 *
 * Returns the general ledger register — per-account chronological lines with a running
 * natural balance. Only 'posted' entries appear; voided entries are excluded.
 *
 * Query params:
 *   accountId  UUID — restrict to a single account (optional; omit for all accounts).
 *   from       ISO date string — inclusive start filter (optional).
 *   to         ISO date string — inclusive end filter (optional).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { generalLedger } from '@/lib/services/journal';
import { queryDate } from '@/lib/validation/helpers';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('accountId') ?? undefined;
    const from = queryDate(sp, 'from');
    const to = queryDate(sp, 'to');

    const ledger = await generalLedger(ctx, { accountId, from, to });
    return NextResponse.json({ ledger });
  } catch (err) {
    return mapError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared error mapper (code → HTTP status).
// ---------------------------------------------------------------------------
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
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[reports/general-ledger] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
