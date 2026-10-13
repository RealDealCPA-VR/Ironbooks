/**
 * GET /api/sales-tax/payments[?agencyId=] — Sales Tax Payment checks (newest first), with
 * isVoid, check number and "To be printed" flag.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { listPaymentChecks } from '@/lib/services/liabilityPayments';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const agencyId = req.nextUrl.searchParams.get('agencyId') ?? undefined;
    return NextResponse.json({ items: await listPaymentChecks(ctx, { kind: 'sales_tax', agencyId }) });
  } catch (err) {
    return routeError(err, 'GET /api/sales-tax/payments');
  }
}
