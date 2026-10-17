/**
 * POST /api/time-entries/bill   — bill unbilled billable time for a customer → creates invoice
 *
 * Body: { customerId: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { billTimeToInvoice } from '@/lib/services/timeTracking';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { billTimeSchema } from '@/lib/validation/timeEntries';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[time-entries/bill/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = billTimeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const invoice = await billTimeToInvoice(ctx, parsed.data);
    return NextResponse.json(invoice, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
