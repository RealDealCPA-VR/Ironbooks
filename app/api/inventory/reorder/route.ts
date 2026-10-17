/**
 * GET /api/inventory/reorder
 *
 * The reorder list: inventory items where on hand - committed (open SOs) + on order (open
 * POs) <= reorderPoint, with a suggested quantity up to the max level (else the reorder
 * point). Items whose open POs already cover the shortfall are left off.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { reorderReport } from '@/lib/services/inventoryOps';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const result = await reorderReport(ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/inventory/reorder]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
