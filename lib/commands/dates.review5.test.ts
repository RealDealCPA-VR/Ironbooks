/**
 * Review round 5 — command bar dates (lib/commands/dates.ts). "Past N months / years" counts back
 * to the same day N months (years) earlier, clamped to the end of a shorter month — the period
 * starts the day after. Before the fix the day overflowed into the next month: on May 31 "past 3
 * months" started on Mar 4 (Feb 31 → Mar 3) and dropped Mar 1-3.
 */
import { describe, expect, it } from 'vitest';
import { parseDateRange } from './dates';

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
const r = (text: string, today: string) => parseDateRange(text, at(today))?.range;

describe('rolling months and years at a month end', () => {
  it('past N months from the 31st', () => {
    expect(r('past 3 months', '2026-05-31')).toMatchObject({ from: '2026-03-01', to: '2026-05-31' });
    expect(r('last 1 month', '2026-03-31')).toMatchObject({ from: '2026-03-01', to: '2026-03-31' });
    expect(r('past 6 months', '2026-08-31')).toMatchObject({ from: '2026-03-01', to: '2026-08-31' });
    // A leap February.
    expect(r('last 1 month', '2028-03-30')).toMatchObject({ from: '2028-03-01', to: '2028-03-30' });
    // Ordinary days are unchanged (same day N months ago, plus one).
    expect(r('past 3 months', '2026-10-15')).toMatchObject({ from: '2026-07-16', to: '2026-10-15' });
    // Across a year boundary.
    expect(r('past 2 months', '2026-01-31')).toMatchObject({ from: '2025-12-01', to: '2026-01-31' });
  });

  it('past N years from Feb 29', () => {
    expect(r('last 1 year', '2028-02-29')).toMatchObject({ from: '2027-03-01', to: '2028-02-29' });
    expect(r('past 2 years', '2026-10-15')).toMatchObject({ from: '2024-10-16', to: '2026-10-15' });
  });
});
