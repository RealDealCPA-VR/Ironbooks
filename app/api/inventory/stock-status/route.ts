/**
 * GET /api/inventory/stock-status
 *
 * Inventory Stock Status by Item: on-hand, committed (open sales-order lines
 * quantity - quantity_invoiced), available (on-hand - committed), on-PO (open
 * purchase-order lines quantity - quantity_billed), reorder point, and a
 * suggested order quantity per active inventory item.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { stockStatus } from '@/lib/services/inventory';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const result = await stockStatus(ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: serviceErrorStatus(err.code) },
      );
    }
    console.error('[GET /api/inventory/stock-status]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
