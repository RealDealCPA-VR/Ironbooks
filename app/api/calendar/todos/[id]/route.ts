/**
 * Alias of /api/todos/:id kept for older callers.
 * PATCH  /api/calendar/todos/:id — edit / mark done
 * DELETE /api/calendar/todos/:id → 204
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteTodo, parseTodoBody, updateTodo } from '@/lib/services/todos';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await updateTodo(ctx, id, parseTodoBody(await req.json().catch(() => ({})))));
  } catch (err) {
    return routeError(err, 'PATCH /api/calendar/todos/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteTodo(ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return routeError(err, 'DELETE /api/calendar/todos/[id]');
  }
}
