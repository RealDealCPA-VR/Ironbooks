/**
 * GET /api/accountant/sales-tax/liability?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=accrual|cash
 * Sales Tax Liability report (per agency + component), tied to the GL (accrual).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { salesTaxLiabilityReport } from '@/lib/services/accountant/salesTaxLedger';
import { dayParam } from '../../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const basis = sp.get('basis') === 'cash' ? 'cash' : 'accrual';
    return NextResponse.json(
      await salesTaxLiabilityReport(ctx, {
        from: dayParam(sp.get('from'), 'from'),
        to: dayParam(sp.get('to'), 'to', true),
        basis,
      }),
    );
  } catch (err) {
    return routeError(err, '/api/accountant/sales-tax/liability');
  }
}
