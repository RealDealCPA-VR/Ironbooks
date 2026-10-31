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
import { expectAllPassed, runDomFile } from '../test/domHarness';
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

  // The pages themselves, on fixed clocks in a browser window (test/dom/formPeriods.dom.tsx):
  // October, the first hour of Q2, and either side of midnight on New Year's Eve, in a zone west
  // and a zone east of UTC (so a UTC-calendar year or quarter would show).
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo']) {
    it(`the form pages open on these periods (${tz})`, async () => {
      process.env.TZ = tz;
      expectAllPassed(await runDomFile('test/dom/formPeriods.dom.tsx'), [
        `the window runs in ${tz}, where a UTC year boundary falls inside these clocks`,
        'Process Payroll Forms: 941 on the last finished quarter; W-2, 940 and W-3 on the last finished year',
        'Payroll reports > State wage worksheet: the last finished quarter, and that is what it runs',
        '1099 Worksheets: opens on, and loads, the last finished calendar year',
        '1099 e-file: opens on, and loads, the last finished calendar year',
      ]);
    }, 180_000);
  }
});
