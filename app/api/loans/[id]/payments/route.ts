/**
 * POST /api/loans/:id/payments { kind: 'check'|'bill', date?, paymentAccountId?, principal?,
 *   interest?, escrow?, reference?, toPrint?, memo?, dueDate? }
 *   Loan Manager "Set up payment": writes the next payment as a check or a bill split between
 *   principal, interest and escrow.
 * DELETE /api/loans/:id/payments?paymentId=… — void a Loan Manager payment: its check or bill and
 *   its exchange gain/loss entry (foreign-currency loans) together.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { setUpLoanPayment, voidLoanPayment } from '@/lib/services/loans';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { loanPaymentSchema } from '@/lib/validation/purchases';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = loanPaymentSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const payment = await setUpLoanPayment(ctx, id, parsed.data);
    return NextResponse.json(payment, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/loans/[id]/payments');
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const paymentId = req.nextUrl.searchParams.get('paymentId');
    if (!paymentId) return NextResponse.json({ error: 'paymentId is required.' }, { status: 400 });
    return NextResponse.json(await voidLoanPayment(ctx, id, paymentId));
  } catch (err) {
    return routeError(err, 'DELETE /api/loans/[id]/payments');
  }
}
