/**
 * GET  /api/sales-orders/:id — fetch a single sales order with lines
 *      (lines include quantityInvoiced for backorder tracking).
 * POST /api/sales-orders/:id  { action: 'convert', lines?, date? } — convert the
 *      order to an invoice. `lines` ([{ lineId, quantity }]) invoices a partial
 *      quantity per line (omitted lines stay on backorder); without `lines` the
 *      full remaining quantity of every line is invoiced.
 * POST /api/sales-orders/:id  { action: 'status', status } — manually set the
 *      status (close a backorder / void an untouched order).
 * PUT/PATCH /api/sales-orders/:id — edit the order (wave2 sales C1; same body as create, lines
 *      may carry their existing `id` to keep invoiced quantities).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { getSalesOrder, convertToInvoice, updateStatus, updateSalesOrder } from '@/lib/services/salesOrders';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createSalesOrderSchema, salesOrderActionSchema } from '@/lib/validation/salesOrders';

function errorResponse(err: unknown) {
  return routeErrorWithWarnings(err, 'sales-orders/[id]');
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const order = await getSalesOrder(ctx, id);
    return NextResponse.json(order);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = salesOrderActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    if (parsed.data.action === 'convert') {
      const invoice = await convertToInvoice(ctx, id, {
        lines: parsed.data.lines,
        date: parsed.data.date,
        overrideCreditLimit: parsed.data.overrideCreditLimit,
      });
      return NextResponse.json(invoice, { status: 201 });
    }

    // action === 'status'
    const status = parsed.data.status;
    const updated = await withVersionCheck(ctx, 'sales_order', id, expectedVersion(req), (c) => updateStatus(c, id, status));
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createSalesOrderSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await withVersionCheck(ctx, 'sales_order', id, expectedVersion(req), (c) => updateSalesOrder(c, id, parsed.data)));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Alias of PUT — the shared api client exposes patch. */
export async function PATCH(req: NextRequest, rc: RouteContext) {
  return PUT(req, rc);
}
