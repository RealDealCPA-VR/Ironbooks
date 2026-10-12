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
import { zodErrorBody } from '@/lib/validation/helpers';
import { logMilesSchema } from '@/lib/validation/mileage';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' || err.code === 'UNBALANCED' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
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
      const fromParam = searchParams.get('from');
      const toParam = searchParams.get('to');
      const range =
        fromParam || toParam
          ? {
              from: fromParam ? new Date(fromParam) : undefined,
              to: toParam ? new Date(toParam) : undefined,
            }
          : undefined;
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

    const log = await logMiles(ctx, {
      ...parsed.data,
      date: parsed.data.date ?? new Date(),
      billable: parsed.data.billable ?? false,
    });
    return NextResponse.json(log, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
