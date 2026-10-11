/**
 * GET  /api/inventory-transfers — list transfers (?siteId= &status=)
 * POST /api/inventory-transfers — QB "Transfer Inventory"
 *   body: { date, fromSiteId, toSiteId, memo?,
 *           lines: [{ itemId, quantity, fromBinId?, toBinId?, serialNumbers?, lotNumber? }] }
 *   Moves quantity (and serials/lots) between sites. No GL impact.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createInventoryTransfer, listInventoryTransfers } from '@/lib/services/inventoryTransfers';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createInventoryTransferSchema } from '@/lib/validation/inventorySites';

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
  console.error('[inventory-transfers/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await listInventoryTransfers(ctx, { siteId: sp.get('siteId') ?? undefined, status: sp.get('status') ?? undefined }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createInventoryTransferSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createInventoryTransfer(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
