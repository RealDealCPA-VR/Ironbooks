/**
 * GET  /api/purchase-orders/:id              — fetch a purchase order with its lines
 *   (lines include quantityBilled for billed/remaining display)
 * POST /api/purchase-orders/:id  { action }  — dispatch actions on a PO
 *   action = 'convert'  → convertToBill (creates bill, posts A/P)
 *     Optional body fields for partial billing:
 *       lines:      [{ lineId, quantity }]  — per-line quantities to bill
 *                   (omitted → bill the full remaining quantity of every line)
 *       date:       bill date (defaults to the PO date)
 *       billNumber: vendor bill / reference number
 *     PO status moves open → partial → closed as quantities are billed.
 *   action = 'void'     → updateStatus to 'void'
 *   action = 'close'    → updateStatus to 'closed' (stop further billing)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import {
  getPurchaseOrder,
  updateStatus,
  convertToBill,
  updatePurchaseOrder,
} from '@/lib/services/purchaseOrders';
import { routeError } from '@/lib/routeErrors';
import { updatePurchaseOrderSchema } from '@/lib/validation/purchaseOrders';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { purchaseOrderActionSchema } from '@/lib/validation/purchaseOrders';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT'
              ? 409
              : 500;
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[purchase-orders/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const po = await getPurchaseOrder(ctx, id);
    return NextResponse.json(po);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = purchaseOrderActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    if (parsed.data.action === 'convert') {
      // A stale tab must not bill a purchase order another user just changed.
      const { lines, date, billNumber } = parsed.data;
      const bill = await withVersionCheck(ctx, 'purchase_order', id, expectedVersion(req), (c) =>
        convertToBill(c, id, { lines, date, billNumber: billNumber ?? null }),
      );
      return NextResponse.json(bill);
    }

    if (parsed.data.action === 'void') {
      const po = await withVersionCheck(ctx, 'purchase_order', id, expectedVersion(req), (c) => updateStatus(c, id, 'void'));
      return NextResponse.json(po);
    }

    // action === 'close'
    const po = await withVersionCheck(ctx, 'purchase_order', id, expectedVersion(req), (c) => updateStatus(c, id, 'closed'));
    return NextResponse.json(po);
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/purchase-orders/:id — edit an open / partly received purchase order. */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = updatePurchaseOrderSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const po = await withVersionCheck(ctx, 'purchase_order', id, expectedVersion(req), (c) => updatePurchaseOrder(c, id, parsed.data));
    return NextResponse.json(po);
  } catch (err) {
    return routeError(err, 'PATCH /api/purchase-orders/[id]');
  }
}
