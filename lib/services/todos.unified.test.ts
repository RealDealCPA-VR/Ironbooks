/**
 * p1 ux: ONE To Do list. Migration 0039 copies the old Lists > To Do rows (todo_items) into the
 * `todos` store under the same ids (idempotent, nothing lost); both old API paths keep working on
 * the one store; Calendar, Reminders and the Lead Center see every to-do; and to-dos linked to a
 * record follow that record's permission area.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { todoItems, todos, userPreferences } from '@/lib/db/schema';
import { BUILTIN_ROLES, unionRoles } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createLead, convertLeadToCustomer } from './leads';
import { moveNotesAndTodos } from './lists/notes';
import { createTodo, listTodos, parseTodoBody, updateTodo, deleteTodo, getTodo } from './todos';
import * as listsTodos from './lists/todos';
import { getReminders } from './reminders';
import { getCalendar } from './calendar';
import { getMyPreferences } from './preferences';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import * as todosRoute from '@/app/api/todos/route';
import * as todoIdRoute from '@/app/api/todos/[id]/route';
import * as calTodosRoute from '@/app/api/calendar/todos/route';
import * as calTodoIdRoute from '@/app/api/calendar/todos/[id]/route';

let t: TestCompany;
const TODAY = '2026-06-15';

function req(url: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Run every statement of migration 0039 again (it must be safe to repeat). */
async function rerunMigration() {
  const text = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0039_p1_ux.sql'), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim();
    if (body) await t.db.execute(sql.raw(body));
  }
}

beforeAll(async () => {
  t = await makeTestCompany('todos-unified');
  ctx = t.ctx;
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0039: one To Do store', () => {
  it('copies todo_items rows into todos under the same ids, keeps todos rows, and is idempotent', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'Migrated Customer' });
    // Old Lists > To Do rows (written straight to the legacy table, as before 0039).
    const [legacyOpen] = await t.db
      .insert(todoItems)
      .values({
        companyId: t.ctx.companyId,
        title: 'Legacy call',
        details: 'from Lists',
        type: 'fax',
        priority: 'high',
        status: 'open',
        dueDate: new Date('2026-06-10T00:00:00.000Z'),
        entityType: 'customer',
        entityId: c.id,
        createdBy: t.ctx.userId,
      })
      .returning();
    const [legacyDone] = await t.db
      .insert(todoItems)
      .values({
        companyId: t.ctx.companyId,
        title: 'Legacy meeting',
        type: 'meeting',
        status: 'done',
        dueDate: new Date('2026-06-01T14:30:00.000Z'),
        completedAt: new Date('2026-06-02T00:00:00.000Z'),
      })
      .returning();
    const [legacyInactive] = await t.db
      .insert(todoItems)
      .values({ companyId: t.ctx.companyId, title: 'Legacy shelved', status: 'inactive' })
      .returning();
    // An old Calendar to-do marked done before the status column existed.
    const [calDone] = await t.db
      .insert(todos)
      .values({ companyId: t.ctx.companyId, title: 'Old calendar task', done: true, status: 'open', dueDate: '2026-05-01' })
      .returning();

    const before = (await t.db.select({ id: todos.id }).from(todos)).length;
    await rerunMigration();
    const after = await t.db.select().from(todos);
    expect(after.length).toBe(before + 3);

    const byId = Object.fromEntries(after.map((r) => [r.id, r]));
    expect(byId[legacyOpen.id]).toMatchObject({
      title: 'Legacy call',
      notes: 'from Lists',
      kind: 'fax',
      priority: 'high',
      status: 'open',
      done: false,
      dueDate: '2026-06-10',
      dueTime: null,
      entityType: 'customer',
      entityId: c.id,
      userId: t.ctx.userId,
    });
    expect(byId[legacyDone.id]).toMatchObject({ status: 'done', done: true, dueDate: '2026-06-01', dueTime: '14:30' });
    expect(byId[legacyDone.id].doneAt).toBeTruthy();
    expect(byId[legacyInactive.id]).toMatchObject({ status: 'inactive', done: false, dueDate: null });
    expect(byId[calDone.id]).toMatchObject({ status: 'done', done: true });

    // Second run: nothing duplicated, nothing changed, legacy rows still there (no data loss).
    await rerunMigration();
    expect((await t.db.select({ id: todos.id }).from(todos)).length).toBe(after.length);
    expect((await t.db.select({ id: todoItems.id }).from(todoItems)).length).toBeGreaterThanOrEqual(3);

    // The migrated rows are visible everywhere: To Do list, old Lists alias, old Calendar alias.
    const open = await listTodos(t.ctx);
    expect(open.find((r) => r.id === legacyOpen.id)?.entityName).toBe('Migrated Customer');
    const viaLists = await listsTodos.listTodos(t.ctx, { status: 'all' });
    expect(viaLists.map((r) => r.id)).toEqual(expect.arrayContaining([legacyOpen.id, legacyDone.id, legacyInactive.id]));
    const viaListsRow = viaLists.find((r) => r.id === legacyOpen.id)!;
    expect(viaListsRow).toMatchObject({ details: 'from Lists', type: 'fax', status: 'open' });

    // Clean up so later tests start from known data.
    for (const id of [legacyOpen.id, legacyDone.id, legacyInactive.id, calDone.id]) await deleteTodo(t.ctx, id);
  });

  it('existing members keep the full menu; brand-new members start with every menu too', async () => {
    // The owner created by the test kit existed when the migration ran again above.
    await t.db.delete(userPreferences).where(eq(userPreferences.userId, t.ctx.userId!));
    expect((await getMyPreferences(t.ctx)).navMode).toBe('advanced'); // a new user: no stored prefs
    await rerunMigration();
    expect((await getMyPreferences(t.ctx)).navMode).toBe('advanced');
  });
});

