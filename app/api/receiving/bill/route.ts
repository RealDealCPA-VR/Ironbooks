/**
 * POST /api/receiving/bill — Enter Bill for Received Items.
 * Body: { preview?, vendorId, billNumber?, date, dueDate?, memo?,
 *         lines: [{ receiptLineId, quantity, unitCost, closeLine? }] }
 * preview: true returns the variances and journal entry without saving (200); otherwise the
 * bill is posted (201).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { enterBillForReceivedItems, previewReceiptBill } from '@/lib/services/receiving';
import { zodErrorBody } from '@/lib/validation/helpers';
import { receiptBillSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = receiptBillSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { preview, ...input } = parsed.data;
    if (preview) return NextResponse.json(await previewReceiptBill(ctx, input));
    return NextResponse.json(await enterBillForReceivedItems(ctx, input), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/receiving/bill');
  }
}
