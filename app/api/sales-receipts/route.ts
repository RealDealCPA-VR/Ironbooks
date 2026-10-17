/**
 * GET  /api/sales-receipts   — list sales receipts (optional ?customerId=&status= filters)
 * POST /api/sales-receipts   — create a sales receipt and post income + payment to the GL
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createSalesReceipt, listSalesReceipts } from '@/lib/services/salesReceipts';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createSalesReceiptSchema } from '@/lib/validation/salesReceipts';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[sales-receipts/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const customerId = searchParams.get('customerId') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const rows = await listSalesReceipts(ctx, { customerId, status });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createSalesReceiptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const receipt = await createSalesReceipt(ctx, parsed.data);

    return NextResponse.json(receipt, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
