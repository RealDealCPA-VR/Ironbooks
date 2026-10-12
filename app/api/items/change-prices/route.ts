/**
 * POST /api/items/change-prices — Change Item Prices.
 * Body: { itemIds? | itemType?, basis: price|cost, adjustBy: percent|amount, value, rounding, dryRun? }
 * dryRun returns the preview without saving.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { changeItemPrices } from '@/lib/services/lists/itemTools';
import { changeItemPricesSchema } from '@/lib/validation/lists';
import { zodErrorBody } from '@/lib/validation/helpers';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = changeItemPricesSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await changeItemPrices(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/items/change-prices');
  }
}
