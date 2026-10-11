/**
 * Wave-2 PREFS package — tester re-test round 2 (independent of the doer's fix commit ceb1683).
 *
 * Re-attacks the round-2 fixes from angles the doer's own tests do not cover:
 *  - system accounts stored BEFORE validation existed (written straight to the settings JSON)
 *    must still be refused at paycheck time, with nothing posted and the system account untouched;
 *  - the filter must not be over-broad: other user-created bank / liability accounts still work;
 *  - schedule math under several machine time zones (process.env.TZ switched at runtime), across
 *    a DST change, and the "due today" boundary of Run due (whole calendar day, no early entry);
 *  - twice-a-month schedules must stay twice a month.
 * Books (TB and balance sheet) must stay balanced after every scenario.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accounts, companies, expenses, paychecks, recurringTemplates } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { balanceSheet, trialBalance } from './reports';
import { getPreferences, updateCompany } from './company';
import { createAccount } from './accounts';
import { createEmployee, runPaycheck } from './payroll';
import { advanceDate, createTemplate, getTemplate, projectOccurrences, runDue, todayUtcMidnight } from './recurring';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

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

/** Simulate a value saved before validation existed: write the settings JSON directly. */
async function storeRaw(settings: Record<string, unknown>) {
  await t.db.update(companies).set({ settings }).where(eq(companies.id, t.ctx.companyId));
}
async function clearSettings() {
  await t.db.update(companies).set({ settings: {} }).where(eq(companies.id, t.ctx.companyId));
}

const paycheckInput = (employeeId: string, iso: string, gross: string, withholding = '0') =>
  ({
    employeeId,
    payDate: day(iso),
    grossPay: gross,
    taxes: withholding === '0' ? [] : [{ kind: 'tax', name: 'Federal Withholding', amount: withholding }],
    employerTaxes: [],
    deductions: [],
  }) as Parameters<typeof runPaycheck>[1];

beforeAll(async () => {
  t = await makeTestCompany('prefsqa3');
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

// ---------------------------------------------------------------------------
// System accounts stored before validation existed
// ---------------------------------------------------------------------------
describe('system accounts saved before the rule existed', () => {
  it('a stored Undeposited Funds paycheck account is refused at paycheck time; nothing posts', async () => {
    const emp = await createEmployee(t.ctx, { firstName: 'Stale', lastName: 'Bank', payType: 'salary', payRate: '52000' });
    await storeRaw({ defaultPaycheckAccountId: t.acct['1050'] });
    try {
      const before = await paycheckCount();
      const udfBefore = await balanceOf('1050');
      const wagesBefore = await balanceOf('6500');
      await expect(runPaycheck(t.ctx, paycheckInput(emp.id, '2026-03-13', '800.00'))).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('Undeposited Funds'),
      });
      expect(await paycheckCount()).toBe(before);
      expect(await balanceOf('1050')).toBe(udfBefore);
      expect(await balanceOf('6500')).toBe(wagesBefore);
    } finally {
      await clearSettings();
    }
    await books();
  });

  it('a stored Sales Tax Payable payroll liabilities account is refused; Sales Tax Payable untouched', async () => {
    const emp = await createEmployee(t.ctx, { firstName: 'Stale', lastName: 'Liab', payType: 'salary', payRate: '52000' });
    await storeRaw({ payrollLiabilityAccountId: t.acct['2200'] });
    try {
      const before = await paycheckCount();
      const stpBefore = await balanceOf('2200');
      await expect(
        runPaycheck(t.ctx, paycheckInput(emp.id, '2026-03-14', '900.00', '90.00')),
      ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('Sales Tax Payable') });
      expect(await paycheckCount()).toBe(before);
      expect(await balanceOf('2200')).toBe(stpBefore);
    } finally {
      await clearSettings();
    }
    await books();
  });

  it('the filter is not over-broad: another checking account and a second payroll liability work end to end', async () => {
    const bank = await createAccount(t.ctx, { code: '1051', name: 'Payroll Checking', type: 'asset', subtype: 'checking' });
    const liab = await createAccount(t.ctx, {
      code: '2201',
      name: 'Payroll Withholdings',
      type: 'liability',
      subtype: 'long_term_liability',
    });
    const emp = await createEmployee(t.ctx, { firstName: 'Ok', lastName: 'Accounts', payType: 'salary', payRate: '52000' });
    try {
      await updateCompany(t.ctx, {
        settings: { defaultPaycheckAccountId: bank.id, payrollLiabilityAccountId: liab.id },
      } as Parameters<typeof updateCompany>[1]);
      const prefs = await getPreferences(t.ctx);
      expect(prefs.defaultPaycheckAccountId).toBe(bank.id);
      expect(prefs.payrollLiabilityAccountId).toBe(liab.id);
      const stpBefore = await balanceOf('2200');
      const udfBefore = await balanceOf('1050');
      await runPaycheck(t.ctx, paycheckInput(emp.id, '2026-03-20', '1000.00', '125.55'));
      // Net pay out of the chosen bank, withholding into the chosen liability (normal-balance signs
      // differ by implementation, so compare magnitudes).
      expect(Money.of(await balanceOf('1051')).abs().toFixed(2)).toBe('874.45');
      expect(Money.of(await balanceOf('2201')).abs().toFixed(2)).toBe('125.55');
      expect(await balanceOf('2200')).toBe(stpBefore);
      expect(await balanceOf('1050')).toBe(udfBefore);
    } finally {
      await clearSettings();
    }
    await books();
  });
});