describe('the one To Do list', () => {
  it('accepts both field styles and keeps status and done in step', async () => {
    const a = await createTodo(t.ctx, parseTodoBody({ title: 'Lists style', details: 'd', type: 'appointment', status: 'open', dueDate: '2026-06-20T00:00:00.000Z' }));
    expect(a).toMatchObject({ notes: 'd', details: 'd', kind: 'appointment', type: 'appointment', dueDate: '2026-06-20', status: 'open', done: false });
    const done = await updateTodo(t.ctx, a.id, { status: 'done' });
    expect(done).toMatchObject({ done: true, status: 'done' });
    expect(done.completedAt).toBeTruthy();
    const reopened = await updateTodo(t.ctx, a.id, { done: false });
    expect(reopened).toMatchObject({ done: false, status: 'open', doneAt: null });
    const shelved = await updateTodo(t.ctx, a.id, { status: 'inactive' });
    expect(shelved.done).toBe(false);
    expect((await listTodos(t.ctx, { includeDone: true })).some((r) => r.id === a.id)).toBe(false);
    expect((await listTodos(t.ctx, { status: 'inactive' })).some((r) => r.id === a.id)).toBe(true);
    await expect(createTodo(t.ctx, { title: 'x', status: 'later' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTodo(t.ctx, { title: 'x', remindOn: '2026-02-30' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTodo(t.ctx, { title: 'x', assignedUserId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await deleteTodo(t.ctx, a.id);
  });

  it('links to customers, vendors, leads, other names and items; merges and lead conversion carry them', async () => {
    const c1 = await createCustomer(t.ctx, { displayName: 'Merge From' });
    const c2 = await createCustomer(t.ctx, { displayName: 'Merge Into' });
    const todo = await createTodo(t.ctx, { title: 'Call about order', entityType: 'customer', entityId: c1.id });
    await moveNotesAndTodos(t.ctx, 'customer', c1.id, c2.id);
    expect((await getTodo(t.ctx, todo.id)).entityName).toBe('Merge Into');

    const lead = await createLead(t.ctx, { name: 'Prospect Pat', companyName: 'Pat Prospects LLC' });
    const leadTodo = await createTodo(t.ctx, { title: 'Send quote', entityType: 'lead', entityId: lead.id, dueDate: '2026-06-14' });
    expect(leadTodo.entityName).toBe('Prospect Pat');
    const { customerId } = await convertLeadToCustomer(t.ctx, lead.id, {});
    const moved = await getTodo(t.ctx, leadTodo.id);
    expect(moved).toMatchObject({ entityType: 'customer', entityId: customerId });
    await deleteTodo(t.ctx, todo.id);
    await deleteTodo(t.ctx, leadTodo.id);
  });

  it('Reminders show due to-dos (and "remind me on" ones); Calendar shows every to-do from either path', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Paper Supply' });
    const due = await createTodo(t.ctx, { title: 'Call supplier', dueDate: '2026-06-14', entityType: 'vendor', entityId: v.id });
    const later = await createTodo(t.ctx, { title: 'Plan the party', dueDate: '2026-09-01' });
    const early = await createTodo(t.ctx, { title: 'Start tax prep', dueDate: '2026-09-15', remindOn: '2026-06-10' });
    // Created through the OLD Lists path: still lands in Reminders and on the Calendar.
    const viaLists = await listsTodos.createTodo(t.ctx, { title: 'Fax the bank', dueDate: '2026-06-15T00:00:00.000Z', type: 'fax' });

    const r = await getReminders(t.ctx, { today: TODAY });
    const section = r.sections.find((s) => s.key === 'toDoNotes')!;
    const labels = section.items.map((i) => i.label);
    expect(labels).toContain('Call supplier (Paper Supply)');
    expect(labels).toContain('Start tax prep');
    expect(labels).toContain('Fax the bank');
    expect(labels).not.toContain('Plan the party');
    expect(section.href).toBe('/todos');

    const cal = await getCalendar(t.ctx, { from: '2026-06-01', to: '2026-06-30', today: TODAY });
    const onDay = (d: string) => cal.days.find((x) => x.date === d)?.events.filter((e) => e.kind === 'todo') ?? [];
    expect(onDay('2026-06-15').map((e) => e.label)).toContain('Fax the bank');
    expect(onDay('2026-06-14').map((e) => e.label)).toContain('Call supplier');

    for (const x of [due, later, early, viaLists]) await deleteTodo(t.ctx, x.id);
  });

  it('a to-do about a record follows that record\'s permission area', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Secret Vendor' });
    const vendorTodo = await createTodo(t.ctx, { title: 'Negotiate price', entityType: 'vendor', entityId: v.id });
    const plain = await createTodo(t.ctx, { title: 'Water the plants' });
    const sales: ServiceContext = { ...t.ctx, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === 'sales')) };
    const seen = (await listTodos(sales)).map((r) => r.id);
    expect(seen).toContain(plain.id);
    expect(seen).not.toContain(vendorTodo.id);
    await expect(getTodo(sales, vendorTodo.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateTodo(sales, vendorTodo.id, { done: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createTodo(sales, { title: 'x', entityType: 'vendor', entityId: v.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    const r = await getReminders(sales, { today: TODAY });
    expect(JSON.stringify(r)).not.toContain('Negotiate price');
    await deleteTodo(t.ctx, vendorTodo.id);
    await deleteTodo(t.ctx, plain.id);
  });
});

describe('both old API paths work on the one store', () => {
  it('/api/todos (old Lists shape) and /api/calendar/todos (old Calendar shape) see the same to-dos', async () => {
    const r1 = await todosRoute.POST(req('/api/todos', 'POST', { title: 'From lists API', details: 'x', type: 'call', dueDate: '2026-06-18T00:00:00.000Z' }));
    expect(r1.status).toBe(201);
    const a = await r1.json();
    const r2 = await calTodosRoute.POST(req('/api/calendar/todos', 'POST', { title: 'From calendar API', notes: 'y', kind: 'meeting', dueDate: '2026-06-19', dueTime: '09:30' }));
    expect(r2.status).toBe(201);
    const b = await r2.json();

    const listed = await (await todosRoute.GET(req('/api/todos?status=all'))).json();
    expect(listed.todos.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    const cal = await (await calTodosRoute.GET(req('/api/calendar/todos'))).json();
    expect(Array.isArray(cal)).toBe(true);
    expect(cal.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([a.id, b.id]));

    // Edit through the other path than the one it was created with.
    const p1 = await calTodoIdRoute.PATCH(req(`/api/calendar/todos/${a.id}`, 'PATCH', { done: true }), params(a.id));
    expect((await p1.json()).status).toBe('done');
    const p2 = await todoIdRoute.PATCH(req(`/api/todos/${b.id}`, 'PATCH', { status: 'done' }), params(b.id));
    expect((await p2.json()).done).toBe(true);
    const open = await (await todosRoute.GET(req('/api/todos'))).json();
    expect(open.todos.some((x: { id: string }) => x.id === a.id || x.id === b.id)).toBe(false);

    const bad = await todosRoute.GET(req('/api/todos?status=someday'));
    expect(bad.status).toBe(400);
    const d1 = await todoIdRoute.DELETE(req(`/api/todos/${a.id}`, 'DELETE'), params(a.id));
    expect(await d1.json()).toEqual({ deleted: true });
    const d2 = await calTodoIdRoute.DELETE(req(`/api/calendar/todos/${b.id}`, 'DELETE'), params(b.id));
    expect(d2.status).toBe(204);
    expect((await todoIdRoute.GET(req(`/api/todos/${b.id}`), params(b.id))).status).toBe(404);
  });
});
