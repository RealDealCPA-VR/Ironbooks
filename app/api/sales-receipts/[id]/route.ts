/**
 * GET    /api/sales-receipts/:id   — fetch a sales receipt with its lines
 * PUT/PATCH /api/sales-receipts/:id — edit (void + re-post in one transaction, wave2 sales C1)
 * DELETE /api/sales-receipts/:id   — void a sales receipt (reverses GL + restores inventory)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getSalesReceipt, updateSalesReceipt, voidSalesReceipt } from '@/lib/services/salesReceipts';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createSalesReceiptSchema } from '@/lib/validation/salesReceipts';

function errorResponse(err: unknown) {
  return routeErrorWithWarnings(err, 'sales-receipts/[id]');
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const receipt = await getSalesReceipt(ctx, id);
    return NextResponse.json(receipt);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createSalesReceiptSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateSalesReceipt(ctx, id, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Alias of PUT — the shared api client exposes patch. */
export async function PATCH(req: NextRequest, rc: RouteContext) {
  return PUT(req, rc);
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const voided = await voidSalesReceipt(ctx, id);
    return NextResponse.json(voided);
  } catch (err) {
    return errorResponse(err);
  }
}
