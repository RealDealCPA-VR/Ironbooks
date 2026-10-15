/**
 * Pure month-end helpers (lib/monthEnd.ts): the local calendar day the close compares against
 * (not UTC), the page's month-end list, and the closing-date password check on the final step.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closePasswordProblem, localDay, monthEndBefore } from './monthEnd';

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('localDay', () => {
  it('is the local calendar day, not the UTC one, west and east of UTC', () => {
    // 8 pm on Mar 30 in Los Angeles is already Mar 31 in UTC.
    process.env.TZ = 'America/Los_Angeles';
    const evening = new Date('2026-03-31T03:00:00.000Z');
    expect(evening.toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(localDay(evening)).toBe('2026-03-30');
    // 8 am on Apr 1 in Tokyo is still Mar 31 in UTC.
    process.env.TZ = 'Asia/Tokyo';
    expect(localDay(new Date('2026-03-31T23:00:00.000Z'))).toBe('2026-04-01');
  });

  it('the page month ends follow the same local month', () => {
    process.env.TZ = 'America/Los_Angeles';
    // Local Mar 31 evening (UTC Apr 1): last month is February, not March.
    const now = new Date('2026-04-01T03:00:00.000Z');
    expect(monthEndBefore(1, now)).toBe('2026-02-28');
    expect(monthEndBefore(0, now)).toBe('2026-03-31');
    expect(monthEndBefore(3, now)).toBe('2025-12-31');
  });
});

describe('closePasswordProblem', () => {
  const base = { password: '', confirm: '', hasClosingPassword: false };
  it('"Set a password" with blank fields is refused even when no password exists yet', () => {
    expect(closePasswordProblem({ ...base, mode: 'set' })).toBe('Type a password, or choose No password.');
    expect(closePasswordProblem({ ...base, mode: 'set', hasClosingPassword: true })).toMatch(/Keep the current password/);
  });
  it('mismatched confirmation is refused; a typed and confirmed password passes', () => {
    expect(closePasswordProblem({ ...base, mode: 'set', password: 'a', confirm: 'b' })).toMatch(/do not match/);
    expect(closePasswordProblem({ ...base, mode: 'set', password: 'secret', confirm: 'secret' })).toBeNull();
  });
  it('keep / no password need nothing typed', () => {
    expect(closePasswordProblem({ ...base, mode: 'remove' })).toBeNull();
    expect(closePasswordProblem({ ...base, mode: 'keep', hasClosingPassword: true })).toBeNull();
  });
});
