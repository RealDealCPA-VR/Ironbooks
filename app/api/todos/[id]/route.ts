/**
 * PATCH  /api/todos/:id — edit / mark done
 * DELETE /api/todos/:id — remove
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { deleteTodo, updateTodo } from '@/lib/services/lists/todos';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await updateTodo(ctx, id, await req.json().catch(() => ({}))));
  } catch (err) {
    return routeError(err, 'PATCH /api/todos/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await deleteTodo(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/todos/:id');
  }
}
