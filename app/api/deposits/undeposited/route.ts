/**
 * GET /api/deposits/undeposited — list payments sitting in Undeposited Funds
 *                                  that have not yet been included in a deposit.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listUndepositedPayments } from '@/lib/services/deposits';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[deposits/undeposited/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const rows = await listUndepositedPayments(ctx);
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
