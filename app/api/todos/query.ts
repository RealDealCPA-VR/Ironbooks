/** Shared query-string parsing for GET /api/todos and its alias GET /api/calendar/todos. */
import type { ServiceContext } from '@/lib/services/_base';
import { validation } from '@/lib/services/_base';
import { listTodos, TODO_ENTITY_TYPES, type ListTodosOptions, type TodoView } from '@/lib/services/todos';

const STATUSES = ['open', 'done', 'inactive', 'all'] as const;

export async function listTodosFromQuery(
  ctx: ServiceContext,
  sp: URLSearchParams,
  defaultStatus: ListTodosOptions['status'] | undefined,
): Promise<TodoView[]> {
  const status = sp.get('status');
  if (status && !(STATUSES as readonly string[]).includes(status)) throw validation('Unknown status.');
  const entityType = sp.get('entityType');
  if (entityType && !(TODO_ENTITY_TYPES as readonly string[]).includes(entityType)) throw validation('Unknown record type.');
  const entityId = sp.get('entityId');
  if (entityId && !/^[0-9a-f-]{36}$/i.test(entityId)) throw validation('entityId must be an id.');
  const day = (k: string) => {
    const v = sp.get(k);
    if (!v) return undefined;
    const d = v.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw validation(`${k} must be a date (YYYY-MM-DD).`);
    return d;
  };
  const includeDone = sp.get('includeDone') === '1';
  return listTodos(ctx, {
    status: (status as ListTodosOptions['status']) ?? (includeDone ? undefined : defaultStatus),
    includeDone,
    entityType: entityType ?? undefined,
    entityId: entityId ?? undefined,
    dueOnOrBefore: day('dueBy'),
    from: day('from'),
    to: day('to'),
    assignedUserId: sp.get('assignedUserId') ?? undefined,
  });
}
