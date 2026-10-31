/**
 * POST /api/loans/:id/what-if { annualRate?, paymentAmount?, termMonths?, lumpSum?,
 *   extraPrincipal?, balloonAmount? }
 *   QB Loan Manager "What If Scenarios": the loan's remaining schedule as it is and with the
 *   changes, from its current balance and next payment, with the difference in interest and in
 *   the number of payments. Nothing is saved.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { whatIfLoan } from '@/lib/services/loans';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { loanWhatIfSchema } from '@/lib/validation/purchases';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req, { optional: true });
    const parsed = loanWhatIfSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await whatIfLoan(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/loans/[id]/what-if');
  }
}
