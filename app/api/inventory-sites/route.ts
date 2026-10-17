/**
 * GET  /api/inventory-sites   — list inventory sites (?includeInactive=1). The company's
 *                               default site is created on first use and always listed first.
 * POST /api/inventory-sites   — create a site { name, code?, address?, notes?, isDefault? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createSite, listSites } from '@/lib/services/inventorySites';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createSiteSchema } from '@/lib/validation/inventorySites';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[inventory-sites/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const includeInactive = req.nextUrl.searchParams.get('includeInactive') === '1';
    return NextResponse.json(await listSites(ctx, { includeInactive }));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createSiteSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const site = await createSite(ctx, parsed.data);
    return NextResponse.json(site, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
