/**
 * fix/payroll P0 regressions:
 *
 *  1. Pre-tax deductions wrongly reduced Social Security / Medicare / FUTA wages. QuickBooks
 *     models a per-item TAX TRACKING TYPE: 401(k)/403(b)/457(b) deferrals reduce income-tax
 *     wages only; Section 125 items reduce income-tax AND FICA/FUTA wages; post-tax nothing.
 *     W-2 Box 1 = gross − 401(k) − Sec 125; Box 3/5 = gross − Sec 125 (Box 3 capped); Box 12 D.
 *     941 line 2 / 5a / 5c, 940 line 4 and the state wage worksheet follow the same bases.
 *  2. The Employees "Run Payroll" single paycheck sent a free-text taxes array, so nothing was
 *     calculated (no employer taxes, zero withholding when blank) and names like "FIT" fell off
 *     the W-2 / 941. The single paycheck now uses the pay-run engine; overrides go through tax
 *     payroll ITEMS, and every line carries its tracking type.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, journalEntryLines, paycheckLines, payrollItems } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import {
  createEmployee,
  createPayRun,
  previewPaycheck,
  runPaycheck,
  updateEmployee,
} from './payroll';
import {
  createPayrollItem,
  ensureDefaultPayrollItems,
  listPayrollItems,
  updatePayrollItem,
  type PayrollItem,
} from './payrollItems';
import { form940Data, form941Data, payrollSummary, stateWageWorksheet, w2Data, w3Data } from './payrollReports';
import { createYtdAdjustment, upsertStateTaxSetting } from './payrollAdjustments';
import { trialBalance } from './reports';
import {
  inferDeductionTracking,
  inferEmployeeTaxTracking,
  paycheckWageBases,
} from './payrollTaxTracking';
import { runPaycheckSchema } from '@/lib/validation/payroll';
import { renderW2Pdf, render941Pdf, renderW3Pdf } from '@/lib/pdf/payrollForms';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-tax-tracking');

let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let items: PayrollItem[] = [];
const item = (name: string) => {
  const it = items.find((i) => i.name === name);
  if (!it) throw new Error(`missing item ${name}`);
  return it;
};

async function newEmployee(first: string, last: string, payRate = '52000') {
  const e = await createEmployee(ctx, { firstName: first, lastName: last, payType: 'salary', payRate });
  await updateEmployee(ctx, e.id, { w4: { filingStatus: 'single', formYear: 2020 } });
  return e;
}

const lineAmt = (lines: Array<{ kind: string; name: string; amount: string }>, kind: string, name: string) =>
  lines.find((l) => l.kind === kind && l.name === name)?.amount ?? '0.00';

describe('payroll tax tracking (pure)', () => {
  it('401(k) reduces income-tax wages only; Section 125 reduces both; post-tax neither', () => {
    const b = paycheckWageBases('2000.00', [
      { kind: 'deduction', name: '401(k)', amount: '200.00', taxTracking: '401k' },
      { kind: 'deduction', name: 'Health', amount: '100.00', taxTracking: 'section125' },
      { kind: 'deduction', name: 'Union dues', amount: '25.00', taxTracking: 'none' },
      { kind: 'employer_contribution', name: 'Employer health', amount: '300.00', taxTracking: 'employer_health' },
    ]);
    expect(b.incomeTaxWages.toFixed(2)).toBe('1700.00');
    expect(b.ficaWages.toFixed(2)).toBe('1900.00');
    expect(b.box12.get('D')?.toFixed(2)).toBe('200.00');
    expect(b.box12.get('DD')?.toFixed(2)).toBe('300.00');
    expect(b.cafeteria.toFixed(2)).toBe('100.00');
  });

  it('a wage-less liability adjustment moves no wages', () => {
    const b = paycheckWageBases('0.00', [
      { kind: 'deduction', name: '401(k)', amount: '-50.00', taxTracking: '401k' },
    ]);
    expect(b.incomeTaxWages.toFixed(2)).toBe('0.00');
    expect(b.ficaWages.toFixed(2)).toBe('0.00');
  });

  it('infers sensible defaults from names', () => {
    expect(inferDeductionTracking('401(k) Employee', true)).toBe('401k');
    // Roth deferrals are after-tax (W-2 Box 12 AA/BB, not D/E): they reduce no wages.
    expect(inferDeductionTracking('Roth 401k', false)).toBe('none');
    expect(inferDeductionTracking('Roth 403(b)', false)).toBe('none');
    expect(inferDeductionTracking('Health Insurance (pre-tax)', true)).toBe('section125');
    expect(inferDeductionTracking('HSA', true)).toBe('hsa');
    expect(inferDeductionTracking('Union dues', false)).toBe('none');
    expect(inferEmployeeTaxTracking('FIT')).toBe('federal_withholding');
    expect(inferEmployeeTaxTracking('State Income Tax (CA)')).toBe('state_withholding');
    expect(inferEmployeeTaxTracking('State Disability (CA)')).toBe('sdi');
    expect(inferEmployeeTaxTracking('FICA')).toBeNull(); // ambiguous: SS or Medicare?
  });
});

describe('payroll tax tracking — paychecks, forms and the single-paycheck path', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'taxtrack@test.local', name: 'Tax Tracking Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Tax Tracking Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['2300', 'Payroll Liabilities', 'liability', 'long_term_liability'],
      ['6500', 'Payroll Expense', 'expense', 'payroll'],
      ['6510', 'Payroll Tax Expense', 'expense', 'payroll'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    await ensureDefaultPayrollItems(ctx);
    items = await listPayrollItems(ctx, { includeInactive: true });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('seeds the default 401(k) as a 401(k) deferral and health as Section 125', () => {
    expect(item('401(k) Employee').taxTracking).toBe('401k');
    expect(item('401(k) Employee').pretax).toBe(true);
    expect(item('Health Insurance (pre-tax)').taxTracking).toBe('section125');
    expect(item('Federal Withholding').taxTracking).toBe('federal_withholding');
    expect(item('State Withholding').taxTracking).toBe('state_withholding');
  });

  it('BUG 1: a 401(k) deferral no longer reduces Social Security, Medicare or FUTA', async () => {
    const e = await newEmployee('Kay', 'Fourohone');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: new Date('2025-03-14'),
      grossPay: '2000.00',
      deductions: [{ kind: 'deduction', name: '401(k) Employee', amount: '200.00', payrollItemId: item('401(k) Employee').id }],
    });
    // FICA / FUTA on the full 2,000.
    expect(lineAmt(pc.lines, 'tax', 'Social Security')).toBe('124.00');
    expect(lineAmt(pc.lines, 'tax', 'Medicare')).toBe('29.00');
    expect(lineAmt(pc.lines, 'employer_contribution', 'Employer Social Security')).toBe('124.00');
    expect(lineAmt(pc.lines, 'employer_contribution', 'Employer Medicare')).toBe('29.00');
    expect(lineAmt(pc.lines, 'employer_contribution', 'Federal Unemployment (FUTA)')).toBe('12.00');

    // Federal income tax is figured on 1,800 — same as a plain 1,800 check.
    const plain = await newEmployee('Pat', 'Plain');
    const ref = await previewPaycheck(ctx, { employeeId: plain.id, payDate: new Date('2025-03-14'), grossPay: '1800.00' });
    expect(lineAmt(pc.lines, 'tax', 'Federal Income Tax')).toBe(lineAmt(ref.lines, 'tax', 'Federal Income Tax'));

    const ded = pc.lines.find((l) => l.kind === 'deduction')!;
    expect(ded.taxTracking).toBe('401k');

    // W-2: Box 1 = 1,800; Box 3/5 = 2,000; Box 4 = 6.2% x Box 3; Box 12 D = 200.
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2025 });
    expect(w2.wages).toBe('1800.00');
    expect(w2.ssWages).toBe('2000.00');
    expect(w2.medicareWages).toBe('2000.00');
    expect(w2.socialSecurity).toBe('124.00');
    expect(w2.box12).toEqual([{ code: 'D', amount: '200.00' }]);
  });

  it('Section 125 health premiums reduce income-tax AND FICA / FUTA wages', async () => {
    const e = await newEmployee('Hal', 'Health');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: new Date('2025-03-14'),
      grossPay: '2000.00',
      deductions: [
        { kind: 'deduction', name: 'Health Insurance (pre-tax)', amount: '100.00', payrollItemId: item('Health Insurance (pre-tax)').id },
        { kind: 'deduction', name: '401(k) Employee', amount: '200.00', payrollItemId: item('401(k) Employee').id },
        { kind: 'deduction', name: 'Union dues', amount: '10.00' }, // custom = after-tax
      ],
    });
    expect(lineAmt(pc.lines, 'tax', 'Social Security')).toBe('117.80'); // 6.2% x 1,900
    expect(lineAmt(pc.lines, 'tax', 'Medicare')).toBe('27.55');         // 1.45% x 1,900
    expect(lineAmt(pc.lines, 'employer_contribution', 'Federal Unemployment (FUTA)')).toBe('11.40');

    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2025 });
    expect(w2.wages).toBe('1700.00');
    expect(w2.ssWages).toBe('1900.00');
    expect(w2.medicareWages).toBe('1900.00');
    expect(w2.box14).toEqual([{ label: 'Sec 125', amount: '100.00' }]);

    const s = await payrollSummary(ctx, { from: new Date('2025-03-14'), to: new Date('2025-03-14'), employeeId: e.id });
    expect(s.rows[0].federalTaxableWages).toBe('1700.00');
    expect(s.rows[0].ficaWages).toBe('1900.00');
  });

  it('W-2 Box 4 = 6.2% x Box 3 for a high earner with 401(k) deferrals (wage base on FICA wages)', async () => {
    const e = await newEmployee('Rich', 'Earner', '400000');
    await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: new Date('2025-06-30'),
      grossPay: '170000.00',
      deductions: [{ kind: 'deduction', name: '401(k) Employee', amount: '20000.00', payrollItemId: item('401(k) Employee').id }],
    });
    const second = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: new Date('2025-12-15'),
      grossPay: '10000.00',
    });
    // 2025 base 176,100: only 6,100 of the second check is SS-taxable.
    expect(lineAmt(second.lines, 'tax', 'Social Security')).toBe('378.20');
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2025 });
    expect(w2.ssWages).toBe('176100.00');
    expect(w2.socialSecurity).toBe('10918.20'); // 176,100 x 6.2%
    expect(w2.wages).toBe('160000.00');
    expect(w2.medicareWages).toBe('180000.00');
  });

  it('941 / 940 / W-3 / state worksheet use the same wage bases', async () => {
    const q = await form941Data(ctx, { quarter: 1, year: 2025 });
    // Q1 2025: Kay (2,000 gross, 401k 200), Hal (2,000 gross, 401k 200 + Sec125 100).
    expect(q.totals.grossPay).toBe('4000.00');
    expect(q.totals.wages).toBe('3500.00');          // line 2
    expect(q.totals.ssWages).toBe('3900.00');        // line 5a col 1
    expect(q.totals.medicareWages).toBe('3900.00');  // line 5c col 1
    expect(q.totals.employeeCount).toBe(2);
    // 5a col 2 = 12.4% of 5a col 1
    expect(q.totals.socialSecurity).toBe('483.60');

    const f940 = await form940Data(ctx, { year: 2025 });
    expect(f940.exemptPayments).toBe('100.00'); // Section 125 only — 401(k) is FUTA-taxable
    expect(f940.futaTaxCalculated).toBe(f940.futaTaxAccrued);

    const w3 = await w3Data(ctx, { year: 2025 });
    expect(w3.box12.find((b) => b.code === 'D')?.amount).toBe('20400.00');
    expect(w3.deferredCompensation).toBe('20400.00');

    // PDFs render the new boxes without throwing.
    const kay = (await w2Data(ctx, { employeeId: (await db.execute(sql`select id from employees where last_name = 'Fourohone'`)).rows[0].id as string, year: 2025 }));
    expect((await renderW2Pdf(kay)).length).toBeGreaterThan(500);
    expect((await render941Pdf(q)).length).toBeGreaterThan(500);
    expect((await renderW3Pdf(w3)).length).toBeGreaterThan(500);
  });

  it('state wage worksheet uses SUI wages (gross less Section 125)', async () => {
    await upsertStateTaxSetting(ctx, { state: 'TX', year: 2025, suiRate: '0.027', suiWageBase: '9000' });
    const e = await newEmployee('Tex', 'Sui');
    await updateEmployee(ctx, e.id, { address: { state: 'TX' } });
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: new Date('2025-04-15'),
      grossPay: '3000.00',
      deductions: [
        { kind: 'deduction', name: 'Health Insurance (pre-tax)', amount: '200.00', payrollItemId: item('Health Insurance (pre-tax)').id },
        { kind: 'deduction', name: '401(k) Employee', amount: '300.00', payrollItemId: item('401(k) Employee').id },
      ],
    });
    expect(lineAmt(pc.lines, 'employer_contribution', 'State Unemployment (TX)')).toBe('75.60'); // 2.7% x 2,800
    const ws = await stateWageWorksheet(ctx, { state: 'TX', year: 2025, quarter: 2 });
    expect(ws.totals.quarterWages).toBe('2800.00');
    expect(ws.totals.suiAccrued).toBe('75.60');
    expect(ws.totals.suiCalculated).toBe('75.60');
  });

  it('BUG 2: a single paycheck (Run Payroll body) posts exactly what a one-person pay run posts', async () => {
    const a = await newEmployee('Run', 'Single');
    const b = await newEmployee('Run', 'Batch');
    const payDate = new Date('2025-05-15');
    const deductions = [{ kind: 'deduction' as const, name: '401(k) Employee', amount: '100.00', payrollItemId: item('401(k) Employee').id }];

    // What the Employees page now sends: no tax lines at all.
    const body = runPaycheckSchema.parse({
      employeeId: a.id,
      payDate: '2025-05-15',
      earnings: [{ kind: 'regular', amount: '2000.00' }],
      deductions,
    });
    expect('taxes' in body).toBe(false);
    const single = await runPaycheck(ctx, { ...body, deductions: body.deductions ?? [] });

    const run = await createPayRun(ctx, {
      payDate,
      employees: [{ employeeId: b.id, amount: '2000.00', deductions }],
    });
    expect(run.results[0].ok).toBe(true);
    const batchLines = await db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, run.results[0].paycheckId!));

    const norm = (ls: Array<{ kind: string; name: string; amount: string; taxTracking?: string | null }>) =>
      ls
        .filter((l) => l.kind !== 'earning')
        .map((l) => `${l.kind}|${l.name}|${l.amount}|${l.taxTracking}`)
        .sort();
    expect(norm(single.lines)).toEqual(norm(batchLines));
    // Employer taxes ARE accrued on the single check.
    expect(lineAmt(single.lines, 'employer_contribution', 'Employer Social Security')).toBe('124.00');
    expect(lineAmt(single.lines, 'employer_contribution', 'Federal Unemployment (FUTA)')).toBe('12.00');
    expect(Number(lineAmt(single.lines, 'tax', 'Federal Income Tax'))).toBeGreaterThan(0);

    // Same GL: amounts per account.
    const gl = async (entryId: string) => {
      const rows = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
      const m = new Map<string, string>();
      for (const r of rows) m.set(r.accountId, `${r.debit ?? '0'}/${r.credit ?? '0'}`);
      return [...m.entries()].sort();
    };
    const batchCheck = (await db.execute(sql`select posted_entry_id from paychecks where id = ${run.results[0].paycheckId}`)).rows[0];
    const glSingle = await gl(single.postedEntryId!);
    const glBatch = await gl(batchCheck.posted_entry_id as string);
    expect(glSingle).toEqual(glBatch);
    expect(glSingle.some(([acc]) => acc === acct['6510'])).toBe(true); // employer tax expense

    // Same W-2.
    const strip = (w: Awaited<ReturnType<typeof w2Data>>) => ({ ...w, employee: null });
    expect(strip(await w2Data(ctx, { employeeId: a.id, year: 2025 }))).toEqual(
      strip(await w2Data(ctx, { employeeId: b.id, year: 2025 })),
    );

    // The books still balance.
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('overrides go through tax ITEMS and stay on the W-2 / 941', async () => {
    const e = await newEmployee('Ollie', 'Override');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: new Date('2025-08-15'),
      grossPay: '1000.00',
      taxOverrides: [
        { payrollItemId: item('Federal Withholding').id, amount: '100.00' },
        { payrollItemId: item('State Withholding').id, amount: '40.00' },
        { payrollItemId: item('Federal Unemployment (FUTA)').id, amount: '0' },
      ],
    });
    const fit = pc.lines.find((l) => l.kind === 'tax' && l.taxTracking === 'federal_withholding')!;
    expect(fit.amount).toBe('100.00');
    expect(fit.name).toBe('Federal Income Tax');
    expect(fit.payrollItemId).toBe(item('Federal Withholding').id);
    expect(pc.lines.some((l) => l.taxTracking === 'futa')).toBe(false);
    // Employer SS / Medicare still accrued even though taxes were overridden.
    expect(lineAmt(pc.lines, 'employer_contribution', 'Employer Social Security')).toBe('62.00');

    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2025 });
    expect(w2.federalWithheld).toBe('100.00');
    expect(w2.state.withheld).toBe('40.00');
    expect(w2.socialSecurity).toBe('62.00');

    const q3 = await form941Data(ctx, { quarter: 3, year: 2025 });
    expect(q3.totals.federalWithheld).toBe('100.00');
    expect(q3.totals.employerSocialSecurity).toBe('62.00');
    expect(q3.totals.socialSecurity).toBe('124.00');
  });

  it('refuses overrides that are not tax items, duplicates, or mixed with tax lists', async () => {
    const e = await newEmployee('Val', 'Idation');
    const base = { employeeId: e.id, payDate: new Date('2025-09-01'), grossPay: '1000.00' };
    await expect(
      runPaycheck(ctx, { ...base, taxOverrides: [{ payrollItemId: item('401(k) Employee').id, amount: '5' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      runPaycheck(ctx, {
        ...base,
        taxOverrides: [
          { payrollItemId: item('Federal Withholding').id, amount: '5' },
          { payrollItemId: item('Federal Withholding').id, amount: '6' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      runPaycheck(ctx, { ...base, taxes: [], taxOverrides: [{ payrollItemId: item('Federal Withholding').id, amount: '5' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('free-text tax lines: standard abbreviations are tracked, unknown names are refused', async () => {
    const e = await newEmployee('Fitz', 'Freetext');
    await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: new Date('2025-10-01'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'FIT', amount: '100.00' }],
    });
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2025 });
    expect(w2.federalWithheld).toBe('100.00'); // was 0.00 before the fix

    await expect(
      runPaycheck(ctx, {
        employeeId: e.id,
        payDate: new Date('2025-10-02'),
        grossPay: '1000.00',
        taxes: [{ kind: 'tax', name: 'FICA', amount: '76.50' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('preview matches the posted check and saves nothing', async () => {
    const e = await newEmployee('Pre', 'View');
    const input = {
      employeeId: e.id,
      payDate: new Date('2025-11-14'),
      grossPay: '2500.00',
      deductions: [{ kind: 'deduction' as const, name: '401(k) Employee', amount: '125.00', payrollItemId: item('401(k) Employee').id }],
    };
    const before = (await db.execute(sql`select count(*)::int as n from paychecks`)).rows[0].n;
    const preview = await previewPaycheck(ctx, input);
    expect((await db.execute(sql`select count(*)::int as n from paychecks`)).rows[0].n).toBe(before);
    expect(preview.wages).toEqual({ gross: '2500.00', incomeTaxWages: '2375.00', ficaWages: '2500.00' });
    const posted = await runPaycheck(ctx, input);
    expect(posted.netPay).toBe(preview.netPay);
    const key = (ls: Array<{ kind: string; name: string; amount: string }>) =>
      ls.map((l) => `${l.kind}|${l.name}|${l.amount}`).sort();
    expect(key(posted.lines)).toEqual(key(preview.lines));
  });

  it('YTD setup with a 401(k) item feeds FICA wage-base tracking from FICA wages', async () => {
    const e = await newEmployee('Mid', 'Year', '300000');
    await createYtdAdjustment(ctx, {
      employeeId: e.id,
      date: new Date('2025-06-30'),
      lines: [
        { kind: 'earning', name: 'Salary', amount: '176000.00' },
        { kind: 'deduction', name: '401(k) Employee', amount: '23000.00', payrollItemId: item('401(k) Employee').id },
        { kind: 'tax', name: 'Social Security', amount: '10912.00' },
      ],
    });
    // FICA wages so far: 176,000 (the 401(k) does not reduce them) → 100 left under 176,100.
    const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: new Date('2025-07-15'), grossPay: '5000.00' });
    expect(lineAmt(pc.lines, 'tax', 'Social Security')).toBe('6.20');
  });

  it('payroll items: tax items need a tracking type; deductions keep pretax in sync', async () => {
    await expect(
      createPayrollItem(ctx, { name: 'Mystery Levy', kind: 'tax', liabilityAccountId: acct['2300'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const local = await createPayrollItem(ctx, {
      name: 'Mystery Levy', kind: 'tax', taxTracking: 'local_tax', liabilityAccountId: acct['2300'],
    });
    expect(local.taxTracking).toBe('local_tax');
    await expect(
      createPayrollItem(ctx, { name: 'Bad', kind: 'deduction', taxTracking: 'futa', liabilityAccountId: acct['2300'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const k403 = await createPayrollItem(ctx, {
      name: 'Teacher plan', kind: 'deduction', taxTracking: '403b', liabilityAccountId: acct['2300'],
    });
    expect(k403.pretax).toBe(true);
    const updated = await updatePayrollItem(ctx, k403.id, { taxTracking: 'none' });
    expect(updated.pretax).toBe(false);
    expect(updated.taxTracking).toBe('none');
  });

  it('migration 0035 backfills legacy items and lines idempotently', async () => {
    // A legacy pre-tax 401(k) item and a paycheck line with no tracking type.
    const [legacy] = await db
      .insert(payrollItems)
      .values({ companyId: ctx.companyId, name: 'Old 401k plan', kind: 'deduction', pretax: true, liabilityAccountId: acct['2300'] })
      .returning();
    const e = await newEmployee('Leg', 'Acy');
    const pc = await runPaycheck(ctx, {
      employeeId: e.id,
      payDate: new Date('2024-05-01'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'Federal Income Tax', amount: '80.00' }],
      deductions: [{ kind: 'deduction', name: 'Old 401k plan', amount: '50.00', payrollItemId: legacy.id }],
    });
    await db.execute(sql`update paycheck_lines set tax_tracking = null where paycheck_id = ${pc.id}`);
    await db.execute(sql`update payroll_items set tax_tracking = null where id = ${legacy.id}`);

    const file = path.resolve(process.cwd(), 'drizzle', '0035_fix_payroll.sql');
    const stmts = fs.readFileSync(file, 'utf8').split('--> statement-breakpoint');
    for (let pass = 0; pass < 2; pass++) {
      for (const s of stmts) if (s.trim()) await db.execute(sql.raw(s));
    }
    const [it2] = await db.select().from(payrollItems).where(eq(payrollItems.id, legacy.id));
    expect(it2.taxTracking).toBe('401k');
    expect(it2.pretax).toBe(true);
    const ls = await db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, pc.id));
    expect(ls.find((l) => l.kind === 'deduction')!.taxTracking).toBe('401k');
    expect(ls.find((l) => l.kind === 'tax')!.taxTracking).toBe('federal_withholding');
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2024 });
    expect(w2.wages).toBe('950.00');
    expect(w2.ssWages).toBe('1000.00');
    expect(w2.federalWithheld).toBe('80.00');
  });
});
