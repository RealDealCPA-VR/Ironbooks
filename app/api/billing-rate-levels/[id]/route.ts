/**
 * GET    /api/billing-rate-levels/:id — a level with its per-item rates
 * PUT    /api/billing-rate-levels/:id — replace it (same body as POST)
 * DELETE /api/billing-rate-levels/:id — delete when unused, else make inactive
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import {
  deleteBillingRateLevel,
  getBillingRateLevel,
  updateBillingRateLevel,
} from '@/lib/services/lists/billingRates';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getBillingRateLevel(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/billing-rate-levels/:id');
  }
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await updateBillingRateLevel(ctx, id, await req.json().catch(() => ({}))));
  } catch (err) {
    return routeError(err, 'PUT /api/billing-rate-levels/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await deleteBillingRateLevel(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/billing-rate-levels/:id');
  }
}
