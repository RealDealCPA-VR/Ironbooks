/**
 * GET /api/inventory-sites/reorder-points — per-site reorder points (?itemId= &siteId=)
 * PUT /api/inventory-sites/reorder-points — { itemId, siteId, reorderPoint?, maxQuantity? }
 *   ('' / null for both clears the item's setting at that site)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listSiteReorderPoints, setSiteReorderPoint } from '@/lib/services/inventorySiteOps';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { siteReorderPointSchema } from '@/lib/validation/inventorySites';

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
  console.error('[inventory-sites/reorder-points]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await listSiteReorderPoints(ctx, { itemId: sp.get('itemId') ?? undefined, siteId: sp.get('siteId') ?? undefined }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = siteReorderPointSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await setSiteReorderPoint(ctx, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}
