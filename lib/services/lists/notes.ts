/**
 * Timestamped notes (QB "Notes" on customer / vendor / employee / other-name records): many dated
 * entries per record instead of one free-text field. Also: entity lookup shared with the To Do
 * list, and the helper merges use to carry notes/to-dos over to the surviving record.
 */
import { and, desc, eq } from 'drizzle-orm';
import { customers, employees, entityNotes, items, otherNames, todoItems, vendors } from '@/lib/db/schema';
import { noteSchema, noteUpdateSchema } from '@/lib/validation/lists';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';

export type NoteEntityType = 'customer' | 'vendor' | 'employee' | 'other_name';
export type LinkEntityType = NoteEntityType | 'item';

/** Verify that a linked record exists in this company; returns its display name. */
export async function entityDisplayName(ctx: ServiceContext, type: LinkEntityType, id: string): Promise<string> {
  const c = ctx.companyId;
  let name: string | undefined;
  if (type === 'customer') {
    const [r] = await ctx.db.select({ n: customers.displayName }).from(customers).where(and(eq(customers.id, id), eq(customers.companyId, c)));
    name = r?.n;
  } else if (type === 'vendor') {
    const [r] = await ctx.db.select({ n: vendors.displayName }).from(vendors).where(and(eq(vendors.id, id), eq(vendors.companyId, c)));
    name = r?.n;
  } else if (type === 'employee') {
    const [r] = await ctx.db
      .select({ f: employees.firstName, l: employees.lastName })
      .from(employees)
      .where(and(eq(employees.id, id), eq(employees.companyId, c)));
    name = r ? `${r.f} ${r.l}` : undefined;
  } else if (type === 'other_name') {
    const [r] = await ctx.db.select({ n: otherNames.name }).from(otherNames).where(and(eq(otherNames.id, id), eq(otherNames.companyId, c)));
    name = r?.n;
  } else if (type === 'item') {
    const [r] = await ctx.db.select({ n: items.name }).from(items).where(and(eq(items.id, id), eq(items.companyId, c)));
    name = r?.n;
  }
  if (name === undefined) throw notFound(type.replace('_', ' '));
  return name;
}

function parseOrThrow<T>(r: { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } }): T {
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw validation(`${first?.path?.length ? first.path.join('.') + ': ' : ''}${first?.message ?? 'Invalid input.'}`);
}

export async function listNotes(ctx: ServiceContext, entityType: NoteEntityType, entityId: string) {
  await entityDisplayName(ctx, entityType, entityId);
  return ctx.db
    .select()
    .from(entityNotes)
    .where(and(eq(entityNotes.companyId, ctx.companyId), eq(entityNotes.entityType, entityType), eq(entityNotes.entityId, entityId)))
    .orderBy(desc(entityNotes.noteDate), desc(entityNotes.createdAt));
}

async function loadNote(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db.select().from(entityNotes).where(and(eq(entityNotes.id, id), eq(entityNotes.companyId, ctx.companyId)));
  if (!row) throw notFound('Note');
  return row;
}

export async function getNote(ctx: ServiceContext, id: string) {
  return loadNote(ctx, id);
}

export async function addNote(ctx: ServiceContext, body: unknown) {
  const input = parseOrThrow(noteSchema.safeParse(body ?? {}));
  await entityDisplayName(ctx, input.entityType, input.entityId);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(entityNotes)
      .values({
        companyId: tx.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        body: input.body,
        noteDate: input.noteDate ?? new Date(),
        createdBy: tx.userId,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'note', entityId: row.id, newValues: row });
    return row;
  });
}

export async function updateNote(ctx: ServiceContext, id: string, body: unknown) {
  const input = parseOrThrow(noteUpdateSchema.safeParse(body ?? {}));
  const before = await loadNote(ctx, id);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(entityNotes)
      .set({
        body: input.body ?? before.body,
        noteDate: input.noteDate ?? before.noteDate,
        updatedAt: new Date(),
      })
      .where(eq(entityNotes.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'note', entityId: id, oldValues: before, newValues: row });
    return row;
  });
}

export async function deleteNote(ctx: ServiceContext, id: string) {
  const before = await loadNote(ctx, id);
  return inTransaction(ctx, async (tx) => {
    await tx.db.delete(entityNotes).where(eq(entityNotes.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'note', entityId: id, oldValues: before });
    return { deleted: true };
  });
}

/**
 * Merge helper: move notes and to-dos (and attachments are left to their own service) from one
 * record to another of the same type. Must run inside the merge transaction.
 */
export async function moveNotesAndTodos(
  tx: ServiceContext,
  entityType: LinkEntityType,
  fromId: string,
  toId: string,
): Promise<{ notes: number; todos: number }> {
  const notes =
    entityType === 'item'
      ? []
      : await tx.db
          .update(entityNotes)
          .set({ entityId: toId, updatedAt: new Date() })
          .where(and(eq(entityNotes.companyId, tx.companyId), eq(entityNotes.entityType, entityType), eq(entityNotes.entityId, fromId)))
          .returning({ id: entityNotes.id });
  const todos = await tx.db
    .update(todoItems)
    .set({ entityId: toId, updatedAt: new Date() })
    .where(and(eq(todoItems.companyId, tx.companyId), eq(todoItems.entityType, entityType), eq(todoItems.entityId, fromId)))
    .returning({ id: todoItems.id });
  return { notes: notes.length, todos: todos.length };
}
