/**
 * Tests for the after-the-fact payroll completion features:
 *  - updateEmployee (edit, SSN/W-4/address, deactivate/reactivate)
 *  - itemized earnings on runPaycheck (hours x rate, overtime, bonus)
 *  - voidPaycheck (GL reversal + voided_at flag, list filtering)
 *  - pay stub YTD aggregates (listPaychecks ytd fields + payStubData)
 *  - payroll reports: payrollSummary / payrollDetail / payrollLiabilityBalances
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, paycheckLines } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { payPayrollLiabilities } from './liabilityPayments';
import {
  createEmployee,
  updateEmployee,
  getEmployee,
  listEmployees,
  runPaycheck,
  listPaychecks,
  voidPaycheck,
  payStubData,
} from './payroll';
import {
  payrollSummary,
  payrollDetail,
  payrollLiabilityBalances,
} from './payrollReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-ux');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};

let empA: { id: string };
let empB: { id: string };

async function balances(): Promise<Record<string, string>> {
  const rows = await db
    .select({ code: accounts.code, balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  return Object.fromEntries(rows.map((r) => [r.code, r.balance]));
}

describe('Payroll UX (employee edit, itemized earnings, void, YTD, reports)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'payroll-ux@test.local', name: 'Payroll UX', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Payroll UX Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',           'asset',     'checking'],
      ['2300', 'Payroll Liabilities','liability', 'long_term_liability'],
      ['6500', 'Payroll Expense',    'expense',   'payroll'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    empA = await createEmployee(ctx, {
      firstName: 'Alice',
      lastName: 'Anderson',
      payType: 'hourly',
      payRate: '25.00',
    });
    empB = await createEmployee(ctx, {
      firstName: 'Bob',
      lastName: 'Brown',
      payType: 'salary',
      payRate: '52000.00',
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Employee update / deactivate / reactivate
  // -------------------------------------------------------------------------

  it('updates basic fields and pay info', async () => {
    const updated = await updateEmployee(ctx, empA.id, {
      email: 'alice@example.com',
      payRate: '26.50',
    });
    expect(updated.email).toBe('alice@example.com');
    expect(updated.payRate).toBe('26.50');
    // Untouched fields stay
    expect(updated.firstName).toBe('Alice');

    // restore rate for later hours x rate assertions
    await updateEmployee(ctx, empA.id, { payRate: '25.00' });
  });

  it('stores SSN normalized and W-4 / address JSON', async () => {
    const updated = await updateEmployee(ctx, empA.id, {
      ssn: '123 45 6789',
      w4: { filingStatus: 'married', dependents: 2, extraWithholding: '25.00' },
      address: { line1: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701' },
    });
    expect(updated.ssn).toBe('123-45-6789');
    expect(updated.w4).toMatchObject({ filingStatus: 'married', dependents: 2 });
    expect(updated.address).toMatchObject({ city: 'Springfield', state: 'IL' });
  });

  it('rejects invalid updates', async () => {
    await expect(updateEmployee(ctx, empA.id, { ssn: '12345' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateEmployee(ctx, empA.id, { payRate: '-1' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateEmployee(ctx, empA.id, { firstName: '   ' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateEmployee(ctx, '00000000-0000-0000-0000-000000000000', { email: 'x@y.z' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deactivates (blocking paychecks) and reactivates', async () => {
    const off = await updateEmployee(ctx, empB.id, { isActive: false });
    expect(off.isActive).toBe(false);

    // Inactive employees are hidden by default, shown with includeInactive.
    const activeOnly = await listEmployees(ctx);
    expect(activeOnly.some((e) => e.id === empB.id)).toBe(false);
    const all = await listEmployees(ctx, { includeInactive: true });
    expect(all.some((e) => e.id === empB.id)).toBe(true);

    await expect(
      runPaycheck(ctx, {
        employeeId: empB.id,
        payDate: new Date('2025-01-20'),
        grossPay: '1000.00',
        taxes: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const on = await updateEmployee(ctx, empB.id, { isActive: true });
    expect(on.isActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Itemized earnings
  // -------------------------------------------------------------------------

  let checkA1: Awaited<ReturnType<typeof runPaycheck>>;
  let checkA2: Awaited<ReturnType<typeof runPaycheck>>;
  let checkB1: Awaited<ReturnType<typeof runPaycheck>>;

  it('runs a paycheck with itemized earnings (hours x rate + overtime)', async () => {
    checkA1 = await runPaycheck(ctx, {
      employeeId: empA.id,
      payDate: new Date('2025-01-15'),
      periodStart: new Date('2025-01-01'),
      periodEnd: new Date('2025-01-15'),
      earnings: [
        { kind: 'regular', hours: '40', rate: '25.00' },              // amount computed: 1000.00
        { kind: 'overtime', hours: '5', rate: '37.50', amount: '187.50' },
      ],
      taxes: [
        { kind: 'tax', name: 'Federal Income Tax', amount: '100.00' },
        { kind: 'tax', name: 'Social Security', amount: '50.00' },
      ],
      // Fixed figures for the report assertions: no employer taxes on this check (omitting
      // employerTaxes would have the server calculate them).
      employerTaxes: [],
    });

    expect(checkA1.grossPay).toBe('1187.50');
    expect(checkA1.netPay).toBe('1037.50');

    const lines = await db
      .select()
      .from(paycheckLines)
      .where(eq(paycheckLines.paycheckId, checkA1.id));
    const earnings = lines.filter((l) => l.kind === 'earning');
    expect(earnings).toHaveLength(2);
    const regular = earnings.find((l) => l.name.startsWith('Regular'));
    const overtime = earnings.find((l) => l.name.startsWith('Overtime'));
    expect(regular?.amount).toBe('1000.00');
    expect(regular?.name).toBe('Regular (40.00 hrs @ 25.00)');
    expect(overtime?.amount).toBe('187.50');
    expect(overtime?.name).toBe('Overtime (5.00 hrs @ 37.50)');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('keeps single-amount grossPay working (one Gross Pay line)', async () => {
    checkB1 = await runPaycheck(ctx, {
      employeeId: empB.id,
      payDate: new Date('2025-01-20'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'Federal Income Tax', amount: '150.00' }],
      employerTaxes: [],
      deductions: [{ kind: 'deduction', name: '401k', amount: '50.00' }],
    });
    expect(checkB1.grossPay).toBe('1000.00');
    expect(checkB1.netPay).toBe('800.00');

    const lines = await db
      .select()
      .from(paycheckLines)
      .where(eq(paycheckLines.paycheckId, checkB1.id));
    const earnings = lines.filter((l) => l.kind === 'earning');
    expect(earnings).toHaveLength(1);
    expect(earnings[0].name).toBe('Gross Pay');
    expect(earnings[0].amount).toBe('1000.00');
  });

  it('rejects a paycheck with neither grossPay nor earnings, and bad earning lines', async () => {
    await expect(
      runPaycheck(ctx, { employeeId: empA.id, payDate: new Date('2025-02-01') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      runPaycheck(ctx, {
        employeeId: empA.id,
        payDate: new Date('2025-02-01'),
        earnings: [{ kind: 'regular', hours: '10' }], // no rate, no amount
        taxes: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      runPaycheck(ctx, {
        employeeId: empA.id,
        payDate: new Date('2025-02-01'),
        earnings: [{ kind: 'bogus' as never, amount: '100' }],
        taxes: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  // YTD aggregates
  // -------------------------------------------------------------------------

  it('computes cumulative YTD on listPaychecks and payStubData', async () => {
    checkA2 = await runPaycheck(ctx, {
      employeeId: empA.id,
      payDate: new Date('2025-02-15'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'Federal Income Tax', amount: '200.00' }],
      employerTaxes: [
        { kind: 'employer_contribution', name: 'Employer Social Security', amount: '62.00' },
      ],
    });
    expect(checkA2.netPay).toBe('800.00');

    const list = await listPaychecks(ctx, { employeeId: empA.id });
    const jan = list.find((p) => p.id === checkA1.id)!;
    const feb = list.find((p) => p.id === checkA2.id)!;
    expect(jan.ytdGross).toBe('1187.50');
    expect(jan.ytdNet).toBe('1037.50');
    expect(feb.ytdGross).toBe('2187.50'); // 1187.50 + 1000.00
    expect(feb.ytdNet).toBe('1837.50');   // 1037.50 + 800.00

    const stub = await payStubData(ctx, checkA2.id);
    expect(stub.ytd.gross).toBe('2187.50');
    expect(stub.ytd.net).toBe('1837.50');
    expect(stub.ytd.taxes).toBe('350.00'); // 150 (Jan) + 200 (Feb)

    // Line-level YTD groups by name across checks.
    const fit = stub.lines.find((l) => l.kind === 'tax' && l.name === 'Federal Income Tax')!;
    expect(fit.amount).toBe('200.00');
    expect(fit.ytdAmount).toBe('300.00'); // 100 (Jan) + 200 (Feb)

    // Earnings group by base kind label despite the hours/rate suffix.
    const grossLine = stub.lines.find((l) => l.kind === 'earning')!;
    expect(grossLine.name).toBe('Gross Pay');
    expect(grossLine.ytdAmount).toBe('1000.00'); // only Feb has a 'Gross Pay' line
  });

  // -------------------------------------------------------------------------
  // Void paycheck
  // -------------------------------------------------------------------------

  it('voids a paycheck: GL reversed, flagged, excluded from lists and YTD', async () => {
    const before = await balances();

    const toVoid = await runPaycheck(ctx, {
      employeeId: empA.id,
      payDate: new Date('2025-03-01'),
      grossPay: '500.00',
      taxes: [],
      employerTaxes: [],
    });

    let after = await balances();
    expect(after['6500']).not.toBe(before['6500']);

    const voided = await voidPaycheck(ctx, toVoid.id);
    expect(voided.voidedAt).toBeTruthy();

    // Balances restored after the void.
    after = await balances();
    expect(after['6500']).toBe(before['6500']);
    expect(after['1000']).toBe(before['1000']);
    expect(after['2300']).toBe(before['2300']);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);

    // Default list excludes voided; includeVoided flags it.
    const defaultList = await listPaychecks(ctx, { employeeId: empA.id });
    expect(defaultList.some((p) => p.id === toVoid.id)).toBe(false);
    const withVoided = await listPaychecks(ctx, { employeeId: empA.id, includeVoided: true });
    const flagged = withVoided.find((p) => p.id === toVoid.id)!;
    expect(flagged.isVoid).toBe(true);
    expect(flagged.ytdGross).toBeNull();

    // YTD figures of live checks are unaffected by the voided check.
    const stub = await payStubData(ctx, checkA2.id);
    expect(stub.ytd.gross).toBe('2187.50');

    // Double-void rejected; unknown id rejected.
    await expect(voidPaycheck(ctx, toVoid.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(voidPaycheck(ctx, '00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  it('payrollSummary aggregates per employee with tax/deduction/employer columns', async () => {
    const summary = await payrollSummary(ctx, {
      from: new Date('2025-01-01'),
      to: new Date('2025-12-31'),
    });

    expect(summary.rows).toHaveLength(2);
    const alice = summary.rows.find((r) => r.employeeName === 'Alice Anderson')!;
    const bob = summary.rows.find((r) => r.employeeName === 'Bob Brown')!;

    // Voided March check excluded from Alice's totals.
    expect(alice.paycheckCount).toBe(2);
    expect(alice.gross).toBe('2187.50');
    expect(alice.taxes['Federal Income Tax']).toBe('300.00');
    expect(alice.taxes['Social Security']).toBe('50.00');
    expect(alice.totalTaxes).toBe('350.00');
    expect(alice.employerTaxes['Employer Social Security']).toBe('62.00');
    expect(alice.totalEmployerTaxes).toBe('62.00');
    expect(alice.net).toBe('1837.50');

    expect(bob.gross).toBe('1000.00');
    expect(bob.deductions['401k']).toBe('50.00');
    expect(bob.totalDeductions).toBe('50.00');
    expect(bob.net).toBe('800.00');

    expect(summary.totals.gross).toBe('3187.50');
    expect(summary.totals.totalTaxes).toBe('500.00');
    expect(summary.totals.totalDeductions).toBe('50.00');
    expect(summary.totals.totalEmployerTaxes).toBe('62.00');
    expect(summary.totals.net).toBe('2637.50');
    expect(summary.taxNames).toContain('Federal Income Tax');
    expect(summary.deductionNames).toEqual(['401k']);
    expect(summary.employerTaxNames).toEqual(['Employer Social Security']);
  });

  it('payrollDetail lists one row per posted, non-void paycheck', async () => {
    const detail = await payrollDetail(ctx, {
      from: new Date('2025-01-01'),
      to: new Date('2025-12-31'),
    });
    expect(detail.rows).toHaveLength(3); // A x2 + B x1; voided March check excluded

    const feb = detail.rows.find((r) => r.paycheckId === checkA2.id)!;
    expect(feb.payDate).toBe('2025-02-15');
    expect(feb.totalEmployerTaxes).toBe('62.00');
    expect(feb.net).toBe('800.00');

    // Employee filter works.
    const bobOnly = await payrollDetail(ctx, {
      from: new Date('2025-01-01'),
      to: new Date('2025-12-31'),
      employeeId: empB.id,
    });
    expect(bobOnly.rows).toHaveLength(1);

    // Bad range rejected.
    await expect(
      payrollDetail(ctx, { from: new Date('2025-12-31'), to: new Date('2025-01-01') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('payrollLiabilityBalances: accruals by item minus payments against 2300', async () => {
    const beforePayment = await payrollLiabilityBalances(ctx, { asOf: new Date('2025-12-31') });
    // FIT 450 (100+200+150) + SS 50 + 401k 50 + Employer SS 62 = 612
    expect(beforePayment.totalAccrued).toBe('612.00');
    expect(beforePayment.totalPaid).toBe('0.00');
    expect(beforePayment.balance).toBe('612.00');

    const fit = beforePayment.items.find((i) => i.name === 'Federal Income Tax')!;
    expect(fit.kind).toBe('tax');
    expect(fit.accrued).toBe('450.00');
    const k401 = beforePayment.items.find((i) => i.name === '401k')!;
    expect(k401.kind).toBe('deduction');
    expect(k401.accrued).toBe('50.00');
    const emplSS = beforePayment.items.find((i) => i.name === 'Employer Social Security')!;
    expect(emplSS.kind).toBe('employer_contribution');
    expect(emplSS.accrued).toBe('62.00');

    // Remit a 941 deposit: Dr 2300 / Cr 1000.
    await payPayrollLiabilities(ctx, {
      amount: '100.00',
      date: new Date('2025-03-31'),
      paymentAccountId: acct['1000'],
    });

    const afterPayment = await payrollLiabilityBalances(ctx, { asOf: new Date('2025-12-31') });
    expect(afterPayment.totalAccrued).toBe('612.00');
    expect(afterPayment.totalPaid).toBe('100.00');
    expect(afterPayment.balance).toBe('512.00');

    // asOf before any payroll: nothing accrued.
    const early = await payrollLiabilityBalances(ctx, { asOf: new Date('2024-12-31') });
    expect(early.totalAccrued).toBe('0.00');
    expect(early.items).toHaveLength(0);
  });
});
