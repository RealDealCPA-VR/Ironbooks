/**
 * GET  /api/loans[?includeInactive=true] — Loan Manager list (balance, next payment)
 * POST /api/loans                          — add a loan
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createLoan, listLoans } from '@/lib/services/loans';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { loanSchema } from '@/lib/validation/purchases';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const loans = await listLoans(ctx, {
      includeInactive: req.nextUrl.searchParams.get('includeInactive') === 'true',
    });
    return NextResponse.json({ loans });
  } catch (err) {
    return routeError(err, 'GET /api/loans');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = loanSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const loan = await createLoan(ctx, parsed.data);
    return NextResponse.json(loan, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/loans');
  }
}
