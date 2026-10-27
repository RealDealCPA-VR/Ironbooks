/**
 * THE To Do list (QB Company > To Do List). One store (`todos`) feeds every place a to-do shows
 * up: the To Do List page (/todos), the Calendar, Reminders, the Lead Center and the to-dos on
 * customer / vendor / employee records. Before migration 0039 there were two stores; the old
 * Lists > To Do rows were copied in under the same ids, so nothing was lost.
 *
 * A to-do is a call, fax, email, meeting, appointment or task with a priority, an optional due
 * date and time, a status (open / done / inactive), an optional "remind me on" date, an optional
 * assigned user, and an optional link to a customer, vendor, employee, lead, other name or item.
 * To-dos never touch the books.
 *
 * Permissions: any member may keep unlinked to-dos. A to-do linked to a record is only visible
 * to (and editable by) members who can view that record's area — customers and leads need
 * Customers & Receivables, vendors need Vendors & Payables, employees need Employees & Payroll,
 * other names and items need Lists. View-only members cannot change to-dos.
 *
 * Field names: the API accepts both the Calendar names (notes, kind, done) and the old Lists
 * names (details, type, status); rows come back carrying both, so every caller keeps working.
 */
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { customers, employees, items, leads, otherNames, todos, userCompanies, vendors } from '@/lib/db/schema';
import { can, type Area } from '@/lib/permissions/model';
import { isRealIsoDay } from '@/lib/validation/prefs';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { entityDisplayName, type LinkEntityType } from './lists/notes';

export type TodoRow = typeof todos.$inferSelect;
export const TODO_KINDS = ['call', 'fax', 'email', 'meeting', 'appointment', 'task'] as const;
export const TODO_PRIORITIES = ['low', 'medium', 'high'] as const;
export const TODO_STATUSES = ['open', 'done', 'inactive'] as const;
export const TODO_ENTITY_TYPES = ['customer', 'vendor', 'employee', 'lead', 'other_name', 'item'] as const;
export type TodoKind = (typeof TODO_KINDS)[number];
export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoEntityType = (typeof TODO_ENTITY_TYPES)[number];

/** Which permission area a linked record belongs to. */
export const TODO_ENTITY_AREA: Record<TodoEntityType, Area> = {
  customer: 'customers',
  lead: 'customers',
  vendor: 'vendors',
  employee: 'payroll',
  other_name: 'lists',
  item: 'lists',
};

/** A to-do as every caller sees it: the stored row plus the old Lists field names. */
export interface TodoView extends TodoRow {
  /** = notes (old Lists name). */
  details: string | null;
  /** = kind (old Lists name). */
  type: string;
  /** = doneAt (old Lists name). */
  completedAt: Date | null;
  /** Display name of the linked record (null when unlinked or no longer there). */
  entityName: string | null;
}

