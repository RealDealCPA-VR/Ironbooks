/**
 * PUT    /api/pricing/levels/:id — update a price level
 * DELETE /api/pricing/levels/:id — delete (unassigns it from customers)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deletePriceLevel, updatePriceLevel } from '@/lib/services/pricing';
import { zodErrorBody } from '@/lib/validation/helpers';
import { priceLevelSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = priceLevelSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updatePriceLevel(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PUT /api/pricing/levels/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deletePriceLevel(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return routeError(err, 'DELETE /api/pricing/levels/:id');
  }
}
