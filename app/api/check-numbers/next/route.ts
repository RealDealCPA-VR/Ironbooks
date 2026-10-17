/**
 * GET /api/check-numbers/next?paymentAccountId=<uuid>
 *
 * Returns the next available check number for the active company.
 * If `paymentAccountId` is provided the scan is scoped to that bank account.
 *
 * Response:
 *   { next: string }   — e.g. "1006"
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { nextCheckNumber } from '@/lib/services/checkNumbers';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[check-numbers/next] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = new URL(req.url);
    const paymentAccountId = searchParams.get('paymentAccountId') ?? undefined;

    const next = await nextCheckNumber(ctx, paymentAccountId);
    return NextResponse.json({ next });
  } catch (err) {
    return errorResponse(err);
  }
}
