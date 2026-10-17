/**
 * GET  /api/time-entries   — list time entries (optional ?customerId=&billable=&invoiced= filters)
 * POST /api/time-entries   — create a new time entry
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listTimeEntries, createTimeEntry } from '@/lib/services/timeTracking';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createTimeEntrySchema } from '@/lib/validation/timeEntries';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[time-entries/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const customerId = searchParams.get('customerId') ?? undefined;
    const billableParam = searchParams.get('billable');
    const invoicedParam = searchParams.get('invoiced');

    const billable =
      billableParam === 'true' ? true : billableParam === 'false' ? false : undefined;
    const invoiced =
      invoicedParam === 'true' ? true : invoicedParam === 'false' ? false : undefined;

    const rows = await listTimeEntries(ctx, { customerId, billable, invoiced });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createTimeEntrySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const entry = await createTimeEntry(ctx, {
      ...parsed.data,
      billable: parsed.data.billable ?? true,
    });

    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
