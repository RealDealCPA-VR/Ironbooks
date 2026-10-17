/**
 * GET /api/finance-charges/preview?asOf=YYYY-MM-DD
 *
 * Previews (without posting) the finance charges that would be assessed as of
 * the given date: per-customer overdue invoices, per-invoice interest, the
 * minimum-charge application, and already-assessed flags for the period.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { previewFinanceCharges } from '@/lib/services/financeCharges';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[finance-charges/preview] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    let asOf = new Date();
    const asOfStr = searchParams.get('asOf');
    if (asOfStr) {
      asOf = new Date(asOfStr + 'T00:00:00.000Z');
      if (isNaN(asOf.getTime())) {
        return NextResponse.json({ error: 'Invalid asOf date.' }, { status: 400 });
      }
    }

    const ctx = await getServerContext();
    const preview = await previewFinanceCharges(ctx, { asOf });
    return NextResponse.json(preview);
  } catch (err) {
    return errorResponse(err);
  }
}
