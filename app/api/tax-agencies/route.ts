/**
 * GET  /api/tax-agencies  — list sales-tax agencies
 * POST /api/tax-agencies  — create an agency ({name, liabilityAccountId?})
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listTaxAgencies, createTaxAgency } from '@/lib/services/salesTax';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION' ? 400 : err.code === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[tax-agencies] error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listTaxAgencies(ctx));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json();
    return NextResponse.json(await createTaxAgency(ctx, body), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
