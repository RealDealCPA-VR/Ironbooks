/**
 * Calendar-day helpers for report pages (PURE: client and server).
 *
 * Document dates are calendar days stored as UTC midnight; "today" is this computer's local
 * calendar day (lib/dates.ts todayISO). Compare day strings, never instants.
 */
import { localDateISO } from '@/lib/dates';

/**
 * True once a lot's expiration day has passed on this computer's calendar. Comparing the stored
 * instant with the clock flagged lots as expired the evening before (west of UTC).
 */
export function lotExpired(expiration: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!expiration) return false;
  const day = (typeof expiration === 'string' ? expiration : expiration.toISOString()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < localDateISO(now);
}
