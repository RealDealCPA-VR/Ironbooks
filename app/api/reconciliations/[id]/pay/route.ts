/**
 * POST /api/reconciliations/[id]/pay
 *
 * QB "Write a check for the balance" step after completing a credit-card
 * reconciliation. Posts Dr CC liability / Cr bank with sourceRef
 * "cc-payment:<reconciliationId>" (one payment per reconciliation).
 *
 * Body: {
 *   paymentAccountId: string,   // GL account of the bank paying from
 *   amount?: string,            // defaults to the statement ending balance
 *   date?: string (ISO),        // defaults to today
 *   memo?: string,
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { payCreditCardBalance } from '@/lib/services/reconcile';

function errResponse(err: ServiceError): NextResponse {
  const statusMap: Record<string, number> = {
    NOT_FOUND: 404,
    VALIDATION: 400,
    UNBALANCED: 400,
    FORBIDDEN: 403,
    CONFLICT: 409,
    PERIOD_CLOSED: 400,
  };
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: statusMap[err.code] ?? 500 },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json();
    const { paymentAccountId, amount, date, memo, exchangeRate } = body ?? {};
    if (!paymentAccountId) {
      return NextResponse.json({ error: 'paymentAccountId is required.' }, { status: 400 });
    }
    const entry = await payCreditCardBalance(ctx, id, {
      paymentAccountId,
      amount: amount ?? undefined,
      date: date ? new Date(date) : undefined,
      memo: memo ?? undefined,
      exchangeRate: exchangeRate ?? undefined,
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[POST /api/reconciliations/:id/pay]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
