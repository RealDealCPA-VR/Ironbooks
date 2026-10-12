/**
 * GET /api/accountant/sales-tax/revenue-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Sales Tax Revenue Summary: total / non-taxable / taxable sales and tax per tax rate.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { salesTaxRevenueSummary } from '@/lib/services/accountant/salesTaxLedger';
import { dayParam } from '../../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await salesTaxRevenueSummary(ctx, {
        from: dayParam(sp.get('from'), 'from'),
        to: dayParam(sp.get('to'), 'to', true),
      }),
    );
  } catch (err) {
    return routeError(err, '/api/accountant/sales-tax/revenue-summary');
  }
}
