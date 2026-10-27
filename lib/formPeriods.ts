/**
 * The period a tax form is normally prepared for, as QuickBooks Desktop offers it: quarterly
 * returns (941, state wage reports) for the last FINISHED quarter, annual ones (1099, W-2, W-3,
 * 940) for the last finished calendar year. Local calendar (the bookkeeper's), not UTC.
 */

export type Quarter = 1 | 2 | 3 | 4;

/** The last finished calendar quarter: October 2026 → Q3 2026, February 2026 → Q4 2025. */
export function lastCompletedQuarter(now: Date = new Date()): { year: number; quarter: Quarter } {
  const current = Math.floor(now.getMonth() / 3) + 1; // 1–4, the quarter in progress
  return current === 1 ? { year: now.getFullYear() - 1, quarter: 4 } : { year: now.getFullYear(), quarter: (current - 1) as Quarter };
}

/** The last finished calendar year (1099s, W-2s, 940): in 2026 → 2025. */
export function lastCompletedYear(now: Date = new Date()): number {
  return now.getFullYear() - 1;
}
