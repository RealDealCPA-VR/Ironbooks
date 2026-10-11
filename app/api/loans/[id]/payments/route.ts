/**
 * POST /api/loans/:id/payments { kind: 'check'|'bill', date?, paymentAccountId?, principal?,
 *   interest?, escrow?, reference?, toPrint?, memo?, dueDate? }
 *   Loan Manager "Set up payment": writes the next payment as a check or a bill split between
 *   principal, interest and escrow.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { setUpLoanPayment } from '@/lib/services/loans';
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
