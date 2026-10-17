/**
 * GET   /api/inventory-sites/:id — one site
 * PATCH /api/inventory-sites/:id — { name?, code?, address?, notes?, isActive?, isDefault?: true }
 *   isDefault: true makes the site the company default (quantities never move between sites);
 *   isActive: false is refused while the site holds stock or is the default.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getSite, setDefaultSite, updateSite } from '@/lib/services/inventorySites';
import { ServiceError, inTransaction } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateSiteSchema } from '@/lib/validation/inventorySites';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[inventory-sites/:id]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getSite(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = updateSiteSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { isDefault, ...patch } = parsed.data;
    const site = await inTransaction(ctx, async (tx) => {
      let row = await updateSite(tx, id, patch);
      if (isDefault) row = await setDefaultSite(tx, id);
      return row;
    });
    return NextResponse.json(site);
  } catch (err) {
    return errorResponse(err);
  }
}
