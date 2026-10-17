/**
 * POST /api/finance-charges — assess finance charges (QB "Assess Finance Charges").
 *
 * Body:
 *   asOf         (required) — ISO date the charges are assessed as of.
 *   customerIds  (optional) — subset of preview customers to assess.
 *   settings     (optional) — per-run override { annualRate, minCharge, graceDays }.
 *
 * Creates one finance-charge invoice per customer with a chargeable overdue
 * balance (idempotent per asOf month). Returns { assessed, skipped }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { assessFinanceCharges } from '@/lib/services/financeCharges';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 423 });
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[finance-charges] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (!body?.asOf) {
      return NextResponse.json({ error: 'asOf is required.' }, { status: 400 });
    }
    const asOf = new Date(String(body.asOf) + (String(body.asOf).length === 10 ? 'T00:00:00.000Z' : ''));
    if (isNaN(asOf.getTime())) {
      return NextResponse.json({ error: 'Invalid asOf date.' }, { status: 400 });
    }

    const ctx = await getServerContext();
    const result = await assessFinanceCharges(ctx, {
      asOf,
      customerIds: Array.isArray(body.customerIds) ? body.customerIds.map(String) : undefined,
      settings: body.settings ?? undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
