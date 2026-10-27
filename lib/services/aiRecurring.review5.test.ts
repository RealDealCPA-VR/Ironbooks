/**
 * Review round 5 — "you pay this every month; memorize it?" suggests the next date on the same
 * calendar day as the document dates (which are UTC calendar days), like memorized transactions
 * advance (recurring.advanceDate). Before the fix the next date was computed in the computer's
 * local time: west of UTC a bill dated the 1st (UTC midnight = the evening before, locally) was
 * suggested for the 28th/30th of the next month, and a month-end bill rolled into the month after.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPatterns } from './aiRecurring';

const original = process.env.TZ;
beforeEach(() => {
  process.env.TZ = 'America/New_York';
});
afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

const doc = (id: string, day: string, total = '120.00') => ({
  id,
  docType: 'bill' as const,
  vendorId: 'vendor-1',
  payee: 'Landlord LLC',
  date: new Date(`${day}T00:00:00.000Z`),
  total,
});

describe('review5: recurring suggestion next date', () => {
  it('a bill on the 1st every month is next due on the 1st', () => {
    const [s] = detectPatterns(
      [doc('a', '2026-01-01'), doc('b', '2026-02-01'), doc('c', '2026-03-01'), doc('d', '2026-04-01')],
      new Date('2026-04-10T12:00:00.000Z'),
    );
    expect(s.frequency).toBe('monthly');
    expect(s.nextDate.slice(0, 10)).toBe('2026-05-01');
  });

  it('a month-end bill stays at the month end (Jan 31 → Feb 28, never Mar 3)', () => {
    const [s] = detectPatterns(
      [doc('a', '2025-10-31'), doc('b', '2025-11-30'), doc('c', '2025-12-31'), doc('d', '2026-01-31')],
      new Date('2026-02-05T12:00:00.000Z'),
    );
    expect(s.frequency).toBe('monthly');
    expect(s.nextDate.slice(0, 10)).toBe('2026-02-28');
  });
});
