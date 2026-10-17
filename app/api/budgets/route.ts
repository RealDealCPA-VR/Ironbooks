/**
 * GET  /api/budgets  — list all budgets for the active company.
 * POST /api/budgets  — create a new budget.
 *
 * POST body: { name: string; fiscalYear: number }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createBudget, listBudgets } from '@/lib/services/budgets';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createBudgetSchema } from '@/lib/validation/budgets';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[budgets] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const list = await listBudgets(ctx);
    return NextResponse.json(list);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createBudgetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const budget = await createBudget(ctx, parsed.data);
    return NextResponse.json(budget, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
