/**
 * PATCH  /api/sales-reps/[id]  — update mutable fields.
 * DELETE /api/sales-reps/[id]  — soft-deactivate (isActive = false).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getSalesRep, updateSalesRep, deactivateSalesRep } from '@/lib/services/salesReps';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject, assertStringFields } from '@/lib/routeErrors';
import { bodyValidationError } from '@/lib/validation/helpers';
import { updateSalesRepSchema } from '@/lib/validation/salesReps';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[sales-reps/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const rep = await getSalesRep(ctx, id);
    return NextResponse.json(rep);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    assertStringFields(body, ['name', 'email']);
    // The body as agents read it described (lib/validation/salesReps.ts). The check above answers
    // first; the schema refuses only a null name, which the service cannot read, and the service
    // checks the name, the email and the rate with its own messages.
    const checked = updateSalesRepSchema.safeParse(body);
    if (!checked.success) throw bodyValidationError(checked.error);
    const rep = await updateSalesRep(ctx, id, {
      name: body.name,
      email: body.email,
      commissionRate: body.commissionRate,
    });
    return NextResponse.json(rep);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const rep = await deactivateSalesRep(ctx, id);
    return NextResponse.json(rep);
  } catch (err) {
    return errorResponse(err);
  }
}
