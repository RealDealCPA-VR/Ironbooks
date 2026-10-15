/**
 * API route: /api/bill-payments/[id]
 *
 * GET    — fetch a single bill payment with its bill applications
 * DELETE — void the bill payment (reverses GL, rolls back bill balances)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { getBillPayment, updateBillPayment, voidBillPayment } from '@/lib/services/billPayments';
import { routeError, serviceErrorBody } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { payBillsSchema } from '@/lib/validation/billPayments';
import { ServiceError } from '@/lib/services/_base';

// Map ServiceError codes to HTTP status codes.
function errorStatus(code: ServiceError['code']): number {
  switch (code) {
    case 'NOT_FOUND':     return 404;
    case 'VALIDATION':    return 400;
    case 'UNBALANCED':    return 400;
    case 'FORBIDDEN':     return 403;
    case 'CONFLICT':      return 409;
    case 'PERIOD_CLOSED': return 422;
    default:              return 500;
  }
}

function errorResponse(err: unknown, label: string) {
  if (err instanceof ServiceError) {
    return NextResponse.json(
      serviceErrorBody(err),
      { status: errorStatus(err.code) },
    );
  }
  console.error(`[${label}]`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const payment = await getBillPayment(ctx, id);
    return NextResponse.json(payment);
  } catch (err) {
    return errorResponse(err, 'GET /api/bill-payments/[id]');
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const voided = await withVersionCheck(ctx, 'bill_payment', id, expectedVersion(req), (c) => voidBillPayment(c, id));
    return NextResponse.json(voided);
  } catch (err) {
    return errorResponse(err, 'DELETE /api/bill-payments/[id]');
  }
}

/** PATCH /api/bill-payments/:id — edit a saved bill payment (same body as POST /api/bill-payments). */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = payBillsSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { allowDuplicateNumber, ...input } = parsed.data;
    const payment = await withVersionCheck(ctx, 'bill_payment', id, expectedVersion(req), (c) => updateBillPayment(c, id, { ...input, paymentAccountId: input.paymentAccountId ?? '', checkDuplicateNumber: !allowDuplicateNumber }));
    return NextResponse.json(payment);
  } catch (err) {
    return routeError(err, 'PATCH /api/bill-payments/[id]');
  }
}
