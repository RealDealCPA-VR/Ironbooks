/**
 * Review round 5 — payroll, time, mileage and expense reports (service level).
 *
 *  1. Voiding a paycheck releases the time entries it paid ([payroll:<id>] tag), so the
 *     corrected check can pull the same hours again.
 *  2. Time already paid on a paycheck cannot have its hours / date / employee changed or be
 *     deleted, and editing its description keeps it marked as paid (no double pay).
 *  3. Editing a paycheck recalculates at the check's own pay frequency (a monthly check is not
 *     re-withheld as biweekly); with no frequency given, the company's payroll pay period
 *     (Preferences) is used instead of a hard-coded 26.
 *  4. Billing time keeps each entry's Customer:Job on its invoice line, and the invoice / the
 *     expense reimbursement are dated today's LOCAL calendar day (not the UTC day).
 *  5. Expense reports refuse non-numeric amounts ("NaN" used to be stored) and round each line
 *     before totalling, so the draft total equals its lines.
 *  6. State SUI/SDI settings and workers' comp rates refuse "NaN" / "abc" as VALIDATION.
 *  7. Renaming a payroll item to another item's name is refused (like creating one).
 *  8. The default mileage rate is the IRS rate for the trip's year.
 *  9. W-3 Box 16 = the sum of the W-2s' Box 16; no-income-tax states get no state wages.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  expenseReportLines,
  expenseReports,
  invoiceLines,
  invoices,
  journalEntries,
  journalEntryLines,
  payrollStateSettings,
  timeEntries,
  users,
  workersCompCodes,
  accounts,
} from '@/lib/db/schema';
import { MoneyParseError } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createCustomer } from './customers';
import { createAccount } from './accounts';
import { createJob } from './jobs';
import {
  createEmployee,
  createPayRun,
  editPaycheck,
  getPaycheck,
  runPaycheck,
  unpaidTimeForPayroll,
  updateEmployee,
  voidPaycheck,
} from './payroll';
import { billTimeToInvoice, createTimeEntry, deleteTimeEntry, updateTimeEntry } from './timeTracking';
import { approveAndReimburse, createReport, submitReport } from './expenseReports';
import { createWorkersCompCode, createYtdAdjustment, updateWorkersCompCode, upsertStateTaxSetting } from './payrollAdjustments';
import { createPayrollItem, updatePayrollItem } from './payrollItems';
import { logMiles } from './mileage';
import { w2Data, w3Data } from './payrollReports';

process.env.TZ = 'America/New_York';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-payroll');
let db: DB;
let seq = 0;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `r5-pay-${seq}@test.local`, name: 'R5', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  return { db, companyId: company.id, userId: user.id };
}

async function acct(ctx: ServiceContext, code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return a;
}

const fit = (lines: Array<{ kind: string; taxTracking?: string | null; amount: string }>) =>
  lines.find((l) => l.kind === 'tax' && l.taxTracking === 'federal_withholding')?.amount ?? '0.00';

describe('review5 payroll / time / mileage / expense reports', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1-2. Time <-> payroll link
  // -------------------------------------------------------------------------
  describe('time paid on paychecks', () => {
    async function paidTime(name: string) {
      const ctx = await newCompany(name);
      const emp = await createEmployee(ctx, { firstName: 'Tim', lastName: 'Sheet', payType: 'hourly', payRate: '20' });
      const t1 = await createTimeEntry(ctx, { employeeId: emp.id, date: d('2026-03-02'), hours: '8', billable: false, description: 'Shop work' });
      const t2 = await createTimeEntry(ctx, { employeeId: emp.id, date: d('2026-03-03'), hours: '6', billable: false });
      const run = await createPayRun(ctx, {
        payDate: d('2026-03-06'),
        periodStart: d('2026-03-01'),
        periodEnd: d('2026-03-07'),
        employees: [{ employeeId: emp.id, timeEntryIds: [t1.id, t2.id] }],
      });
      expect(run.results[0].ok).toBe(true);
      return { ctx, emp, t1, t2, paycheckId: run.results[0].paycheckId! };
    }

    it('voiding the paycheck releases its time entries so the corrected check can pay them', async () => {
      const { ctx, emp, t1, t2, paycheckId } = await paidTime('R5 Void Releases Time');
      const period = { employeeId: emp.id, periodStart: d('2026-03-01'), periodEnd: d('2026-03-07') };
      expect((await unpaidTimeForPayroll(ctx, period)).entries).toHaveLength(0);

      await voidPaycheck(ctx, paycheckId);

      const unpaid = await unpaidTimeForPayroll(ctx, period);
      expect(unpaid.entries.map((e) => e.id).sort()).toEqual([t1.id, t2.id].sort());
      expect(unpaid.totalHours).toBe('14.00');
      // The original descriptions come back without the payroll tag.
      const rows = await ctx.db.select().from(timeEntries).where(eq(timeEntries.employeeId, emp.id));
      expect(rows.find((r) => r.id === t1.id)?.description).toBe('Shop work');
      expect(rows.find((r) => r.id === t2.id)?.description ?? null).toBeNull();

      // The replacement check pulls the same hours.
      const again = await createPayRun(ctx, {
        payDate: d('2026-03-06'),
        employees: [{ employeeId: emp.id, timeEntryIds: [t1.id, t2.id] }],
      });
      expect(again.results[0].ok).toBe(true);
      expect(again.results[0].grossPay).toBe('280.00');
    });

    it('paid time cannot change hours, date or employee, or be deleted; a description edit keeps it paid', async () => {
      const { ctx, emp, t1 } = await paidTime('R5 Paid Time Locked');
      const other = await createEmployee(ctx, { firstName: 'Ola', lastName: 'Other', payType: 'hourly', payRate: '20' });
      await expect(updateTimeEntry(ctx, t1.id, { hours: '10' })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(updateTimeEntry(ctx, t1.id, { date: d('2026-03-04') })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(updateTimeEntry(ctx, t1.id, { employeeId: other.id })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(deleteTimeEntry(ctx, t1.id)).rejects.toMatchObject({ code: 'CONFLICT' });

      const edited = await updateTimeEntry(ctx, t1.id, { description: 'Shop work (fixed typo)' });
      expect(edited.hours).toBe('8.00');
      expect(edited.description).toContain('Shop work (fixed typo)');
      // Still paid: it can't be pulled into another paycheck.
      const period = { employeeId: emp.id, periodStart: d('2026-03-01'), periodEnd: d('2026-03-07') };
      expect((await unpaidTimeForPayroll(ctx, period)).entries.map((e) => e.id)).not.toContain(t1.id);
      const twice = await createPayRun(ctx, {
        payDate: d('2026-03-13'),
        employees: [{ employeeId: emp.id, timeEntryIds: [t1.id] }],
      }).catch((e) => e);
      expect(twice).toMatchObject({ code: 'VALIDATION' });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Pay frequency on edit / default
  // -------------------------------------------------------------------------
  describe('pay frequency', () => {
    it('editing a monthly paycheck without changes keeps the same withholding', async () => {
      const ctx = await newCompany('R5 Edit Monthly');
      const emp = await createEmployee(ctx, { firstName: 'Mo', lastName: 'Nthly', payType: 'salary', payRate: '60000' });
      await updateEmployee(ctx, emp.id, { w4: { filingStatus: 'single', formYear: 2020 } });
      const pc = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-03-31'), grossPay: '5000.00', periodsPerYear: 12 });
      const before = fit(pc.lines);
      expect(Number(before)).toBeGreaterThan(0);

      const edited = await editPaycheck(ctx, pc.id, { payDate: d('2026-03-31'), grossPay: '5000.00' });
      expect(fit(edited.lines)).toBe(before);
      expect(edited.netPay).toBe(pc.netPay);
      // Re-saving again is idempotent too.
      const again = await editPaycheck(ctx, pc.id, { payDate: d('2026-03-31'), grossPay: '5000.00' });
      expect(fit(again.lines)).toBe(before);
      expect((await getPaycheck(ctx, pc.id)).netPay).toBe(pc.netPay);
    });

    it("a paycheck without a pay frequency uses the company's payroll pay period", async () => {
      const ctx = await newCompany('R5 Pref Monthly');
      await updateCompany(ctx, { settings: { payrollPayPeriod: 'monthly' } });
      const a = await createEmployee(ctx, { firstName: 'Al', lastName: 'Pref', payType: 'salary', payRate: '60000' });
      const b = await createEmployee(ctx, { firstName: 'Bo', lastName: 'Pref', payType: 'salary', payRate: '60000' });
      const implicit = await runPaycheck(ctx, { employeeId: a.id, payDate: d('2026-03-31'), grossPay: '5000.00' });
      const explicit = await runPaycheck(ctx, { employeeId: b.id, payDate: d('2026-03-31'), grossPay: '5000.00', periodsPerYear: 12 });
      expect(fit(implicit.lines)).toBe(fit(explicit.lines));

      // Pay run salary default spreads the annual salary over the preference's 12 periods.
      const c = await createEmployee(ctx, { firstName: 'Cy', lastName: 'Pref', payType: 'salary', payRate: '60000' });
      const run = await createPayRun(ctx, { payDate: d('2026-04-30'), employees: [{ employeeId: c.id }] });
      expect(run.results[0].grossPay).toBe('5000.00');
    });

    it('refuses a nonsense pay frequency instead of computing with it', async () => {
      const ctx = await newCompany('R5 Bad Frequency');
      const e = await createEmployee(ctx, { firstName: 'Ba', lastName: 'Freq', payType: 'salary', payRate: '60000' });
      await expect(runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-03-31'), grossPay: '100.00', periodsPerYear: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-03-31'), grossPay: '100.00', periodsPerYear: Number.NaN })).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  it('a YTD entry that affects accounts posts wages and net pay to the Preferences payroll accounts, like a paycheck', async () => {
    const ctx = await newCompany('R5 YTD Pref Accounts');
    const wages = await createAccount(ctx, { code: '6550', name: 'Salaries & Wages', type: 'expense', subtype: 'payroll' });
    const savings = await acct(ctx, '1010');
    expect(savings.subtype).toBe('savings');
    await updateCompany(ctx, { settings: { payrollExpenseAccountId: wages.id, defaultPaycheckAccountId: savings.id } });
    const e = await createEmployee(ctx, { firstName: 'Yt', lastName: 'Dee', payType: 'salary', payRate: '50000' });
    const check = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-06-05'), grossPay: '1000.00', taxes: [], employerTaxes: [] });
    const ytd = await createYtdAdjustment(ctx, {
      employeeId: e.id,
      date: d('2026-03-31'),
      affectsAccounts: true,
      lines: [
        { kind: 'earning', name: 'Salary', amount: '3000.00' },
        { kind: 'tax', name: 'Federal Income Tax', amount: '300.00' },
      ],
    });
    const linesOf = async (entryId: string) =>
      ctx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
    const checkLines = await linesOf(check.postedEntryId!);
    const ytdLines = await linesOf(ytd.postedEntryId!);
    // The paycheck debits the preferred wages account and pays from the preferred bank...
    expect(checkLines.find((l) => l.debit && Number(l.debit) === 1000)?.accountId).toBe(wages.id);
    expect(checkLines.find((l) => l.credit && Number(l.credit) === 1000)?.accountId).toBe(savings.id);
    // ...and so does the YTD entry.
    expect(ytdLines.find((l) => l.debit && Number(l.debit) === 3000)?.accountId).toBe(wages.id);
    expect(ytdLines.find((l) => l.credit && Number(l.credit) === 2700)?.accountId).toBe(savings.id);
  });

  // -------------------------------------------------------------------------
  // Concurrency: the wage bases are read in the same transaction that posts the check
  // -------------------------------------------------------------------------
  it('two checks posted at once for an employee at the Social Security wage base withhold it only once', async () => {
    const ctx = await newCompany('R5 SS Base Race');
    const e = await createEmployee(ctx, { firstName: 'Ra', lastName: 'Ce', payType: 'salary', payRate: '200000' });
    // 2026 wage base 184,500: 184,000 already paid → only 500 more is subject to Social Security.
    await createYtdAdjustment(ctx, {
      employeeId: e.id,
      date: d('2026-01-31'),
      lines: [{ kind: 'earning', name: 'Salary', amount: '184000.00' }],
    });
    const [a, b] = await Promise.all([
      runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-11-13'), grossPay: '1000.00' }),
      runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-11-13'), grossPay: '1000.00' }),
    ]);
    const ss = (lines: Array<{ kind: string; taxTracking?: string | null; amount: string }>, t: string) =>
      Number(lines.find((l) => l.taxTracking === t)?.amount ?? 0);
    expect(ss(a.lines, 'social_security') + ss(b.lines, 'social_security')).toBeCloseTo(31.0, 2); // 500 x 6.2%
    expect(ss(a.lines, 'employer_social_security') + ss(b.lines, 'employer_social_security')).toBeCloseTo(31.0, 2);
  });

  // -------------------------------------------------------------------------
  // 4. Billing time: job on lines, local "today"
  // -------------------------------------------------------------------------
  it("billing time keeps each entry's job on its invoice line and dates the invoice today (local day)", async () => {
    const ctx = await newCompany('R5 Bill Time Job');
    const cust = await createCustomer(ctx, { displayName: 'Job Client' });
    const job = await createJob(ctx, { customerId: cust.id, name: 'Kitchen remodel' });
    await createTimeEntry(ctx, { customerId: cust.id, jobId: job.id, date: d('2026-12-30'), hours: '2', rate: '100', billable: true });
    await createTimeEntry(ctx, { customerId: cust.id, date: d('2026-12-30'), hours: '1', rate: '100', billable: true });

    // 11:30 pm on Dec 31 in New York = 04:30 on Jan 1 UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T04:30:00.000Z'));
    const inv = await billTimeToInvoice(ctx, { customerId: cust.id });
    vi.useRealTimers();

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.date.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    const lines = await ctx.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    expect(lines.map((l) => l.jobId).sort()).toEqual([job.id, null].sort());
  });

  // -------------------------------------------------------------------------
  // 5. Expense reports
  // -------------------------------------------------------------------------
  describe('expense reports', () => {
    it('refuse an amount that is not a number and store nothing', async () => {
      const ctx = await newCompany('R5 Expense NaN');
      const emp = await createEmployee(ctx, { firstName: 'Ex', lastName: 'Pense', payType: 'salary', payRate: '1' });
      const travel = await acct(ctx, '6000');
      for (const amount of ['NaN', 'abc', 'Infinity']) {
        const err = await createReport(ctx, { employeeId: emp.id, lines: [{ accountId: travel.id, amount }] }).catch((e) => e);
        expect(err, amount).not.toBeInstanceOf(MoneyParseError);
        expect(err, amount).toMatchObject({ code: 'VALIDATION' });
      }
      // An A/R line could never be reimbursed (A/R needs a customer name): refused up front.
      const ar = await acct(ctx, '1200');
      expect(ar.subtype).toBe('accounts_receivable');
      await expect(createReport(ctx, { employeeId: emp.id, lines: [{ accountId: ar.id, amount: '5.00' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await ctx.db.select().from(expenseReports).where(eq(expenseReports.companyId, ctx.companyId))).toHaveLength(0);
    });

    it('round each line before totalling and reimburse on the local calendar day', async () => {
      const ctx = await newCompany('R5 Expense Rounding');
      const emp = await createEmployee(ctx, { firstName: 'Ro', lastName: 'Und', payType: 'salary', payRate: '1' });
      const travel = await acct(ctx, '6000');
      const rep = await createReport(ctx, {
        employeeId: emp.id,
        lines: [
          { accountId: travel.id, amount: '10.005' },
          { accountId: travel.id, amount: '10.005' },
        ],
      });
      const lines = await ctx.db.select().from(expenseReportLines).where(eq(expenseReportLines.expenseReportId, rep.id));
      const lineSum = lines.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0) / 100;
      expect(rep.total).toBe(lineSum.toFixed(2));

      await submitReport(ctx, rep.id);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2027-01-01T04:30:00.000Z')); // Dec 31, 11:30 pm in New York
      const done = await approveAndReimburse(ctx, rep.id);
      vi.useRealTimers();
      expect(done.total).toBe(rep.total);
      const [je] = await ctx.db.select().from(journalEntries).where(eq(journalEntries.id, done.postedEntryId!));
      expect(je.date.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // 6. State settings / workers comp rates
  // -------------------------------------------------------------------------
  it('state SUI/SDI settings and workers comp rates refuse values that are not numbers', async () => {
    const ctx = await newCompany('R5 Rates NaN');
    for (const bad of ['NaN', 'abc', 'Infinity', '-Infinity']) {
      for (const field of ['suiRate', 'suiWageBase', 'sdiRate', 'sdiWageBase'] as const) {
        const err = await upsertStateTaxSetting(ctx, { state: 'CA', year: 2026, [field]: bad }).catch((e) => e);
        expect(err, `${field}=${bad}`).toMatchObject({ code: 'VALIDATION' });
      }
      const wc = await createWorkersCompCode(ctx, { code: `X${bad.length}`, ratePer100: bad }).catch((e) => e);
      expect(wc, `ratePer100=${bad}`).toMatchObject({ code: 'VALIDATION' });
    }
    expect(await ctx.db.select().from(payrollStateSettings).where(eq(payrollStateSettings.companyId, ctx.companyId))).toHaveLength(0);
    expect(await ctx.db.select().from(workersCompCodes).where(eq(workersCompCodes.companyId, ctx.companyId))).toHaveLength(0);
    const ok = await createWorkersCompCode(ctx, { code: '8810', ratePer100: '0.25' });
    await expect(updateWorkersCompCode(ctx, ok.id, { ratePer100: 'NaN' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  // 7. Payroll item rename
  // -------------------------------------------------------------------------
  it('renaming a payroll item to the name of another item is refused', async () => {
    const ctx = await newCompany('R5 Item Rename');
    const liab = await acct(ctx, '2300');
    await createPayrollItem(ctx, { name: 'Dental', kind: 'deduction', liabilityAccountId: liab.id });
    const vision = await createPayrollItem(ctx, { name: 'Vision', kind: 'deduction', liabilityAccountId: liab.id });
    await expect(updatePayrollItem(ctx, vision.id, { name: ' dental ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Renaming to its own name (different case) is fine.
    expect((await updatePayrollItem(ctx, vision.id, { name: 'VISION' })).name).toBe('VISION');
  });

  // -------------------------------------------------------------------------
  // 8. Mileage rate by year
  // -------------------------------------------------------------------------
  it("the default mileage rate is the IRS business rate for the trip's year", async () => {
    const ctx = await newCompany('R5 Mileage Rate');
    expect((await logMiles(ctx, { date: d('2024-06-01'), miles: 10 })).ratePerMile).toBe('0.6700');
    expect((await logMiles(ctx, { date: d('2025-06-01'), miles: 10 })).ratePerMile).toBe('0.7000');
    const y2026 = await logMiles(ctx, { date: d('2026-06-01'), miles: 10 });
    expect(y2026.ratePerMile).toBe('0.7250');
    expect(y2026.amount).toBe('7.25');
  });

  // -------------------------------------------------------------------------
  // 9. W-2 / W-3 state boxes
  // -------------------------------------------------------------------------
  it('W-3 Box 16 equals the sum of the W-2s; a no-income-tax state shows no state wages', async () => {
    const ctx = await newCompany('R5 W3 State');
    const withheld = await createEmployee(ctx, { firstName: 'Cal', lastName: 'One', payType: 'salary', payRate: '1' });
    const exempt = await createEmployee(ctx, { firstName: 'Cal', lastName: 'Two', payType: 'salary', payRate: '1' });
    const texan = await createEmployee(ctx, { firstName: 'Tex', lastName: 'Three', payType: 'salary', payRate: '1' });
    await updateEmployee(ctx, withheld.id, { address: { state: 'CA' } });
    await updateEmployee(ctx, exempt.id, { address: { state: 'CA' }, w4: { stateW4: { exempt: true } } });
    await updateEmployee(ctx, texan.id, { address: { state: 'TX' } });
    for (const e of [withheld, exempt, texan]) {
      await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-05-01'), grossPay: '3000.00' });
    }
    const w2s = await Promise.all([withheld, exempt, texan].map((e) => w2Data(ctx, { employeeId: e.id, year: 2026 })));
    expect(Number(w2s[0].state.withheld)).toBeGreaterThan(0);
    expect(w2s[0].state.wages).toBe('3000.00');
    // California wages are reported even when nothing was withheld.
    expect(w2s[1].state.withheld).toBe('0.00');
    expect(w2s[1].state.wages).toBe('3000.00');
    // Texas has no income tax: boxes 15-17 stay empty.
    expect(w2s[2].state.wages).toBe('0.00');
    const w3 = await w3Data(ctx, { year: 2026 });
    const sum = w2s.reduce((s, w) => s + Number(w.state.wages), 0);
    expect(Number(w3.stateWages)).toBeCloseTo(sum, 2);
    expect(w3.stateWages).toBe('6000.00');
  });
});
