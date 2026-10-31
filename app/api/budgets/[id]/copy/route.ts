/**
 * POST /api/budgets/[id]/copy — Copy a budget or forecast into another year, every amount +/- a percentage: { name, fiscalYear, isForecast?, percent? }
 * (lib/services/budgetTools.ts). Company-scoped; one transaction with one audit record.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { copyBudget } from '@/lib/services/budgetTools';
import { zodErrorBody } from '@/lib/validation/helpers';
import { copyBudgetSchema } from '@/lib/validation/budgets';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const parsed = copyBudgetSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await copyBudget(ctx, id, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'budgets/[id]/copy');
  }
}
