/**
 * GET /api/reports/customer-statement
 *
 * Query params:
 *   customerId  (required) — UUID of the customer.
 *   from        (optional) — ISO date string, start of period.
 *   to          (optional) — ISO date string, end of period (inclusive).
 *
 * Returns a CustomerStatement with chronological invoice/payment lines
 * and a running balance.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { customerStatement } from '@/lib/services/statements';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { parseDateParam } from '../_lib';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[customer-statement] Unexpected error', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const customerId = searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json(
        { error: 'customerId query parameter is required.' },
        { status: 400 },
      );
    }

    // Real calendar days only (400 otherwise): new Date('2026-02-30') rolled over to March 2.
    const from = parseDateParam(searchParams.get('from'), 'from');
    const to = parseDateParam(searchParams.get('to'), 'to');

    const statement = await customerStatement(ctx, customerId, { from, to });
    return NextResponse.json(statement);
  } catch (err) {
    return errorResponse(err);
  }
}
