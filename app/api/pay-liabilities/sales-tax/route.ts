/**
 * GET /api/pay-liabilities/sales-tax — per-agency sales-tax liability balances
 *
 * Query params:
 *   from — ISO date string (inclusive start), optional
 *   to   — ISO date string (inclusive end), optional
 *   basis — 'accrual' (default; ties to the GL) or 'cash'
 *
 * Returns { rows: AgencyLiabilityRow[], totalCollected, totalPaid, totalBalance, glBalance, tiesToGl }
 * from the GL-driven sales-tax engine (lib/services/accountant/salesTaxLedger.ts).
 *
 * Payments themselves POST to /api/pay-liabilities with type 'sales_tax' and an
 * agencyId — the service debits the agency's liabilityAccountId when set (else 2200).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { salesTaxLiabilityByAgency } from '@/lib/services/liabilityPayments';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' || err.code === 'UNBALANCED' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[/api/pay-liabilities/sales-tax]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const range: { from?: Date; to?: Date; basis?: 'accrual' | 'cash' } = {};
    if (searchParams.get('basis') === 'cash') range.basis = 'cash';
    const fromStr = searchParams.get('from');
    const toStr = searchParams.get('to');
    if (fromStr) {
      const d = new Date(fromStr);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid `from` date', code: 'VALIDATION' }, { status: 400 });
      }
      range.from = d;
    }
    if (toStr) {
      const d = new Date(toStr);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid `to` date', code: 'VALIDATION' }, { status: 400 });
      }
      range.to = d;
    }

    return NextResponse.json(await salesTaxLiabilityByAgency(ctx, range));
  } catch (err) {
    return errorResponse(err);
  }
}
