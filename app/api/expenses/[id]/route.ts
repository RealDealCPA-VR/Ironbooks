/**
 * GET    /api/expenses/:id   — fetch an expense with its lines
 * DELETE /api/expenses/:id   — void the expense (reverses its GL entry)
 */
import { NextRequest, NextResponse } from 'next/server';
import { zodErrorWithFixes } from '@/lib/fixRoutes';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { getExpense, updateExpense, voidExpense } from '@/lib/services/expenses';
import { routeError, serviceErrorBody, serviceErrorStatus } from '@/lib/routeErrors';
import { createExpenseSchema } from '@/lib/validation/expenses';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(
      { ...serviceErrorBody(err), details: err.details ?? null },
      { status },
    );
  }
  console.error('[expenses/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const expense = await getExpense(ctx, id);
    return NextResponse.json(expense);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const expense = await withVersionCheck(ctx, 'expense', id, expectedVersion(req), (c) => voidExpense(c, id));
    return NextResponse.json({ expense });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/expenses/:id — edit a saved check / cash expense / credit-card charge (same body as
 * POST). Memo/payee/number-only edits keep the posted entry; anything else is void + repost.
 */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createExpenseSchema.safeParse(body);
    if (!parsed.success) return zodErrorWithFixes(ctx, parsed.error, body, 'expense');
    const { allowDuplicateNumber, ...input } = parsed.data;
    const expense = await withVersionCheck(ctx, 'expense', id, expectedVersion(req), (c) => updateExpense(c, id, { ...input, checkDuplicateNumber: !allowDuplicateNumber }));
    return NextResponse.json({ expense });
  } catch (err) {
    return routeError(err, 'PATCH /api/expenses/[id]');
  }
}
