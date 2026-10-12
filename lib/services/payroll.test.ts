import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  runPaycheck,
  listPaychecks,
} from './payroll';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};

describe('Payroll service (end-to-end)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'payroll-owner@test.local', name: 'Payroll Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Payroll Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed the three accounts required by runPaycheck.
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',          'asset',   'checking'],
      ['2300', 'Payroll Liabilities','liability','long_term_liability'],
      ['6500', 'Payroll Expense',   'expense',  'payroll'],
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
  // Employee CRUD
  // -------------------------------------------------------------------------

  it('creates an employee', async () => {
    const emp = await createEmployee(ctx, {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      payType: 'salary',
      payRate: '80000.00',
    });
    expect(emp.firstName).toBe('Jane');
    expect(emp.lastName).toBe('Doe');
    expect(emp.payRate).toBe('80000.00');
    expect(emp.isActive).toBe(true);
    expect(emp.companyId).toBe(ctx.companyId);
  });

  it('lists only active employees by default', async () => {
    const list = await listEmployees(ctx);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((e) => e.isActive)).toBe(true);
  });

  it('gets employee by id', async () => {
    const list = await listEmployees(ctx);
    const first = list[0];
    const fetched = await getEmployee(ctx, first.id);
    expect(fetched.id).toBe(first.id);
  });

  it('rejects negative pay rate', async () => {
    await expect(
      createEmployee(ctx, {
        firstName: 'Bad',
        lastName: 'Rate',
        payType: 'hourly',
        payRate: '-10',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  // runPaycheck — main scenario: gross 1000, taxes 200, net 800
  // -------------------------------------------------------------------------

  it('runs a paycheck and posts a balanced GL entry (gross=1000, taxes=200, net=800)', async () => {
    const employees = await listEmployees(ctx);
    const emp = employees[0];

    const result = await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: new Date('2025-01-15'),
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-01-15'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'Federal Income Tax', amount: '150.00' },
               { kind: 'tax', name: 'Social Security',   amount: '50.00' }],
      // No employer taxes on this check (omitting employerTaxes has the server calculate them).
      employerTaxes: [],
      deductions: [],
    });

    // Net pay should be 1000 - 200 = 800
    expect(result.netPay).toBe('800.00');
    expect(result.grossPay).toBe('1000.00');
    expect(result.totalTaxes).toBe('200.00');
    expect(result.totalDeductions).toBe('0.00');
    expect(result.postedEntryId).toBeTruthy();

    // Account balances should reflect the GL impact:
    //   Dr 6500 Payroll Expense  +1000.00
    //   Cr 2300 Payroll Liab.    +200.00
    //   Cr 1000 Checking         -800.00 (credit decreases asset natural balance)
    const rows = await db
      .select({ code: accounts.code, balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.companyId, ctx.companyId));
    const bal = Object.fromEntries(rows.map((r) => [r.code, r.balance]));
    expect(bal['6500']).toBe('1000.00');
    expect(bal['2300']).toBe('200.00');
    // Checking is an asset (debit-normal); a credit reduces it from 0 to -800.
    expect(bal['1000']).toBe('-800.00');
  });

  it('trial balance is balanced after payroll posting', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('lists paychecks', async () => {
    const list = await listPaychecks(ctx);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].companyId).toBe(ctx.companyId);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('rejects gross pay of zero', async () => {
    const emps = await listEmployees(ctx);
    await expect(
      runPaycheck(ctx, {
        employeeId: emps[0].id,
        payDate: new Date('2025-02-01'),
        grossPay: '0',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects when taxes + deductions exceed gross', async () => {
    const emps = await listEmployees(ctx);
    await expect(
      runPaycheck(ctx, {
        employeeId: emps[0].id,
        payDate: new Date('2025-02-01'),
        grossPay: '500.00',
        taxes: [{ kind: 'tax', name: 'Huge Tax', amount: '600.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('runs a paycheck with deductions only (no taxes)', async () => {
    const emps = await listEmployees(ctx);
    const emp = emps[0];

    const result = await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: new Date('2025-02-15'),
      grossPay: '500.00',
      taxes: [],
      deductions: [{ kind: 'deduction', name: '401k', amount: '50.00' }],
    });

    expect(result.netPay).toBe('450.00');
    expect(result.totalTaxes).toBe('0.00');
    expect(result.totalDeductions).toBe('50.00');
    expect(result.postedEntryId).toBeTruthy();

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});
