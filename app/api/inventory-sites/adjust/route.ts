/**
 * POST /api/inventory-sites/adjust — QB "Adjust Quantity on Hand" at a site.
 *   body: { itemId, quantityChange, unitCost? (required when adding), date, memo?,
 *           siteId?, binId?, serialNumbers?, lotNumber?, lotExpiration? }
 * Posts the balanced value entry through the existing costing engines (average / FIFO) and
 * records the site-tagged movement in the same transaction.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { adjustQuantityAtSite } from '@/lib/services/inventorySiteOps';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { siteAdjustmentSchema } from '@/lib/validation/inventorySites';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT' || err.code === 'PERIOD_CLOSED'
              ? 409
              : 500;
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[inventory-sites/adjust]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = siteAdjustmentSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await adjustQuantityAtSite(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
