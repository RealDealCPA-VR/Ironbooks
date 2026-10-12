/**
 * PATCH  /api/lists/:list/:id — edit an entry (send only the fields to change)
 * DELETE /api/lists/:list/:id — delete an unused entry; an entry in use is made inactive instead
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { isSimpleListKey, removeEntry, updateEntry } from '@/lib/services/lists/simpleLists';

type RouteContext = { params: Promise<{ list: string; id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { list, id } = await params;
    if (!isSimpleListKey(list)) return NextResponse.json({ error: 'Unknown list' }, { status: 404 });
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(await updateEntry(ctx, list, id, body));
  } catch (err) {
    return routeError(err, 'PATCH /api/lists/:list/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { list, id } = await params;
    if (!isSimpleListKey(list)) return NextResponse.json({ error: 'Unknown list' }, { status: 404 });
    const ctx = await getServerContext();
    return NextResponse.json(await removeEntry(ctx, list, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/lists/:list/:id');
  }
}
