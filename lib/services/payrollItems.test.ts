/**
 * Payroll items: default seeding, CRUD validation, and runPaycheck GL mapping —
 * mapped expense/liability accounts, pre-tax wage-base reduction, and post-tax
 * garnishments with their own liability account.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createEmployee, runPaycheck } from './payroll';
import {
  createPayrollItem,
  ensureDefaultPayrollItems,
  getPayrollItem,
  listPayrollItems,
  updatePayrollItem,
} from './payrollItems';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-items');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};

function tbRow(tb: Awaited<ReturnType<typeof trialBalance>>, code: string) {
  return tb.rows.find((r) => r.code === code);
}

describe('Payroll items (seeding, CRUD, GL mapping)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'pitems-owner@test.local', name: 'Items Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Payroll Items Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',              'asset',     'checking'],
      ['2300', 'Payroll Liabilities',   'liability', 'long_term_liability'],
      ['2310', '401(k) Payable',        'liability', 'long_term_liability'],
      ['2320', 'Garnishments Payable',  'liability', 'long_term_liability'],
      ['6500', 'Payroll Expense',       'expense',   'payroll'],
      ['6510', 'Payroll Tax Expense',   'expense',   'payroll'],
      ['6520', 'Officer Wages',         'expense',   'payroll'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Default seeding
  // -------------------------------------------------------------------------

  it('seeds sensible defaults on first use, idempotently', async () => {
    const seeded = await ensureDefaultPayrollItems(ctx);
    expect(seeded.length).toBeGreaterThanOrEqual(13);

    const names = seeded.map((i) => i.name);
    for (const expected of [
      'Salary', 'Hourly', 'Federal Withholding', 'Social Security', 'Medicare',
      'Employer Social Security', 'Federal Unemployment (FUTA)',
      '401(k) Employee', 'Wage Garnishment',
    ]) {
      expect(names).toContain(expected);
    }

    const salary = seeded.find((i) => i.name === 'Salary')!;
    expect(salary.kind).toBe('earning');
    expect(salary.expenseAccountId).toBe(acct['6500']);

    const fwh = seeded.find((i) => i.name === 'Federal Withholding')!;
    expect(fwh.kind).toBe('tax');
    expect(fwh.liabilityAccountId).toBe(acct['2300']);

    const erSs = seeded.find((i) => i.name === 'Employer Social Security')!;
    expect(erSs.kind).toBe('employer_contribution');
    expect(erSs.expenseAccountId).toBe(acct['6510']); // prefers 6510 when present
    expect(erSs.liabilityAccountId).toBe(acct['2300']);

    const k401 = seeded.find((i) => i.name === '401(k) Employee')!;
    expect(k401.pretax).toBe(true);

    const garn = seeded.find((i) => i.name === 'Wage Garnishment')!;
    expect(garn.kind).toBe('garnishment');
    expect(garn.pretax).toBe(false);

    // Second call is a no-op.
    const again = await ensureDefaultPayrollItems(ctx);
    expect(again.length).toBe(seeded.length);
  });

  // -------------------------------------------------------------------------
  // CRUD validation
  // -------------------------------------------------------------------------

  it('requires the GL side(s) appropriate for the kind', async () => {
    await expect(
      createPayrollItem(ctx, { name: 'No Expense Earning', kind: 'earning' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      createPayrollItem(ctx, { name: 'No Liab Deduction', kind: 'deduction' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      createPayrollItem(ctx, {
        name: 'Half Employer Item',
        kind: 'employer_contribution',
        expenseAccountId: acct['6510'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects pretax on non-deduction kinds and duplicate names', async () => {
    await expect(
      createPayrollItem(ctx, {
        name: 'Pretax Garnishment',
        kind: 'garnishment',
        pretax: true,
        liabilityAccountId: acct['2320'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      createPayrollItem(ctx, {
        name: 'salary', // case-insensitive dup of seeded 'Salary'
        kind: 'earning',
        expenseAccountId: acct['6500'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('creates, updates, and deactivates a custom item', async () => {
    const item = await createPayrollItem(ctx, {
      name: 'Union Dues',
      kind: 'deduction',
      liabilityAccountId: acct['2300'],
      calcBasis: 'fixed',
      defaultRate: '25',
    });
    expect(item.defaultRate).toBe('25.0000');
    expect(item.pretax).toBe(false);

    const updated = await updatePayrollItem(ctx, item.id, { defaultRate: '30', pretax: true });
    expect(updated.defaultRate).toBe('30.0000');
    expect(updated.pretax).toBe(true);

    await updatePayrollItem(ctx, item.id, { isActive: false });
    const active = await listPayrollItems(ctx);
    expect(active.find((i) => i.id === item.id)).toBeUndefined();
    const all = await listPayrollItems(ctx, { includeInactive: true });
    expect(all.find((i) => i.id === item.id)).toBeDefined();

    const fetched = await getPayrollItem(ctx, item.id);
    expect(fetched.isActive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // runPaycheck GL mapping
  // -------------------------------------------------------------------------

  it('posts wages to the earning item mapped expense account (not 6500)', async () => {
    const emp = await createEmployee(ctx, {
      firstName: 'Olive', lastName: 'Officer', payType: 'salary', payRate: '120000',
    });
    const officerWages = await createPayrollItem(ctx, {
      name: 'Officer Salary',
      kind: 'earning',
      expenseAccountId: acct['6520'],
      calcBasis: 'fixed',
    });

    const before = await trialBalance(ctx);
    const before6520 = tbRow(before, '6520')?.debit ?? '0.00';

    await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: new Date('2025-02-15'),
      earnings: [{ kind: 'regular', amount: '3000.00', payrollItemId: officerWages.id }],
      taxes: [],          // explicit: no withholding for a clean GL assertion
      employerTaxes: [],
    });

    const after = await trialBalance(ctx);
    expect(after.balanced).toBe(true);
    expect(Number(tbRow(after, '6520')!.debit) - Number(before6520)).toBeCloseTo(3000, 2);
    // 6500 untouched by this check (no unmapped earning lines).
    expect(tbRow(after, '6500')?.debit ?? '0.00').toBe(before.rows.find((r) => r.code === '6500')?.debit ?? '0.00');
  });

  it('credits a garnishment to its own liability account, post-tax', async () => {
    const emp = await createEmployee(ctx, {
      firstName: 'Gary', lastName: 'Garnished', payType: 'salary', payRate: '52000',
    });
    const garnItem = await createPayrollItem(ctx, {
      name: 'Child Support Garnishment',
      kind: 'garnishment',
      liabilityAccountId: acct['2320'],
      calcBasis: 'fixed',
    });

    const before = await trialBalance(ctx);
    const before2320 = Number(tbRow(before, '2320')?.credit ?? '0');

    const check = await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: new Date('2025-02-15'),
      grossPay: '2000.00',
      deductions: [
        { kind: 'deduction', name: 'Child Support', amount: '300.00', payrollItemId: garnItem.id },
      ],
    });

    const after = await trialBalance(ctx);
    expect(after.balanced).toBe(true);
    expect(Number(tbRow(after, '2320')!.credit) - before2320).toBeCloseTo(300, 2);
    expect(check.totalDeductions).toBe('300.00');

    // Garnishment is POST-tax: withholding matches a no-deduction check of the
    // same gross (same-employee YTD is zero for both comparisons below).
    const garnFed = check.lines.find((l) => l.kind === 'tax' && l.name === 'Federal Income Tax');
    const empB = await createEmployee(ctx, {
      firstName: 'Nora', lastName: 'NoDeduction', payType: 'salary', payRate: '52000',
    });
    const plain = await runPaycheck(ctx, {
      employeeId: empB.id,
      payDate: new Date('2025-02-15'),
      grossPay: '2000.00',
    });
    const plainFed = plain.lines.find((l) => l.kind === 'tax' && l.name === 'Federal Income Tax');
    expect(garnFed!.amount).toBe(plainFed!.amount);
    expect(check.totalTaxes).toBe(plain.totalTaxes);
  });

  it('pre-tax deduction reduces the wage base before withholding', async () => {
    const empA = await createEmployee(ctx, {
      firstName: 'Petra', lastName: 'Pretax', payType: 'salary', payRate: '52000',
    });
    const k401 = (await listPayrollItems(ctx)).find((i) => i.name === '401(k) Employee')!;

    const withPretax = await runPaycheck(ctx, {
      employeeId: empA.id,
      payDate: new Date('2025-03-01'),
      grossPay: '2000.00',
      deductions: [
        { kind: 'deduction', name: '401(k)', amount: '200.00', payrollItemId: k401.id },
      ],
    });

    const empB = await createEmployee(ctx, {
      firstName: 'Paula', lastName: 'Posttax', payType: 'salary', payRate: '52000',
    });
    const without = await runPaycheck(ctx, {
      employeeId: empB.id,
      payDate: new Date('2025-03-01'),
      grossPay: '2000.00',
    });

    const fed = (r: typeof withPretax) =>
      Number(r.lines.find((l) => l.kind === 'tax' && l.name === 'Federal Income Tax')!.amount);
    const ss = (r: typeof withPretax) =>
      Number(r.lines.find((l) => l.kind === 'tax' && l.name === 'Social Security')!.amount);

    expect(fed(withPretax)).toBeLessThan(fed(without));
    // A 401(k) deferral reduces income-tax wages only — it stays subject to Social Security
    // (6.2% of the full 2000), unlike a Section 125 item (see payrollTaxTracking.test.ts).
    expect(ss(withPretax)).toBeCloseTo(124, 2);
    expect(ss(without)).toBeCloseTo(124, 2);

    // Gross stays the full 2000; only the tax base shrinks.
    expect(withPretax.grossPay).toBe('2000.00');
    expect(withPretax.totalDeductions).toBe('200.00');
  });

  it('rejects a line referencing an item of the wrong kind', async () => {
    const emp = await createEmployee(ctx, {
      firstName: 'Kim', lastName: 'KindCheck', payType: 'salary', payRate: '52000',
    });
    const hourly = (await listPayrollItems(ctx)).find((i) => i.name === 'Hourly')!;
    await expect(
      runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2025-03-01'),
        grossPay: '1000.00',
        deductions: [
          { kind: 'deduction', name: 'Bad', amount: '50.00', payrollItemId: hourly.id },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
