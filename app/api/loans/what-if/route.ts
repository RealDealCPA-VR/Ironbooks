/**
 * POST /api/loans/what-if { originalAmount, annualRate, termMonths, paymentsPerYear?, originDate,
 *   firstPaymentDate, balloonAmount?, compounding?, dayCount?, paymentAmount?, escrowAmount? }
 *   QB Loan Manager "What If" for a new loan: its payment, the full schedule, total interest and
 *   the payoff date. Nothing is saved.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { evaluateLoan } from '@/lib/services/loans';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { loanEvaluateSchema } from '@/lib/validation/purchases';

export async function POST(req: NextRequest) {
  try {
    // A member of the company with Banking access (the route permission map checks it).
    await getServerContext();
    const body = await requireJsonObject(req, { optional: true });
    const parsed = loanEvaluateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(evaluateLoan(parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/loans/what-if');
  }
}
