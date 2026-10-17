/**
 * GET    /api/bills/:id   — fetch a bill with its lines
 * PATCH  /api/bills/:id   — edit an unpaid bill (void + repost GL, redo inventory receipts)
 * DELETE /api/bills/:id   — void a bill (and reverse its GL entry)
 */
import { NextRequest, NextResponse } from 'next/server';
import { zodErrorWithFixes } from '@/lib/fixRoutes';
import { serviceErrorBody, serviceErrorStatus } from '@/lib/routeErrors';
import { getServerContext } from '@/lib/context';
import { getBill, updateBill, voidBill } from '@/lib/services/bills';
import { ServiceError } from '@/lib/services/_base';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { createBillSchema } from '@/lib/validation/bills';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json(serviceErrorBody(err), { status });
  }
  console.error('[bills/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const bill = await getBill(ctx, id);
    return NextResponse.json(bill);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createBillSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorWithFixes(ctx, parsed.error, body, 'expense');
    }

    // Multi-user: 409 if someone else saved this bill since it was loaded.
    const bill = await withVersionCheck(ctx, 'bill', id, expectedVersion(req), (c) =>
      updateBill(c, id, {
        ...parsed.data,
        checkDuplicateNumber: !parsed.data.allowDuplicateNumber,
      }),
    );

    return NextResponse.json(bill);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const voided = await withVersionCheck(ctx, 'bill', id, expectedVersion(req), (c) => voidBill(c, id));
    return NextResponse.json(voided);
  } catch (err) {
    return errorResponse(err);
  }
}
