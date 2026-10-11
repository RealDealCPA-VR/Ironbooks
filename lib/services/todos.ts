/**
 * To Do list (QB Company > To Do List; also the to-dos tab in the Lead Center and on
 * customer/vendor records). A to-do is a call, meeting, task or email with an optional due date,
 * optionally linked to a customer, vendor, employee or lead. To-dos never touch the books.
 */
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import { todos } from '@/lib/db/schema';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';

export type TodoRow = typeof todos.$inferSelect;
export const TODO_KINDS = ['call', 'meeting', 'task', 'email'] as const;
export const TODO_PRIORITIES = ['low', 'medium', 'high'] as const;
export const TODO_ENTITY_TYPES = ['customer', 'vendor', 'employee', 'lead'] as const;

export interface TodoInput {
  title?: string;
  notes?: string | null;
  kind?: (typeof TODO_KINDS)[number];
  priority?: (typeof TODO_PRIORITIES)[number];
  /** 'YYYY-MM-DD' or null. */
  dueDate?: string | null;
  /** 'HH:MM' (24h) or null. */
  dueTime?: string | null;
  done?: boolean;
  entityType?: (typeof TODO_ENTITY_TYPES)[number] | null;
  entityId?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function checkInput(input: TodoInput, creating: boolean) {
  if (creating && !input.title?.trim()) throw validation('A to-do needs a short description.');
  if (input.title !== undefined && input.title.trim().length > 255) throw validation('The description is too long.');
  if (input.dueDate && !DATE_RE.test(input.dueDate)) throw validation('Due date must be YYYY-MM-DD.');
  if (input.dueTime && !TIME_RE.test(input.dueTime)) throw validation('Time must be HH:MM.');
  if (input.kind !== undefined && !TODO_KINDS.includes(input.kind)) throw validation('Unknown to-do type.');
  if (input.priority !== undefined && !TODO_PRIORITIES.includes(input.priority)) throw validation('Unknown priority.');
  const hasType = input.entityType !== undefined && input.entityType !== null;
  const hasId = input.entityId !== undefined && input.entityId !== null;
  if (hasType !== hasId && (input.entityType !== undefined || input.entityId !== undefined)) {
    throw validation('Link a to-do with both a record type and a record.');
  }
  if (hasType && !TODO_ENTITY_TYPES.includes(input.entityType!)) throw validation('Unknown record type.');
}

export interface ListTodosOptions {
  /** Include finished to-dos (default false). */
  includeDone?: boolean;
  /** Only to-dos due on/before this 'YYYY-MM-DD' (plus undated ones when includeUndated). */
  dueOnOrBefore?: string;
  includeUndated?: boolean;
  from?: string;
  to?: string;
  entityType?: string;
  entityId?: string;
}

export async function listTodos(ctx: ServiceContext, opts: ListTodosOptions = {}): Promise<TodoRow[]> {
  const conds = [eq(todos.companyId, ctx.companyId)];
  if (!opts.includeDone) conds.push(eq(todos.done, false));
  if (opts.entityType && opts.entityId) {
    conds.push(eq(todos.entityType, opts.entityType), eq(todos.entityId, opts.entityId));
  }
  if (opts.dueOnOrBefore) {
    const c = opts.includeUndated
      ? or(lte(todos.dueDate, opts.dueOnOrBefore), isNull(todos.dueDate))
      : lte(todos.dueDate, opts.dueOnOrBefore);
    if (c) conds.push(c);
  }
  const rows = await ctx.db
    .select()
    .from(todos)
    .where(and(...conds))
    .orderBy(asc(todos.dueDate), asc(todos.createdAt));
  return rows.filter(
    (r) => (!opts.from || (r.dueDate ?? '') >= opts.from) && (!opts.to || (r.dueDate ?? '9999') <= opts.to),
  );
}

async function load(ctx: ServiceContext, id: string): Promise<TodoRow> {
  const [row] = await ctx.db.select().from(todos).where(and(eq(todos.id, id), eq(todos.companyId, ctx.companyId)));
  if (!row) throw notFound('To-do');
  return row;
}

export async function createTodo(ctx: ServiceContext, input: TodoInput): Promise<TodoRow> {
  checkInput(input, true);
  const [row] = await ctx.db
    .insert(todos)
    .values({
      companyId: ctx.companyId,
      userId: ctx.userId,
      title: input.title!.trim(),
      notes: input.notes?.trim() || null,
      kind: input.kind ?? 'task',
      priority: input.priority ?? 'medium',
      dueDate: input.dueDate || null,
      dueTime: input.dueTime || null,
      done: Boolean(input.done),
      doneAt: input.done ? new Date() : null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    })
    .returning();
  await writeAudit(ctx, { action: 'create', entityType: 'todo', entityId: row.id, newValues: { title: row.title, dueDate: row.dueDate } });
  return row;
}

export async function updateTodo(ctx: ServiceContext, id: string, input: TodoInput): Promise<TodoRow> {
  const before = await load(ctx, id);
  checkInput(input, false);
  const patch: Partial<typeof todos.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) {
    if (!input.title.trim()) throw validation('A to-do needs a short description.');
    patch.title = input.title.trim();
  }
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate || null;
  if (input.dueTime !== undefined) patch.dueTime = input.dueTime || null;
  if (input.done !== undefined) {
    patch.done = input.done;
    patch.doneAt = input.done ? (before.doneAt ?? new Date()) : null;
  }
  if (input.entityType !== undefined) patch.entityType = input.entityType;
  if (input.entityId !== undefined) patch.entityId = input.entityId;
  const [row] = await ctx.db.update(todos).set(patch).where(and(eq(todos.id, id), eq(todos.companyId, ctx.companyId))).returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'todo',
    entityId: id,
    oldValues: { title: before.title, dueDate: before.dueDate, done: before.done },
    newValues: { title: row.title, dueDate: row.dueDate, done: row.done },
  });
  return row;
}

export async function deleteTodo(ctx: ServiceContext, id: string): Promise<void> {
  const before = await load(ctx, id);
  await ctx.db.delete(todos).where(and(eq(todos.id, id), eq(todos.companyId, ctx.companyId)));
  await writeAudit(ctx, { action: 'delete', entityType: 'todo', entityId: id, oldValues: { title: before.title } });
}
