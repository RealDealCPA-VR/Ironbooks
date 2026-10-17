/**
 * GET /api/sales-orders/backorders — backorder report: every open / partially
 * invoiced sales-order line with remaining (uninvoiced) quantity, including
 * customer and item context. QB "Open Sales Orders by Item/Customer" data.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { backorderReport } from '@/lib/services/salesOrders';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    const rows = await backorderReport(ctx);
    return NextResponse.json(rows);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[sales-orders/backorders]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
