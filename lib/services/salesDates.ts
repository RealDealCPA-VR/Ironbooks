/**
 * "Today" for sales documents the server dates by itself (estimate conversion, the Income
 * Tracker / Collections Center / expiring-estimates "as of today").
 *
 * Document dates are calendar days stored at UTC midnight. `new Date()` is an instant: dated
 * as-is it is the UTC calendar day, which in the evening west of UTC is already tomorrow (9 pm
 * in New York is the next day in UTC) — an estimate converted then got tomorrow's date, and an
 * invoice due today showed as overdue. Today is the company's calendar day in its time zone
 * (Company preferences; the same day collection letters print, lib/services/letters.ts).
 */
import { todayInTimeZone } from '@/lib/preferences';
import type { ServiceContext } from './_base';
import { getPreferences } from './company';

/** Today's calendar day in the company's time zone, at UTC midnight (the stored-date convention). */
export async function companyToday(ctx: ServiceContext, now: Date = new Date()): Promise<Date> {
  const prefs = await getPreferences(ctx);
  return new Date(`${todayInTimeZone(prefs.timezone, now)}T00:00:00.000Z`);
}
