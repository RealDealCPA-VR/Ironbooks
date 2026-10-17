/**
 * GET  /api/item-receipts   — list item receipts (optional ?vendorId= ?status=)
 * POST /api/item-receipts   — create an item receipt (QB "Receive Items")
 *   body: { vendorId, date, reference?, memo?, purchaseOrderId?,
 *           lines: [{ itemId, description?, quantity, unitCost }] }
 *   Receives stock immediately and posts Dr Inventory / Cr 2050 Item Receipts
 *   Accrual. With purchaseOrderId set, line quantities are claimed against the
 *   PO's remaining (unbilled/unreceived) quantities.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createItemReceipt, listItemReceipts } from '@/lib/services/itemReceipts';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createItemReceiptSchema } from '@/lib/validation/itemReceipts';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[item-receipts/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const vendorId = searchParams.get('vendorId') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const rows = await listItemReceipts(ctx, { vendorId, status });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createItemReceiptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const receipt = await createItemReceipt(ctx, parsed.data);

    return NextResponse.json(receipt, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
