/**
 * Shared display formatting helpers for pages. Currency lives in lib/money.ts;
 * this module covers dates so every list renders the same 'MMM d, yyyy' style.
 *
 * Business dates (transaction date, due date, statement date, pay date ...) are calendar days.
 * The API stores them as UTC midnight and sends them back as "YYYY-MM-DDT00:00:00.000Z" (or the
 * client has a bare "YYYY-MM-DD"). Parsing either with `new Date(...)` and showing it in local
 * time moves the day back by one in every time zone west of UTC (all of the US), so they are read
 * as the calendar day they name. Any other timestamp is a real instant (createdAt, completedAt,
 * voidedAt ...) and is shown in the viewer's local time.
 */
import { format } from 'date-fns';

/** "YYYY-MM-DD", optionally followed by a UTC-midnight time ("T00:00:00", ".000", "Z"/"+00:00"). */
const CALENDAR_DAY_RE = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/;

/** True for a calendar-day value: "YYYY-MM-DD" or that day at UTC midnight. */
export function isCalendarDay(value: string): boolean {
  return CALENDAR_DAY_RE.test(value.trim());
}

/**
 * The Date to display for an API date value: a calendar day (date-only or UTC-midnight string)
 * becomes local midnight of that same day; any other timestamp is returned as the instant it is.
 * Null for empty or unparseable input.
 */
export function toDisplayDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  let d: Date;
  if (typeof value === 'string') {
    const s = value.trim();
    const day = CALENDAR_DAY_RE.exec(s);
    d = day ? new Date(`${day[1]}T00:00:00`) : new Date(s);
  } else {
    d = value;
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format an ISO date (or full timestamp) string as e.g. "Jun 9, 2026".
 * Calendar days are shown as the day they name (no UTC off-by-one); real instants in local time.
 * Returns an em dash for null/empty/invalid input.
 */
export function formatDate(value: string | Date | null | undefined): string {
  const d = toDisplayDate(value);
  return d ? format(d, 'MMM d, yyyy') : '—';
}

/**
 * Short US date, e.g. "6/9/2026" (the `toLocaleDateString('en-US')` style used by reports),
 * with the same calendar-day handling as formatDate. Em dash for null/empty/invalid input.
 */
export function formatShortDate(value: string | Date | null | undefined): string {
  const d = toDisplayDate(value);
  return d ? format(d, 'M/d/yyyy') : '—';
}

/**
 * Locale-formatted date with custom Intl options (e.g. { month: 'short', day: 'numeric',
 * year: 'numeric' }), same calendar-day handling. Em dash for null/empty/invalid input.
 */
export function formatDateWith(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions,
  locale = 'en-US',
): string {
  const d = toDisplayDate(value);
  return d ? d.toLocaleDateString(locale, options) : '—';
}
