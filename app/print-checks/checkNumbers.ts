/**
 * Check numbers for a print run (pure, unit-tested in lib/ui.review5.test.ts).
 */
import { stepDocNumber } from '@/lib/shortcuts';

/**
 * The numbers for `count` checks starting at `first`, stepping the number at its end and keeping
 * its prefix and zero padding ("001099" → "001100", "CHK-99" → "CHK-100"), as the + key does in
 * a check number field. Null when the run needs more than one number and `first` does not end in
 * digits. (Only a plain "1001" used to work: a padded "001001" could not be batch-printed, and a
 * single check printed from it left the next number unchanged — the next check reused it.)
 */
export function checkNumberSeries(first: string, count: number): string[] | null {
  const start = first.trim();
  if (!start) return null;
  const out = [start];
  for (let i = 1; i < count; i++) {
    const next = stepDocNumber('+', out[i - 1]);
    if (next === null || next === out[i - 1]) return null;
    out.push(next);
  }
  return out;
}

/** The number for the next check after `last` (same stepping), or null when it can't be stepped. */
export function nextCheckNumber(last: string): string | null {
  const n = stepDocNumber('+', last.trim());
  return n === null || n === last.trim() ? null : n;
}
