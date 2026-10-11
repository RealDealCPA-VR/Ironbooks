/**
 * PUT /api/pricing/levels/:id/items — replace a per-item price level's prices
 * Body: { items: [{ itemId, price }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { setPriceLevelItems } from '@/lib/services/pricing';
import { zodErrorBody } from '@/lib/validation/helpers';
import { priceLevelItemsSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = priceLevelItemsSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json({ items: await setPriceLevelItems(ctx, id, parsed.data.items) });
  } catch (err) {
    return routeError(err, 'PUT /api/pricing/levels/:id/items');
  }
}
