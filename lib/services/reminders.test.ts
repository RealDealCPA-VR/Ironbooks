/**
 * Reminders (J7), Calendar (J6) and the To Do list: categories follow Preferences > Reminders
 * (summary / list / off + look-ahead days), respect the member's permissions, and the calendar
 * shows entered vs due transactions, to-dos and scheduled memorized transactions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, unionRoles } from '@/lib/permissions/model';
import { updateCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createExpense } from './expenses';
import { createTemplate } from './recurring';
import { createTodo, deleteTodo, listTodos, updateTodo } from './todos';
import { getReminders } from './reminders';
import { getCalendar } from './calendar';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const TODAY = '2026-06-15';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('Reminders, Calendar and To-dos (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('reminders');
    const customer = await createCustomer(t.ctx, { displayName: 'Late Payer' });
    const vendor = await createVendor(t.ctx, { displayName: 'Power Co' });
    // Overdue invoice (due May 1) and a current one (due July 30).
    await createInvoice(t.ctx, {
      customerId: customer.id,
      date: day('2026-04-01'),
      dueDate: day('2026-05-01'),
      lines: [{ description: 'Old work', quantity: '1', rate: '300.00' }],
    });
    await createInvoice(t.ctx, {
      customerId: customer.id,
      date: day('2026-06-10'),
      dueDate: day('2026-07-30'),
      lines: [{ description: 'New work', quantity: '1', rate: '50.00' }],
    });
    // Bill due in 5 days, and one due in 40 days.
    await createBill(t.ctx, { vendorId: vendor.id, date: day('2026-06-01'), dueDate: day('2026-06-20'), lines: [{ accountId: t.acct['6600'], amount: '120.00' }] });
    await createBill(t.ctx, { vendorId: vendor.id, date: day('2026-06-01'), dueDate: day('2026-07-25'), lines: [{ accountId: t.acct['6600'], amount: '80.00' }] });
    // A check waiting to be printed.
    await createExpense(t.ctx, {
      payeeName: 'Landlord',
      date: day('2026-06-14'),
      method: 'check',
      paymentAccountId: t.acct['1000'],
      toPrint: true,
      lines: [{ accountId: t.acct['6400'], amount: '900.00' }],
    });
    // A remind-only memorized bill due tomorrow.
    await createTemplate(t.ctx, {
      name: 'Internet',
      docType: 'bill',
      frequency: 'monthly',
      nextRunDate: day('2026-06-16'),
      mode: 'remind',
      template: { vendorId: vendor.id, lines: [{ accountId: t.acct['6600'], amount: '60.00' }] },
    });
    await createTodo(t.ctx, { title: 'Call Late Payer', dueDate: '2026-06-14', kind: 'call' });
    await createTodo(t.ctx, { title: 'Plan next year', dueDate: '2026-09-01' });
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('lists what needs attention with counts and totals', async () => {
    const r = await getReminders(t.ctx, { today: TODAY });
    const byKey = Object.fromEntries(r.sections.map((s) => [s.key, s]));
    expect(byKey.overdueInvoices.count).toBe(1);
    expect(byKey.overdueInvoices.total).toBe('300.00');
    expect(byKey.billsToPay.count).toBe(1); // only the one inside the 10-day window
    expect(byKey.billsToPay.total).toBe('120.00');
    expect(byKey.checksToPrint.count).toBe(1);
    expect(byKey.memorizedTransactionsDue.items[0].label).toMatch(/Internet/);
    expect(byKey.toDoNotes.items.map((i) => i.label)).toEqual(['Call Late Payer']);
  });

  it('follows Preferences > Reminders (off, list, look-ahead days)', async () => {
    await updateCompany(t.ctx, {
      settings: {
        reminders: {
          checksToPrint: { mode: 'off', days: 0 },
          billsToPay: { mode: 'list', days: 60 },
          overdueInvoices: { mode: 'summary', days: 60 }, // 60 days after due: May 1 is not yet
        },
      } as never,
    });
    const r = await getReminders(t.ctx, { today: TODAY });
    const keys = r.sections.map((s) => s.key);
    expect(keys).not.toContain('checksToPrint');
    expect(keys).not.toContain('overdueInvoices');
    const bills = r.sections.find((s) => s.key === 'billsToPay')!;
    expect(bills.mode).toBe('list');
    expect(bills.count).toBe(2);
  });

  it('leaves out categories the member cannot view', async () => {
    const salesOnly = unionRoles(BUILTIN_ROLES.filter((r) => r.key === 'sales'));
    const r = await getReminders({ ...t.ctx, access: salesOnly }, { today: TODAY });
    const keys = r.sections.map((s) => s.key);
    expect(keys).not.toContain('billsToPay');
    const cal = await getCalendar({ ...t.ctx, access: salesOnly }, { from: '2026-06-01', to: '2026-06-30', today: TODAY });
    expect(cal.days.flatMap((d) => d.events).some((e) => e.kind === 'bill')).toBe(false);
  });

  it('calendar shows entered, due, scheduled and to-do items by day', async () => {
    const cal = await getCalendar(t.ctx, { from: '2026-06-01', to: '2026-06-30', today: TODAY });
    const on = (d: string) => cal.days.find((x) => x.date === d)?.events ?? [];
    expect(on('2026-06-10').some((e) => e.kind === 'invoice' && e.type === 'entered')).toBe(true);
    expect(on('2026-06-20').some((e) => e.kind === 'bill' && e.type === 'due')).toBe(true);
    expect(on('2026-06-16').some((e) => e.kind === 'memorized' && e.type === 'scheduled')).toBe(true);
    const todo = on('2026-06-14').find((e) => e.kind === 'todo')!;
    expect(todo.overdue).toBe(true);
    expect(on('2026-06-14').some((e) => e.kind === 'check')).toBe(true);
    // Overdue invoice due date is outside the month: not shown in June.
    expect(cal.days.every((d) => d.date >= '2026-06-01' && d.date <= '2026-06-30')).toBe(true);
    await expect(getCalendar(t.ctx, { from: '2026-06-30', to: '2026-06-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(getCalendar(t.ctx, { from: '2020-01-01', to: '2026-01-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('to-dos: validate, complete, link and delete', async () => {
    await expect(createTodo(t.ctx, { title: '  ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTodo(t.ctx, { title: 'x', dueDate: '06/01/2026' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTodo(t.ctx, { title: 'x', entityType: 'customer' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [call] = await listTodos(t.ctx);
    const done = await updateTodo(t.ctx, call.id, { done: true });
    expect(done.done).toBe(true);
    expect(done.doneAt).toBeTruthy();
    expect((await listTodos(t.ctx)).some((x) => x.id === call.id)).toBe(false);
    expect((await listTodos(t.ctx, { includeDone: true })).some((x) => x.id === call.id)).toBe(true);
    await deleteTodo(t.ctx, call.id);
    await expect(updateTodo(t.ctx, call.id, { done: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