export interface TodoInput {
  title?: string;
  notes?: string | null;
  kind?: TodoKind;
  priority?: (typeof TODO_PRIORITIES)[number];
  /** 'YYYY-MM-DD' or null. */
  dueDate?: string | null;
  /** 'HH:MM' (24h) or null. */
  dueTime?: string | null;
  /** Shortcut for status 'done' / 'open'. */
  done?: boolean;
  status?: TodoStatus;
  entityType?: TodoEntityType | null;
  entityId?: string | null;
  assignedUserId?: string | null;
  /** 'YYYY-MM-DD' or null: show in Reminders from this day. */
  remindOn?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDay(v: string): boolean {
  return DATE_RE.test(v) && isRealIsoDay(v);
}

/**
 * Normalize a request body (either naming style) into a TodoInput. Unknown keys are ignored;
 * wrong types are refused. Old Lists clients sent dueDate as a timestamp — its calendar day is
 * kept (a time other than midnight UTC becomes the due time).
 */
export function parseTodoBody(body: unknown): TodoInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validation('Send the to-do as an object.');
  const b = body as Record<string, unknown>;
  const out: TodoInput = {};
  const str = (k: string, v: unknown): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') throw validation(`${k} must be text.`);
    return v;
  };
  const title = str('title', b.title);
  if (title !== undefined) {
    if (title === null) throw validation('A to-do needs a short description.');
    out.title = title;
  }
  const notes = str('notes', b.notes !== undefined ? b.notes : b.details);
  if (notes !== undefined) out.notes = notes;
  const kind = str('kind', b.kind !== undefined ? b.kind : b.type);
  if (kind !== undefined && kind !== null) out.kind = kind as TodoKind;
  const priority = str('priority', b.priority);
  if (priority !== undefined && priority !== null) out.priority = priority as TodoInput['priority'];
  const due = str('dueDate', b.dueDate);
  if (due !== undefined) {
    if (due && /^\d{4}-\d{2}-\d{2}T/.test(due)) {
      // Old Lists clients: an ISO timestamp. Check the calendar day first so an impossible
      // day (Feb 30) is refused instead of silently rolling over into the next month.
      if (!isDay(due.slice(0, 10))) throw validation('Due date must be a real date (YYYY-MM-DD).');
      // Keep the day and time as written: converting to UTC would move '00:30+01:00' to the
      // previous day and 'T24:00' to the next one.
      const m = /^T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(due.slice(10));
      if (!m) throw validation('Due date must be a real date (YYYY-MM-DD).');
      out.dueDate = due.slice(0, 10);
      const hhmm = `${m[1]}:${m[2]}`;
      if (hhmm !== '00:00' && b.dueTime === undefined) out.dueTime = hhmm;
    } else out.dueDate = due || null;
  }
  const time = str('dueTime', b.dueTime);
  if (time !== undefined) out.dueTime = time || null;
  if (b.done !== undefined) {
    if (typeof b.done !== 'boolean') throw validation('done must be true or false.');
    out.done = b.done;
  }
  const status = str('status', b.status);
  if (status !== undefined && status !== null) out.status = status as TodoStatus;
  const et = str('entityType', b.entityType);
  if (et !== undefined) out.entityType = (et || null) as TodoEntityType | null;
  const eid = str('entityId', b.entityId);
  if (eid !== undefined) out.entityId = eid || null;
  const au = str('assignedUserId', b.assignedUserId);
  if (au !== undefined) out.assignedUserId = au || null;
  const ro = str('remindOn', b.remindOn);
  if (ro !== undefined) out.remindOn = ro || null;
  return out;
}

function checkInput(input: TodoInput, creating: boolean) {
  if (creating && !input.title?.trim()) throw validation('A to-do needs a short description.');
  if (input.title !== undefined && !input.title.trim()) throw validation('A to-do needs a short description.');
  if (input.title !== undefined && input.title.trim().length > 255) throw validation('The description is too long.');
  if (input.notes && input.notes.length > 20000) throw validation('The details are too long.');
  if (input.dueDate && !isDay(input.dueDate)) throw validation('Due date must be a real date (YYYY-MM-DD).');
  if (input.remindOn && !isDay(input.remindOn)) throw validation('The reminder date must be a real date (YYYY-MM-DD).');
  if (input.dueTime && !TIME_RE.test(input.dueTime)) throw validation('Time must be HH:MM.');
  if (input.kind !== undefined && !TODO_KINDS.includes(input.kind)) throw validation('Unknown to-do type.');
  if (input.priority !== undefined && !TODO_PRIORITIES.includes(input.priority)) throw validation('Unknown priority.');
  if (input.status !== undefined && !TODO_STATUSES.includes(input.status)) throw validation('Unknown status.');
  if (input.assignedUserId && !UUID_RE.test(input.assignedUserId)) throw validation('Pick a user to assign this to-do to.');
  const hasType = input.entityType !== undefined && input.entityType !== null;
  const hasId = input.entityId !== undefined && input.entityId !== null;
  if (hasType !== hasId && (input.entityType !== undefined || input.entityId !== undefined)) {
    throw validation('Link a to-do with both a record type and a record (or neither).');
  }
  if (hasType && !TODO_ENTITY_TYPES.includes(input.entityType!)) throw validation('Unknown record type.');
}

/** Can this member see to-dos linked to this kind of record? Unlinked to-dos: always. */
export function canSeeTodoLink(ctx: ServiceContext, entityType: string | null | undefined): boolean {
  if (!entityType || !ctx.access) return true;
  const area = TODO_ENTITY_AREA[entityType as TodoEntityType];
  return area ? can(ctx.access, area, 'view') : true;
}

