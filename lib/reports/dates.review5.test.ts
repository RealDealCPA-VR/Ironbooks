/**
 * Review round 5 — lot expiration on the Inventory by Site page.
 *
 * Expiration dates are calendar days stored as UTC midnight. Comparing that instant with the
 * clock (`new Date(exp) < new Date()`) flagged a lot as expired from 8 pm the evening BEFORE its
 * expiration day in New York (and all of its last day). A lot is expired once its day has passed
 * on this computer's calendar.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { lotExpired } from './dates';

const origTz = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (origTz === undefined) delete process.env.TZ;
  else process.env.TZ = origTz;
});

describe('lotExpired', () => {
  it('is not expired the evening before, nor on its expiration day; expired the day after', () => {
    const exp = '2026-10-27T00:00:00.000Z';
    expect(lotExpired(exp, new Date('2026-10-27T00:30:00.000Z'))).toBe(false); // Oct 26, 8:30 pm EDT
    expect(lotExpired(exp, new Date('2026-10-27T20:00:00.000Z'))).toBe(false); // on Oct 27
    expect(lotExpired(exp, new Date('2026-10-28T14:00:00.000Z'))).toBe(true); // Oct 28
    expect(lotExpired(null, new Date())).toBe(false);
  });
});

/**
 * Voided/Deleted Transactions and the Closing Date Exception Report filter and show WHEN a change
 * was made (a real timestamp). The pages used UTC-day bounds and printed the UTC clock, so a
 * transaction voided at 9 pm on Oct 26 in California showed as "2026-10-27 04:00" and fell
 * outside a report run for Oct 26. The pages now pass the typed days to the report service, which
 * reads them in the company's time zone, and show each change on that zone's clock.
 */
describe('audit timestamps on report pages', () => {
  it('a picked day covers that calendar day in the company time zone', async () => {
    const { zonedDayBound } = await import('@/lib/preferences');
    expect(zonedDayBound('2026-10-26', 'America/Los_Angeles')?.toISOString()).toBe('2026-10-26T07:00:00.000Z');
    expect(zonedDayBound('2026-10-26', 'America/Los_Angeles', true)?.toISOString()).toBe('2026-10-27T06:59:59.999Z');
    expect(zonedDayBound('nope', 'America/Los_Angeles')).toBeUndefined();
  });

  it('shows the change on the company clock when the page passes its time zone', async () => {
    const { localDateTime } = await import('./dates');
    expect(localDateTime('2026-10-27T04:05:00.000Z', 'America/Los_Angeles')).toBe('2026-10-26 21:05');
    expect(localDateTime('2026-10-27T04:05:00.000Z', 'America/New_York')).toBe('2026-10-27 00:05');
    expect(localDateTime(null, 'America/New_York')).toBe('');
  });

  it('shows the local date and time of the change', async () => {
    const { localDateTime } = await import('./dates');
    const prev = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(localDateTime('2026-10-27T04:05:00.000Z')).toBe('2026-10-26 21:05');
      expect(localDateTime('')).toBe('');
    } finally {
      process.env.TZ = prev;
    }
  });
});

/**
 * The Memorize dialog said "Relative dates are saved as the exact dates shown", but a memorized
 * report keeps a relative Dates choice (This month, Last month …) relative — as QuickBooks does —
 * and only custom dates are fixed. The note now says what will happen for the report on screen.
 */
describe('memorizeDatesNote', () => {
  it('relative, custom and default dates are each described as they will run', async () => {
    const { memorizeDatesNote } = await import('./dates');
    const choices: [string, string][] = [['this_month', 'This month'], ['last_month', 'Last month']];
    expect(memorizeDatesNote({ dates: 'last_month' }, choices)).toMatch(/Last month.*each time/i);
    expect(memorizeDatesNote({ dates: 'last_month' }, choices)).not.toMatch(/exact dates/i);
    expect(memorizeDatesNote({ from: '2026-01-01', to: '2026-03-31' }, choices)).toMatch(/01\/01\/2026 – 03\/31\/2026/);
    expect(memorizeDatesNote({ asOf: '2026-03-31' }, choices)).toMatch(/03\/31\/2026/);
    expect(memorizeDatesNote({}, choices)).toMatch(/default/i);
  });
});
