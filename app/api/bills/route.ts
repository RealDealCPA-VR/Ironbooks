/**
 * GET  /api/bills          — list bills (optional ?vendorId=&status= filters)
 * POST /api/bills          — create a new bill
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createBill, listBills } from '@/lib/services/bills';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createBillSchema } from '@/lib/validation/bills';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT'
              ? 409
              : 500;
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[bills/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const vendorId = searchParams.get('vendorId') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const rows = await listBills(ctx, { vendorId, status });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createBillSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    // QB duplicate vendor-reference warning: refused (409, details.duplicateNumber) unless confirmed.
    const { allowDuplicateNumber, ...input } = parsed.data;
    const bill = await createBill(ctx, { ...input, checkDuplicateNumber: !allowDuplicateNumber });

    return NextResponse.json(bill, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
