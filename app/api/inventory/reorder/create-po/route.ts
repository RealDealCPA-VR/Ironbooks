/**
 * POST /api/inventory/reorder/create-po — purchase orders from the reorder list, one per
 * preferred vendor. Body: { itemIds?, quantities?: { [itemId]: qty }, date?, dryRun? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { createPurchaseOrdersFromReorder } from '@/lib/services/lists/itemTools';
import { reorderPoSchema } from '@/lib/validation/lists';
import { zodErrorBody } from '@/lib/validation/helpers';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = reorderPoSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const result = await createPurchaseOrdersFromReorder(ctx, parsed.data);
    return NextResponse.json(result, { status: result.dryRun ? 200 : 201 });
  } catch (err) {
    return routeError(err, 'POST /api/inventory/reorder/create-po');
  }
}