/** Display name of a linked record (throws NOT_FOUND when it isn't in this company). */
async function linkedName(ctx: ServiceContext, entityType: TodoEntityType, entityId: string): Promise<string> {
  if (!UUID_RE.test(entityId)) throw notFound(entityType.replace('_', ' '));
  if (entityType === 'lead') {
    const [row] = await ctx.db
      .select({ n: leads.name })
      .from(leads)
      .where(and(eq(leads.id, entityId), eq(leads.companyId, ctx.companyId)));
    if (!row) throw notFound('lead');
    return row.n;
  }
  return entityDisplayName(ctx, entityType as LinkEntityType, entityId);
}

/** Never trust a client-supplied id: a linked record must exist in this company. */
async function assertLinkedRecord(
  ctx: ServiceContext,
  entityType: TodoEntityType | null | undefined,
  entityId: string | null | undefined,
): Promise<void> {
  if (!entityType || !entityId) return;
  if (!canSeeTodoLink(ctx, entityType)) {
    throw validation(`You don't have access to ${entityType.replace('_', ' ')} records, so you can't link a to-do to one.`);
  }
  try {
    await linkedName(ctx, entityType, entityId);
  } catch {
    throw validation(`The linked ${entityType.replace('_', ' ')} was not found in this company.`);
  }
}

async function assertAssignee(ctx: ServiceContext, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const [m] = await ctx.db
    .select({ u: userCompanies.userId })
    .from(userCompanies)
    .where(and(eq(userCompanies.companyId, ctx.companyId), eq(userCompanies.userId, userId)));
  if (!m) throw validation('That user is not a member of this company.');
}

async function toView(ctx: ServiceContext, r: TodoRow): Promise<TodoView> {
  let entityName: string | null = null;
  if (r.entityType && r.entityId) {
    entityName = await linkedName(ctx, r.entityType as TodoEntityType, r.entityId).catch(() => null);
  }
  return { ...r, details: r.notes, type: r.kind, completedAt: r.doneAt, entityName };
}

/**
 * Display names of the records many to-dos link to, one query per record type (not one per
 * to-do: the Calendar, Reminders and the inbox list every open to-do). Same names as linkedName.
 */
async function linkedNames(ctx: ServiceContext, rows: TodoRow[]): Promise<Map<string, string>> {
  const byType = new Map<TodoEntityType, Set<string>>();
  for (const r of rows) {
    if (!r.entityType || !r.entityId || !UUID_RE.test(r.entityId)) continue;
    const t = r.entityType as TodoEntityType;
    if (!TODO_ENTITY_TYPES.includes(t)) continue;
    if (!byType.has(t)) byType.set(t, new Set());
    byType.get(t)!.add(r.entityId);
  }
  const out = new Map<string, string>();
  const c = ctx.companyId;
  for (const [type, idSet] of byType) {
    const all = [...idSet];
    for (let i = 0; i < all.length; i += 500) {
      const ids = all.slice(i, i + 500);
      let found: Array<{ id: string; n: string }> = [];
      if (type === 'customer') {
        found = await ctx.db.select({ id: customers.id, n: customers.displayName }).from(customers).where(and(eq(customers.companyId, c), inArray(customers.id, ids)));
      } else if (type === 'vendor') {
        found = await ctx.db.select({ id: vendors.id, n: vendors.displayName }).from(vendors).where(and(eq(vendors.companyId, c), inArray(vendors.id, ids)));
      } else if (type === 'employee') {
        const rs = await ctx.db
          .select({ id: employees.id, f: employees.firstName, l: employees.lastName })
          .from(employees)
          .where(and(eq(employees.companyId, c), inArray(employees.id, ids)));
        found = rs.map((r) => ({ id: r.id, n: `${r.f} ${r.l}` }));
      } else if (type === 'lead') {
        found = await ctx.db.select({ id: leads.id, n: leads.name }).from(leads).where(and(eq(leads.companyId, c), inArray(leads.id, ids)));
      } else if (type === 'other_name') {
        found = await ctx.db.select({ id: otherNames.id, n: otherNames.name }).from(otherNames).where(and(eq(otherNames.companyId, c), inArray(otherNames.id, ids)));
      } else if (type === 'item') {
        found = await ctx.db.select({ id: items.id, n: items.name }).from(items).where(and(eq(items.companyId, c), inArray(items.id, ids)));
      }
      for (const f of found) out.set(`${type}:${f.id}`, f.n);
    }
  }
  return out;
}

