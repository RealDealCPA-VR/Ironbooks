/**
 * GET  /api/mileage          — list mileage logs for the active company.
 * POST /api/mileage          — log a new mileage entry.
 *
 * GET query params:
 *   ?customerId=<uuid>       — filter by customer.
 *   ?summary=true            — return mileageSummary instead of the list.
 *   ?from=<ISO date>         — summary range start (only used with ?summary=true).
 *   ?to=<ISO date>           — summary range end   (only used with ?summary=true).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listMileage, logMiles, mileageSummary } from '@/lib/services/mileage';
import { ServiceError } from '@/lib/services/_base';
import { queryDate, zodErrorBody } from '@/lib/validation/helpers';
import { logMilesSchema } from '@/lib/validation/mileage';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[mileage] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    if (searchParams.get('summary') === 'true') {
      // queryDate refuses a malformed / impossible date with VALIDATION (400); `new Date('garbage')`
      // reached the query as an Invalid Date and answered 500.
      const from = queryDate(searchParams, 'from');
      const to = queryDate(searchParams, 'to');
      const range = from || to ? { from, to } : undefined;
      const summary = await mileageSummary(ctx, range);
      return NextResponse.json(summary);
    }

    const customerId = searchParams.get('customerId') ?? undefined;
    const vehicleId = searchParams.get('vehicleId') ?? undefined;
    const list = await listMileage(ctx, { customerId, vehicleId });
    return NextResponse.json(list);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = logMilesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const now = new Date();
    const log = await logMiles(ctx, {
      ...parsed.data,
      // No date: today's LOCAL calendar day at UTC midnight (the stored-date convention). The
      // current instant carried a time of day — and the next UTC day in the evening.
      date: parsed.data.date ?? new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())),
      billable: parsed.data.billable ?? false,
    });
    return NextResponse.json(log, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
