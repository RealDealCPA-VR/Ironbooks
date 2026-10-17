/**
 * GET  /api/fixed-assets/:id  — fetch asset with depreciation entries and schedule.
 * POST /api/fixed-assets/:id  — action dispatch.
 *   body: { action: 'depreciate', date: ISO date string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getAsset, depreciationSchedule, postDepreciation } from '@/lib/services/fixedAssets';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { fixedAssetActionSchema } from '@/lib/validation/fixedAssets';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[fixed-assets/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const asset = await getAsset(ctx, id);

    // Attach the full computed depreciation schedule to the response.
    const schedule = depreciationSchedule({
      cost: asset.cost,
      salvageValue: asset.salvageValue,
      usefulLifeMonths: asset.usefulLifeMonths,
      placedInService: new Date(asset.placedInService),
    });

    return NextResponse.json({ ...asset, schedule });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = fixedAssetActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    // action === 'depreciate'
    const result = await postDepreciation(ctx, { assetId: id, date: parsed.data.date });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