export interface ListTodosOptions {
  /** Which statuses to return. Default: 'open' (or open + done with includeDone). */
  status?: TodoStatus | 'all';
  /** Include finished to-dos (default false). Inactive ones need status 'inactive' / 'all'. */
  includeDone?: boolean;
  /** Only to-dos due on/before this 'YYYY-MM-DD' (plus undated ones when includeUndated). */
  dueOnOrBefore?: string;
  includeUndated?: boolean;
  from?: string;
  to?: string;
  entityType?: string;
  entityId?: string;
  assignedUserId?: string;
}

export async function listTodos(ctx: ServiceContext, opts: ListTodosOptions = {}): Promise<TodoView[]> {
  const conds = [eq(todos.companyId, ctx.companyId)];
  const status = opts.status ?? (opts.includeDone ? undefined : 'open');
  if (status && status !== 'all') conds.push(eq(todos.status, status));
  else if (!status) conds.push(inArray(todos.status, ['open', 'done']));
  if (opts.entityType) conds.push(eq(todos.entityType, opts.entityType));
  if (opts.entityId) {
    if (!UUID_RE.test(opts.entityId)) return [];
    conds.push(eq(todos.entityId, opts.entityId));
  }
  if (opts.assignedUserId) {
    if (!UUID_RE.test(opts.assignedUserId)) return [];
    conds.push(eq(todos.assignedUserId, opts.assignedUserId));
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
    .orderBy(asc(todos.dueDate), asc(todos.dueTime), asc(todos.createdAt));
  const visible = rows.filter(
    (r) =>
      canSeeTodoLink(ctx, r.entityType) &&
      (!opts.from || (r.dueDate ?? '') >= opts.from) &&
      (!opts.to || (r.dueDate ?? '9999') <= opts.to),
  );
  // Undated to-dos sort last (QB lists dated ones first).
  visible.sort((a, b) => (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1));
  const names = await linkedNames(ctx, visible);
  return visible.map((r) => ({
    ...r,
    details: r.notes,
    type: r.kind,
    completedAt: r.doneAt,
    entityName: r.entityType && r.entityId ? (names.get(`${r.entityType}:${r.entityId}`) ?? null) : null,
  }));
}

/**
 * Open to-dos that belong in the Reminders list as of `today`: a to-do with a "remind me on"
 * date shows from that day; otherwise it shows once it is due within `days` days.
 */
export async function todosToRemind(ctx: ServiceContext, today: string, horizon: string): Promise<TodoView[]> {
  const rows = await listTodos(ctx, { status: 'open' });
  return rows.filter((r) => (r.remindOn ? r.remindOn <= today : !!r.dueDate && r.dueDate <= horizon));
}

async function load(ctx: ServiceContext, id: string): Promise<TodoRow> {
  if (!UUID_RE.test(id)) throw notFound('To-do');
  const [row] = await ctx.db.select().from(todos).where(and(eq(todos.id, id), eq(todos.companyId, ctx.companyId)));
  // A to-do about a record the member can't see is treated as not there at all.
  if (!row || !canSeeTodoLink(ctx, row.entityType)) throw notFound('To-do');
  return row;
}

export async function getTodo(ctx: ServiceContext, id: string): Promise<TodoView> {
  return toView(ctx, await load(ctx, id));
}

/** Resolve status + done from a patch (status wins; done=false re-opens). */
function nextStatus(input: TodoInput, before: TodoStatus): TodoStatus {
  if (input.status !== undefined) return input.status;
  if (input.done !== undefined) return input.done ? 'done' : before === 'done' ? 'open' : before;
  return before;
}

export async function createTodo(ctx: ServiceContext, input: TodoInput): Promise<TodoView> {
  checkInput(input, true);
  // View-only check, link check, insert and audit commit together (nothing left behind on refusal).
  const row = await inTransaction(ctx, async (tx) => {
    await assertLinkedRecord(tx, input.entityType, input.entityId);
    await assertAssignee(tx, input.assignedUserId);
    const status = nextStatus(input, 'open');
    const [created] = await tx.db
      .insert(todos)
      .values({
        companyId: tx.companyId,
        userId: tx.userId,
        title: input.title!.trim(),
        notes: input.notes?.trim() || null,
        kind: input.kind ?? 'task',
        priority: input.priority ?? 'medium',
        dueDate: input.dueDate || null,
        dueTime: input.dueTime || null,
        status,
        done: status === 'done',
        doneAt: status === 'done' ? new Date() : null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        assignedUserId: input.assignedUserId ?? null,
        remindOn: input.remindOn || null,
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'todo',
      entityId: created.id,
      newValues: { title: created.title, dueDate: created.dueDate, status: created.status, entityType: created.entityType, entityId: created.entityId },
    });
    return created;
  });
  return toView(ctx, row);
}

export async function updateTodo(ctx: ServiceContext, id: string, input: TodoInput): Promise<TodoView> {
  checkInput(input, false);
  const row = await inTransaction(ctx, async (tx) => {
    const before = await load(tx, id);
    // Validate the link this patch will leave behind (either half may change).
    if (input.entityType !== undefined || input.entityId !== undefined) {
      const nextType = input.entityType !== undefined ? input.entityType : (before.entityType as TodoEntityType | null);
      const nextId = input.entityId !== undefined ? input.entityId : before.entityId;
      if (!nextType !== !nextId) throw validation('Link a to-do with both a record type and a record (or neither).');
      if (nextType && !TODO_ENTITY_TYPES.includes(nextType)) throw validation('Unknown record type.');
      await assertLinkedRecord(tx, nextType, nextId);
    }
    if (input.assignedUserId !== undefined) await assertAssignee(tx, input.assignedUserId);
    const patch: Partial<typeof todos.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate || null;
    if (input.dueTime !== undefined) patch.dueTime = input.dueTime || null;
    if (input.remindOn !== undefined) patch.remindOn = input.remindOn || null;
    if (input.assignedUserId !== undefined) patch.assignedUserId = input.assignedUserId || null;
    const status = nextStatus(input, before.status as TodoStatus);
    if (status !== before.status || input.done !== undefined || input.status !== undefined) {
      patch.status = status;
      patch.done = status === 'done';
      patch.doneAt = status === 'done' ? (before.doneAt ?? new Date()) : null;
    }
    if (input.entityType !== undefined) patch.entityType = input.entityType;
    if (input.entityId !== undefined) patch.entityId = input.entityId;
    const [updated] = await tx.db
      .update(todos)
      .set(patch)
      .where(and(eq(todos.id, id), eq(todos.companyId, tx.companyId)))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'todo',
      entityId: id,
      oldValues: { title: before.title, dueDate: before.dueDate, status: before.status },
      newValues: { title: updated.title, dueDate: updated.dueDate, status: updated.status },
    });
    return updated;
  });
  return toView(ctx, row);
}

export async function deleteTodo(ctx: ServiceContext, id: string): Promise<void> {
  await inTransaction(ctx, async (tx) => {
    const before = await load(tx, id);
    await tx.db.delete(todos).where(and(eq(todos.id, id), eq(todos.companyId, tx.companyId)));
    await writeAudit(tx, { action: 'delete', entityType: 'todo', entityId: id, oldValues: { title: before.title, status: before.status } });
  });
}

/**
 * Merge / lead-convert helper: move every to-do linked to one record onto another. Must run
 * inside the caller's transaction (it does not audit on its own — the merge does).
 */
export async function moveTodos(
  tx: ServiceContext,
  entityType: TodoEntityType,
  fromId: string,
  toId: string,
  toType: TodoEntityType = entityType,
): Promise<number> {
  const moved = await tx.db
    .update(todos)
    .set({ entityType: toType, entityId: toId, updatedAt: new Date() })
    .where(and(eq(todos.companyId, tx.companyId), eq(todos.entityType, entityType), eq(todos.entityId, fromId)))
    .returning({ id: todos.id });
  return moved.length;
}
