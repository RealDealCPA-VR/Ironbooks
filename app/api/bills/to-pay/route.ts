/**
 * GET /api/bills/to-pay?vendorId=&dueOnOrBefore=YYYY-MM-DD&discountOnly=true&asOf=YYYY-MM-DD
 *   Pay Bills list: open bills with due date (from terms when missing), early-payment discount
 *   suggestion and the "due on or before" / "discount available" filters.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listBillsToPay } from '@/lib/services/bills';
import { routeError } from '@/lib/routeErrors';

function dateParam(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const q = req.nextUrl.searchParams;
    const rows = await listBillsToPay(ctx, {
      vendorId: q.get('vendorId') ?? undefined,
      dueOnOrBefore: dateParam(q.get('dueOnOrBefore')),
      discountAvailableOnly: q.get('discountOnly') === 'true',
      asOf: dateParam(q.get('asOf')),
    });
    return NextResponse.json({ bills: rows });
  } catch (err) {
    return routeError(err, 'GET /api/bills/to-pay');
  }
}
