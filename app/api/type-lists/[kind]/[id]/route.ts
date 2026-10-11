/**
 * PUT    /api/type-lists/customer|vendor/:id — rename / re-parent / (de)activate a type
 * DELETE /api/type-lists/customer|vendor/:id — delete (deactivates instead when in use)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteType, updateType, type TypeListKind } from '@/lib/services/typeLists';
import { zodErrorBody } from '@/lib/validation/helpers';
import { typeListSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ kind: string; id: string }> };

function kindOf(kind: string): TypeListKind | null {
  return kind === 'customer' || kind === 'vendor' ? kind : null;
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const p = await params;
    const kind = kindOf(p.kind);
    if (!kind) return NextResponse.json({ error: 'Unknown list' }, { status: 404 });
    const ctx = await getServerContext();
    const parsed = typeListSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateType(ctx, kind, p.id, parsed.data));
  } catch (err) {
    return routeError(err, 'PUT /api/type-lists/:kind/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const p = await params;
    const kind = kindOf(p.kind);
    if (!kind) return NextResponse.json({ error: 'Unknown list' }, { status: 404 });
    const ctx = await getServerContext();
    return NextResponse.json(await deleteType(ctx, kind, p.id));
  } catch (err) {
    return routeError(err, 'DELETE /api/type-lists/:kind/:id');
  }
}
