/**
 * GET  /api/tax-agencies  — list sales-tax agencies
 * POST /api/tax-agencies  — create an agency ({name, liabilityAccountId?})
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listTaxAgencies, createTaxAgency } from '@/lib/services/salesTax';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject, assertStringFields } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
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
    const body = await requireJsonObject(req);
    assertStringFields(body, ['name']);
    return NextResponse.json(await createTaxAgency(ctx, body as Parameters<typeof createTaxAgency>[1]), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
