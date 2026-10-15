/**
 * POST /api/receipts/[id]/save — turn a reviewed receipt into a transaction and attach it.
 * Body (lib/services/receipts.ts saveReceiptSchema):
 *   { version, kind: 'expense'|'check'|'credit_card'|'bill', vendorId? | newVendorName? | payeeName?,
 *     date, total, tax?, taxAccountId?, accountId, paymentAccountId?, memo?, reference?, dueDate?,
 *     classId?, customerId?, allowDuplicateNumber? }
 * Mapped 'member': the service requires Banking create (expense / check / card charge) or Vendors
 * create (bill), plus Vendors create for a new vendor. Closing date (x-closing-password),
 * duplicate check / bill numbers (409) and the receipt's version (409) are enforced.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { saveReceipt } from '@/lib/services/receipts';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    return NextResponse.json(await saveReceipt(ctx, id, body), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/receipts/[id]/save');
  }
}
