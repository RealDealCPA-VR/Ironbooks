/**
 * THE To Do list (lib/services/todos.ts).
 * GET  /api/todos — ?status=open|done|inactive|all (default open), ?includeDone=1,
 *                   ?entityType=&entityId=, ?dueBy=YYYY-MM-DD, ?from=&to=, ?assignedUserId=
 *                   → { todos: [...] }
 * POST /api/todos — add a to-do { title, notes|details?, kind|type?, priority?, dueDate?, dueTime?,
 *                   status?|done?, entityType?, entityId?, assignedUserId?, remindOn? }
 * Any member may use it; to-dos linked to a record follow that record's area (service).
 * /api/calendar/todos is an alias kept for older callers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { createTodo, parseTodoBody } from '@/lib/services/todos';
import { listTodosFromQuery } from './query';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ todos: await listTodosFromQuery(ctx, req.nextUrl.searchParams, 'open') });
  } catch (err) {
    return routeError(err, 'GET /api/todos');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const input = parseTodoBody(await req.json().catch(() => ({})));
    return NextResponse.json(await createTodo(ctx, input), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/todos');
  }
}
