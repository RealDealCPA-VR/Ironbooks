/**
 * POST /api/budgets/[id]/fill-from-actuals — Fill a budget (one class / Customer:Job / the whole company) with a fiscal year's actual amounts: { fiscalYear?, classId?, customerId? }
 * (lib/services/budgetTools.ts). Company-scoped; one transaction with one audit record.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { fillBudgetFromActuals } from '@/lib/services/budgetTools';
import { zodErrorBody } from '@/lib/validation/helpers';
import { fillBudgetSchema } from '@/lib/validation/budgets';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const parsed = fillBudgetSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await fillBudgetFromActuals(ctx, id, parsed.data), { status: 200 });
  } catch (err) {
    return routeError(err, 'budgets/[id]/fill-from-actuals');
  }
}
