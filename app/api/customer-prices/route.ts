/**
 * GET  /api/customer-prices          — list custom prices (?customerId=)
 * POST /api/customer-prices          — upsert a custom price
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listCustomerPrices, setCustomerPrice } from '@/lib/services/customerPricing';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

// ── GET /api/customer-prices ──────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId') ?? undefined;
    const prices = await listCustomerPrices(ctx, customerId);
    return NextResponse.json({ prices });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/customer-prices]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST /api/customer-prices (upsert) ────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    const price = await setCustomerPrice(ctx, {
      customerId: body.customerId,
      itemId: body.itemId,
      price: body.price,
    });

    return NextResponse.json({ price }, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/customer-prices]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
