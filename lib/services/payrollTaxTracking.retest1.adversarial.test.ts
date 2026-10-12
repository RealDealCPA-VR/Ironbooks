/**
 * Independent QA (tester) — fix/payroll re-test round 1.
 *
 * Verifies the Roth fix (inferDeductionTracking / createPayrollItem / updatePayrollItem /
 * migration 0035) and the "employer taxes always calculated" change, with wage-base and
 * W-2 / W-3 / 941 / 940 figures, voids, cross-type validation and books-balanced checks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { paycheckLines, payrollItems, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance, balanceSheet } from './reports';
import { createEmployee, runPaycheck, updateEmployee, voidPaycheck } from './payroll';
import {
  createPayrollItem,
  ensureDefaultPayrollItems,
  listPayrollItems,
  updatePayrollItem,
  type PayrollItem,
} from './payrollItems';
import { inferDeductionTracking, isPretaxTracking } from './payrollTaxTracking';
import { form940Data, form941Data, w2Data, w3Data } from './payrollReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-tt-retest1');
let db: DB;
let ctx: ServiceContext;
let items: PayrollItem[] = [];

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const item = (name: string) => {
  const it = items.find((i) => i.name === name);
  if (!it) throw new Error(`missing item ${name}`);
  return it;
};
type L = { kind: string; amount: string; taxTracking?: string | null };
const byTracking = (ls: L[], t: string) =>
  ls.filter((l) => l.taxTracking === t).reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero()).toFixed(2);

async function emp(first: string, last: string) {
  const e = await createEmployee(ctx, { firstName: first, lastName: last, payType: 'salary', payRate: '60000' });
  await updateEmployee(ctx, e.id, { w4: { filingStatus: 'single', formYear: 2020 } });
  return e;
}

async function assertBooksBalanced() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(ctx, new Date('2100-01-01T00:00:00Z'));
  expect(bs.balanced).toBe(true);
}

describe('fix/payroll re-test 1 — Roth deferrals and employer taxes', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u1] = await db.insert(users).values({ email: 'qa-rt1@test.local', name: 'QA', passwordHash: 'x' }).returning();
    const c1 = await createCompany(db, { name: 'QA Retest1 Co', ownerId: u1.id });
    ctx = { db, companyId: c1.id, userId: u1.id };
    await ensureDefaultPayrollItems(ctx);
    items = await listPayrollItems(ctx, { includeInactive: true });
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('inference matrix: Roth never pre-tax, pre-tax flag wins, "growth" is not "roth"', () => {
    expect(inferDeductionTracking('Roth 401(k)', false)).toBe('roth_401k');
    expect(inferDeductionTracking('Roth 401(k)', true)).toBe('roth_401k');
    expect(inferDeductionTracking('ROTH 403(B)', true)).toBe('roth_403b');
    expect(inferDeductionTracking('Roth 457(b) plan', false)).toBe('roth_457b');
    expect(inferDeductionTracking('401k-Roth', false)).toBe('roth_401k');
    expect(inferDeductionTracking('Roth IRA payroll deduction', true)).toBe('none');
    expect(inferDeductionTracking('Growth Fund 401k', true)).toBe('401k');
    expect(inferDeductionTracking('After-tax 401(k)', false)).toBe('none');
    expect(inferDeductionTracking('401(k) Employee', true)).toBe('401k');
    expect(inferDeductionTracking('Dental', true)).toBe('section125');
    expect(inferDeductionTracking('Union dues', false)).toBe('none');
    for (const t of ['roth_401k', 'roth_403b', 'roth_457b', 'none']) expect(isPretaxTracking(t)).toBe(false);
  });

  it('createPayrollItem: a Roth item flagged pre-tax by mistake is still saved after-tax', async () => {
    const r = await createPayrollItem(ctx, {
      name: 'Roth 403(b)',
      kind: 'deduction',
      pretax: true,
      liabilityAccountId: item('401(k) Employee').liabilityAccountId,
    });
    expect(r.taxTracking).toBe('roth_403b');
    expect(r.pretax).toBe(false);
  });

  it('updatePayrollItem: toggling pre-tax on a Roth item cannot make it pre-tax', async () => {
    const r = await createPayrollItem(ctx, {
      name: 'Roth 457(b)',
      kind: 'deduction',
      pretax: false,
      liabilityAccountId: item('401(k) Employee').liabilityAccountId,
    });
    const u = await updatePayrollItem(ctx, r.id, { pretax: true });
    expect(u.taxTracking).toBe('roth_457b');
    expect(u.pretax).toBe(false);
  });

  it('a Roth type is rejected on a non-deduction item', async () => {
    await expect(
      createPayrollItem(ctx, {
        name: 'Roth match',
        kind: 'employer_contribution',
        taxTracking: 'roth_401k',
        expenseAccountId: item('Employer Social Security').expenseAccountId ?? undefined,
        liabilityAccountId: item('401(k) Employee').liabilityAccountId,
      } as Parameters<typeof createPayrollItem>[1]),
    ).rejects.toThrow();
  });

  it('mixed check: 401(k) + Roth 401(k) + Section 125 — every wage base and form is right', async () => {
    const roth = await createPayrollItem(ctx, {
      name: 'Roth 401(k) Mixed',
      kind: 'deduction',
      pretax: false,
      liabilityAccountId: item('401(k) Employee').liabilityAccountId,
    });
    const e = await emp('Mixed', 'Saver');
    // A control check without the Roth line: federal withholding must be identical.
    const control = await emp('Control', 'Saver');
    const base = [
      { kind: 'deduction' as const, name: '401(k) Employee', amount: '150.00', payrollItemId: item('401(k) Employee').id },
      { kind: 'deduction' as const, name: 'Health Insurance (pre-tax)', amount: '75.25', payrollItemId: item('Health Insurance (pre-tax)').id },
    ];
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2024-08-15'),
      grossPay: '2500.00',
      deductions: [...base, { kind: 'deduction', name: 'Roth 401(k) Mixed', amount: '125.00', payrollItemId: roth.id }],
    });
    const pcCtl = await runPaycheck(ctx, { employeeId: control.id, payDate: d('2024-08-15'), grossPay: '2500.00', deductions: base });
    expect(byTracking(pc.lines, 'federal_withholding')).toBe(byTracking(pcCtl.lines, 'federal_withholding'));
    // FICA on gross - s125 = 2424.75
    expect(byTracking(pc.lines, 'social_security')).toBe('150.33'); // 150.3345
    expect(byTracking(pc.lines, 'medicare')).toBe('35.16'); // 35.158875
    expect(byTracking(pc.lines, 'roth_401k')).toBe('125.00');
    // Net = gross - all taxes - all deductions
    const taxes = pc.lines.filter((l) => l.kind === 'tax').reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero());
    expect(Money.of(pc.netPay).toFixed(2)).toBe(Money.of('2500').minus(taxes).minus('350.25').toFixed(2));

    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2024 });
    expect(w2.wages).toBe('2274.75'); // 2500 - 150 - 75.25 (Roth NOT subtracted)
    expect(w2.ssWages).toBe('2424.75');
    expect(w2.medicareWages).toBe('2424.75');
    expect(w2.box12.find((b) => b.code === 'D')?.amount).toBe('150.00');
    expect(w2.box12.find((b) => b.code === 'AA')?.amount).toBe('125.00');

    const w3 = await w3Data(ctx, { year: 2024 });
    // Box 12a deferred comp: D 150 x2 + AA 125
    expect(w3.deferredCompensation).toBe('425.00');
    expect(w3.box12.find((b) => b.code === 'AA')?.amount).toBe('125.00');

    const q3 = await form941Data(ctx, { quarter: 3, year: 2024 });
    expect(q3.totals.wages).toBe('4549.50'); // line 2: 2 x 2274.75
    expect(q3.totals.ssWages).toBe('4849.50'); // 5a: 2 x 2424.75
    const f940 = await form940Data(ctx, { year: 2024 });
    expect(f940.exemptPayments).toBe('150.50'); // only Section 125 is FUTA-exempt
    await assertBooksBalanced();

    // Void removes Box 12 AA
    await voidPaycheck(ctx, pc.id);
    const w2v = await w2Data(ctx, { employeeId: e.id, year: 2024 });
    expect(w2v.box12.find((b) => b.code === 'AA')).toBeUndefined();
    expect(w2v.wages).toBe('0.00');
    await assertBooksBalanced();
  });

  it('migration 0035 on legacy rows: case-insensitive names, Roth variants, after-tax stays after-tax', async () => {
    const legacy = await db
      .insert(payrollItems)
      .values([
        { companyId: ctx.companyId, name: 'GROWTH FUND 401K', kind: 'deduction', pretax: true },
        { companyId: ctx.companyId, name: 'ROTH 457 PLAN', kind: 'deduction', pretax: true },
        { companyId: ctx.companyId, name: 'Roth IRA (legacy)', kind: 'deduction', pretax: true },
        { companyId: ctx.companyId, name: 'After-tax 401k (legacy)', kind: 'deduction', pretax: false },
        { companyId: ctx.companyId, name: 'Roth 403b (legacy)', kind: 'deduction', pretax: false },
      ])
      .returning();
    const file = path.resolve(process.cwd(), 'drizzle', '0035_fix_payroll.sql');
    for (const s of fs.readFileSync(file, 'utf8').split('--> statement-breakpoint')) {
      if (s.trim()) await db.execute(sql.raw(s));
    }
    const rows = await db.select().from(payrollItems).where(eq(payrollItems.companyId, ctx.companyId));
    const by = (n: string) => rows.find((r) => r.name === n)!;
    expect([by('GROWTH FUND 401K').taxTracking, by('GROWTH FUND 401K').pretax]).toEqual(['401k', true]);
    expect([by('ROTH 457 PLAN').taxTracking, by('ROTH 457 PLAN').pretax]).toEqual(['roth_457b', false]);
    expect([by('Roth IRA (legacy)').taxTracking, by('Roth IRA (legacy)').pretax]).toEqual(['none', false]);
    expect([by('After-tax 401k (legacy)').taxTracking, by('After-tax 401k (legacy)').pretax]).toEqual(['none', false]);
    expect([by('Roth 403b (legacy)').taxTracking, by('Roth 403b (legacy)').pretax]).toEqual(['roth_403b', false]);
    // SQL and JS inference agree on every legacy row.
    for (const r of legacy) {
      const after = by(r.name);
      expect(after.taxTracking).toBe(inferDeductionTracking(r.name, r.pretax));
    }
    // Defaults and previously typed items untouched.
    expect(by('401(k) Employee').taxTracking).toBe('401k');
    expect(by('Roth 403(b)').taxTracking).toBe('roth_403b');
    // Re-running is idempotent.
    for (const s of fs.readFileSync(file, 'utf8').split('--> statement-breakpoint')) {
      if (s.trim()) await db.execute(sql.raw(s));
    }
    const again = await db.select().from(payrollItems).where(eq(payrollItems.companyId, ctx.companyId));
    for (const r of again) expect(r.taxTracking).toBe(by(r.name).taxTracking);
  });

  it('employee taxes typed in, employer taxes omitted: employer FICA/FUTA still calculated and posted', async () => {
    const e = await emp('Typed', 'Taxes');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2025-03-14'),
      grossPay: '1000.00',
      taxes: [
        { kind: 'tax', name: 'Federal Income Tax', amount: '50.00', taxTracking: 'federal_withholding' },
        { kind: 'tax', name: 'Social Security', amount: '62.00', taxTracking: 'social_security' },
        { kind: 'tax', name: 'Medicare', amount: '14.50', taxTracking: 'medicare' },
      ],
    } as Parameters<typeof runPaycheck>[1]);
    expect(byTracking(pc.lines, 'employer_social_security')).toBe('62.00');
    expect(byTracking(pc.lines, 'employer_medicare')).toBe('14.50');
    expect(byTracking(pc.lines, 'futa')).toBe('6.00');
    const stored = await db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, pc.id));
    expect(byTracking(stored, 'futa')).toBe('6.00');
    const q1 = await form941Data(ctx, { quarter: 1, year: 2025 });
    expect(Money.of(q1.totals.employerSocialSecurity).gte(62)).toBe(true);
    await assertBooksBalanced();

    // Explicit [] still means "no employer taxes".
    const e2 = await emp('No', 'Employer');
    const pc2 = await runPaycheck(ctx, {
      employeeId: e2.id,
      payDate: d('2025-03-14'),
      grossPay: '1000.00',
      taxes: [],
      employerTaxes: [],
    } as Parameters<typeof runPaycheck>[1]);
    expect(pc2.lines.filter((l) => l.kind === 'employer_contribution')).toEqual([]);
    await assertBooksBalanced();
  });
});
