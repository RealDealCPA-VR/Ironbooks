/**
 * The date window "Why did this change?" uses for a report total (ux/undo).
 *
 * It must be the window the report actually ran with, so the number explained is the number on
 * screen: the `range` the server resolved for the last completed run (relative "Dates" presets
 * such as Last month, and defaults, already applied), never the live, unapplied filter form.
 */
import type { StdReport } from './types';
import type { PermissionSet } from '@/lib/permissions/model';
import { todayISO } from '@/lib/dates';

export interface ReportWindow {
  from: string | null;
  to: string;
  /** Period report with no start date: the server falls back to the fiscal year to date. */
  fiscalYearToDate: boolean;
}

/** Reports whose totals are a period (from..to); the rest are point-in-time (as of). */
const PERIOD_REPORTS = new Set(['profit-loss']);

export function reportWhyChangedWindow(
  reportKey: string,
  runParams: Record<string, string | undefined>,
  range?: StdReport['range'],
  today: string = todayISO(),
): ReportWindow {
  const isRange = PERIOD_REPORTS.has(reportKey);
  if (range) {
    return isRange
      ? { from: range.from, to: range.to, fiscalYearToDate: false }
      : { from: null, to: range.asOf, fiscalYearToDate: false };
  }
  // Older server without `range`: best effort from the run's explicit dates.
  const from = isRange ? runParams.from || null : null;
  const to = isRange ? runParams.to || today : runParams.asOf || runParams.to || today;
  return { from, to, fiscalYearToDate: isRange && !from };
}

/** The permission GET /api/why-changed requires (lib/permissions/routes.ts). */
export const WHY_CHANGED_AREA = 'reports_financial' as const;

/**
 * Whether to show "Why did this change?" buttons to a user (cosmetic; the route enforces it).
 * Unknown permissions (not loaded / single-user file) → shown, the server decides.
 */
export function canExplainChanges(permissions: PermissionSet | null | undefined): boolean {
  if (!permissions) return true;
  return permissions[WHY_CHANGED_AREA]?.includes('view') ?? false;
}
