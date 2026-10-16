import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, parseISO, isValid } from 'date-fns';
import { isCalendarDay, toDisplayDate } from '@/lib/format';

/** Tailwind-aware className merge. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format a date (Date | ISO string) for display. Calendar days the API sends as UTC midnight
 * ("2026-06-09T00:00:00.000Z") show as the day they name (lib/format.ts), not the day before in
 * US time zones; other timestamps are real instants shown in local time.
 */
export function formatDate(date: Date | string | null | undefined, fmt = 'MM/dd/yyyy'): string {
  if (!date) return '';
  const d =
    typeof date === 'string'
      ? isCalendarDay(date)
        ? (toDisplayDate(date) ?? new Date(NaN))
        : parseISO(date)
      : date;
  return isValid(d) ? format(d, fmt) : '';
}

/** Format a number as a percentage, e.g. 0.082 -> "8.2%". */
export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Compact number formatting, e.g. 2_400_000 -> "2.4M". */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

/** Slug/code generators */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Clamp helper. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Tiny assert for invariants in the accounting engine. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invariant violation: ${message}`);
}
