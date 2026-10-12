/**
 * Alias of /api/todos kept for older callers (Calendar / Lead Center before the To Do lists were
 * merged). Same store, same rules; GET returns a bare array and defaults to open to-dos.
 * GET  /api/calendar/todos[?includeDone=1&entityType=&entityId=&status=]
 * POST /api/calendar/todos — create (same body as POST /api/todos)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createTodo, parseTodoBody } from '@/lib/services/todos';
import { routeError } from '@/lib/routeErrors';
import { listTodosFromQuery } from '@/app/api/todos/query';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listTodosFromQuery(ctx, req.nextUrl.searchParams, 'open'));
  } catch (err) {
    return routeError(err, 'GET /api/calendar/todos');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const input = parseTodoBody(await req.json().catch(() => ({})));
    return NextResponse.json(await createTodo(ctx, input), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/calendar/todos');
  }
}
