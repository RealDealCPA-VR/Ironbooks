/**
 * GET  /api/fulfillment — Sales Order Fulfillment Worksheet
 *        ?customerId=&itemId=&from=YYYY-MM-DD&to=YYYY-MM-DD&shipStatus=complete|partial|none
 * POST /api/fulfillment — batch-invoice what can ship
 *        Body: { date?, selections: [{ salesOrderId, lines?: [{ lineId, quantity }] }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { batchInvoiceSalesOrders, fulfillmentWorksheet, type ShipStatus } from '@/lib/services/fulfillment';
import { zodErrorBody } from '@/lib/validation/helpers';
import { batchInvoiceSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

function day(v: string | null): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return new Date(`${v}T00:00:00.000Z`);
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const ship = sp.get('shipStatus');
    const result = await fulfillmentWorksheet(ctx, {
      customerId: sp.get('customerId') || null,
      itemId: sp.get('itemId') || null,
      from: day(sp.get('from')),
      to: day(sp.get('to')),
      shipStatus: ship === 'complete' || ship === 'partial' || ship === 'none' ? (ship as ShipStatus) : null,
    });
    return NextResponse.json(result);
  } catch (err) {
    return routeError(err, 'GET /api/fulfillment');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = batchInvoiceSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await batchInvoiceSalesOrders(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/fulfillment');
  }
}
