/**
 * GET    /api/currencies/home-currency-adjustment/:id — one adjustment with its detail lines
 * DELETE /api/currencies/home-currency-adjustment/:id — void it (its entry and its reversal)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getHomeCurrencyAdjustment, voidHomeCurrencyAdjustment } from '@/lib/services/homeCurrencyAdjustment';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getHomeCurrencyAdjustment(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/currencies/home-currency-adjustment/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await voidHomeCurrencyAdjustment(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/currencies/home-currency-adjustment/[id]');
  }
}
