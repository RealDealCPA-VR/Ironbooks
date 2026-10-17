/**
 * POST /api/assemblies/pending/:id
 *
 * Body: { action: 'finalize' | 'cancel' }
 *
 * finalize — runs buildAssembly for the queued quantity (blocked with
 *            per-component shortage detail when stock is insufficient).
 * cancel   — marks the pending build cancelled; no stock moves.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { cancelPendingBuild, finalizePendingBuild } from '@/lib/services/assemblies';
import { zodErrorBody } from '@/lib/validation/helpers';
import { buildSiteFieldsSchema } from '@/lib/validation/inventorySites';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req)) as { action?: string };

    if (body.action === 'finalize') {
      // Optional Advanced Inventory fields: build site / bins / serials / lots.
      const site = buildSiteFieldsSchema.safeParse(body);
      if (!site.success) return NextResponse.json(zodErrorBody(site.error), { status: 400 });
      const result = await finalizePendingBuild(ctx, id, site.data);
      return NextResponse.json(result);
    }
    if (body.action === 'cancel') {
      const result = await cancelPendingBuild(ctx, id);
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: 'action must be "finalize" or "cancel"', code: 'VALIDATION' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/assemblies/pending/:id]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
