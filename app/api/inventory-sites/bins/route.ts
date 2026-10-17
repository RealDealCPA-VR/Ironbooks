/**
 * GET  /api/inventory-sites/bins  — list bins (?siteId= &includeInactive=1)
 * POST /api/inventory-sites/bins  — create a bin { siteId, name }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createBin, listBins } from '@/lib/services/inventorySites';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createBinSchema } from '@/lib/validation/inventorySites';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[inventory-sites/bins]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await listBins(ctx, { siteId: sp.get('siteId'), includeInactive: sp.get('includeInactive') === '1' }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createBinSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createBin(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
