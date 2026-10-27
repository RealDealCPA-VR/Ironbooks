/**
 * GET /api/bills/to-pay?vendorId=&dueOnOrBefore=YYYY-MM-DD&discountOnly=true&asOf=YYYY-MM-DD
 *   Pay Bills list: open bills with due date (from terms when missing), early-payment discount
 *   suggestion and the "due on or before" / "discount available" filters.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listBillsToPay } from '@/lib/services/bills';
import { routeError } from '@/lib/routeErrors';
import { queryDate } from '@/lib/validation/helpers';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const q = req.nextUrl.searchParams;
    // Real calendar days only: `new Date('2026-02-30')` rolled over to March 2 (bills due by then
    // were listed, and the discount was offered as of a day the user never picked).
    const rows = await listBillsToPay(ctx, {
      vendorId: q.get('vendorId') ?? undefined,
      dueOnOrBefore: queryDate(q, 'dueOnOrBefore'),
      discountAvailableOnly: q.get('discountOnly') === 'true',
      asOf: queryDate(q, 'asOf'),
    });
    return NextResponse.json({ bills: rows });
  } catch (err) {
    return routeError(err, 'GET /api/bills/to-pay');
  }
}
