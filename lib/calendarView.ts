/**
 * Calendar layout for Preferences > Calendar (prefsperms A2; QB My Preferences > Calendar).
 * Pure (no DOM): the calendar page (app/calendar/page.tsx) and its tests use it.
 *
 *  - Calendar view: Day, Week or Month ('last' = the view used last time on this computer).
 *  - Weekly view: Sunday-Saturday, Monday-Sunday, Monday-Friday, or the work week from Time &
 *    Expenses ("First day of the work week"). The month grid starts on the same weekday.
 *  - Upcoming & Past Due: what is due from N days back to M days ahead, past-due items first.
 *
 * Every date is a calendar day 'YYYY-MM-DD' handled in UTC arithmetic, so the machine's time zone
 * never shifts a day; "today" comes from the company's calendar (usePreferences().today).
 */

export type CalendarViewKind = 'day' | 'week' | 'month';
export type CalendarViewPref = CalendarViewKind | 'last';
export type CalendarWeekPref = 'company' | 'sun_sat' | 'mon_sun' | 'mon_fri';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toUtc(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(iso: string): number {
  return toUtc(iso).getUTCDay();
}

/** The weekday a week (and the month grid) starts on: 0 Sunday or 1 Monday. */
export function weekStartDay(pref: CalendarWeekPref, firstDayOfWeek: 'sunday' | 'monday'): 0 | 1 {
  if (pref === 'sun_sat') return 0;
  if (pref === 'mon_sun' || pref === 'mon_fri') return 1;
  return firstDayOfWeek === 'sunday' ? 0 : 1;
}

/** The view the calendar opens in. */
export function initialCalendarView(pref: CalendarViewPref, remembered: string | null | undefined): CalendarViewKind {
  if (pref !== 'last') return pref;
  return remembered === 'day' || remembered === 'week' || remembered === 'month' ? remembered : 'month';
}

export interface CalendarLayout {
  /** The days shown, in order. */
  days: string[];
  /** Grid columns (1 for Day, 5 or 7 for Week, 7 for Month). */
  columns: number;
  /** Column headings. */
  headings: string[];
  /** First and last day to load. */
  from: string;
  to: string;
}

/** The days a view shows around `anchor`. */
export function calendarLayout(
  view: CalendarViewKind,
  anchor: string,
  pref: CalendarWeekPref,
  firstDayOfWeek: 'sunday' | 'monday',
): CalendarLayout {
  const start = weekStartDay(pref, firstDayOfWeek);
  if (view === 'day') {
    return { days: [anchor], columns: 1, headings: [WEEKDAY[weekdayOf(anchor)]], from: anchor, to: anchor };
  }
  if (view === 'week') {
    const first = addDays(anchor, -((weekdayOf(anchor) - start + 7) % 7));
    const count = pref === 'mon_fri' ? 5 : 7;
    const days = Array.from({ length: count }, (_, i) => addDays(first, i));
    return { days, columns: count, headings: days.map((d) => WEEKDAY[weekdayOf(d)]), from: days[0], to: days[days.length - 1] };
  }
  const monthFirst = `${anchor.slice(0, 7)}-01`;
  const gridFirst = addDays(monthFirst, -((weekdayOf(monthFirst) - start + 7) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridFirst, i));
  const headings = Array.from({ length: 7 }, (_, i) => WEEKDAY[(start + i) % 7]);
  return { days, columns: 7, headings, from: days[0], to: days[41] };
}

/** Previous / next period for the arrows. */
export function shiftAnchor(view: CalendarViewKind, anchor: string, dir: -1 | 1): string {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  const d = toUtc(`${anchor.slice(0, 7)}-01`);
  d.setUTCMonth(d.getUTCMonth() + dir);
  return fromUtc(d);
}

/** Heading for the period shown. */
export function periodTitle(view: CalendarViewKind, layout: CalendarLayout, anchor: string): string {
  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => toUtc(iso).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' });
  if (view === 'day') return fmt(anchor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (view === 'week') {
    return `${fmt(layout.from, { month: 'short', day: 'numeric' })} – ${fmt(layout.to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return fmt(`${anchor.slice(0, 7)}-01`, { month: 'long', year: 'numeric' });
}

/** The days the Upcoming & Past Due list covers. */
export function upcomingPastDueRange(today: string, pastDueDays: number, upcomingDays: number): { from: string; to: string } {
  return { from: addDays(today, -Math.max(0, pastDueDays)), to: addDays(today, Math.max(0, upcomingDays)) };
}

export interface DueEvent {
  type: string;
  done?: boolean;
  overdue?: boolean;
}

/**
 * Split what is due in the range into Past Due (before today, not done) and Upcoming (today
 * onward), each in date order.
 */
export function splitUpcomingPastDue<E extends DueEvent>(
  days: Array<{ date: string; events: E[] }>,
  today: string,
): { pastDue: Array<E & { date: string }>; upcoming: Array<E & { date: string }> } {
  const pastDue: Array<E & { date: string }> = [];
  const upcoming: Array<E & { date: string }> = [];
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const e of d.events) {
      if (e.type !== 'due' || e.done) continue;
      (d.date < today ? pastDue : upcoming).push({ ...e, date: d.date });
    }
  }
  return { pastDue, upcoming };
}
