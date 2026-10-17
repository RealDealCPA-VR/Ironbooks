/**
 * Pay runs (batch payroll) + time -> payroll link.
 *
 * createPayRun posts one paycheck per selected employee with per-employee failure
 * recording (NOT all-or-nothing), stamps paychecks.pay_run_id, and pulls unpaid
 * time entries (hours x employee rate) marking them with the [payroll:<id>] tag.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, paychecks, payRuns, timeEntries } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import {
  createEmployee,
  createPayRun,
  listPayRuns,
  runPaycheck,
  unpaidTimeForPayroll,
  updateEmployee,
} from './payroll';
import { createTimeEntry } from './timeTracking';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-pay-runs');
let ctx: ServiceContext;
let db: DB;

let hank: { id: string };  // hourly, $25/hr
let sally: { id: string }; // salary, $52,000/yr
let carl: { id: string };  // commission
let ida: { id: string };   // inactive

describe('Pay runs + time link', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'payruns-owner@test.local', name: 'PayRuns Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Pay Runs Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',            'asset',     'checking'],
      ['2300', 'Payroll Liabilities', 'liability', 'long_term_liability'],
      ['6500', 'Payroll Expense',     'expense',   'payroll'],
      ['6510', 'Payroll Tax Expense', 'expense',   'payroll'],
    ];
    for (const [code, name, type, subtype] of defs) {
      await createAccount(ctx, { code, name, type: type as never, subtype });
    }

    hank = await createEmployee(ctx, {
      firstName: 'Hank', lastName: 'Hourly', payType: 'hourly', payRate: '25.00',
    });
    sally = await createEmployee(ctx, {
      firstName: 'Sally', lastName: 'Salaried', payType: 'salary', payRate: '52000.00',
    });
    carl = await createEmployee(ctx, {
      firstName: 'Carl', lastName: 'Commission', payType: 'commission', payRate: '0',
    });
    ida = await createEmployee(ctx, {
      firstName: 'Ida', lastName: 'Inactive', payType: 'hourly', payRate: '20.00',
    });
    await updateEmployee(ctx, ida.id, { isActive: false });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Batch run with per-employee defaults and failure recording
  // -------------------------------------------------------------------------

  it('runs a batch with defaults, records per-employee failures, stamps payRunId', async () => {
    const { payRun, results } = await createPayRun(ctx, {
      payDate: new Date('2025-01-17'),
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-01-15'),
      memo: 'First biweekly run',
      employees: [
        { employeeId: hank.id, hours: '80' },
        { employeeId: sally.id },                    // salary default 52000/26 = 2000
        { employeeId: carl.id, amount: '1500.00' },  // commission needs an amount
        { employeeId: ida.id },                      // inactive — must fail, not block
      ],
    });

    expect(payRun.id).toBeTruthy();
    expect(results).toHaveLength(4);

    const byId = new Map(results.map((r) => [r.employeeId, r]));
    expect(byId.get(hank.id)!.ok).toBe(true);
    expect(byId.get(hank.id)!.grossPay).toBe('2000.00'); // 80 x 25
    expect(byId.get(sally.id)!.ok).toBe(true);
    expect(byId.get(sally.id)!.grossPay).toBe('2000.00'); // 52000 / 26
    expect(byId.get(carl.id)!.ok).toBe(true);
    expect(byId.get(carl.id)!.grossPay).toBe('1500.00');

    const idaResult = byId.get(ida.id)!;
    expect(idaResult.ok).toBe(false);
    expect(idaResult.error).toMatch(/inactive/i);

    // Successful checks carry the run id; the failed employee got no paycheck.
    const runChecks = await db
      .select()
      .from(paychecks)
      .where(eq(paychecks.payRunId, payRun.id));
    expect(runChecks).toHaveLength(3);
    expect(runChecks.every((c) => c.postedEntryId)).toBe(true);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('records a failure for a commission employee without an amount', async () => {
    // Every check refused → the run is refused as a whole (no empty pay-run header is saved);
    // the per-employee results travel in the error details.
    const before = (await db.select().from(payRuns)).length;
    const err = await createPayRun(ctx, {
      payDate: new Date('2025-01-31'),
      employees: [{ employeeId: carl.id }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('VALIDATION');
    const results = (err.details as { results: Array<{ ok: boolean; error?: string }> }).results;
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/amount/i);
    expect((await db.select().from(payRuns)).length).toBe(before);
  });

  it('lists past runs with paychecks and non-void totals', async () => {
    const runs = await listPayRuns(ctx);
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const first = runs.find((r) => r.memo === 'First biweekly run')!;
    expect(first.paychecks).toHaveLength(3);
    expect(first.totalGross).toBe('5500.00'); // 2000 + 2000 + 1500
    expect(first.paychecks.every((p) => !p.isVoid)).toBe(true);
    const names = first.paychecks.map((p) => p.employeeName);
    expect(names).toContain('Hank Hourly');
    expect(names).toContain('Sally Salaried');
  });

  // -------------------------------------------------------------------------
  // Time -> payroll
  // -------------------------------------------------------------------------

  it('pulls unpaid time entries into a pay run and marks them paid', async () => {
    const e1 = await createTimeEntry(ctx, {
      employeeId: hank.id,
      date: new Date('2025-02-03'),
      hours: '8',
      billable: false,
      description: 'Server maintenance',
    });
    const e2 = await createTimeEntry(ctx, {
      employeeId: hank.id,
      date: new Date('2025-02-05'),
      hours: '4.5',
      billable: false,
    });
    // Outside the period — must not be pulled.
    await createTimeEntry(ctx, {
      employeeId: hank.id,
      date: new Date('2025-03-20'),
      hours: '6',
      billable: false,
    });

    const unpaid = await unpaidTimeForPayroll(ctx, {
      employeeId: hank.id,
      periodStart: new Date('2025-02-01'),
      periodEnd: new Date('2025-02-14'),
    });
    expect(unpaid.entries).toHaveLength(2);
    expect(unpaid.totalHours).toBe('12.50');

    const { results } = await createPayRun(ctx, {
      payDate: new Date('2025-02-14'),
      periodStart: new Date('2025-02-01'),
      periodEnd: new Date('2025-02-14'),
      employees: [
        { employeeId: hank.id, timeEntryIds: unpaid.entries.map((e) => e.id) },
      ],
    });

    expect(results[0].ok).toBe(true);
    expect(results[0].warning).toBeUndefined();
    expect(results[0].grossPay).toBe('312.50'); // 12.5 hrs x $25

    // Entries now carry the [payroll:<paycheckId>] tag…
    const [marked] = await db.select().from(timeEntries).where(eq(timeEntries.id, e1.id));
    expect(marked.description).toContain(`[payroll:${results[0].paycheckId}]`);
    const [marked2] = await db.select().from(timeEntries).where(eq(timeEntries.id, e2.id));
    expect(marked2.description).toContain('[payroll:');

    // …and drop out of the unpaid pool.
    const after = await unpaidTimeForPayroll(ctx, {
      employeeId: hank.id,
      periodStart: new Date('2025-02-01'),
      periodEnd: new Date('2025-02-14'),
    });
    expect(after.entries).toHaveLength(0);

    // Double-pay guard: reusing the same entries fails for that employee.
    const again = await createPayRun(ctx, {
      payDate: new Date('2025-02-28'),
      employees: [{ employeeId: hank.id, timeEntryIds: [e1.id] }],
    }).catch((e) => e);
    expect(again).toBeInstanceOf(ServiceError);
    const againResults = (again.details as { results: Array<{ ok: boolean; error?: string }> }).results;
    expect(againResults[0].ok).toBe(false);
    expect(againResults[0].error).toMatch(/already paid/i);
  });

  it('rejects duplicate employees in one run and stamps payRunId via runPaycheck input', async () => {
    await expect(
      createPayRun(ctx, {
        payDate: new Date('2025-02-28'),
        employees: [{ employeeId: hank.id }, { employeeId: hank.id }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Direct runPaycheck without payRunId leaves the column null (legacy path intact).
    const single = await runPaycheck(ctx, {
      employeeId: sally.id,
      payDate: new Date('2025-02-28'),
      grossPay: '2000.00',
      taxes: [],
      employerTaxes: [],
    });
    const [row] = await db.select().from(paychecks).where(eq(paychecks.id, single.id));
    expect(row.payRunId).toBeNull();
  });
});
