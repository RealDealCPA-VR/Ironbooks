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
