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

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

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

  it('the trial balance range never starts after today', () => {
    process.env.TZ = 'America/New_York';
    expect(thisYearStart() <= todayISO()).toBe(true);
  });

  it('the pages use these helpers', async () => {
    const fs = await import('node:fs');
    for (const f of ['app/accountant/working-trial-balance/page.tsx', 'app/accountant/period-copy/page.tsx']) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toContain('getUTCFullYear');
    }
  });
});
