/**
 * Wave-2 PREFS package — independent adversarial QA (tester).
 *
 * Probes the claims of the doer (commit 9127a89) against the accounting invariants and the
 * service-layer rules in _base.ts:
 *  - A1/A2  preference-driven GL accounts never break subledger == control account
 *  - A2     aging basis preference never changes what is owed (only the buckets)
 *  - B17    memorized transactions: idempotent runs (sequential AND concurrent), closing date
 *  - J6/J7  to-dos: view-only members never mutate; links must point at real records
 *  - J8     lead conversion is idempotent
 * The books must stay balanced (TB and balance sheet) after every scenario.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accounts, customers, expenses, invoices, recurringTemplates, todos } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { balanceSheet, trialBalance } from './reports';
import { setClosingDate, updateCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createEmployee, runPaycheck } from './payroll';
import { arAging, arAgingDetail } from './reportsExtra';
import { createTemplate, getTemplate, runDue, runTemplateNow } from './recurring';
import { createTodo, deleteTodo, updateTodo } from './todos';
import { convertLeadToCustomer, createLead } from './leads';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function books() {
  const tb = await trialBalance(t.ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(t.ctx);
  expect(bs.balanced).toBe(true);
}

async function balanceOf(code: string): Promise<string> {
  const [row] = await t.db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.companyId, t.ctx.companyId), eq(accounts.code, code)));
  return Money.of(row.balance).toFixed(2);
}

beforeAll(async () => {
  t = await makeTestCompany('prefsqa');
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

// ---------------------------------------------------------------------------
// A1/A2 — preferred payroll accounts must not corrupt control accounts
// ---------------------------------------------------------------------------
describe('payroll account preferences', () => {
  it('a paycheck never comes out of A/R even if the "paycheck account" preference names it', async () => {
    const emp = await createEmployee(t.ctx, { firstName: 'Pat', lastName: 'Payee', payType: 'salary', payRate: '52000' });
    const arBefore = await balanceOf('1200');
    await updateCompany(t.ctx, { settings: { defaultPaycheckAccountId: t.acct['1200'] } });
    try {
      await runPaycheck(t.ctx, {
        employeeId: emp.id,
        payDate: day('2026-01-15'),
        grossPay: '1000.00',
        taxes: [],
        employerTaxes: [],
        deductions: [],
      } as Parameters<typeof runPaycheck>[1]);
    } catch (err) {
      // Rejecting a non-bank paycheck account is acceptable too.
      expect((err as { code?: string }).code).toBe('VALIDATION');
    }
    try {
      // The A/R control account must still equal the customer subledger (no invoices touched).
      expect(await balanceOf('1200')).toBe(arBefore);
    } finally {
      await updateCompany(t.ctx, { settings: { defaultPaycheckAccountId: null } });
    }
    await books();
  });

  it('wages never post to Accounts Payable even if the "wages expense" preference names it', async () => {
    const emp = await createEmployee(t.ctx, { firstName: 'Ann', lastName: 'Wages', payType: 'salary', payRate: '52000' });
    const apBefore = await balanceOf('2000');
    await updateCompany(t.ctx, { settings: { payrollExpenseAccountId: t.acct['2000'] } });
    try {
      await runPaycheck(t.ctx, {
        employeeId: emp.id,
        payDate: day('2026-01-16'),
        grossPay: '500.00',
        taxes: [],
        employerTaxes: [],
        deductions: [],
      } as Parameters<typeof runPaycheck>[1]);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('VALIDATION');
    }
    try {
      // A/P must stay equal to the open-bill subledger (no bills exist → unchanged).
      expect(await balanceOf('2000')).toBe(apBefore);
    } finally {
      await updateCompany(t.ctx, { settings: { payrollExpenseAccountId: null } });
    }
    await books();
  });
});

// ---------------------------------------------------------------------------
// A2 — aging basis preference only moves buckets, never totals
// ---------------------------------------------------------------------------
describe('aging basis preference', () => {
  it('the A/R aging total is the same under both bases and equals open invoice balances', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'Aging Invariant Co' });
    await createInvoice(t.ctx, {
      customerId: c.id,
      date: day('2026-01-05'),
      dueDate: day('2026-02-04'),
      lines: [{ description: 'A', quantity: '3', rate: '33.33' }],
    });
    await createInvoice(t.ctx, {
      customerId: c.id,
      date: day('2026-03-01'),
      dueDate: day('2026-05-30'),
      lines: [{ description: 'B', quantity: '1', rate: '0.01' }],
    });
    const asOf = day('2026-04-01');
    await updateCompany(t.ctx, { settings: { agingFrom: 'due_date' } });
    const byDue = await arAging(t.ctx, asOf);
    const detailDue = await arAgingDetail(t.ctx, asOf);
    await updateCompany(t.ctx, { settings: { agingFrom: 'transaction_date' } });
    const byTxn = await arAging(t.ctx, asOf);
    const detailTxn = await arAgingDetail(t.ctx, asOf);
    await updateCompany(t.ctx, { settings: { agingFrom: 'due_date' } });

    const rowDue = byDue.rows.find((r) => r.id === c.id)!;
    const rowTxn = byTxn.rows.find((r) => r.id === c.id)!;
    expect(rowDue.total).toBe('100.00');
    expect(rowTxn.total).toBe(rowDue.total);
    expect(byTxn.totals.total).toBe(byDue.totals.total);
    expect(detailTxn.rows.length).toBe(detailDue.rows.length);
    // Transaction-date basis: the March 1 invoice is 31 days old, not "current".
    expect(rowTxn.current).toBe('0.00');
    expect(rowDue.current).toBe('0.01');
  });
});

// ---------------------------------------------------------------------------
// B17 — memorized transactions: idempotency and closing date
// ---------------------------------------------------------------------------
describe('memorized transactions (adversarial)', () => {
  async function countExpensesWithMemo(memo: string) {
    const rows = await t.db
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(eq(expenses.companyId, t.ctx.companyId), eq(expenses.memo, memo)));
    return rows.length;
  }

  it('running the same due date twice enters the transaction once', async () => {
    const memo = 'qa-seq-once';
    const tpl = await createTemplate(t.ctx, {
      name: 'QA sequential',
      docType: 'expense',
      frequency: 'monthly',
      nextRunDate: day('2026-02-01'),
      mode: 'automatic',
      template: {
        payeeName: 'Supplier',
        method: 'cash',
        memo,
        paymentAccountId: t.acct['1000'],
        lines: [{ accountId: t.acct['6400'], amount: '12.34' }],
      },
    });
    await runDue(t.ctx, day('2026-02-02'));
    await runDue(t.ctx, day('2026-02-02'));
    expect(await countExpensesWithMemo(memo)).toBe(1);
    expect((await getTemplate(t.ctx, tpl.id)).nextRunDate?.toISOString().slice(0, 10)).toBe('2026-03-01');
    await books();
  });

  it('two overlapping runs (Electron hourly timer + Run now) never double-post', async () => {
    const memo = 'qa-concurrent-once';
    const tpl = await createTemplate(t.ctx, {
      name: 'QA concurrent',
      docType: 'expense',
      frequency: 'monthly',
      nextRunDate: day('2026-02-10'),
      mode: 'automatic',
      remaining: 1,
      template: {
        payeeName: 'Supplier',
        method: 'cash',
        memo,
        paymentAccountId: t.acct['1000'],
        lines: [{ accountId: t.acct['6400'], amount: '99.99' }],
      },
    });
    const [a, b] = await Promise.all([runDue(t.ctx, day('2026-02-11')), runDue(t.ctx, day('2026-02-11'))]);
    const entered = [...a.generated, ...b.generated].filter((g) => g.templateId === tpl.id);
    expect(entered.length).toBe(1);
    expect(await countExpensesWithMemo(memo)).toBe(1);
    const after = await getTemplate(t.ctx, tpl.id);
    expect(after.remaining).toBe(0);
    expect(after.isActive).toBe(false);
    await books();
  });

  it('a template due inside a closed period posts nothing, stays due, and Enter Now is refused', async () => {
    const memo = 'qa-closed';
    const tpl = await createTemplate(t.ctx, {
      name: 'QA closed period',
      docType: 'expense',
      frequency: 'monthly',
      nextRunDate: day('2025-06-01'),
      mode: 'automatic',
      remaining: 3,
      template: {
        payeeName: 'Old supplier',
        method: 'cash',
        memo,
        paymentAccountId: t.acct['1000'],
        lines: [{ accountId: t.acct['6400'], amount: '10.00' }],
      },
    });
    await setClosingDate(t.ctx, { closingDate: '2025-12-31' });
    try {
      const r = await runDue(t.ctx, day('2025-06-02'));
      expect(r.failed.map((f) => f.templateId)).toContain(tpl.id);
      expect(await countExpensesWithMemo(memo)).toBe(0);
      const still = await getTemplate(t.ctx, tpl.id);
      expect(still.nextRunDate?.toISOString().slice(0, 10)).toBe('2025-06-01');
      expect(still.remaining).toBe(3);
      await expect(runTemplateNow(t.ctx, tpl.id, day('2025-07-01'))).rejects.toBeTruthy();
      const still2 = await getTemplate(t.ctx, tpl.id);
      expect(still2.remaining).toBe(3);
      expect(await countExpensesWithMemo(memo)).toBe(0);
    } finally {
      await setClosingDate(t.ctx, { closingDate: null });
      await t.db.delete(recurringTemplates).where(eq(recurringTemplates.id, tpl.id));
    }
    await books();
  });

  it('a view-only member cannot create a memorized transaction (nothing is left behind)', async () => {
    const viewer = await addMember(t, 'viewer', 'memo-viewer');
    const before = (await t.db.select({ id: recurringTemplates.id }).from(recurringTemplates)).length;
    await expect(
      createTemplate(viewer, {
        name: 'Viewer sneaky',
        docType: 'expense',
        frequency: 'monthly',
        nextRunDate: day('2026-02-01'),
        template: { paymentAccountId: t.acct['1000'], lines: [{ accountId: t.acct['6400'], amount: '1.00' }] },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const after = (await t.db.select({ id: recurringTemplates.id }).from(recurringTemplates)).length;
    expect(after).toBe(before);
  });

  it('rejects malformed schedule options', async () => {
    const base = {
      name: 'Bad',
      docType: 'expense' as const,
      frequency: 'monthly' as const,
      nextRunDate: day('2026-02-01'),
      template: {},
    };
    await expect(createTemplate(t.ctx, { ...base, remaining: -1 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTemplate(t.ctx, { ...base, remaining: 1.5 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTemplate(t.ctx, { ...base, daysInAdvance: 366 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTemplate(t.ctx, { ...base, nextRunDate: 'not a date' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createTemplate(t.ctx, { ...base, frequency: 'hourly' as never }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createTemplate(t.ctx, { ...base, template: [] as never }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
// J6/J7 — to-dos
// ---------------------------------------------------------------------------
describe('to-dos (adversarial)', () => {
  it('a view-only member cannot edit or delete a to-do — and a refused change leaves no trace', async () => {
    const todo = await createTodo(t.ctx, { title: 'Owner task', dueDate: '2026-06-01' });
    const viewer = await addMember(t, 'viewer', 'todo-viewer');

    await expect(updateTodo(viewer, todo.id, { title: 'hijacked', done: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [afterUpdate] = await t.db.select().from(todos).where(eq(todos.id, todo.id));
    expect(afterUpdate.title).toBe('Owner task');
    expect(afterUpdate.done).toBe(false);

    await expect(deleteTodo(viewer, todo.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const stillThere = await t.db.select().from(todos).where(eq(todos.id, todo.id));
    expect(stillThere.length).toBe(1);

    const countBefore = (await t.db.select({ id: todos.id }).from(todos)).length;
    await expect(createTodo(viewer, { title: 'viewer note' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await t.db.select({ id: todos.id }).from(todos)).length).toBe(countBefore);
  });

  it('a to-do can only be linked to a real record of this company', async () => {
    await expect(
      createTodo(t.ctx, {
        title: 'Call ghost',
        entityType: 'customer',
        entityId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|NOT_FOUND/) });
  });

  it('rejects impossible calendar dates', async () => {
    await expect(createTodo(t.ctx, { title: 'Feb 30', dueDate: '2026-02-30' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(createTodo(t.ctx, { title: 'Month 13', dueDate: '2026-13-01' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

// ---------------------------------------------------------------------------
// J8 — Lead Center conversion idempotency
// ---------------------------------------------------------------------------
describe('lead conversion (adversarial)', () => {
  it('converting the same lead twice (double click) creates exactly one customer', async () => {
    const lead = await createLead(t.ctx, { name: 'Double Click Dana', companyName: 'Dana Double LLC' });
    const results = await Promise.allSettled([
      convertLeadToCustomer(t.ctx, lead.id),
      convertLeadToCustomer(t.ctx, lead.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const made = await t.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, t.ctx.companyId), eq(customers.displayName, 'Dana Double LLC')));
    expect(made.length).toBe(1);
  });

  it('a view-only member cannot convert a lead', async () => {
    const lead = await createLead(t.ctx, { name: 'Viewer Victor' });
    const viewer = await addMember(t, 'viewer', 'lead-viewer');
    await expect(convertLeadToCustomer(viewer, lead.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const made = await t.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, t.ctx.companyId), eq(customers.displayName, 'Viewer Victor')));
    expect(made.length).toBe(0);
  });
});

// A/R subledger cross-check over everything this file did (fails if a paycheck hit A/R above).
describe('A/R subledger == control after the whole run', () => {
  it('open invoice balances equal the A/R account', async () => {
    const open = await t.db
      .select({ bal: invoices.balanceDue, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.companyId, t.ctx.companyId));
    const sub = open
      .filter((r) => r.status !== 'void' && r.status !== 'draft')
      .reduce((s, r) => s.plus(Money.of(r.bal)), Money.of(0));
    expect(await balanceOf('1200')).toBe(sub.toFixed(2));
    await books();
  });
});
