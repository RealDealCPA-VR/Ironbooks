/**
 * Wave-2 PREFS package — tester re-test round 1 (independent of the doer's fix commit c25472e).
 *
 * Re-attacks each fix from a different angle than the round-1 tests:
 *  - preference accounts: system accounts that LOOK like the right kind (Undeposited Funds is
 *    seeded as an asset/checking account; Sales Tax Payable as a plain liability), inactive and
 *    foreign accounts, malformed ids, an account whose subtype changes after the preference was
 *    saved, and that a refused paycheck leaves no trace;
 *  - memorized transactions: 3-way overlapping runs across several templates, Run due racing
 *    Enter Now on the last remaining entry;
 *  - to-dos: view-only create leaves nothing, foreign-company links, more impossible dates/times;
 *  - zIsoDay (lib/validation/prefs.ts) used by the API schemas.
 * Books (TB and balance sheet) must stay balanced after every scenario.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accounts, companies, expenses, paychecks, recurringTemplates, todos } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { balanceSheet, trialBalance } from './reports';
import { updateCompany } from './company';
import { createAccount, updateAccount } from './accounts';
import { createCustomer } from './customers';
import { createEmployee, runPaycheck } from './payroll';
import { createTemplate, getTemplate, runDue, runTemplateNow } from './recurring';
import { createTodo } from './todos';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';
import { calendarQuerySchema, isRealIsoDay } from '@/lib/validation/prefs';

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

async function paycheckCount(): Promise<number> {
  const rows = await t.db.select({ id: paychecks.id }).from(paychecks).where(eq(paychecks.companyId, t.ctx.companyId));
  return rows.length;
}

async function expectPrefRejected(settings: Record<string, unknown>) {
  try {
    await expect(updateCompany(t.ctx, { settings } as Parameters<typeof updateCompany>[1])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  } finally {
    // If the bad value was (wrongly) saved, do not let it leak into later scenarios.
    await t.db.update(companies).set({ settings: {} }).where(eq(companies.id, t.ctx.companyId));
  }
}

const paycheckInput = (employeeId: string, iso: string, gross: string) =>
  ({
    employeeId,
    payDate: day(iso),
    grossPay: gross,
    taxes: [],
    employerTaxes: [],
    deductions: [],
  }) as Parameters<typeof runPaycheck>[1];

beforeAll(async () => {
  t = await makeTestCompany('prefsqa2');
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

// ---------------------------------------------------------------------------
// Preference accounts — kinds, system accounts, stale values
// ---------------------------------------------------------------------------
describe('preference accounts (re-test)', () => {
  it('rejects inactive, foreign, malformed and non-string account ids (VALIDATION, never 500)', async () => {
    const dormant = await createAccount(t.ctx, { code: '1090', name: 'Dormant Bank', type: 'asset', subtype: 'checking' });
    await updateAccount(t.ctx, dormant.id, { isActive: false });
    await expectPrefRejected({ defaultPaycheckAccountId: dormant.id });

    const other = await makeTestCompany('prefsqa2-other');
    const foreignBank = other.acct['1000'];
    await other.cleanup();
    // makeTestCompany switched BKA_DATA_DIR; the main company's db handle is still open.
    process.env.BKA_DATA_DIR = t.dir;
    await expectPrefRejected({ defaultPaycheckAccountId: foreignBank });
    await expectPrefRejected({ defaultPaycheckAccountId: '00000000-0000-4000-8000-000000000000' });
    await expectPrefRejected({ defaultPaycheckAccountId: 'not-a-uuid' });
    await expectPrefRejected({ payrollExpenseAccountId: 12345 });
    // Credit card as the paycheck bank, or as the payroll liabilities account.
    await expectPrefRejected({ defaultPaycheckAccountId: t.acct['2100'] });
    await expectPrefRejected({ payrollLiabilityAccountId: t.acct['2100'] });
    // A rejected save must not have changed anything (atomic: one bad key spoils the patch).
    const { getPreferences } = await import('./company');
    await expectPrefRejected({ defaultPaycheckAccountId: t.acct['1010'], payrollExpenseAccountId: t.acct['1200'] });
    expect((await getPreferences(t.ctx)).defaultPaycheckAccountId).toBeNull();
  });

  it('Undeposited Funds can never be the paycheck account (it only clears through Make Deposits)', async () => {
    // 1050 is seeded as asset/checking, so a subtype-only check would wrongly treat it as a bank.
    await expectPrefRejected({ defaultPaycheckAccountId: t.acct['1050'] });
    await expectPrefRejected({ defaultCheckAccountId: t.acct['1050'] });
    await expectPrefRejected({ defaultBillPaymentAccountId: t.acct['1050'] });
  });

  it('Sales Tax Payable can never receive payroll withholdings', async () => {
    // 2200 is seeded as a plain liability; payroll posting to it would make Sales Tax Payable
    // differ from the sales tax owed to agencies.
    await expectPrefRejected({ payrollLiabilityAccountId: t.acct['2200'] });
  });

  it('a bank account later re-typed (subtype changed) is refused at paycheck time and nothing posts', async () => {
    const payroll = await createAccount(t.ctx, { code: '1020', name: 'Payroll Bank', type: 'asset', subtype: 'checking' });
    const emp = await createEmployee(t.ctx, { firstName: 'Ret', lastName: 'Yped', payType: 'salary', payRate: '52000' });
    await updateCompany(t.ctx, { settings: { defaultPaycheckAccountId: payroll.id } });
    try {
      await updateAccount(t.ctx, payroll.id, { subtype: 'fixed_assets' });
      const before = await paycheckCount();
      const expBefore = await balanceOf('6500');
      await expect(runPaycheck(t.ctx, paycheckInput(emp.id, '2026-02-13', '700.00'))).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      expect(await paycheckCount()).toBe(before);
      expect(await balanceOf('6500')).toBe(expBefore);
    } finally {
      await updateAccount(t.ctx, payroll.id, { subtype: 'checking' });
      await updateCompany(t.ctx, { settings: { defaultPaycheckAccountId: null } });
    }
    await books();
  });

  it('a preferred bank account made inactive falls back to 1000 Checking and the paycheck balances', async () => {
    const payroll = await createAccount(t.ctx, { code: '1030', name: 'Old Payroll Bank', type: 'asset', subtype: 'checking' });
    const emp = await createEmployee(t.ctx, { firstName: 'Fall', lastName: 'Back', payType: 'salary', payRate: '52000' });
    await updateCompany(t.ctx, { settings: { defaultPaycheckAccountId: payroll.id } });
    await updateAccount(t.ctx, payroll.id, { isActive: false });
    const checkingBefore = Money.of(await balanceOf('1000'));
    try {
      await runPaycheck(t.ctx, paycheckInput(emp.id, '2026-02-14', '250.00'));
      expect(Money.of(await balanceOf('1000')).toFixed(2)).toBe(checkingBefore.minus('250.00').toFixed(2));
      expect(await balanceOf('1030')).toBe('0.00');
    } finally {
      await t.db.update(companies).set({ settings: {} }).where(eq(companies.id, t.ctx.companyId));
    }
    await books();
  });
});

// ---------------------------------------------------------------------------
// Memorized transactions — heavier overlap
// ---------------------------------------------------------------------------
describe('memorized transactions (re-test)', () => {
  const tpl = (memo: string, remaining: number | null, nextIso: string) => ({
    name: memo,
    docType: 'expense' as const,
    frequency: 'monthly' as const,
    nextRunDate: day(nextIso),
    mode: 'automatic' as const,
    remaining,
    template: {
      payeeName: 'Supplier',
      method: 'cash',
      memo,
      paymentAccountId: t.acct['1000'],
      lines: [{ accountId: t.acct['6400'], amount: '3.33' }],
    },
  });
  async function count(memo: string) {
    return (
      await t.db
        .select({ id: expenses.id })
        .from(expenses)
        .where(and(eq(expenses.companyId, t.ctx.companyId), eq(expenses.memo, memo)))
    ).length;
  }

  it('three overlapping Run due calls over several templates enter each due occurrence exactly once', async () => {
    const a = await createTemplate(t.ctx, tpl('qa2-tri-a', null, '2026-05-01'));
    const b = await createTemplate(t.ctx, tpl('qa2-tri-b', 2, '2026-05-03'));
    const c = await createTemplate(t.ctx, tpl('qa2-tri-c', 1, '2026-05-05'));
    const cashBefore = Money.of(await balanceOf('1000'));
    const runs = await Promise.all([
      runDue(t.ctx, day('2026-05-10')),
      runDue(t.ctx, day('2026-05-10')),
      runDue(t.ctx, day('2026-05-10')),
    ]);
    expect(runs.flatMap((r) => r.failed)).toEqual([]);
    expect(await count('qa2-tri-a')).toBe(1);
    expect(await count('qa2-tri-b')).toBe(1);
    expect(await count('qa2-tri-c')).toBe(1);
    expect(runs.flatMap((r) => r.generated).length).toBe(3);
    expect(Money.of(await balanceOf('1000')).toFixed(2)).toBe(cashBefore.minus('9.99').toFixed(2));
    expect((await getTemplate(t.ctx, b.id)).remaining).toBe(1);
    expect((await getTemplate(t.ctx, c.id)).isActive).toBe(false);
    // Advanced exactly once (past asOf, before the following month's run).
    const nextA = (await getTemplate(t.ctx, a.id)).nextRunDate!.getTime();
    expect(nextA).toBeGreaterThan(day('2026-05-10').getTime());
    expect(nextA).toBeLessThan(day('2026-06-15').getTime());
    await books();
  });

  it('a monthly memorized transaction on the 1st stays on the 1st (no time-zone drift)', async () => {
    // Dates are stored as UTC midnight (the API parses 'YYYY-MM-DD' that way). advanceDate /
    // addMonthsClamped use LOCAL-time getters, so west of UTC 2026-05-01 becomes 2026-05-31.
    const memo = 'qa2-drift';
    const x = await createTemplate(t.ctx, tpl(memo, null, '2026-05-01'));
    await runDue(t.ctx, day('2026-05-02'));
    const next = (await getTemplate(t.ctx, x.id)).nextRunDate?.toISOString().slice(0, 10);
    expect(next).toBe('2026-06-01');
    const [exp] = await t.db
      .select({ date: expenses.date })
      .from(expenses)
      .where(and(eq(expenses.companyId, t.ctx.companyId), eq(expenses.memo, memo)));
    expect(new Date(exp.date as unknown as string).toISOString().slice(0, 10)).toBe('2026-05-01');
    await t.db.delete(recurringTemplates).where(eq(recurringTemplates.id, x.id));
    await books();
  });

  it('Run due racing Enter Now on the last remaining entry posts once', async () => {
    const memo = 'qa2-race-last';
    const x = await createTemplate(t.ctx, tpl(memo, 1, '2026-07-01'));
    await Promise.allSettled([runDue(t.ctx, day('2026-07-02')), runTemplateNow(t.ctx, x.id, day('2026-07-02'))]);
    expect(await count(memo)).toBe(1);
    const after = await getTemplate(t.ctx, x.id);
    expect(after.remaining).toBe(0);
    expect(after.isActive).toBe(false);
    await books();
  });

  it('a view-only member cannot run due transactions (and nothing posts)', async () => {
    const memo = 'qa2-viewer-run';
    await createTemplate(t.ctx, tpl(memo, null, '2026-08-01'));
    const viewer = await addMember(t, 'viewer', 'qa2-viewer-run');
    await expect(runDue(viewer, day('2026-08-02'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await count(memo)).toBe(0);
    await t.db.delete(recurringTemplates).where(eq(recurringTemplates.name, memo));
  });
});

// ---------------------------------------------------------------------------
// To-dos and dates
// ---------------------------------------------------------------------------
describe('to-dos (re-test)', () => {
  it('a view-only member cannot create a to-do and no row is left behind', async () => {
    const viewer = await addMember(t, 'viewer', 'qa2-todo-viewer');
    await expect(createTodo(viewer, { title: 'sneaky' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const rows = await t.db.select({ id: todos.id }).from(todos).where(eq(todos.title, 'sneaky'));
    expect(rows.length).toBe(0);
  });

  it('cannot link to a record of another company, or with a mismatched type', async () => {
    const other = await makeTestCompany('prefsqa2-todo');
    const { createCustomer: cc } = await import('./customers');
    const foreign = await cc(other.ctx, { displayName: 'Foreign Co' });
    await other.cleanup();
    process.env.BKA_DATA_DIR = t.dir;
    await expect(
      createTodo(t.ctx, { title: 'x', entityType: 'customer', entityId: foreign.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const mine = await createCustomer(t.ctx, { displayName: 'Mine Inc' });
    await expect(createTodo(t.ctx, { title: 'x', entityType: 'lead', entityId: mine.id })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(createTodo(t.ctx, { title: 'x', entityId: mine.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createTodo(t.ctx, { title: 'x', entityType: 'invoice' as never, entityId: mine.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects impossible dates and times, accepts real leap days', async () => {
    for (const bad of ['2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29', '2026-1-01', ' 2026-01-01', '2026-01-01T00:00']) {
      await expect(createTodo(t.ctx, { title: 'd', dueDate: bad })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    for (const bad of ['24:00', '9:00', '12:60']) {
      await expect(createTodo(t.ctx, { title: 'd', dueTime: bad })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    const ok = await createTodo(t.ctx, { title: 'leap', dueDate: '2024-02-29', dueTime: '23:59' });
    expect(ok.dueDate).toBe('2024-02-29');
  });

  it('zIsoDay in API schemas rejects impossible dates', () => {
    expect(isRealIsoDay('2026-02-28')).toBe(true);
    expect(isRealIsoDay('2026-02-29')).toBe(false);
    expect(isRealIsoDay('2000-02-29')).toBe(true);
    expect(isRealIsoDay('1900-02-29')).toBe(false);
    expect(calendarQuerySchema.safeParse({ from: '2026-01-01', to: '2026-06-31' }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ from: '2026-01-01', to: '2026-06-30' }).success).toBe(true);
  });
});
