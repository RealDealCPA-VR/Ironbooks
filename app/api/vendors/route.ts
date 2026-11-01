/**
 * GET  /api/vendors   — list vendors (optional ?includeInactive=true; ?withBalances=true adds each
 *                       vendor's A/P ledger balance, for the Vendor Center)
 * POST /api/vendors   — create a new vendor
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { balancesForContext } from '@/lib/services/access';
import { createVendor, listVendors, listVendorsWithBalances } from '@/lib/services/vendors';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createVendorSchema } from '@/lib/validation/vendors';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[vendors/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const includeInactive = req.nextUrl.searchParams.get('includeInactive') === 'true';
    const rows =
      req.nextUrl.searchParams.get('withBalances') === 'true'
        ? await listVendorsWithBalances(ctx, { includeInactive })
        : await listVendors(ctx, { includeInactive });
    return NextResponse.json(balancesForContext(ctx, 'vendors.center', rows)); // QB View Balance
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createVendorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const vendor = await createVendor(ctx, parsed.data);
    return NextResponse.json(vendor, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
