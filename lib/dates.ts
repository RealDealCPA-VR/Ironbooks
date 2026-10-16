/**
 * Shared date formatting for the UI. Keeps every page on the same
 * 'MMM d, yyyy' (en-US) rendering regardless of the machine locale.
 *
 * Delegates to lib/format.ts so calendar days the API sends as UTC midnight
 * ("2026-06-09T00:00:00.000Z") show as the day they name, not the day before in US time zones.
 */
import { formatDate as formatDisplayDate, toDisplayDate } from '@/lib/format';

/**
 * Instant bounds of a local calendar day picked in an <input type="date"> ("YYYY-MM-DD"), as ISO
 * strings, for filtering real timestamps (audit log, transaction log). `new Date('YYYY-MM-DD')`
 * is UTC midnight, so mixing it with local setHours() selected the wrong day west of UTC.
 * Undefined for blank / unparseable input.
 */
export function localDayStartIso(day: string | null | undefined): string | undefined {
  return localDayBound(day, 'T00:00:00.000');
}

/** End (23:59:59.999 local) of a picked calendar day, as an ISO string. See localDayStartIso. */
export function localDayEndIso(day: string | null | undefined): string | undefined {
  return localDayBound(day, 'T23:59:59.999');
}

function localDayBound(day: string | null | undefined, time: string): string | undefined {
  const s = (day ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}${time}`); // no zone suffix: parsed as local time
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Today's LOCAL calendar date as "YYYY-MM-DD" — the default for <input type="date"> fields.
 * `new Date().toISOString().slice(0, 10)` is the UTC date, so in the evening west of UTC (e.g.
 * 8pm in New York) it picked tomorrow and forms were dated a day ahead.
 */
export function todayISO(now: Date = new Date()): string {
  return localDateISO(now);
}

/** A Date's LOCAL calendar date as "YYYY-MM-DD" (e.g. a local date N days from today). */
export function localDateISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * QB default reversing date: the 1st of the month after an entry's date, as "YYYY-MM-DD".
 * Uses the date's UTC year-month (the API sends calendar days as UTC midnight), matching the
 * server's defaultReversalDate in lib/services/journal.ts. Reading it in local time made a Jul 1
 * entry default to Jul 1 west of UTC. Accepts "YYYY-MM-DD" or a full ISO string; '' if invalid.
 */
export function firstOfNextMonthISO(entryDate: string): string {
  const m = /^(\d{4})-(\d{2})/.exec((entryDate ?? '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)); // month index m[2] = next month
  return d.toISOString().slice(0, 10);
}

/** Format an ISO date/datetime string as e.g. 'Jun 9, 2026'. Returns '—' for empty input. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  // Unparseable input is shown as typed (this helper's historical behavior).
  return toDisplayDate(iso) ? formatDisplayDate(iso) : iso;
}
