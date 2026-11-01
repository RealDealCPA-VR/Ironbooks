/**
 * GET  /api/sales-orders/:id — fetch a single sales order with lines
 *      (lines include quantityInvoiced for backorder tracking).
 * POST /api/sales-orders/:id  { action: 'convert', lines?, date? } — convert the
 *      order to an invoice. `lines` ([{ lineId, quantity }]) invoices a partial
 *      quantity per line (omitted lines stay on backorder); without `lines` the
 *      full remaining quantity of every line is invoiced.
 * POST /api/sales-orders/:id  { action: 'status', status } — manually set the
 *      status (close a backorder / void an untouched order). A void order stays void.
 * DELETE /api/sales-orders/:id — delete the order (refused once anything was invoiced from it).
 * PUT/PATCH /api/sales-orders/:id — edit the order (wave2 sales C1; same body as create, lines
 *      may carry their existing `id` to keep invoiced quantities).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import {
  getSalesOrder,
  convertToInvoice,
  updateStatus,
  updateSalesOrder,
  voidSalesOrder,
  deleteSalesOrder,
} from '@/lib/services/salesOrders';
import { ServiceError } from '@/lib/services/_base';
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
      const { lines, date, overrideCreditLimit } = parsed.data;
      // A stale tab must not convert an order another user just changed.
      const invoice = await withVersionCheck(ctx, 'sales_order', id, expectedVersion(req), (c) =>
        convertToInvoice(c, id, { lines, date, overrideCreditLimit }),
      );
      return NextResponse.json(invoice, { status: 201 });
    }

    // action === 'status'
    const status = parsed.data.status;
    if (status === 'void') {
      return NextResponse.json(
        await withVersionCheck(ctx, 'sales_order', id, expectedVersion(req), (c) => voidSalesOrder(c, id)),
      );
    }
    // QB has no "unvoid": a void order is read-only (Undo and the Accountant's Copy import reopen
    // one through the service, not this route).
    if ((await getSalesOrder(ctx, id)).status === 'void') {
      throw new ServiceError('CONFLICT', 'This sales order is void, so its status can no longer be changed.');
    }
    const updated = await withVersionCheck(ctx, 'sales_order', id, expectedVersion(req), (c) => updateStatus(c, id, status));
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/sales-orders/:id — QB Edit > Delete Sales Order (Ctrl+D). */
export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(
      await withVersionCheck(ctx, 'sales_order', id, expectedVersion(req), (c) => deleteSalesOrder(c, id)),
    );
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
