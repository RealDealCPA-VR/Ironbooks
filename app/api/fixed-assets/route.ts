/**
 * GET  /api/fixed-assets  — list all fixed assets for the active company.
 * POST /api/fixed-assets  — create a new fixed asset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listAssets, createAsset } from '@/lib/services/fixedAssets';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createAssetSchema } from '@/lib/validation/fixedAssets';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[fixed-assets] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(_req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const assets = await listAssets(ctx);
    return NextResponse.json(assets);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createAssetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const asset = await createAsset(ctx, parsed.data);

    return NextResponse.json(asset, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