// ---------------------------------------------------------------------------
// Schedule math under different machine time zones
// ---------------------------------------------------------------------------
describe('memorized schedule math in any time zone', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const zones = ['America/New_York', 'America/Los_Angeles', 'Pacific/Pago_Pago', 'Pacific/Kiritimati', 'Asia/Kolkata', 'UTC'];

  it.each(zones)('monthly/quarterly/yearly/weekly advance identically in %s (incl. across DST)', (tz) => {
    process.env.TZ = tz;
    expect(iso(advanceDate(day('2026-05-01'), 'monthly'))).toBe('2026-06-01');
    expect(iso(advanceDate(day('2026-01-31'), 'monthly'))).toBe('2026-02-28');
    expect(iso(advanceDate(day('2026-11-30'), 'quarterly'))).toBe('2027-02-28');
    expect(iso(advanceDate(day('2028-02-29'), 'yearly'))).toBe('2029-02-28');
    // US DST ends 2026-11-01 and starts 2027-03-14: weekly must still be exactly 7 calendar days.
    expect(iso(advanceDate(day('2026-10-29'), 'weekly'))).toBe('2026-11-05');
    expect(iso(advanceDate(day('2027-03-10'), 'weekly'))).toBe('2027-03-17');
    expect(iso(advanceDate(day('2026-10-25'), 'biweekly'))).toBe('2026-11-08');
    expect(iso(advanceDate(day('2026-12-31'), 'daily'))).toBe('2027-01-01');
    // Results stay at UTC midnight (the stored-date convention).
    expect(advanceDate(day('2026-05-01'), 'monthly')!.getUTCHours()).toBe(0);
    const year = projectOccurrences(day('2026-01-01'), 'monthly', day('2026-01-01'), day('2026-12-31'));
    expect(year.map((d) => d.getUTCDate())).toEqual(Array(12).fill(1));
  });

  it.each(zones)('todayUtcMidnight is the local calendar day in %s', (tz) => {
    process.env.TZ = tz;
    const lateEvening = new Date(2026, 9, 10, 23, 59); // local Oct 10, 11:59 pm
    const earlyMorning = new Date(2026, 9, 10, 0, 1); // local Oct 10, 12:01 am
    expect(iso(todayUtcMidnight(lateEvening))).toBe('2026-10-10');
    expect(iso(todayUtcMidnight(earlyMorning))).toBe('2026-10-10');
  });

  it('a twice-a-month schedule starting on the 15th stays twice a month (every month, February too)', () => {
    // advanceDate('semimonthly') adds 15 days in the first half: 2026-02-15 -> 2026-03-02, then
    // 03-17, 04-01, 04-16... February gets one occurrence and the 15th/30th pair is lost for good,
    // contrary to the function's own comment ("keeps e.g. 5th/20th pairs").
    const dates = projectOccurrences(day('2026-01-15'), 'semimonthly', day('2026-01-01'), day('2026-12-31'));
    const perMonth = new Map<string, number>();
    for (const d of dates) perMonth.set(iso(d)!.slice(0, 7), (perMonth.get(iso(d)!.slice(0, 7)) ?? 0) + 1);
    for (let m = 1; m <= 12; m++) {
      const key = `2026-${String(m).padStart(2, '0')}`;
      expect({ month: key, count: perMonth.get(key) ?? 0 }).toEqual({ month: key, count: 2 });
    }
    // The first-half occurrence keeps its day.
    expect(dates.filter((d) => d.getUTCDate() <= 15).map((d) => d.getUTCDate())).toEqual(Array(12).fill(15));
  });
});

