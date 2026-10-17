/**
 * GET /api/items/:id/components — bundle (group item) components.
 *
 * Returns the BOM rows for a bundle item joined with each component item's
 * sales details, so the invoice form can expand a bundle into individual
 * lines. Returns { components: [] } when the bundle has no BOM yet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getBundleComponents } from '@/lib/services/items';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const components = await getBundleComponents(ctx, id);
    return NextResponse.json({ components });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/items/:id/components]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
