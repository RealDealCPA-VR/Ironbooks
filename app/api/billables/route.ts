/**
 * GET /api/billables?customerId=…  — unbilled billable time & costs for a customer
 *                                    (reimbursable bill/expense lines + unbilled time).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listUnbilled } from '@/lib/services/billables';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[billables/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    const billables = await listUnbilled(ctx, customerId);
    return NextResponse.json(billables);
  } catch (err) {
    return errorResponse(err);
  }
}
