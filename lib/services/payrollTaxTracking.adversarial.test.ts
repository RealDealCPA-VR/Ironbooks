/**
 * Independent QA (tester) — fix/payroll P0s, adversarial cases.
 *
 *  P0-1 deduction tax treatment: 401(k) keeps FICA/FUTA/SUI wages; Section 125 reduces them;
 *       after-tax (incl. ROTH 401(k)) reduces nothing. Additional Medicare threshold, SS wage
 *       base by year on Box 3, 941 5a across quarters, rounding to the penny, voids, edits,
 *       migration of legacy items.
 *  P0-2 single paycheck = pay-run engine: GL, liabilities, W-2, 941, state taxes; overrides by
 *       tax ITEM only; cross-company item ids; closing date; rollback.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { journalEntryLines, paycheckLines, paychecks, payrollItems, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { trialBalance, balanceSheet } from './reports';
import {
  createEmployee,
  createPayRun,
  editPaycheck,
  previewPaycheck,
  runPaycheck,
  updateEmployee,
  voidPaycheck,
} from './payroll';
import {
  createPayrollItem,
  ensureDefaultPayrollItems,
  listPayrollItems,
  type PayrollItem,
} from './payrollItems';
import { upsertStateTaxSetting } from './payrollAdjustments';
import {
  form940Data,
  form941Data,
  payrollLiabilityBalances,
  stateWageWorksheet,
  w2Data,
} from './payrollReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-tax-tracking-adv');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
let items: PayrollItem[] = [];
let otherItems: PayrollItem[] = [];

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const item = (name: string, list = items) => {
  const it = list.find((i) => i.name === name);
  if (!it) throw new Error(`missing item ${name}`);
  return it;
};
type L = { kind: string; name: string; amount: string; taxTracking?: string | null };
const byTracking = (ls: L[], t: string) =>
  ls.filter((l) => l.taxTracking === t).reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero()).toFixed(2);
const sumKind = (ls: L[], k: string) =>
  ls.filter((l) => l.kind === k).reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero());

async function emp(first: string, last: string, c: ServiceContext = ctx) {
  const e = await createEmployee(c, { firstName: first, lastName: last, payType: 'salary', payRate: '60000' });
  await updateEmployee(c, e.id, { w4: { filingStatus: 'single', formYear: 2020 } });
  return e;
}

async function paycheckCount(c: ServiceContext) {
  return (await c.db.select({ id: paychecks.id }).from(paychecks).where(eq(paychecks.companyId, c.companyId))).length;
}

async function assertBooksBalanced(c: ServiceContext) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(c, new Date('2100-01-01T00:00:00Z'));
  expect(bs.balanced).toBe(true);
}

async function jeLines(entryId: string) {
  return db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
}

describe('fix/payroll tax tracking — adversarial QA', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u1] = await db.insert(users).values({ email: 'qa-tt@test.local', name: 'QA', passwordHash: 'x' }).returning();
    const c1 = await createCompany(db, { name: 'QA Tax Tracking Co', ownerId: u1.id });
    ctx = { db, companyId: c1.id, userId: u1.id };
    const [u2] = await db.insert(users).values({ email: 'qa-tt2@test.local', name: 'QA2', passwordHash: 'x' }).returning();
    const c2 = await createCompany(db, { name: 'Other Tax Tracking Co', ownerId: u2.id });
    other = { db, companyId: c2.id, userId: u2.id };
    await ensureDefaultPayrollItems(ctx);
    await ensureDefaultPayrollItems(other);
    items = await listPayrollItems(ctx, { includeInactive: true });
    otherItems = await listPayrollItems(other, { includeInactive: true });
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // P0-1: deduction tax treatment
  // ---------------------------------------------------------------------------

  it('auditor repro: 401(k) leaves SS/Medicare/FUTA on full gross; JE balances to the penny', async () => {
    const e = await emp('Aud', 'Repro');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2025-02-14'),
      grossPay: '1234.57',
      deductions: [{ kind: 'deduction', name: '401(k) Employee', amount: '123.46', payrollItemId: item('401(k) Employee').id }],
    });
    expect(byTracking(pc.lines, 'social_security')).toBe('76.54'); // 1234.57 x 6.2% = 76.543
    expect(byTracking(pc.lines, 'medicare')).toBe('17.90'); // 17.901
    expect(byTracking(pc.lines, 'employer_social_security')).toBe('76.54');
    expect(byTracking(pc.lines, 'futa')).toBe('7.41'); // 7.407
    // net = gross - taxes - deductions exactly
    const net = Money.of(pc.grossPay).minus(sumKind(pc.lines, 'tax')).minus(sumKind(pc.lines, 'deduction'));
    expect(net.toFixed(2)).toBe(pc.netPay);
    const rows = await jeLines(pc.postedEntryId!);
    const dr = rows.reduce((s, r) => s.plus(Money.of(r.debit ?? '0')), Money.zero());
    const cr = rows.reduce((s, r) => s.plus(Money.of(r.credit ?? '0')), Money.zero());
    expect(dr.toFixed(2)).toBe(cr.toFixed(2));
    // debits = gross + employer taxes
    expect(dr.toFixed(2)).toBe(Money.of(pc.grossPay).plus(sumKind(pc.lines, 'employer_contribution')).toFixed(2));
    await assertBooksBalanced(ctx);
  });

  it('Section 125 odd-cent amount: FICA on gross − 125 rounded to the penny, W-2 Box 1/3/5 exact', async () => {
    const e = await emp('Odd', 'Cents');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2025-02-14'),
      grossPay: '1000.01',
      deductions: [
        { kind: 'deduction', name: 'Health Insurance (pre-tax)', amount: '33.33', payrollItemId: item('Health Insurance (pre-tax)').id },
        { kind: 'deduction', name: '401(k) Employee', amount: '50.05', payrollItemId: item('401(k) Employee').id },
      ],
    });
    // FICA wages 966.68
    expect(byTracking(pc.lines, 'social_security')).toBe('59.93');
    expect(byTracking(pc.lines, 'medicare')).toBe('14.02');
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2025 });
    expect(w2.wages).toBe('916.63');
    expect(w2.ssWages).toBe('966.68');
    expect(w2.medicareWages).toBe('966.68');
    expect(w2.box12).toEqual([{ code: 'D', amount: '50.05' }]);
  });

  it('Additional Medicare threshold is measured on Medicare wages (401(k) does NOT reduce them)', async () => {
    const e = await emp('Addl', 'Medicare');
    await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2025-03-31'),
      grossPay: '200000.00',
      deductions: [{ kind: 'deduction', name: '401(k) Employee', amount: '23000.00', payrollItemId: item('401(k) Employee').id }],
    });
    const second = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2025-04-15'), grossPay: '10000.00' });
    // YTD Medicare wages already 200,000 -> all 10,000 over threshold: 1.45% + 0.9% = 235.00
    expect(byTracking(second.lines, 'medicare')).toBe('235.00');
    // employer Medicare has no additional tax
    expect(byTracking(second.lines, 'employer_medicare')).toBe('145.00');
    const q2 = await form941Data(ctx, { quarter: 2, year: 2025 });
    expect(Number(q2.totals.additionalMedicareWages)).toBeGreaterThanOrEqual(10000);
  });

  it('W-2 Box 3 uses the YEAR\'s wage base (2024: 168,600) on FICA wages, not Box 1', async () => {
    const e = await emp('Base', 'Twentyfour');
    await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2024-06-28'),
      grossPay: '180000.00',
      deductions: [
        { kind: 'deduction', name: '401(k) Employee', amount: '15000.00', payrollItemId: item('401(k) Employee').id },
        { kind: 'deduction', name: 'Health Insurance (pre-tax)', amount: '2000.00', payrollItemId: item('Health Insurance (pre-tax)').id },
      ],
    });
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2024 });
    expect(w2.wages).toBe('163000.00');
    expect(w2.ssWages).toBe('168600.00');
    expect(w2.socialSecurity).toBe('10453.20'); // 168,600 x 6.2%
    expect(w2.medicareWages).toBe('178000.00');
  });

  it('941 line 5a across quarters: wage-base room uses prior-quarter FICA wages (401(k) included)', async () => {
    const e = await emp('Quarter', 'Room');
    await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2023-03-15'),
      grossPay: '160000.00',
      deductions: [{ kind: 'deduction', name: '401(k) Employee', amount: '20000.00', payrollItemId: item('401(k) Employee').id }],
    });
    await runPaycheck(ctx, { employeeId: e.id, payDate: d('2023-05-15'), grossPay: '10000.00' });
    // 2023 base 160,200 -> only 200 of Q2 is SS-taxable (the 401(k) did not create room).
    const q2 = await form941Data(ctx, { quarter: 2, year: 2023 });
    expect(q2.totals.ssWages).toBe('200.00');
    expect(q2.totals.employeeSocialSecurity).toBe('12.40');
    expect(q2.totals.employerSocialSecurity).toBe('12.40');
  });

  it('ROTH 401(k) is after-tax: must NOT reduce Box 1 / income-tax wages (and is not Box 12 D)', async () => {
    // A user-created Roth item (pre-tax unchecked, no explicit tracking type).
    const roth = await createPayrollItem(ctx, {
      name: 'Roth 401(k)',
      kind: 'deduction',
      pretax: false,
      liabilityAccountId: item('401(k) Employee').liabilityAccountId,
    });
    expect(roth.pretax).toBe(false);
    expect(roth.taxTracking).not.toBe('401k');

    const e = await emp('Roth', 'Saver');
    await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2025-06-13'),
      grossPay: '2000.00',
      deductions: [{ kind: 'deduction', name: 'Roth 401(k)', amount: '200.00', payrollItemId: roth.id }],
    });
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2025 });
    expect(w2.wages).toBe('2000.00');
    expect(w2.box12.find((b) => b.code === 'D')).toBeUndefined();
  });

  it('migration 0035 must not flip a legacy after-tax "Roth 401(k)" item to pre-tax', async () => {
    const [legacy] = await db
      .insert(payrollItems)
      .values({ companyId: ctx.companyId, name: 'Roth 401k (legacy)', kind: 'deduction', pretax: false })
      .returning();
    const file = path.resolve(process.cwd(), 'drizzle', '0035_fix_payroll.sql');
    for (const s of fs.readFileSync(file, 'utf8').split('--> statement-breakpoint')) {
      if (s.trim()) await db.execute(sql.raw(s));
    }
    const [after] = await db.select().from(payrollItems).where(eq(payrollItems.id, legacy.id));
    expect(after.pretax).toBe(false);
    expect(after.taxTracking).toBe('none');
  });

  it('migration 0035 leaves explicitly-typed items alone and keeps default items correct', async () => {
    const after = await listPayrollItems(ctx, { includeInactive: true });
    const by = (n: string) => after.find((i) => i.name === n)!;
    expect(by('401(k) Employee').taxTracking).toBe('401k');
    expect(by('Health Insurance (pre-tax)').taxTracking).toBe('section125');
    expect(by('Wage Garnishment').taxTracking).toBe('none');
    expect(by('Federal Unemployment (FUTA)').taxTracking).toBe('futa');
  });

  it('void removes the check from W-2 / 941 / 940 and the books stay balanced', async () => {
    const e = await emp('Void', 'Me');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2022-02-15'),
      grossPay: '3000.00',
      deductions: [
        { kind: 'deduction', name: '401(k) Employee', amount: '300.00', payrollItemId: item('401(k) Employee').id },
        { kind: 'deduction', name: 'Health Insurance (pre-tax)', amount: '100.00', payrollItemId: item('Health Insurance (pre-tax)').id },
      ],
    });
    const before940 = await form940Data(ctx, { year: 2022 });
    expect(before940.exemptPayments).toBe('100.00');
    await voidPaycheck(ctx, pc.id);
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2022 });
    expect(w2.wages).toBe('0.00');
    expect(w2.box12).toEqual([]);
    const q1 = await form941Data(ctx, { quarter: 1, year: 2022 });
    expect(q1.totals.wages).toBe('0.00');
    const f940 = await form940Data(ctx, { year: 2022 });
    expect(f940.exemptPayments).toBe('0.00');
    expect(f940.futaTaxAccrued).toBe('0.00');
    await assertBooksBalanced(ctx);
  });

  it('edit with recalculation re-applies the tracking types (401(k) raised, FICA unchanged)', async () => {
    const e = await emp('Edit', 'Recalc');
    const k = item('401(k) Employee');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2021-03-15'),
      grossPay: '2000.00',
      deductions: [{ kind: 'deduction', name: '401(k) Employee', amount: '100.00', payrollItemId: k.id }],
    });
    const fitBefore = Number(byTracking(pc.lines, 'federal_withholding'));
    const edited = await editPaycheck(ctx, pc.id, {
      payDate: d('2021-03-15'),
      earnings: [{ kind: 'regular', amount: '2000.00' }],
      deductions: [{ kind: 'deduction', name: '401(k) Employee', amount: '400.00', payrollItemId: k.id }],
    });
    const lines = await db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, edited.id));
    expect(byTracking(lines, 'social_security')).toBe('124.00');
    expect(byTracking(lines, 'futa')).toBe('12.00');
    expect(Number(byTracking(lines, 'federal_withholding'))).toBeLessThan(fitBefore);
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2021 });
    expect(w2.wages).toBe('1600.00');
    expect(w2.ssWages).toBe('2000.00');
    await assertBooksBalanced(ctx);
  });

  it('edit keeping the explicit tax lines (Edit Paycheck modal body) keeps W-2 / 941 aggregation', async () => {
    const e = await emp('Edit', 'Explicit');
    const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2021-05-14'), grossPay: '1500.00' });
    // The modal echoes the stored lines back, incl. name + taxTracking (+ item id, here null).
    const taxes = pc.lines
      .filter((l) => l.kind === 'tax')
      .map((l) => ({ kind: 'tax' as const, name: l.name, amount: l.amount, payrollItemId: l.payrollItemId, taxTracking: l.taxTracking }));
    const employerTaxes = pc.lines
      .filter((l) => l.kind === 'employer_contribution')
      .map((l) => ({ kind: 'employer_contribution' as const, name: l.name, amount: l.amount, payrollItemId: l.payrollItemId, taxTracking: l.taxTracking }));
    await editPaycheck(ctx, pc.id, {
      payDate: d('2021-05-14'),
      earnings: [{ kind: 'regular', amount: '1500.00' }],
      deductions: [],
      taxes,
      employerTaxes,
    });
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2021 });
    expect(w2.federalWithheld).toBe(byTracking(pc.lines, 'federal_withholding'));
    expect(w2.socialSecurity).toBe('93.00');
    const q2 = await form941Data(ctx, { quarter: 2, year: 2021 });
    expect(q2.totals.employerSocialSecurity).toBe('93.00');
  });

  // ---------------------------------------------------------------------------
  // P0-2: single paycheck = pay-run engine
  // ---------------------------------------------------------------------------

  it('single paycheck == one-person pay run with state SUI/SDI, Section 125 and 401(k): lines, GL, liabilities, W-2, 941, state worksheet', async () => {
    await upsertStateTaxSetting(ctx, { state: 'CA', year: 2020, suiRate: '0.034', suiWageBase: '7000', sdiRate: '0.01', sdiWageBase: '122909' });
    const a = await emp('Solo', 'Check');
    const b = await emp('Batch', 'Check');
    await updateEmployee(ctx, a.id, { address: { state: 'CA' } });
    await updateEmployee(ctx, b.id, { address: { state: 'CA' } });
    const deductions = [
      { kind: 'deduction' as const, name: '401(k) Employee', amount: '250.00', payrollItemId: item('401(k) Employee').id },
      { kind: 'deduction' as const, name: 'Health Insurance (pre-tax)', amount: '75.25', payrollItemId: item('Health Insurance (pre-tax)').id },
    ];
    const liabBefore = await payrollLiabilityBalances(ctx, { asOf: d('2099-01-01') });
    const single = await runPaycheck(ctx, {
      employeeId: a.id,
      payDate: d('2020-08-14'),
      earnings: [{ kind: 'regular', amount: '2500.00' }],
      deductions,
    });
    const liabMid = await payrollLiabilityBalances(ctx, { asOf: d('2099-01-01') });
    const run = await createPayRun(ctx, {
      payDate: d('2020-08-14'),
      employees: [{ employeeId: b.id, amount: '2500.00', deductions }],
    });
    expect(run.results[0].ok).toBe(true);
    const batchLines = await db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, run.results[0].paycheckId!));
    const norm = (ls: L[]) => ls.filter((l) => l.kind !== 'earning').map((l) => `${l.kind}|${l.name}|${l.amount}|${l.taxTracking}`).sort();
    expect(norm(single.lines)).toEqual(norm(batchLines));

    // State taxes computed on FICA wages (2,424.75): SUI 3.4% = 82.44; SDI 1% = 24.25
    expect(byTracking(single.lines, 'sui')).toBe('82.44');
    expect(byTracking(single.lines, 'sdi')).toBe('24.25');
    expect(Number(byTracking(single.lines, 'federal_withholding'))).toBeGreaterThan(0);

    // GL: employer tax expense debited == employer lines; liability accrual == taxes + deductions + employer
    const employer = sumKind(single.lines, 'employer_contribution');
    const accrued = Money.of(liabMid.totalAccrued).minus(Money.of(liabBefore.totalAccrued));
    expect(accrued.toFixed(2)).toBe(
      sumKind(single.lines, 'tax').plus(sumKind(single.lines, 'deduction')).plus(employer).toFixed(2),
    );
    const rows = await jeLines(single.postedEntryId!);
    const debits = rows.reduce((s, r) => s.plus(Money.of(r.debit ?? '0')), Money.zero());
    expect(debits.toFixed(2)).toBe(Money.of('2500.00').plus(employer).toFixed(2));

    // W-2 identical
    const strip = (w: Awaited<ReturnType<typeof w2Data>>) => ({ ...w, employee: null });
    const w2a = await w2Data(ctx, { employeeId: a.id, year: 2020 });
    expect(strip(w2a)).toEqual(strip(await w2Data(ctx, { employeeId: b.id, year: 2020 })));
    expect(w2a.wages).toBe('2174.75');
    expect(w2a.ssWages).toBe('2424.75');
    expect(w2a.state.code).toBe('CA');

    // 941 Q3 2020 = exactly two employees, symmetric
    const q3 = await form941Data(ctx, { quarter: 3, year: 2020 });
    expect(q3.totals.employeeCount).toBe(2);
    expect(q3.totals.wages).toBe('4349.50');
    expect(q3.totals.ssWages).toBe('4849.50');
    expect(q3.totals.employeeSocialSecurity).toBe(q3.totals.employerSocialSecurity);

    const ws = await stateWageWorksheet(ctx, { state: 'CA', year: 2020, quarter: 3 });
    expect(ws.totals.quarterWages).toBe('4849.50');
    expect(ws.totals.suiAccrued).toBe(ws.totals.suiCalculated);
    await assertBooksBalanced(ctx);
  });

  it('override of an employee tax with a sub-penny amount is rounded and the JE still balances', async () => {
    const e = await emp('Penny', 'Override');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2025-09-12'),
      grossPay: '1000.00',
      taxOverrides: [{ payrollItemId: item('Federal Withholding').id, amount: '55.555' }],
    });
    const fit = byTracking(pc.lines, 'federal_withholding');
    expect(fit).toMatch(/^55\.5[56]$/);
    for (const l of pc.lines) expect(l.amount).toMatch(/^-?\d+\.\d{2}$/);
    const net = Money.of(pc.grossPay).minus(sumKind(pc.lines, 'tax')).minus(sumKind(pc.lines, 'deduction'));
    expect(net.toFixed(2)).toBe(pc.netPay);
    await assertBooksBalanced(ctx);
  });

  it('override with a negative amount is refused and nothing is saved', async () => {
    const e = await emp('Neg', 'Override');
    const n = await paycheckCount(ctx);
    await expect(
      runPaycheck(ctx, {
        employeeId: e.id,
        payDate: d('2025-09-12'),
        grossPay: '1000.00',
        taxOverrides: [{ payrollItemId: item('Social Security').id, amount: '-1.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await paycheckCount(ctx)).toBe(n);
  });

  it('override naming ANOTHER company\'s tax item is refused (no cross-company leak) and saves nothing', async () => {
    const e = await emp('Cross', 'Company');
    const n = await paycheckCount(ctx);
    const nOther = await paycheckCount(other);
    let err: unknown;
    try {
      await runPaycheck(ctx, {
        employeeId: e.id,
        payDate: d('2025-09-12'),
        grossPay: '1000.00',
        taxOverrides: [{ payrollItemId: item('Federal Withholding', otherItems).id, amount: '10.00' }],
      });
    } catch (x) {
      err = x;
    }
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toMatch(/NOT_FOUND|VALIDATION/);
    expect(await paycheckCount(ctx)).toBe(n);
    expect(await paycheckCount(other)).toBe(nOther);
  });

  it('override of the SAME tracking type via two different items is refused', async () => {
    const extraFit = await createPayrollItem(ctx, {
      name: 'Federal Withholding (alt)',
      kind: 'tax',
      taxTracking: 'federal_withholding',
      liabilityAccountId: item('Federal Withholding').liabilityAccountId,
    });
    const e = await emp('Dup', 'Tracking');
    await expect(
      runPaycheck(ctx, {
        employeeId: e.id,
        payDate: d('2025-09-12'),
        grossPay: '1000.00',
        taxOverrides: [
          { payrollItemId: item('Federal Withholding').id, amount: '10.00' },
          { payrollItemId: extraFit.id, amount: '20.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('override of an employer item (SUI) replaces the calculated state line and stays on the worksheet', async () => {
    await upsertStateTaxSetting(ctx, { state: 'TX', year: 2025, suiRate: '0.027', suiWageBase: '9000' });
    const e = await emp('Sui', 'Override');
    await updateEmployee(ctx, e.id, { address: { state: 'TX' } });
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2025-11-14'),
      grossPay: '1000.00',
      taxOverrides: [{ payrollItemId: item('State Unemployment (SUI)').id, amount: '30.00' }],
    });
    const sui = pc.lines.filter((l) => l.taxTracking === 'sui');
    expect(sui).toHaveLength(1);
    expect(sui[0].amount).toBe('30.00');
    expect(sui[0].name).toBe('State Unemployment (TX)');
    const ws = await stateWageWorksheet(ctx, { state: 'TX', year: 2025, quarter: 4 });
    expect(ws.totals.suiAccrued).toBe('30.00');
    await assertBooksBalanced(ctx);
  });

  it('a single paycheck dated on/before the closing date is refused with nothing left behind', async () => {
    const e = await emp('Closed', 'Single');
    await setClosingDate(ctx, { closingDate: '2019-12-31' });
    try {
      const n = await paycheckCount(ctx);
      await expect(
        runPaycheck(ctx, { employeeId: e.id, payDate: d('2019-12-20'), grossPay: '1000.00' }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      expect(await paycheckCount(ctx)).toBe(n);
      const w2 = await w2Data(ctx, { employeeId: e.id, year: 2019 });
      expect(w2.wages).toBe('0.00');
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    await assertBooksBalanced(ctx);
  });

  it('preview never posts: no paycheck, no journal entry', async () => {
    const e = await emp('Preview', 'Only');
    const n = await paycheckCount(ctx);
    const je = (await db.execute(sql`select count(*)::int as n from journal_entries`)).rows[0].n;
    const p = await previewPaycheck(ctx, {
      employeeId: e.id,
      payDate: d('2025-12-12'),
      grossPay: '1500.00',
      taxOverrides: [{ payrollItemId: item('Federal Withholding').id, amount: '0' }],
    });
    expect(p.lines.some((l) => l.taxTracking === 'federal_withholding')).toBe(false);
    expect(Number(p.totalEmployerTaxes)).toBeGreaterThan(0);
    expect(await paycheckCount(ctx)).toBe(n);
    expect((await db.execute(sql`select count(*)::int as n from journal_entries`)).rows[0].n).toBe(je);
  });

  it('multi-company isolation: W-2 / 941 of the other company see none of these checks', async () => {
    const q = await form941Data(other, { quarter: 3, year: 2020 });
    expect(q.totals.employeeCount).toBe(0);
    expect(q.totals.wages).toBe('0.00');
    await assertBooksBalanced(other);
  });
});