// ---------------------------------------------------------------------------
// Run due: whole-day boundary, no early entry
// ---------------------------------------------------------------------------
describe('Run due date boundary', () => {
  const tpl = (memo: string, nextIso: string, daysInAdvance = 0) => ({
    name: memo,
    docType: 'expense' as const,
    frequency: 'monthly' as const,
    nextRunDate: day(nextIso),
    mode: 'automatic' as const,
    remaining: null,
    daysInAdvance,
    template: {
      payeeName: 'Landlord',
      method: 'cash',
      memo,
      paymentAccountId: t.acct['1000'],
      lines: [{ accountId: t.acct['6400'], amount: '10.01' }],
    },
  });
  async function entered(memo: string) {
    return t.db
      .select({ date: expenses.date })
      .from(expenses)
      .where(and(eq(expenses.companyId, t.ctx.companyId), eq(expenses.memo, memo)));
  }

  it('enters what is due today, not what is due tomorrow; days-in-advance enters early but dated on schedule', async () => {
    const today = await createTemplate(t.ctx, tpl('qa3-today', '2026-09-01'));
    const tomorrow = await createTemplate(t.ctx, tpl('qa3-tomorrow', '2026-09-02'));
    const early = await createTemplate(t.ctx, tpl('qa3-early', '2026-09-02', 1));
    const cashBefore = Money.of(await balanceOf('1000'));
    const res = await runDue(t.ctx, day('2026-09-01'));
    expect(res.failed).toEqual([]);
    expect((await entered('qa3-today')).length).toBe(1);
    expect((await entered('qa3-tomorrow')).length).toBe(0);
    const [e] = await entered('qa3-early');
    expect(e).toBeDefined();
    expect(iso(new Date(e.date as unknown as string))).toBe('2026-09-02');
    expect(Money.of(await balanceOf('1000')).toFixed(2)).toBe(cashBefore.minus('20.02').toFixed(2));
    expect(iso((await getTemplate(t.ctx, today.id)).nextRunDate)).toBe('2026-10-01');
    expect(iso((await getTemplate(t.ctx, tomorrow.id)).nextRunDate)).toBe('2026-09-02');
    expect(iso((await getTemplate(t.ctx, early.id)).nextRunDate)).toBe('2026-10-02');
    // Running the same day again is a no-op (idempotent).
    const again = await runDue(t.ctx, day('2026-09-01'));
    expect(again.generated.length).toBe(0);
    expect(Money.of(await balanceOf('1000')).toFixed(2)).toBe(cashBefore.minus('20.02').toFixed(2));
    await t.db.delete(recurringTemplates).where(eq(recurringTemplates.companyId, t.ctx.companyId));
    await books();
  });
});
