/**
 * Fix round 3: twice-a-month (semimonthly) schedules keep a fixed pair of days. The second date
 * is the first + 15, clamped to the month's last day, and the schedule returns to the original
 * first-half day next month (never the clamped one).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { expenses, recurringTemplates } from '@/lib/db/schema';
import { balanceSheet, trialBalance } from './reports';
import { advanceDate, createTemplate, getTemplate, projectOccurrences, runDue, semimonthlyAnchor, updateTemplate } from './recurring';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const year = (start: string, y: number) =>
  projectOccurrences(day(start), 'semimonthly', day(`${y}-01-01`), day(`${y}-12-31`)).map((d) => iso(d)!);

function pairs(y: number, first: number, second: (last: number) => number): string[] {
  const out: string[] = [];
  for (let m = 0; m < 12; m++) {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const mm = String(m + 1).padStart(2, '0');
    out.push(`${y}-${mm}-${String(first).padStart(2, '0')}`, `${y}-${mm}-${String(second(last)).padStart(2, '0')}`);
  }
  return out;
}

describe('semimonthly schedules keep a fixed pair of days', () => {
  for (const y of [2026, 2028]) {
    it(`1st/16th all year (${y})`, () => {
      expect(year(`${y}-01-01`, y)).toEqual(pairs(y, 1, () => 16));
    });
    it(`5th/20th all year (${y})`, () => {
      expect(year(`${y}-01-05`, y)).toEqual(pairs(y, 5, () => 20));
    });
    it(`15th/30th (15th/last day in February) all year (${y})`, () => {
      expect(year(`${y}-01-15`, y)).toEqual(pairs(y, 15, (last) => Math.min(30, last)));
    });
    it(`a 31st second date (15th/last day) returns to the 15th (${y})`, () => {
      expect(iso(advanceDate(day(`${y}-01-31`), 'semimonthly'))).toBe(`${y}-02-15`);
      expect(iso(advanceDate(day(`${y}-02-15`), 'semimonthly'))).toBe(y === 2028 ? '2028-02-29' : '2026-02-28');
      expect(iso(advanceDate(day(y === 2028 ? '2028-02-29' : '2026-02-28'), 'semimonthly'))).toBe(`${y}-03-15`);
      expect(iso(advanceDate(day(`${y}-03-15`), 'semimonthly'))).toBe(`${y}-03-30`);
    });
  }

  it('15/30 in January leads to 15/28 in February and back to 15/30 in March', () => {
    expect(
      projectOccurrences(day('2026-01-15'), 'semimonthly', day('2026-01-01'), day('2026-03-31')).map(iso),
    ).toEqual(['2026-01-15', '2026-01-30', '2026-02-15', '2026-02-28', '2026-03-15', '2026-03-30']);
  });

  it('a 14th/29th pair survives February (leap and normal year) because the anchor comes from the start', () => {
    expect(year('2028-01-14', 2028)).toEqual(pairs(2028, 14, (last) => Math.min(29, last)));
    expect(year('2026-01-14', 2026)).toEqual(pairs(2026, 14, (last) => Math.min(29, last)));
  });

  it('a 13th/28th pair survives a normal-year February with a stored anchor', () => {
    expect(year('2026-01-13', 2026)).toEqual(pairs(2026, 13, () => 28));
    expect(iso(advanceDate(day('2026-02-28'), 'semimonthly', 13))).toBe('2026-03-13');
    expect(iso(advanceDate(day('2026-02-28'), 'semimonthly', 14))).toBe('2026-03-14');
    // Without an anchor, a February month-end reads as the 15th/last-day pair.
    expect(iso(advanceDate(day('2026-02-28'), 'semimonthly'))).toBe('2026-03-15');
  });

  it('derives the anchor day from a date', () => {
    expect(semimonthlyAnchor(day('2026-03-05'))).toBe(5);
    expect(semimonthlyAnchor(day('2026-03-20'))).toBe(5);
    expect(semimonthlyAnchor(day('2026-03-30'))).toBe(15);
    expect(semimonthlyAnchor(day('2026-03-31'))).toBe(15);
    expect(semimonthlyAnchor(day('2026-04-30'))).toBe(15);
    expect(semimonthlyAnchor(day('2026-02-28'))).toBe(15);
    expect(semimonthlyAnchor(day('2028-02-29'))).toBe(15);
    expect(semimonthlyAnchor(day('2028-02-28'))).toBe(13);
  });

  it('a 13th/28th pair survives a leap-year February', () => {
    expect(year('2028-01-13', 2028)).toEqual(pairs(2028, 13, () => 28));
  });
});

describe('memorized twice-a-month transactions keep their pair through Run due', () => {
  let t: TestCompany;
  beforeAll(async () => {
    t = await makeTestCompany('prefs-fix3');
  }, 120_000);
  afterAll(async () => {
    await t?.cleanup();
  });

  it('a 14th/29th rent entry runs 14/29, 14/28, 14/29 across a normal-year February', async () => {
    const memo = 'fix3-semimonthly';
    const tpl = await createTemplate(t.ctx, {
      name: memo,
      docType: 'expense',
      frequency: 'semimonthly',
      nextRunDate: day('2026-01-14'),
      mode: 'automatic',
      remaining: null,
      daysInAdvance: 0,
      template: {
        payeeName: 'Landlord',
        method: 'cash',
        memo,
        paymentAccountId: t.acct['1000'],
        lines: [{ accountId: t.acct['6400'], amount: '5.00' }],
      },
    });
    expect((await getTemplate(t.ctx, tpl.id)).anchorDay).toBe(14);
    const seen: string[] = [];
    for (const asOf of ['2026-01-14', '2026-01-29', '2026-02-14', '2026-02-28', '2026-03-14', '2026-03-29']) {
      const res = await runDue(t.ctx, day(asOf));
      expect(res.failed).toEqual([]);
      seen.push(iso((await getTemplate(t.ctx, tpl.id)).nextRunDate)!);
    }
    expect(seen).toEqual(['2026-01-29', '2026-02-14', '2026-02-28', '2026-03-14', '2026-03-29', '2026-04-14']);
    const rows = await t.db
      .select({ date: expenses.date })
      .from(expenses)
      .where(and(eq(expenses.companyId, t.ctx.companyId), eq(expenses.memo, memo)));
    expect(rows.map((r) => iso(new Date(r.date as unknown as string))).sort()).toEqual([
      '2026-01-14',
      '2026-01-29',
      '2026-02-14',
      '2026-02-28',
      '2026-03-14',
      '2026-03-29',
    ]);

    // Changing the date re-anchors the pair.
    await updateTemplate(t.ctx, tpl.id, { nextRunDate: day('2026-05-20') });
    expect((await getTemplate(t.ctx, tpl.id)).anchorDay).toBe(5);
    await t.db.delete(recurringTemplates).where(eq(recurringTemplates.companyId, t.ctx.companyId));
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
    expect((await balanceSheet(t.ctx)).balanced).toBe(true);
  }, 120_000);
});
