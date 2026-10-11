/**
 * PUT    /api/pricing/rules/:id — replace a price rule
 * DELETE /api/pricing/rules/:id — delete it
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deletePriceRule, updatePriceRule } from '@/lib/services/pricing';
import { zodErrorBody } from '@/lib/validation/helpers';
import { priceRuleSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = priceRuleSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updatePriceRule(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PUT /api/pricing/rules/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deletePriceRule(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return routeError(err, 'DELETE /api/pricing/rules/:id');
  }
}
