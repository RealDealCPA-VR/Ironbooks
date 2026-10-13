/**
 * GET  /api/item-receipts/:id              — fetch an item receipt with its lines
 * POST /api/item-receipts/:id  { action }  — dispatch actions on a receipt
 *   action = 'convert' → convertToBill (enters the vendor bill: Dr 2050 accrual /
 *            Cr 2000 A/P; the receipt keeps the inventory debit + stock movement)
 *     Optional body fields: billNumber, date, dueDate
 *   action = 'void'    → voidItemReceipt (blocked if billed or stock consumed;
 *            releases any claimed PO quantities)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { getItemReceipt, convertToBill, voidItemReceipt, updateItemReceipt } from '@/lib/services/itemReceipts';
import { routeError } from '@/lib/routeErrors';
import { createItemReceiptSchema } from '@/lib/validation/itemReceipts';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { itemReceiptActionSchema } from '@/lib/validation/itemReceipts';

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
  console.error('[item-receipts/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const receipt = await getItemReceipt(ctx, id);
    return NextResponse.json(receipt);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = itemReceiptActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    if (parsed.data.action === 'convert') {
      // A stale tab must not bill an item receipt another user just changed.
      const { billNumber, date, dueDate } = parsed.data;
      const bill = await withVersionCheck(ctx, 'item_receipt', id, expectedVersion(req), (c) =>
        convertToBill(c, id, { billNumber: billNumber ?? null, date, dueDate: dueDate ?? null }),
      );
      return NextResponse.json(bill);
    }

    // action === 'void'
    const receipt = await withVersionCheck(ctx, 'item_receipt', id, expectedVersion(req), (c) => voidItemReceipt(c, id));
    return NextResponse.json(receipt);
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/item-receipts/:id — edit an unbilled item receipt (same body as POST /api/item-receipts). */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createItemReceiptSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const receipt = await withVersionCheck(ctx, 'item_receipt', id, expectedVersion(req), (c) => updateItemReceipt(c, id, parsed.data));
    return NextResponse.json(receipt);
  } catch (err) {
    return routeError(err, 'PATCH /api/item-receipts/[id]');
  }
}
