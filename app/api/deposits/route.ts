/**
 * GET  /api/deposits      — list all deposits for the company
 * POST /api/deposits      — create a new deposit (Undeposited Funds -> bank)
 *   Body: {
 *     depositAccountId: string,
 *     date: string (ISO),
 *     paymentIds?: string[],        // paymentsReceived rows in UF
 *     salesReceiptIds?: string[],   // salesReceipts rows in UF
 *     invoicePaymentIds?: string[], // invoices whose payment-item lines sit in UF
 *     extraLines?: Array<{ accountId, amount, description? }>, // e.g. owner contribution
 *     cashBack?: { accountId, amount, memo? },                 // QB "Cash back goes to"
 *     memo?: string
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import { zodErrorWithFixes } from '@/lib/fixRoutes';
import { serviceErrorBody, serviceErrorStatus } from '@/lib/routeErrors';
import { getServerContext } from '@/lib/context';
import { createDeposit, listDeposits } from '@/lib/services/deposits';
import { ServiceError } from '@/lib/services/_base';
import { createDepositSchema } from '@/lib/validation/deposits';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(serviceErrorBody(err), { status });
  }
  console.error('[deposits/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const rows = await listDeposits(ctx);
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createDepositSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorWithFixes(ctx, parsed.error, body, 'bank', { purpose: 'deposit' });
    }

    const deposit = await createDeposit(ctx, parsed.data);

    return NextResponse.json(deposit, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
