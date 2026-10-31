/**
 * POST /api/budgets/[id]/adjust — Adjust Row Amounts: { percent, fromMonth?, accountIds?, classId?, customerId? }
 * (lib/services/budgetTools.ts). Company-scoped; one transaction with one audit record.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { adjustBudget } from '@/lib/services/budgetTools';
import { zodErrorBody } from '@/lib/validation/helpers';
import { adjustBudgetSchema } from '@/lib/validation/budgets';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const parsed = adjustBudgetSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await adjustBudget(ctx, id, parsed.data), { status: 200 });
  } catch (err) {
    return routeError(err, 'budgets/[id]/adjust');
  }
}
