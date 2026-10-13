/**
 * p1 ux QA re-test round 2 (tester): old Lists clients' ISO due timestamps keep the calendar day and
 * time exactly as written (no UTC shift either way), impossible times are refused on both API paths
 * with nothing saved, an explicit dueTime still wins, and the kept day is what Reminders and the
 * calendar alias see.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { auditLogs, todos } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createTodo, deleteTodo, getTodo, parseTodoBody, todosToRemind } from './todos';
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
const rowsTitled = async (title: string) =>
  t.db.select().from(todos).where(and(eq(todos.companyId, t.ctx.companyId), eq(todos.title, title)));
const auditCount = async () => (await t.db.select().from(auditLogs).where(eq(auditLogs.companyId, t.ctx.companyId))).length;

beforeAll(async () => {
  t = await makeTestCompany('todos-retest2');
  ctx = t.ctx;
});
afterAll(async () => {
  await t.cleanup();
});

const KEEP: Array<[string, string, string | undefined]> = [
  ['2026-03-01T00:30:00+01:00', '2026-03-01', '00:30'], // UTC would be Feb 28
  ['2026-03-01T23:15:00-08:00', '2026-03-01', '23:15'], // UTC would be Mar 2
  ['2026-01-01T00:05:00+14:00', '2026-01-01', '00:05'], // UTC would be the previous year
  ['2026-12-31T23:59:59.999-12:00', '2026-12-31', '23:59'], // UTC would be the next year
  ['2026-03-01T00:30:00+0100', '2026-03-01', '00:30'], // offset without a colon
  ['2028-02-29T18:00:00Z', '2028-02-29', '18:00'], // leap day
  ['2026-06-10T09:05', '2026-06-10', '09:05'], // no zone
  ['2026-06-10T09:05:07', '2026-06-10', '09:05'],
  ['2026-06-10T00:00:00+05:00', '2026-06-10', undefined], // midnight as written: no time
];
const BAD = [
  '2026-02-28T24:00:00Z',
  '2026-02-28T24:00',
  '2026-02-28T12:60:00Z',
  '2026-02-28T12:30:60Z',
  '2026-02-28T25:00:00Z',
  '2026-02-28T9:05',
  '2026-02-28T',
  '2026-02-28Tnoon',
  '2026-02-28T12:00:00Zjunk',
  '2026-02-28T12:00:00+01:00 extra',
  '2026-02-30T10:00:00Z', // impossible day still refused first
  '2027-02-29T10:00:00+01:00',
];

describe('re-test 2: parser keeps the written day and time', () => {
  it.each(KEEP)('%s -> %s %s', (due, day, time) => {
    const p = parseTodoBody({ title: 'x', dueDate: due });
    expect(p.dueDate).toBe(day);
    expect(p.dueTime).toBe(time);
  });

  it.each(BAD)('refuses %s', (due) => {
    expect(() => parseTodoBody({ title: 'x', dueDate: due })).toThrow(/real date/i);
  });

  it('an explicit dueTime wins over the time inside the timestamp; blank dueTime clears it', () => {
    expect(parseTodoBody({ title: 'x', dueDate: '2026-03-01T00:30:00+01:00', dueTime: '14:00' })).toMatchObject({ dueDate: '2026-03-01', dueTime: '14:00' });
    expect(parseTodoBody({ title: 'x', dueDate: '2026-03-01T00:30:00+01:00', dueTime: '' })).toMatchObject({ dueDate: '2026-03-01', dueTime: null });
  });

  it('plain days and clears are unchanged', () => {
    expect(parseTodoBody({ title: 'x', dueDate: '2026-03-01' }).dueDate).toBe('2026-03-01');
    expect(parseTodoBody({ title: 'x', dueDate: '' }).dueDate).toBeNull();
    expect(parseTodoBody({ title: 'x', dueDate: null }).dueDate).toBeNull();
    expect(parseTodoBody({ title: 'x' }).dueDate).toBeUndefined();
  });
});

describe('re-test 2: both API paths store the day as written', () => {
  it('POST /api/todos and /api/calendar/todos with an offset timestamp save the written day and time', async () => {
    for (const [name, route] of [['/api/todos', todosRoute], ['/api/calendar/todos', calTodosRoute]] as const) {
      const title = `offset ${name}`;
      const res = await route.POST(req(name, 'POST', { title, dueDate: '2026-03-01T00:30:00+01:00' }));
      expect(res.status, name).toBe(201);
      const [row] = await rowsTitled(title);
      expect(row.dueDate, name).toBe('2026-03-01');
      expect(row.dueTime, name).toBe('00:30');
      await deleteTodo(t.ctx, row.id);
    }
  });

  it('POST with an impossible time answers 400 on both paths and saves nothing (no row, no audit)', async () => {
    const before = await auditCount();
    for (const [name, route] of [['/api/todos', todosRoute], ['/api/calendar/todos', calTodosRoute]] as const) {
      for (const due of BAD) {
        const title = `bad-time ${name} ${due}`;
        const res = await route.POST(req(name, 'POST', { title, dueDate: due }));
        expect(res.status, `${name} ${due}`).toBe(400);
        expect((await rowsTitled(title)).length, `${name} ${due}`).toBe(0);
      }
    }
    expect(await auditCount()).toBe(before);
  });

  it('PATCH on both paths: an offset timestamp sets the written day; T24:00 is refused and the day stays', async () => {
    const x = await createTodo(t.ctx, { title: 'patch-keep', dueDate: '2026-02-27' });
    for (const [name, route] of [['/api/todos', todoIdRoute], ['/api/calendar/todos', calTodoIdRoute]] as const) {
      const bad = await route.PATCH(req(`${name}/${x.id}`, 'PATCH', { dueDate: '2026-02-28T24:00:00Z' }), params(x.id));
      expect(bad.status, name).toBe(400);
      expect((await getTodo(t.ctx, x.id)).dueDate, name).toBe('2026-02-27');
    }
    const ok = await calTodoIdRoute.PATCH(req(`/api/calendar/todos/${x.id}`, 'PATCH', { dueDate: '2026-03-02T23:30:00-07:00' }), params(x.id));
    expect(ok.status).toBe(200);
    expect(await getTodo(t.ctx, x.id)).toMatchObject({ dueDate: '2026-03-02', dueTime: '23:30' });
    const ok2 = await todoIdRoute.PATCH(req(`/api/todos/${x.id}`, 'PATCH', { dueDate: '2026-03-05T00:15:00+09:00' }), params(x.id));
    expect(ok2.status).toBe(200);
    expect(await getTodo(t.ctx, x.id)).toMatchObject({ dueDate: '2026-03-05', dueTime: '00:15' });
    await deleteTodo(t.ctx, x.id);
  });

  it('the kept day is the one Reminders uses (due Mar 1, not due yet on Feb 28) and the old alias lists it', async () => {
    const res = await todosRoute.POST(req('/api/todos', 'POST', { title: 'remind-kept-day', dueDate: '2026-03-01T00:30:00+01:00' }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const ids = async (today: string) => (await todosToRemind(t.ctx, today, today)).map((r) => r.id);
    expect(await ids('2026-02-28')).not.toContain(id); // a UTC shift would have made it due Feb 28
    expect(await ids('2026-03-01')).toContain(id);
    const alias = (await (await calTodosRoute.GET(req('/api/calendar/todos'))).json()) as Array<{ id: string; dueDate: string }>;
    expect(alias.find((r) => r.id === id)?.dueDate).toBe('2026-03-01');
    await deleteTodo(t.ctx, id);
  });
});
