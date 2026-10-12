/**
 * Old Lists > To Do service names, kept as a thin alias over THE To Do list
 * (lib/services/todos.ts). Since migration 0039 there is one store; this module only maps the old
 * field names (details, type, status, dueDate as a timestamp) and options onto it.
 */
import type { ServiceContext } from '../_base';
import {
  createTodo as createUnified,
  deleteTodo as deleteUnified,
  listTodos as listUnified,
  parseTodoBody,
  updateTodo as updateUnified,
  type TodoStatus,
  type TodoView,
} from '../todos';
import type { LinkEntityType } from './notes';

export interface ListTodosOpts {
  status?: 'open' | 'done' | 'inactive' | 'all';
  entityType?: LinkEntityType | 'lead';
  entityId?: string;
  /** Only to-dos due on or before this date. */
  dueBy?: Date;
}

export async function listTodos(ctx: ServiceContext, opts: ListTodosOpts = {}): Promise<TodoView[]> {
  return listUnified(ctx, {
    status: (opts.status ?? 'all') as TodoStatus | 'all',
    entityType: opts.entityType,
    entityId: opts.entityId,
    dueOnOrBefore: opts.dueBy ? opts.dueBy.toISOString().slice(0, 10) : undefined,
  });
}

export async function createTodo(ctx: ServiceContext, body: unknown): Promise<TodoView> {
  return createUnified(ctx, parseTodoBody(body ?? {}));
}

export async function updateTodo(ctx: ServiceContext, id: string, body: unknown): Promise<TodoView> {
  return updateUnified(ctx, id, parseTodoBody(body ?? {}));
}

export async function deleteTodo(ctx: ServiceContext, id: string): Promise<{ deleted: true }> {
  await deleteUnified(ctx, id);
  return { deleted: true };
}
