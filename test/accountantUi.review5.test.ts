/**
 * Review round 5 (team uib): Accountant Center defaults.
 *
 *  - Working Trial Balance opened on "January 1 of the UTC year" and Period Copy on "last UTC
 *    year". On a December 31 evening in the Americas (already next year in UTC) the trial balance
 *    ran from next year's January 1 to today, and Period Copy offered the current, unfinished year;
 *    early on January 1 east of UTC they ran a year too far back. They now use the local calendar.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { lastCalendarYear, thisYearStart } from '@/app/accountant/_shared';
import { todayISO } from '@/lib/dates';
import { expectAllPassed, runDomFile } from './domHarness';

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** Local wall-clock times either side of New Year (month 1–12), with the local date they are. */
const CLOCKS: Array<{ at: [number, number, number, number, number]; date: string }> = [
  { at: [2026, 12, 31, 23, 30], date: '2026-12-31' },
  { at: [2026, 12, 31, 23, 59], date: '2026-12-31' },
  { at: [2027, 1, 1, 0, 0], date: '2027-01-01' },
  { at: [2027, 1, 1, 0, 30], date: '2027-01-01' },
  { at: [2027, 1, 1, 8, 0], date: '2027-01-01' },
  { at: [2026, 10, 30, 12, 0], date: '2026-10-30' },
];
const ZONES = ['America/Los_Angeles', 'America/New_York', 'UTC', 'Asia/Tokyo', 'Pacific/Auckland'];

describe('Accountant Center date defaults follow the local calendar', () => {
  it('New Year’s Eve, 11:30 pm in Los Angeles (already January 1 in UTC)', () => {
    process.env.TZ = 'America/Los_Angeles';
    const nye = new Date('2027-01-01T07:30:00.000Z'); // Dec 31 2026, 23:30 local
    expect(thisYearStart(nye)).toBe('2026-01-01');
    expect(lastCalendarYear(nye)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('New Year’s morning, 8 am in Tokyo (still December 31 in UTC)', () => {
    process.env.TZ = 'Asia/Tokyo';
    const ny = new Date('2026-12-31T23:00:00.000Z'); // Jan 1 2027, 08:00 local
    expect(thisYearStart(ny)).toBe('2027-01-01');
    expect(lastCalendarYear(ny)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  // Every clock either side of New Year, in zones west of, on and east of UTC: the trial balance
  // range (thisYearStart → today) is this local year up to today, and Period Copy's year is the
  // one that ended the day before it began. A UTC-year version fails in Los Angeles / New York on
  // New Year's Eve and in Tokyo / Auckland on New Year's morning; the check below proves those
  // clocks really are another year in UTC.
  for (const tz of ZONES) {
    it(`the trial balance range never starts after today, and Period Copy's year is finished (${tz})`, () => {
      process.env.TZ = tz;
      let straddles = 0;
      for (const { at, date } of CLOCKS) {
        const [y, m, d, h, min] = at;
        const now = new Date(y, m - 1, d, h, min);
        const label = `${date} ${h}:${String(min).padStart(2, '0')} in ${tz}`;
        expect(todayISO(now), label).toBe(date);
        if (now.getUTCFullYear() !== now.getFullYear()) straddles++;

        const from = thisYearStart(now);
        expect(from, label).toBe(`${date.slice(0, 4)}-01-01`);
        expect(from <= date, `${label}: ${from} starts after today`).toBe(true);

        const last = lastCalendarYear(now);
        const prev = Number(date.slice(0, 4)) - 1;
        expect(last, label).toEqual({ from: `${prev}-01-01`, to: `${prev}-12-31` });
        expect(last.to < from, `${label}: the year to copy ends before this one begins`).toBe(true);
      }
      if (tz !== 'UTC') expect(straddles, `some clock is another year in UTC in ${tz}`).toBeGreaterThan(0);
    });
  }

  // The pages themselves, on the same kind of fixed clocks, in a browser window
  // (test/dom/accountantDates.dom.tsx): what they show and the requests they send.
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo']) {
    it(`Working Trial Balance and Period Copy open on these dates (${tz})`, async () => {
      process.env.TZ = tz;
      expectAllPassed(await runDomFile('test/dom/accountantDates.dom.tsx'), [
        `the window runs in ${tz}, where a UTC year boundary falls inside these clocks`,
        'Working Trial Balance: opens on January 1 of this year through today, and loads that range',
        'Period Copy: opens on last calendar year, and creates the copy for it',
      ]);
    }, 180_000);
  }
});
