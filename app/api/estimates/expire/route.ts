/**
 * POST /api/estimates/expire
 *
 * Body (all optional):
 *   { asOf?: string }   — ISO date string; defaults to today's date.
 *
 * Response:
 *   { expired: number } — count of estimates that were set to 'rejected'.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expireOverdueEstimates } from '@/lib/services/estimateExpiry';
import { companyToday } from '@/lib/services/salesDates';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[estimates/expire] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();

    // An empty body is fine (asOf defaults to today); malformed JSON or a non-object body is a 400.
    const body: { asOf?: string } = await requireJsonObject(req, { optional: true });

    // Default: today's calendar day (company time zone). An estimate stays valid through its
    // expiration date: compared with this instant it was expired on that very day.
    const asOf = body.asOf ? new Date(body.asOf) : await companyToday(ctx);

    if (isNaN(asOf.getTime())) {
      return NextResponse.json(
        { error: 'Invalid asOf date.', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const expired = await expireOverdueEstimates(ctx, asOf);
    return NextResponse.json({ expired });
  } catch (err) {
    return errorResponse(err);
  }
}
