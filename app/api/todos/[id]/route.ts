/**
 * GET    /api/todos/:id — one to-do
 * PATCH  /api/todos/:id — edit / mark done (status or done)
 * DELETE /api/todos/:id — remove → { deleted: true }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { deleteTodo, getTodo, parseTodoBody, updateTodo } from '@/lib/services/todos';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getTodo(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/todos/:id');
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await updateTodo(ctx, id, parseTodoBody(await req.json().catch(() => ({})))));
  } catch (err) {
    return routeError(err, 'PATCH /api/todos/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteTodo(ctx, id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return routeError(err, 'DELETE /api/todos/:id');
  }
}
