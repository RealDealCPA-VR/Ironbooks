/**
 * GET  /api/sales-orders   — list all sales orders for the current company
 * POST /api/sales-orders   — create a new sales order (no GL posting)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createSalesOrder, listSalesOrders } from '@/lib/services/salesOrders';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createSalesOrderSchema } from '@/lib/validation/salesOrders';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[sales-orders/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const orders = await listSalesOrders(ctx);
    return NextResponse.json(orders);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createSalesOrderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const order = await createSalesOrder(ctx, parsed.data);

    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
