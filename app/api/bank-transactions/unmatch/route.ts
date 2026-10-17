/**
 * POST /api/bank-transactions/unmatch
 *
 * Undo a categorization or a match:
 *  - Entry created by categorize → voided.
 *  - Pre-existing matched entry → stays posted; only the link is cleared.
 *
 * Request body: { bankTransactionId: string }
 * Response 200: the updated bank transaction row
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { unmatch } from '@/lib/services/bankCategorize';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { bankTransactionId } = body ?? {};

    if (!bankTransactionId) {
      return NextResponse.json({ error: 'bankTransactionId is required.' }, { status: 400 });
    }

    const updated = await unmatch(ctx, bankTransactionId);
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[POST /api/bank-transactions/unmatch]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
