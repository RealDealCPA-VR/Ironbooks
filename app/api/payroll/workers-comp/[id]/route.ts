/** PATCH /api/payroll/workers-comp/[id] — change a class code's description, rate or status. */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { updateWorkersCompCode } from '@/lib/services/payrollAdjustments';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateWorkersCompCodeSchema } from '@/lib/validation/payroll';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const parsed = updateWorkersCompCodeSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateWorkersCompCode(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'payroll/workers-comp/[id]');
  }
}
