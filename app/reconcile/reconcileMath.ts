/**
 * Reconcile window rules (pure, unit-tested in lib/ui.review5.test.ts).
 */
import { Money } from '@/lib/money';

/**
 * The difference is 0.00 (QB: Reconcile Now needs a difference of exactly zero). The service
 * refuses anything else (lib/services/reconcile.ts: equalWithinCent of zero, i.e. < 0.005), but
 * the window used to show a one-cent difference in green with Finish enabled, and only the save
 * failed.
 */
export function differenceIsZero(difference: string | null | undefined): boolean {
  try {
    return Money.abs(difference ?? '0').lessThan('0.005');
  } catch {
    return false;
  }
}

/**
 * A line's cleared mark after a toggle request answered. The request said which state it asked
 * for, so the line takes THAT state — flipping whatever the line shows now went wrong when a
 * line was clicked again before the first answer came back (the box ended unticked while the
 * server had it cleared).
 */
export function applyClearedAnswer<L extends { journalEntryLineId: string; isCleared: boolean }>(
  lines: L[],
  lineId: string,
  isCleared: boolean,
): L[] {
  return lines.map((l) => (l.journalEntryLineId === lineId ? { ...l, isCleared } : l));
}
