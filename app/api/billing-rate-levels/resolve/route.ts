/**
 * GET /api/billing-rate-levels/resolve?itemId=&employeeId=|vendorId=|otherNameId=
 * The hourly rate to bill for a service item worked by that person (billing rate level first,
 * then the item's sales price).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { resolveBillingRate } from '@/lib/services/lists/billingRates';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const itemId = sp.get('itemId') ?? '';
    const ids = { employeeId: sp.get('employeeId'), vendorId: sp.get('vendorId'), otherNameId: sp.get('otherNameId') };
    if (!UUID.test(itemId) || Object.values(ids).some((v) => v && !UUID.test(v))) {
      return NextResponse.json({ error: 'itemId (and a valid person id) are required', code: 'VALIDATION' }, { status: 400 });
    }
    const ctx = await getServerContext();
    return NextResponse.json(await resolveBillingRate(ctx, ids, itemId));
  } catch (err) {
    return routeError(err, 'GET /api/billing-rate-levels/resolve');
  }
}
