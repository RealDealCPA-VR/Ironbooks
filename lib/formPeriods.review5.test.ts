/**
 * Review round 5 (team uib): which period the tax forms open on.
 *
 *  - Process Payroll Forms opened the 941 on Q1 of the current year all year round (in October,
 *    with Q3 due, it offered Q1), the state wage worksheet on the quarter still in progress, and
 *    the 1099 worksheet and 1099 e-file on the current year — in January, when last year's 1099s
 *    are due, the e-file came out for the new, empty year unless the year was changed by hand.
 *    QuickBooks opens them on the last finished quarter / calendar year; so do these now.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { lastCompletedQuarter, lastCompletedYear } from './formPeriods';

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('tax form periods', () => {
  it('quarterly forms: the last finished quarter', () => {
    process.env.TZ = 'America/Chicago';
    expect(lastCompletedQuarter(new Date(2026, 9, 27))).toEqual({ year: 2026, quarter: 3 }); // Oct 27
    expect(lastCompletedQuarter(new Date(2026, 3, 1))).toEqual({ year: 2026, quarter: 1 }); // Apr 1
    expect(lastCompletedQuarter(new Date(2026, 6, 15))).toEqual({ year: 2026, quarter: 2 });
    expect(lastCompletedQuarter(new Date(2026, 0, 20))).toEqual({ year: 2025, quarter: 4 }); // January: Q4 of last year
    expect(lastCompletedQuarter(new Date(2026, 2, 31, 23, 59))).toEqual({ year: 2025, quarter: 4 });
  });

  it('annual forms (1099, W-2, 940): the last finished calendar year, by the local calendar', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(lastCompletedYear(new Date(2026, 0, 15))).toBe(2025);
    // 11 pm on New Year's Eve in Los Angeles is already January 1 in UTC; still 2025's forms.
    expect(lastCompletedYear(new Date('2027-01-01T07:00:00.000Z'))).toBe(2025);
  });

  it('the form pages open on these periods', () => {
    const read = (f: string) => fs.readFileSync(f, 'utf8');
    expect(read('app/payroll-forms/page.tsx')).toContain('useState(String(lastCompletedQuarter().quarter))');
    expect(read('app/payroll-forms/reports/page.tsx')).toContain('useState(String(lastCompletedQuarter().quarter))');
    expect(read('app/reports/1099/page.tsx')).toContain('useState(String(lastCompletedYear()))');
    expect(read('app/reports/1099-efile/page.tsx')).toContain('useState(String(lastCompletedYear()))');
  });
});
