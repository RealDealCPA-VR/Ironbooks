/**
 * GET  /api/purchase-orders          — list purchase orders (optional ?vendorId= ?status=)
 * POST /api/purchase-orders          — create a new purchase order
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createPurchaseOrder, listPurchaseOrders } from '@/lib/services/purchaseOrders';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createPurchaseOrderSchema } from '@/lib/validation/purchaseOrders';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[purchase-orders/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const vendorId = searchParams.get('vendorId') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const rows = await listPurchaseOrders(ctx, { vendorId, status });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createPurchaseOrderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const po = await createPurchaseOrder(ctx, parsed.data);

    return NextResponse.json(po, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
