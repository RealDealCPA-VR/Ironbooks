/**
 * Review round 5 — the To Do list on a large company file (failed before the fix): listing
 * to-dos looked up the linked customer / vendor / item name with one query PER TO-DO, so the
 * Calendar, Reminders and the inbox (each lists every open to-do) slowed down linearly. Names are
 * now read with one query per record type — and are the same names as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '@/lib/db';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createTodo, listTodos } from './todos';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('r5-todos');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('listTodos on many linked to-dos', () => {
  it('reads linked names per record type, not per to-do', async () => {
    const custs = [];
    for (let i = 0; i < 12; i++) custs.push(await createCustomer(t.ctx, { displayName: `R5 Todo Customer ${i}` }));
    const vend = await createVendor(t.ctx, { displayName: 'R5 Todo Vendor' });
    for (const c of custs) await createTodo(t.ctx, { title: `Call ${c.displayName}`, entityType: 'customer', entityId: c.id });
    for (let i = 0; i < 3; i++) await createTodo(t.ctx, { title: `Pay vendor ${i}`, entityType: 'vendor', entityId: vend.id });
    await createTodo(t.ctx, { title: 'Unlinked' });

    let selects = 0;
    const counting = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'select') {
          return (...args: unknown[]) => {
            selects++;
            return (target.select as (...a: unknown[]) => unknown)(...args);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as DB;

    const rows = await listTodos({ ...t.ctx, db: counting });
    expect(rows).toHaveLength(16);
    expect(rows.find((r) => r.title === 'Call R5 Todo Customer 7')?.entityName).toBe('R5 Todo Customer 7');
    expect(rows.find((r) => r.title === 'Pay vendor 1')?.entityName).toBe('R5 Todo Vendor');
    expect(rows.find((r) => r.title === 'Unlinked')?.entityName).toBeNull();
    // The to-do list itself + one per linked record type (customers, vendors).
    expect(selects).toBeLessThanOrEqual(3);
  });
});
