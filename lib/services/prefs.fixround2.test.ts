/**
 * Wave-2 PREFS fix round 2 regressions:
 *  - 1050 Undeposited Funds is refused for every bank preference, including the Make Deposits
 *    default (Make Deposits moves money OUT of Undeposited Funds, so it can't be the target);
 *  - 2200 Sales Tax Payable is refused as the payroll liabilities account;
 *  - the Preferences dropdowns never offer either system account;
 *  - memorized-transaction schedule math is pure UTC (no drift west of UTC).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { companies } from '@/lib/db/schema';
import { updateCompany, getPreferences } from './company';
import { accountFitsKind } from './prefAccounts';
import { advanceDate, projectOccurrences, todayUtcMidnight } from './recurring';
import { FIELD_META } from '@/lib/preferenceFields';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

async function save(settings: Record<string, unknown>) {
  return updateCompany(t.ctx, { settings } as Parameters<typeof updateCompany>[1]);
}

beforeAll(async () => {
  t = await makeTestCompany('prefsfix2');
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

describe('system accounts in preferences', () => {
  it('refuses Undeposited Funds as the Make Deposits default too, with a plain message', async () => {
    try {
      await expect(save({ defaultDepositAccountId: t.acct['1050'] })).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('Undeposited Funds holds payments waiting to be deposited'),
      });
    } finally {
      await t.db.update(companies).set({ settings: {} }).where(eq(companies.id, t.ctx.companyId));
    }
    expect((await getPreferences(t.ctx)).defaultDepositAccountId ?? null).toBeNull();
    // A real bank account is still accepted.
    await save({ defaultDepositAccountId: t.acct['1000'] });
    expect((await getPreferences(t.ctx)).defaultDepositAccountId).toBe(t.acct['1000']);
    await t.db.update(companies).set({ settings: {} }).where(eq(companies.id, t.ctx.companyId));
  });

  it('refuses Sales Tax Payable as the payroll liabilities account', async () => {
    try {
      await expect(save({ payrollLiabilityAccountId: t.acct['2200'] })).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('Sales Tax Payable'),
      });
    } finally {
      await t.db.update(companies).set({ settings: {} }).where(eq(companies.id, t.ctx.companyId));
    }
  });

  it('accountFitsKind and the Preferences dropdowns agree on the system accounts', () => {
    const uf = { id: 'a', code: '1050', name: 'Undeposited Funds', type: 'asset', subtype: 'checking' };
    const chk = { id: 'b', code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' };
    const stp = { id: 'c', code: '2200', name: 'Sales Tax Payable', type: 'liability', subtype: 'long_term_liability' };
    const pl = { id: 'd', code: '2300', name: 'Payroll Liabilities', type: 'liability', subtype: 'other_current_liability' };
    expect(accountFitsKind(uf, 'bank')).toBe(false);
    expect(accountFitsKind(chk, 'bank')).toBe(true);
    expect(accountFitsKind(stp, 'payroll_liability')).toBe(false);
    expect(accountFitsKind(pl, 'payroll_liability')).toBe(true);
    for (const key of ['defaultCheckAccountId', 'defaultBillPaymentAccountId', 'defaultDepositAccountId', 'defaultPaycheckAccountId']) {
      const f = FIELD_META[key].accounts!;
      expect(f(uf)).toBe(false);
      expect(f(chk)).toBe(true);
    }
    const liab = FIELD_META.payrollLiabilityAccountId.accounts!;
    expect(liab(stp)).toBe(false);
    expect(liab(pl)).toBe(true);
  });
});

describe('memorized schedule math is UTC (stored dates are UTC midnight)', () => {
  it('advances on calendar days regardless of the machine time zone', () => {
    expect(iso(advanceDate(day('2026-05-01'), 'monthly'))).toBe('2026-06-01');
    expect(iso(advanceDate(day('2026-01-31'), 'monthly'))).toBe('2026-02-28');
    expect(iso(advanceDate(day('2028-01-31'), 'monthly'))).toBe('2028-02-29');
    expect(iso(advanceDate(day('2026-12-01'), 'quarterly'))).toBe('2027-03-01');
    expect(iso(advanceDate(day('2026-03-01'), 'yearly'))).toBe('2027-03-01');
    expect(iso(advanceDate(day('2026-03-01'), 'daily'))).toBe('2026-03-02');
    expect(iso(advanceDate(day('2026-03-07'), 'weekly'))).toBe('2026-03-14');
    expect(iso(advanceDate(day('2026-05-01'), 'semimonthly'))).toBe('2026-05-16');
    expect(iso(advanceDate(day('2026-05-16'), 'semimonthly'))).toBe('2026-06-01');
    expect(iso(advanceDate(day('2026-05-01'), 'never'))).toBeNull();
  });

  it('a year of monthly occurrences all land on the 1st', () => {
    const dates = projectOccurrences(day('2026-01-01'), 'monthly', day('2026-01-01'), day('2026-12-31'));
    expect(dates.map(iso)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-01`),
    );
  });

  it('"today" is the local calendar date at UTC midnight', () => {
    const now = new Date(2026, 9, 10, 23, 30); // local Oct 10, 11:30 pm
    expect(iso(todayUtcMidnight(now))).toBe('2026-10-10');
    expect(todayUtcMidnight(now).getUTCHours()).toBe(0);
  });
});
