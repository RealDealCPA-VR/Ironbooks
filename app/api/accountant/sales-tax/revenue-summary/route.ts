/**
 * GET /api/accountant/sales-tax/revenue-summary?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=accrual|cash
 * Sales Tax Revenue Summary: total / non-taxable / taxable sales and tax per tax rate.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getPreferences } from '@/lib/services/company';
import { salesTaxRevenueSummary } from '@/lib/services/accountant/salesTaxLedger';
import { dayParam } from '../../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    // Default: the company's sales tax basis preference (QB Preferences > Sales Tax).
    const qb = sp.get('basis');
    const basis = qb === 'cash' || qb === 'accrual' ? qb : (await getPreferences(ctx)).salesTaxBasis === 'cash' ? 'cash' : 'accrual';
    return NextResponse.json(
      await salesTaxRevenueSummary(ctx, {
        from: dayParam(sp.get('from'), 'from'),
        to: dayParam(sp.get('to'), 'to', true),
        basis,
      }),
    );
  } catch (err) {
    return routeError(err, '/api/accountant/sales-tax/revenue-summary');
  }
}
