/**
 * GET   /api/payroll-items/[id] — fetch one payroll item.
 * PATCH /api/payroll-items/[id] — update name / accounts / calc defaults, and
 *                                 deactivate (isActive:false) / reactivate (true).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getPayrollItem, updatePayrollItem } from '@/lib/services/payrollItems';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updatePayrollItemSchema } from '@/lib/validation/payrollItems';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[payroll-items/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    return NextResponse.json(await getPayrollItem(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const parsed = updatePayrollItemSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const updated = await updatePayrollItem(ctx, id, parsed.data);
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
