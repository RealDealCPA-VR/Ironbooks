/**
 * PUT/PATCH /api/invoices/statement-charges/:id — edit a statement charge (void + re-post through
 * the invoice edit path; payments already applied stay applied). Void via DELETE /api/invoices/:id.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { updateStatementCharge } from '@/lib/services/batchInvoicing';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { statementChargeSchema } from '@/lib/validation/sales';

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = statementChargeSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateStatementCharge(ctx, id, parsed.data));
  } catch (err) {
    return routeErrorWithWarnings(err, 'PUT /api/invoices/statement-charges/[id]');
  }
}

export async function PATCH(req: NextRequest, rc: RouteContext) {
  return PUT(req, rc);
}
