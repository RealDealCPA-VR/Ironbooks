/**
 * p1 ux QA (tester): adversarial tests for THE To Do list (lib/services/todos.ts) and both API
 * paths. View-only members, multi-company isolation in one file, audit trail, rollback on a
 * refused link, date validation of old Lists timestamps, Reminders windows, Calendar and
 * permissions, done/reopen bookkeeping.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { auditLogs, todos, users } from '@/lib/db/schema';
import { BUILTIN_ROLES, unionRoles } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createEmployee } from './payroll';
import { createTodo, deleteTodo, getTodo, listTodos, parseTodoBody, todosToRemind, updateTodo } from './todos';
import { getReminders } from './reminders';
import { getCalendar } from './calendar';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import * as todosRoute from '@/app/api/todos/route';
import * as todoIdRoute from '@/app/api/todos/[id]/route';
import * as calTodosRoute from '@/app/api/calendar/todos/route';
import * as calTodoIdRoute from '@/app/api/calendar/todos/[id]/route';

let t: TestCompany;
let other: ServiceContext; // a second company in the SAME company file database
let viewer: ServiceContext;
const TODAY = '2026-06-15';

function req(url: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const role = (key: string): ServiceContext => ({ ...t.ctx, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)) });

beforeAll(async () => {
  t = await makeTestCompany('todos-qa');
  ctx = t.ctx;
  const [u2] = await t.db.insert(users).values({ email: `other-${Date.now()}@test.local`, name: 'Other owner', passwordHash: 'x' }).returning();
  const c2 = await createCompany(t.db, { name: 'Other Co', ownerId: u2.id });
  other = { db: t.db, companyId: c2.id, userId: u2.id };
  viewer = await addMember(t, 'viewer');
});
afterAll(async () => {
  await t.cleanup();
});

describe('view-only members', () => {
  it('can read the list but cannot add, change or delete a to-do (service and both API paths)', async () => {
    const mine = await createTodo(t.ctx, { title: 'Owner task' });
    expect((await listTodos(viewer)).map((r) => r.id)).toContain(mine.id);
    await expect(createTodo(viewer, { title: 'Sneaky' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateTodo(viewer, mine.id, { done: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteTodo(viewer, mine.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    ctx = viewer;
    try {
      expect((await todosRoute.POST(req('/api/todos', 'POST', { title: 'x' }))).status).toBe(403);
      expect((await calTodosRoute.POST(req('/api/calendar/todos', 'POST', { title: 'x' }))).status).toBe(403);
      expect((await todoIdRoute.PATCH(req(`/api/todos/${mine.id}`, 'PATCH', { done: true }), params(mine.id))).status).toBe(403);
      expect((await calTodoIdRoute.PATCH(req(`/api/calendar/todos/${mine.id}`, 'PATCH', { done: true }), params(mine.id))).status).toBe(403);
      expect((await todoIdRoute.DELETE(req(`/api/todos/${mine.id}`, 'DELETE'), params(mine.id))).status).toBe(403);
      expect((await calTodoIdRoute.DELETE(req(`/api/calendar/todos/${mine.id}`, 'DELETE'), params(mine.id))).status).toBe(403);
      expect((await todosRoute.GET(req('/api/todos'))).status).toBe(200);
    } finally {
      ctx = t.ctx;
    }
    const after = await getTodo(t.ctx, mine.id);
    expect(after).toMatchObject({ status: 'open', done: false });
    expect((await t.db.select().from(todos).where(eq(todos.title, 'Sneaky'))).length).toBe(0);
    await deleteTodo(t.ctx, mine.id);
  });
});

describe('multi-company isolation inside one company file', () => {
  it('another company cannot see, edit, delete or link to this company\'s records', async () => {
    const cust = await createCustomer(t.ctx, { displayName: 'Company A Customer' });
    const a = await createTodo(t.ctx, { title: 'A only', entityType: 'customer', entityId: cust.id, dueDate: '2026-06-14' });

    expect((await listTodos(other, { status: 'all' })).map((r) => r.id)).not.toContain(a.id);
    await expect(getTodo(other, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateTodo(other, a.id, { title: 'hijacked' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteTodo(other, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Linking a company-B to-do to company A's customer is refused, on create and on edit.
    await expect(createTodo(other, { title: 'x', entityType: 'customer', entityId: cust.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    const b = await createTodo(other, { title: 'B task' });
    await expect(updateTodo(other, b.id, { entityType: 'customer', entityId: cust.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Assigning to a user who belongs only to company A is refused.
    await expect(updateTodo(other, b.id, { assignedUserId: t.ctx.userId! })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Company B's Reminders and Calendar never show A's to-do.
    const r = await getReminders(other, { today: TODAY });
    expect(JSON.stringify(r)).not.toContain('A only');
    const cal = await getCalendar(other, { from: '2026-06-01', to: '2026-06-30', today: TODAY });
    expect(JSON.stringify(cal)).not.toContain('A only');

    expect((await getTodo(t.ctx, a.id)).title).toBe('A only');
    await deleteTodo(t.ctx, a.id);
    await deleteTodo(other, b.id);
  });
});

describe('audit trail and rollback', () => {
  it('writes an audit row for create, update and delete', async () => {
    const x = await createTodo(t.ctx, { title: 'Audited' });
    await updateTodo(t.ctx, x.id, { status: 'done' });
    await deleteTodo(t.ctx, x.id);
    const rows = await t.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'todo'), eq(auditLogs.entityId, x.id)));
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'delete', 'update']);
  });

  it('a refused link leaves nothing behind (no row, no audit)', async () => {
    const before = (await t.db.select({ id: todos.id }).from(todos)).length;
    const auditsBefore = (await t.db.select({ id: auditLogs.id }).from(auditLogs)).length;
    await expect(
      createTodo(t.ctx, { title: 'Ghost', entityType: 'vendor', entityId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTodo(t.ctx, { title: 'Half link', entityType: 'vendor' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await t.db.select({ id: todos.id }).from(todos)).length).toBe(before);
    expect((await t.db.select({ id: auditLogs.id }).from(auditLogs)).length).toBe(auditsBefore);
  });
});

describe('dates and fields (both naming styles)', () => {
  it('refuses wrong value types in the body', () => {
    expect(() => parseTodoBody({ title: 5 })).toThrow();
    expect(() => parseTodoBody({ title: 'x', done: 'yes' })).toThrow();
    expect(() => parseTodoBody([])).toThrow();
    expect(() => parseTodoBody(null)).toThrow();
  });

  it('an old Lists timestamp for an impossible day (Feb 30) is refused, not moved to March 2', async () => {
    // Old Lists clients send dueDate as an ISO timestamp. JavaScript rolls 2026-02-30 over to
    // 2026-03-02; the to-do must not silently land on a different day.
    let parsed: ReturnType<typeof parseTodoBody> | null = null;
    let threw = false;
    try {
      parsed = parseTodoBody({ title: 'Feb 30', dueDate: '2026-02-30T00:00:00.000Z' });
    } catch {
      threw = true;
    }
    expect(threw ? null : parsed?.dueDate).toBeNull();
  });

  it('an old Lists timestamp keeps its calendar day and time', () => {
    expect(parseTodoBody({ title: 'x', dueDate: '2026-06-10T00:00:00.000Z' })).toMatchObject({ dueDate: '2026-06-10' });
    expect(parseTodoBody({ title: 'x', dueDate: '2026-06-10T00:00:00.000Z' }).dueTime).toBeUndefined();
    expect(parseTodoBody({ title: 'x', dueDate: '2026-06-10T15:45:00.000Z' })).toMatchObject({ dueDate: '2026-06-10', dueTime: '15:45' });
    // An explicit dueTime wins over the timestamp's time.
    expect(parseTodoBody({ title: 'x', dueDate: '2026-06-10T15:45:00.000Z', dueTime: '08:00' })).toMatchObject({ dueTime: '08:00' });
  });

  it('marking done twice keeps the first completion time; reopening clears it; inactive is not done', async () => {
    const x = await createTodo(t.ctx, { title: 'Twice', status: 'done' });
    expect(x.done).toBe(true);
    const first = x.doneAt;
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 15));
    const again = await updateTodo(t.ctx, x.id, { done: true });
    expect(new Date(again.doneAt!).getTime()).toBe(new Date(first!).getTime());
    const viaStatus = await updateTodo(t.ctx, x.id, { status: 'done' });
    expect(new Date(viaStatus.doneAt!).getTime()).toBe(new Date(first!).getTime());
    const reopened = await updateTodo(t.ctx, x.id, { status: 'open' });
    expect(reopened).toMatchObject({ done: false, doneAt: null, completedAt: null });
    const inactive = await updateTodo(t.ctx, x.id, { status: 'inactive' });
    // done:false on an inactive to-do must not reactivate it.
    const stillInactive = await updateTodo(t.ctx, x.id, { done: false });
    expect(inactive.status).toBe('inactive');
    expect(stillInactive.status).toBe('inactive');
    await deleteTodo(t.ctx, x.id);
  });

  it('unlinking clears both halves; a half unlink is refused', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Unlink Vendor' });
    const x = await createTodo(t.ctx, { title: 'Linked', entityType: 'vendor', entityId: v.id });
    await expect(updateTodo(t.ctx, x.id, { entityId: null })).rejects.toMatchObject({ code: 'VALIDATION' });
    const un = await updateTodo(t.ctx, x.id, { entityType: null, entityId: null });
    expect(un).toMatchObject({ entityType: null, entityId: null, entityName: null });
    await deleteTodo(t.ctx, x.id);
  });
});

describe('service validation matches (via createTodo)', () => {
  it('createTodo refuses the same impossible values', async () => {
    for (const bad of [
      { title: 'x', dueDate: '2026-02-30' },
      { title: 'x', dueDate: '2026-13-01' },
      { title: 'x', dueTime: '24:00' },
      { title: '   ' },
      { title: 'x'.repeat(256) },
      { title: 'x', kind: 'party' },
      { title: 'x', priority: 'urgent' },
      { title: 'x', entityType: 'bank', entityId: '00000000-0000-4000-8000-000000000000' },
    ]) {
      await expect(createTodo(t.ctx, bad as never)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
  });
});

describe('Reminders and Calendar', () => {
  it('follows the "remind me on" day, the due window, status and the to-do reminder preference', async () => {
    const dueToday = await createTodo(t.ctx, { title: 'R due today', dueDate: TODAY });
    const overdue = await createTodo(t.ctx, { title: 'R overdue', dueDate: '2026-06-01' });
    const tomorrow = await createTodo(t.ctx, { title: 'R tomorrow', dueDate: '2026-06-16' });
    const remindToday = await createTodo(t.ctx, { title: 'R remind today, undated', remindOn: TODAY });
    const remindLater = await createTodo(t.ctx, { title: 'R remind later', remindOn: '2026-06-20', dueDate: '2026-06-30' });
    const undated = await createTodo(t.ctx, { title: 'R undated' });
    const doneOverdue = await createTodo(t.ctx, { title: 'R done overdue', dueDate: '2026-06-01', status: 'done' });
    const inactiveOverdue = await createTodo(t.ctx, { title: 'R inactive overdue', dueDate: '2026-06-01', status: 'inactive' });

    const labels = (await todosToRemind(t.ctx, TODAY, TODAY)).map((r) => r.title);
    expect(labels).toEqual(expect.arrayContaining(['R due today', 'R overdue', 'R remind today, undated']));
    for (const no of ['R tomorrow', 'R remind later', 'R undated', 'R done overdue', 'R inactive overdue']) expect(labels).not.toContain(no);
    // A 1-day window brings tomorrow in.
    expect((await todosToRemind(t.ctx, TODAY, '2026-06-16')).map((r) => r.title)).toContain('R tomorrow');

    const rem = await getReminders(t.ctx, { today: TODAY });
    const sec = rem.sections.find((s) => s.key === 'toDoNotes')!;
    expect(sec.items.map((i) => i.label)).toEqual(expect.arrayContaining(['R due today', 'R overdue']));
    expect(sec.items.every((i) => i.href === '/todos')).toBe(true);
    expect(sec.total).toBeNull();

    // Calendar: dated to-dos on their day (done ones too, marked done); undated ones nowhere.
    const cal = await getCalendar(t.ctx, { from: '2026-06-01', to: '2026-06-30', today: TODAY });
    const all = cal.days.flatMap((d) => d.events.filter((e) => e.kind === 'todo').map((e) => ({ ...e, date: d.date })));
    expect(all.find((e) => e.label === 'R overdue')).toMatchObject({ date: '2026-06-01', overdue: true });
    expect(all.find((e) => e.label === 'R done overdue')).toMatchObject({ done: true, overdue: false });
    expect(all.some((e) => e.label === 'R undated')).toBe(false);
    expect(all.some((e) => e.label === 'R inactive overdue')).toBe(false);

    for (const x of [dueToday, overdue, tomorrow, remindToday, remindLater, undated, doneOverdue, inactiveOverdue]) await deleteTodo(t.ctx, x.id);
  });

  it('a member who cannot see employees never sees employee to-dos (list, Reminders, Calendar, API)', async () => {
    const emp = await createEmployee(t.ctx, { firstName: 'Pat', lastName: 'Payroll', payType: 'hourly', payRate: '20' } as never);
    const x = await createTodo(t.ctx, { title: 'Raise review for Pat', entityType: 'employee', entityId: emp.id, dueDate: TODAY });
    const sales = role('sales');
    expect((await listTodos(sales, { status: 'all' })).map((r) => r.id)).not.toContain(x.id);
    expect(JSON.stringify(await getReminders(sales, { today: TODAY }))).not.toContain('Raise review');
    expect(JSON.stringify(await getCalendar(sales, { from: '2026-06-01', to: '2026-06-30', today: TODAY }))).not.toContain('Raise review');
    ctx = sales;
    try {
      const listed = await (await todosRoute.GET(req('/api/todos?status=all'))).json();
      expect(listed.todos.map((r: { id: string }) => r.id)).not.toContain(x.id);
      const cal = await (await calTodosRoute.GET(req(`/api/calendar/todos?entityType=employee&entityId=${emp.id}`))).json();
      expect(cal).toEqual([]);
      expect((await todoIdRoute.GET(req(`/api/todos/${x.id}`), params(x.id))).status).toBe(404);
      expect((await calTodoIdRoute.DELETE(req(`/api/calendar/todos/${x.id}`, 'DELETE'), params(x.id))).status).toBe(404);
    } finally {
      ctx = t.ctx;
    }
    // The payroll processor sees it.
    expect((await listTodos(role('payroll_processor'))).map((r) => r.id)).toContain(x.id);
    await deleteTodo(t.ctx, x.id);
  });
});

describe('old API shapes', () => {
  it('GET /api/todos returns { todos } and /api/calendar/todos a bare array; bad query values are 400', async () => {
    const x = await createTodo(t.ctx, { title: 'Shape' });
    const a = await (await todosRoute.GET(req('/api/todos'))).json();
    expect(Array.isArray(a.todos)).toBe(true);
    const b = await (await calTodosRoute.GET(req('/api/calendar/todos'))).json();
    expect(Array.isArray(b)).toBe(true);
    expect((await todosRoute.GET(req('/api/todos?entityType=bank'))).status).toBe(400);
    expect((await todosRoute.GET(req('/api/todos?entityId=not-an-id'))).status).toBe(400);
    expect((await todoIdRoute.GET(req('/api/todos/not-an-id'), params('not-an-id'))).status).toBe(404);
    expect((await todosRoute.POST(req('/api/todos', 'POST', { notes: 'no title' }))).status).toBe(400);
    await deleteTodo(t.ctx, x.id);
  });
});
