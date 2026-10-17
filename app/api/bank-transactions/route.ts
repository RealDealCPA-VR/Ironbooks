/**
 * GET /api/bank-transactions?bankAccountId=<uuid>&filter=all|unreviewed|matched|excluded
 *
 * Returns staged bank-feed transactions for a bank account, newest first.
 *  - filter=unreviewed — not matched AND not excluded (the review queue)
 *  - filter=matched    — categorized or matched rows
 *  - filter=excluded   — excluded rows
 *  - filter=all (default) — everything
 * `unmatchedOnly=true` is kept for back-compat and behaves like filter=unreviewed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { listStaged, type ReviewFilter } from '@/lib/services/bankCategorize';
import { serviceErrorStatus } from '@/lib/routeErrors';

const FILTERS: ReviewFilter[] = ['all', 'unreviewed', 'matched', 'excluded'];

function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = new URL(req.url);
    const bankAccountId = searchParams.get('bankAccountId');
    const unmatchedOnly = searchParams.get('unmatchedOnly') === 'true';
    const filterParam = searchParams.get('filter');

    if (!bankAccountId) {
      return NextResponse.json({ error: 'bankAccountId query parameter is required.' }, { status: 400 });
    }
    if (filterParam && !FILTERS.includes(filterParam as ReviewFilter)) {
      return NextResponse.json(
        { error: `filter must be one of: ${FILTERS.join(', ')}.` },
        { status: 400 },
      );
    }

    const rows = await listStaged(ctx, bankAccountId, {
      unmatchedOnly,
      filter: (filterParam as ReviewFilter) ?? undefined,
    });
    return NextResponse.json(rows);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[GET /api/bank-transactions]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
