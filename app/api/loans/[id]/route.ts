/**
 * GET    /api/loans/:id — loan with payments and the amortization schedule
 * PATCH  /api/loans/:id — edit the loan's terms / accounts
 * DELETE /api/loans/:id — remove from the Loan Manager (its checks / bills stay)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deactivateLoan, getLoan, updateLoan } from '@/lib/services/loans';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { loanSchema } from '@/lib/validation/purchases';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getLoan(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/loans/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = loanSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateLoan(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/loans/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await deactivateLoan(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/loans/[id]');
  }
}
