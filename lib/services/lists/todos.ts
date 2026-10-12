/**
 * QB "To Do" list: reminders (calls, meetings, tasks...) with a due date and priority,
 * optionally linked to a customer, vendor, employee, other name or item. No GL impact.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { todoItems, userCompanies } from '@/lib/db/schema';
import { todoSchema, todoUpdateSchema } from '@/lib/validation/lists';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';
import { entityDisplayName, type LinkEntityType } from './notes';

function parseOrThrow<T>(r: { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } }): T {
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw validation(`${first?.path?.length ? first.path.join('.') + ': ' : ''}${first?.message ?? 'Invalid input.'}`);
}

export interface ListTodosOpts {
  status?: 'open' | 'done' | 'inactive' | 'all';
  entityType?: LinkEntityType;
  entityId?: string;
  /** Only to-dos due on or before this date. */
  dueBy?: Date;
}

export async function listTodos(ctx: ServiceContext, opts: ListTodosOpts = {}) {
  const conds = [eq(todoItems.companyId, ctx.companyId)];
  if (opts.status && opts.status !== 'all') conds.push(eq(todoItems.status, opts.status));
  if (opts.entityType) conds.push(eq(todoItems.entityType, opts.entityType));
  if (opts.entityId) conds.push(eq(todoItems.entityId, opts.entityId));
  if (opts.dueBy) conds.push(sql`${todoItems.dueDate} <= ${opts.dueBy}`);
  const rows = await ctx.db
    .select()
    .from(todoItems)
    .where(and(...conds))
    .orderBy(asc(sql`coalesce(${todoItems.dueDate}, '9999-12-31'::timestamp)`), asc(todoItems.createdAt));
  // Attach the linked record's display name for the list view.
  const out = [];
  for (const r of rows) {
    let entityName: string | null = null;
    if (r.entityType && r.entityId) {
      entityName = await entityDisplayName(ctx, r.entityType as LinkEntityType, r.entityId).catch(() => null);
    }
    out.push({ ...r, entityName });
  }
  return out;
}

async function loadTodo(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db.select().from(todoItems).where(and(eq(todoItems.id, id), eq(todoItems.companyId, ctx.companyId)));
  if (!row) throw notFound('To Do');
  return row;
}

async function validateLinks(
  ctx: ServiceContext,
  entityType: string | null | undefined,
  entityId: string | null | undefined,
  assignedUserId: string | null | undefined,
) {
  if (!!entityType !== !!entityId) {
    throw validation('Pick both the kind of record and the record to link this to-do to (or neither).');
  }
  if (entityType && entityId) await entityDisplayName(ctx, entityType as LinkEntityType, entityId);
  if (assignedUserId) {
    const [m] = await ctx.db
      .select({ u: userCompanies.userId })
      .from(userCompanies)
      .where(and(eq(userCompanies.companyId, ctx.companyId), eq(userCompanies.userId, assignedUserId)));
    if (!m) throw notFound('User in this company');
  }
}

export async function createTodo(ctx: ServiceContext, body: unknown) {
  const input = parseOrThrow(todoSchema.safeParse(body ?? {}));
  await validateLinks(ctx, input.entityType, input.entityId, input.assignedUserId);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(todoItems)
      .values({
        companyId: tx.companyId,
        title: input.title,
        details: input.details ?? null,
        type: input.type,
        priority: input.priority,
        status: input.status,
        dueDate: input.dueDate ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        assignedUserId: input.assignedUserId ?? null,
        createdBy: tx.userId,
        completedAt: input.status === 'done' ? new Date() : null,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'todo', entityId: row.id, newValues: row });
    return row;
  });
}

export async function updateTodo(ctx: ServiceContext, id: string, body: unknown) {
  const patch = parseOrThrow(todoUpdateSchema.safeParse(body ?? {}));
  const before = await loadTodo(ctx, id);
  const entityType = patch.entityType !== undefined ? patch.entityType : before.entityType;
  const entityId = patch.entityId !== undefined ? patch.entityId : before.entityId;
  const assignedUserId = patch.assignedUserId !== undefined ? patch.assignedUserId : before.assignedUserId;
  await validateLinks(ctx, entityType, entityId, assignedUserId);
  const status = patch.status ?? before.status;
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(todoItems)
      .set({
        title: patch.title ?? before.title,
        details: patch.details !== undefined ? patch.details : before.details,
        type: patch.type ?? before.type,
        priority: patch.priority ?? before.priority,
        status,
        dueDate: patch.dueDate !== undefined ? patch.dueDate : before.dueDate,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        assignedUserId: assignedUserId ?? null,
        completedAt: status === 'done' ? before.completedAt ?? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(todoItems.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'todo', entityId: id, oldValues: before, newValues: row });
    return row;
  });
}

export async function deleteTodo(ctx: ServiceContext, id: string) {
  const before = await loadTodo(ctx, id);
  return inTransaction(ctx, async (tx) => {
    await tx.db.delete(todoItems).where(eq(todoItems.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'todo', entityId: id, oldValues: before });
    return { deleted: true };
  });
}
