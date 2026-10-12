/**
 * POST /api/type-lists/vendor-assign — set a vendor's type. Body: { vendorId, vendorTypeId|null }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { assignVendorType } from '@/lib/services/typeLists';
import { zodErrorBody } from '@/lib/validation/helpers';
import { vendorTypeAssignSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = vendorTypeAssignSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await assignVendorType(ctx, parsed.data.vendorId, parsed.data.vendorTypeId));
  } catch (err) {
    return routeError(err, 'POST /api/type-lists/vendor-assign');
  }
}
