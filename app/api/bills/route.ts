/**
 * GET  /api/bills          — list bills (optional ?vendorId=&status= filters)
 * POST /api/bills          — create a new bill
 */
import { NextRequest, NextResponse } from 'next/server';
import { zodErrorWithFixes } from '@/lib/fixRoutes';
import { serviceErrorBody, serviceErrorStatus } from '@/lib/routeErrors';
import { getServerContext } from '@/lib/context';
import { createBill, listBills } from '@/lib/services/bills';
import { ServiceError } from '@/lib/services/_base';
import { createBillSchema } from '@/lib/validation/bills';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(serviceErrorBody(err), { status });
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
      return zodErrorWithFixes(ctx, parsed.error, body, 'expense');
    }

    // QB duplicate vendor-reference warning: refused (409, details.duplicateNumber) unless confirmed.
    const { allowDuplicateNumber, ...input } = parsed.data;
    const bill = await createBill(ctx, { ...input, checkDuplicateNumber: !allowDuplicateNumber });

    return NextResponse.json(bill, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
