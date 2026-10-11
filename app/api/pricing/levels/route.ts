/**
 * GET  /api/pricing/levels — price levels (with per-item prices and assigned-customer counts)
 * POST /api/pricing/levels — create { name, type: 'fixed_percent'|'per_item', percent?, rounding? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createPriceLevel, listPriceLevels } from '@/lib/services/pricing';
import { zodErrorBody } from '@/lib/validation/helpers';
import { priceLevelSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ levels: await listPriceLevels(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/pricing/levels');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = priceLevelSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createPriceLevel(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/pricing/levels');
  }
}
