/**
 * GET  /api/vendor-credits          — list vendor credits (optional ?vendorId=&status= filters)
 * POST /api/vendor-credits          — create a new vendor credit
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createVendorCredit, listVendorCredits } from '@/lib/services/vendorCredits';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createVendorCreditSchema } from '@/lib/validation/vendorCredits';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[vendor-credits/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const vendorId = searchParams.get('vendorId') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const rows = await listVendorCredits(ctx, { vendorId, status });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createVendorCreditSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const credit = await createVendorCredit(ctx, parsed.data);

    return NextResponse.json(credit, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
