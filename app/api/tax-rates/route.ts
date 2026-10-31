/**
 * GET  /api/tax-rates  — list sales tax items (rates). Active ones only — the pick-lists on new
 *                        forms; ?includeInactive=true lists inactive ones too (the Sales Tax
 *                        Items list's "Show inactive").
 * POST /api/tax-rates  — create a sales tax item { name, rate: 0..1 fraction, agencyId?, isActive? }
 *                        (name unique in the company; the agency must be one of its agencies).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listTaxRates, createTaxRate } from '@/lib/services/salesTax';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';
import { taxRateCreateSchema } from '@/lib/validation/lists';
import { zodErrorBody } from '@/lib/validation/helpers';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[tax-rates] error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const includeInactive = req?.nextUrl?.searchParams.get('includeInactive') === 'true';
    return NextResponse.json(await listTaxRates(ctx, { includeInactive }));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = taxRateCreateSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createTaxRate(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
