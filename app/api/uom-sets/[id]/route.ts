/**
 * GET    /api/uom-sets/:id — one set with its units
 * PUT    /api/uom-sets/:id — replace it (same body as POST)
 * DELETE /api/uom-sets/:id — delete when unused, else make inactive
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { deleteUomSet, getUomSet, updateUomSet } from '@/lib/services/lists/uom';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getUomSet(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/uom-sets/:id');
  }
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await updateUomSet(ctx, id, await req.json().catch(() => ({}))));
  } catch (err) {
    return routeError(err, 'PUT /api/uom-sets/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await deleteUomSet(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/uom-sets/:id');
  }
}
