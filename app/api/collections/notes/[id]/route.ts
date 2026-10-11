/** PATCH /api/collections/notes/:id — { done: boolean } mark a follow-up done (wave2 sales C9). */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { setCollectionNoteDone } from '@/lib/services/incomeTracker';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const b = (await req.json().catch(() => ({}))) as { done?: unknown };
    return NextResponse.json(await setCollectionNoteDone(ctx, id, b.done !== false));
  } catch (err) {
    return routeError(err, 'PATCH /api/collections/notes/[id]');
  }
}
