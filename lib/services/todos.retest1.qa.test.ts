/**
 * p1 ux QA re-test round 1 (tester): proves the parseTodoBody fix (old Lists ISO timestamps for an
 * impossible day are refused) end to end — parser, service, BOTH API paths (create and edit), no
 * row or audit left behind on refusal, the stored day never changes — and that real days still
 * work (leap day, month ends, time kept). Also checks the Lead Center flow now on /api/todos.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { auditLogs, todos } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createLead } from './leads';
import { createTodo, deleteTodo, getTodo, parseTodoBody } from './todos';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import * as todosRoute from '@/app/api/todos/route';
import * as todoIdRoute from '@/app/api/todos/[id]/route';
import * as calTodosRoute from '@/app/api/calendar/todos/route';
import * as calTodoIdRoute from '@/app/api/calendar/todos/[id]/route';

let t: TestCompany;

function req(url: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const IMPOSSIBLE = [
  '2026-02-30T00:00:00.000Z',
  '2026-02-29T00:00:00.000Z', // 2026 is not a leap year
  '2026-04-31T12:00:00.000Z',
  '2026-13-01T00:00:00.000Z',
  '2026-00-10T00:00:00.000Z',
  '2026-06-00T00:00:00.000Z',
  '2026-06-10Tnonsense',
];

async function countRows(title: string) {
  return (await t.db.select().from(todos).where(and(eq(todos.companyId, t.ctx.companyId), eq(todos.title, title)))).length;
}

beforeAll(async () => {
  t = await makeTestCompany('todos-retest1');
  ctx = t.ctx;
});
afterAll(async () => {
  await t.cleanup();
});

describe('re-test: old Lists timestamps for impossible days', () => {
  it('the parser refuses every impossible day instead of rolling it into another month', () => {
    for (const due of IMPOSSIBLE) expect(() => parseTodoBody({ title: 'x', dueDate: due }), due).toThrow(/real date/i);
  });

  it('real days still parse, including leap day and month ends; the calendar day never moves', () => {
    expect(parseTodoBody({ title: 'x', dueDate: '2028-02-29T00:00:00.000Z' }).dueDate).toBe('2028-02-29');
    expect(parseTodoBody({ title: 'x', dueDate: '2026-02-28T00:00:00.000Z' }).dueDate).toBe('2026-02-28');
    expect(parseTodoBody({ title: 'x', dueDate: '2026-04-30T23:59:00.000Z' })).toMatchObject({ dueDate: '2026-04-30', dueTime: '23:59' });
    expect(parseTodoBody({ title: 'x', dueDate: '2026-12-31T00:00:00.000Z' }).dueDate).toBe('2026-12-31');
    // Plain days pass through untouched to the service check; blank clears.
    expect(parseTodoBody({ title: 'x', dueDate: '2026-06-10' }).dueDate).toBe('2026-06-10');
    expect(parseTodoBody({ title: 'x', dueDate: '' }).dueDate).toBeNull();
    expect(parseTodoBody({ title: 'x', dueDate: null }).dueDate).toBeNull();
  });

  it('POST on both API paths answers 400 and saves nothing (no row, no audit)', async () => {
    const before = (await t.db.select().from(auditLogs).where(eq(auditLogs.companyId, t.ctx.companyId))).length;
    for (const [name, route] of [['/api/todos', todosRoute], ['/api/calendar/todos', calTodosRoute]] as const) {
      for (const due of IMPOSSIBLE) {
        const title = `bad-day ${name} ${due}`;
        const res = await route.POST(req(name, 'POST', { title, dueDate: due }));
        expect(res.status, `${name} ${due}`).toBe(400);
        expect(await countRows(title), `${name} ${due}`).toBe(0);
      }
    }
    const after = (await t.db.select().from(auditLogs).where(eq(auditLogs.companyId, t.ctx.companyId))).length;
    expect(after).toBe(before);
  });

  it('PATCH on both API paths refuses the impossible day and leaves the saved day alone', async () => {
    const x = await createTodo(t.ctx, { title: 'Keep my day', dueDate: '2026-02-27' });
    for (const [name, route] of [['/api/todos', todoIdRoute], ['/api/calendar/todos', calTodoIdRoute]] as const) {
      const res = await route.PATCH(req(`${name}/${x.id}`, 'PATCH', { dueDate: '2026-02-30T00:00:00.000Z' }), params(x.id));
      expect(res.status, name).toBe(400);
      expect((await getTodo(t.ctx, x.id)).dueDate, name).toBe('2026-02-27');
    }
    // A real old-style timestamp still edits the day (and time) through the alias.
    const ok = await calTodoIdRoute.PATCH(req(`/api/calendar/todos/${x.id}`, 'PATCH', { dueDate: '2026-03-02T09:30:00.000Z' }), params(x.id));
    expect(ok.status).toBe(200);
    const after = await getTodo(t.ctx, x.id);
    expect(after.dueDate).toBe('2026-03-02');
    expect(after.dueTime).toBe('09:30');
    await deleteTodo(t.ctx, x.id);
  });

  it('createTodo itself (no parser) refuses plain impossible days', async () => {
    for (const due of ['2026-02-30', '2026-02-29', '2026-04-31']) {
      await expect(createTodo(t.ctx, { title: `svc ${due}`, dueDate: due })).rejects.toThrow(/real date/i);
      expect(await countRows(`svc ${due}`)).toBe(0);
    }
  });
});

describe('re-test: Lead Center on /api/todos', () => {
  it('adds a lead to-do, lists it with includeDone, and toggles it done and back, the way the Lead Center page does', async () => {
    const lead = await createLead(t.ctx, { name: 'Retest Lead' } as Parameters<typeof createLead>[1]);
    const created = await todosRoute.POST(req('/api/todos', 'POST', { title: 'Call back', dueDate: '2026-07-01', kind: 'call', entityType: 'lead', entityId: lead.id }));
    expect(created.status).toBe(201);
    const todo = await created.json();
    const list = async () =>
      (await (await todosRoute.GET(req(`/api/todos?includeDone=1&entityType=lead&entityId=${lead.id}`))).json()).todos as Array<{ id: string; title: string; dueDate: string | null; done: boolean }>;
    expect((await list()).map((x) => x.id)).toEqual([todo.id]);
    expect((await list())[0]).toMatchObject({ title: 'Call back', dueDate: '2026-07-01', done: false });
    expect((await todoIdRoute.PATCH(req(`/api/todos/${todo.id}`, 'PATCH', { done: true }), params(todo.id))).status).toBe(200);
    expect((await list())[0].done).toBe(true); // includeDone keeps it in the lead's list
    expect((await todoIdRoute.PATCH(req(`/api/todos/${todo.id}`, 'PATCH', { done: false }), params(todo.id))).status).toBe(200);
    expect((await list())[0].done).toBe(false);
    // The old alias sees the same row (one store).
    const viaAlias = (await (await calTodosRoute.GET(req(`/api/calendar/todos?entityType=lead&entityId=${lead.id}`))).json()) as Array<{ id: string }>;
    expect(viaAlias.map((x) => x.id)).toEqual([todo.id]);
    await deleteTodo(t.ctx, todo.id);
  });
});
