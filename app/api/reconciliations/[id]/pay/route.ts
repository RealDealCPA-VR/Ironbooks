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
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { paymentAccountId, amount, date, memo, exchangeRate } = body ?? {};
    if (!paymentAccountId) {
      return NextResponse.json({ error: 'paymentAccountId is required.' }, { status: 400 });
    }
    const entry = await payCreditCardBalance(ctx, id, {
      paymentAccountId,
      amount: amount ?? undefined,
      date: date || undefined,
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
