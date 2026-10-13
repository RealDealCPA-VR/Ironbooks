/**
 * GET    /api/payroll/[id] — one paycheck with its lines (for the edit form).
 * PATCH  /api/payroll/[id] — edit a paycheck (QB "Edit Paycheck"): the old GL entry is voided
 *                            and a corrected one posted in the same transaction. Refused when
 *                            the check was cleared in a completed bank reconciliation or its
 *                            period is closed.
 * DELETE /api/payroll/[id] — void a paycheck.
 *
 * Voiding voids the underlying GL journal entry (blocked when a line was cleared in a
 * completed reconciliation, or the period is closed) and stamps paychecks.voided_at so
 * W-2 / 941 / pay-stub aggregations exclude the check.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { editPaycheck, getPaycheck, voidPaycheck } from '@/lib/services/payroll';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { editPaycheckSchema } from '@/lib/validation/payroll';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    return NextResponse.json(await getPaycheck(ctx, id));
  } catch (err) {
    return routeError(err, 'payroll/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const parsed = editPaycheckSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const updated = await withVersionCheck(ctx, 'paycheck', id, expectedVersion(req), (c) => editPaycheck(c, id, { ...parsed.data, deductions: parsed.data.deductions ?? [] }));
    return NextResponse.json(updated);
  } catch (err) {
    return routeError(err, 'payroll/[id]');
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    return NextResponse.json(await withVersionCheck(ctx, 'paycheck', id, expectedVersion(req), (c) => voidPaycheck(c, id)));
  } catch (err) {
    return routeError(err, 'payroll/[id]');
  }
}
