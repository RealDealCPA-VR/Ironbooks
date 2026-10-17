/**
 * GET /api/export/statements/open-item?customerId=&asOf=
 *
 * Open-item customer statement (JSON): each open invoice with aging as of a
 * date, plus an aging summary footer. Complements the balance-forward format
 * at /api/reports/customer-statement.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { openItemStatement } from '@/lib/services/statements';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[export/statements/open-item] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const customerId = searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json({ error: 'customerId query parameter is required.' }, { status: 400 });
    }

    let asOf = new Date();
    const asOfStr = searchParams.get('asOf');
    if (asOfStr) {
      asOf = new Date(asOfStr + 'T00:00:00.000Z');
      if (isNaN(asOf.getTime())) {
        return NextResponse.json({ error: 'Invalid asOf date.' }, { status: 400 });
      }
    }

    const ctx = await getServerContext();
    const statement = await openItemStatement(ctx, customerId, asOf);
    return NextResponse.json(statement);
  } catch (err) {
    return errorResponse(err);
  }
}
