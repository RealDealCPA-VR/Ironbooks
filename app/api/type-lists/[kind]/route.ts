/**
 * GET  /api/type-lists/customer|vendor — the Customer Type / Vendor Type list
 * POST /api/type-lists/customer|vendor — add { name, parentId? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createType, listTypes, type TypeListKind } from '@/lib/services/typeLists';
import { zodErrorBody } from '@/lib/validation/helpers';
import { typeListSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ kind: string }> };

function kindOf(kind: string): TypeListKind | null {
  return kind === 'customer' || kind === 'vendor' ? kind : null;
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const kind = kindOf((await params).kind);
    if (!kind) return NextResponse.json({ error: 'Unknown list' }, { status: 404 });
    const ctx = await getServerContext();
    return NextResponse.json({ types: await listTypes(ctx, kind) });
  } catch (err) {
    return routeError(err, 'GET /api/type-lists/:kind');
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const kind = kindOf((await params).kind);
    if (!kind) return NextResponse.json({ error: 'Unknown list' }, { status: 404 });
    const ctx = await getServerContext();
    const parsed = typeListSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createType(ctx, kind, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/type-lists/:kind');
  }
}
