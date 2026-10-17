/**
 * POST /api/expenses/:id/print — mark a queued check as printed.
 *
 * Body (JSON, optional): { checkNumber?: string }
 *   When omitted, the next available check number for the expense's payment
 *   account is assigned automatically.
 *
 * Effects: expenses.toPrint = false, expenses.reference = checkNumber, and the
 * linked journal entry's reference is updated for traceability.
 *
 * → 200 { expense: Expense }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { markExpensePrinted } from '@/lib/services/expenses';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details ?? null },
      { status },
    );
  }
  console.error('[expenses/[id]/print]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req, { optional: true })) as {
      checkNumber?: unknown;
      allowDuplicateNumber?: unknown;
    };
    const checkNumber =
      body.checkNumber != null && String(body.checkNumber).trim() !== ''
        ? String(body.checkNumber).trim()
        : undefined;

    const expense = await markExpensePrinted(ctx, {
      expenseId: id,
      checkNumber,
      allowDuplicateNumber: body.allowDuplicateNumber === true,
    });
    return NextResponse.json({ expense });
  } catch (err) {
    return errorResponse(err);
  }
}
