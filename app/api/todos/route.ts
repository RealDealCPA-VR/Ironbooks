/**
 * GET  /api/todos[?includeDone=1&entityType=&entityId=] — the To Do list
 * POST /api/todos — create { title, notes?, kind?, priority?, dueDate?, dueTime?, entityType?, entityId? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createTodo, listTodos } from '@/lib/services/todos';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createTodoSchema } from '@/lib/validation/prefs';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await listTodos(ctx, {
        includeDone: sp.get('includeDone') === '1',
        entityType: sp.get('entityType') ?? undefined,
        entityId: sp.get('entityId') ?? undefined,
      }),
    );
  } catch (err) {
    return routeError(err, 'GET /api/todos');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = createTodoSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createTodo(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/todos');
  }
}
