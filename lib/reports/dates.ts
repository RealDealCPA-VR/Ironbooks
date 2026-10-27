/**
 * Calendar-day helpers for report pages (PURE: client and server).
 *
 * Document dates are calendar days stored as UTC midnight; "today" is this computer's local
 * calendar day (lib/dates.ts todayISO). Compare day strings, never instants. Audit timestamps
 * (when something was voided, deleted or changed) are real instants: the audit reports filter them
 * by the company's calendar day (lib/services/preferences.ts companyDayBound) and show them on the
 * company's clock (localDateTime with the Preferences time zone).
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

/**
 * 'YYYY-MM-DD HH:MM' for a real timestamp ('' when there is none): on the clock of `timeZone`
 * (an IANA zone, e.g. the company's Preferences time zone), or this computer's without one or for
 * a zone the runtime does not know.
 */
export function localDateTime(iso: string | Date | null | undefined, timeZone?: string | null): string {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(d);
      const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    } catch {
      /* an unknown zone: this computer's clock */
    }
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${localDateISO(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const mdy = (s: string) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;

/**
 * What the Memorize dialog says about the dates a memorized report will run for. A relative Dates
 * choice (This month, Last month …) stays relative — each run covers the period current at the
 * time, as in QuickBooks — while custom dates are saved exactly as entered.
 */
export function memorizeDatesNote(params: Record<string, string | undefined>, choices: [string, string][]): string {
  const label = params.dates ? choices.find(([k]) => k === params.dates)?.[1] : undefined;
  if (params.dates) {
    return `Dates stay “${label ?? params.dates}”: each time you run it, the memorized report covers that period as of the day you run it.`;
  }
  if (params.from || params.to) {
    const range = [params.from, params.to].filter(Boolean).map((s) => mdy(s!)).join(' – ');
    return `The dates are saved exactly as entered (${range}). Choose a Dates setting such as “This month” to keep them relative.`;
  }
  if (params.asOf) return `The date is saved exactly as entered (as of ${mdy(params.asOf)}). Choose a Dates setting to keep it relative.`;
  return 'No dates are set: each run uses the report’s default dates (fiscal year to date, or today).';
}
