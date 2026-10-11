/**
 * PATCH  /api/todos/:id — edit / mark done
 * DELETE /api/todos/:id
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteTodo, updateTodo } from '@/lib/services/todos';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateTodoSchema } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = updateTodoSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateTodo(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/todos/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteTodo(ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return routeError(err, 'DELETE /api/todos/[id]');
  }
}
