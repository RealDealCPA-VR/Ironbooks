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
import { serviceErrorStatus } from '@/lib/routeErrors';
import { queryDate } from '@/lib/validation/helpers';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
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
    // A real calendar day: `new Date('2026-02-30')` silently became March 2, so the liability was
    // shown for a range the user never asked for. queryDate refuses it with a 400.
    const from = queryDate(searchParams, 'from');
    const to = queryDate(searchParams, 'to');
    if (from) range.from = from;
    if (to) range.to = to;

    return NextResponse.json(await salesTaxLiabilityByAgency(ctx, range));
  } catch (err) {
    return errorResponse(err);
  }
}
