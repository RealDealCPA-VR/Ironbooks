/**
 * GET  /api/todos — the To Do list (?status=open|done|inactive|all, ?entityType=&entityId=, ?dueBy=)
 * POST /api/todos — add a to-do
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { createTodo, listTodos, type ListTodosOpts } from '@/lib/services/lists/todos';
import { TODO_ENTITY_TYPES } from '@/lib/validation/lists';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const status = sp.get('status') ?? 'open';
    if (!['open', 'done', 'inactive', 'all'].includes(status)) {
      return NextResponse.json({ error: 'Unknown status', code: 'VALIDATION' }, { status: 400 });
    }
    const entityType = sp.get('entityType');
    if (entityType && !(TODO_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      return NextResponse.json({ error: 'Unknown entity type', code: 'VALIDATION' }, { status: 400 });
    }
    const entityId = sp.get('entityId');
    if (entityId && !/^[0-9a-f-]{36}$/i.test(entityId)) {
      return NextResponse.json({ error: 'entityId must be an id', code: 'VALIDATION' }, { status: 400 });
    }
    const dueBy = sp.get('dueBy') ? new Date(sp.get('dueBy')!) : undefined;
    const ctx = await getServerContext();
    const opts: ListTodosOpts = {
      status: status as ListTodosOpts['status'],
      entityType: (entityType ?? undefined) as ListTodosOpts['entityType'],
      entityId: entityId ?? undefined,
      dueBy: dueBy && !Number.isNaN(dueBy.getTime()) ? dueBy : undefined,
    };
    return NextResponse.json({ todos: await listTodos(ctx, opts) });
  } catch (err) {
    return routeError(err, 'GET /api/todos');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await createTodo(ctx, await req.json().catch(() => ({}))), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/todos');
  }
}
