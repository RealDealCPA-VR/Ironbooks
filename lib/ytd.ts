/**
 * Fiscal year-to-date window used by the dashboard KPI cards.
 *
 * `fiscalYearEnd` is the company's "MM-DD" setting (companies.settings.fiscalYearEnd).
 * The YTD window starts the day after the most recent fiscal year end strictly before
 * `now` (date-only), and runs through the end of `now`'s day. Falls back to Jan 1 of the
 * current calendar year when the setting is missing or malformed.
 *
 * "Today" is the calendar day on this computer, but the bounds are expressed in UTC: stored
 * document dates are UTC midnight of their calendar day, so local-midnight bounds would drop
 * the first day of the year (west of UTC) or today's documents (east of UTC).
 */
export function ytdRange(fiscalYearEnd: string | undefined | null, now: Date = new Date()): { from: Date; to: Date } {
  const y = now.getFullYear();
  const todayMs = Date.UTC(y, now.getMonth(), now.getDate());
  let from = new Date(Date.UTC(y, 0, 1));
  const m = /^(\d{2})-(\d{2})$/.exec(fiscalYearEnd ?? '');
  if (m) {
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      // Most recent fiscal year end strictly before today (a year ending today is still open).
      let end = new Date(Date.UTC(y, month, day));
      if (end.getTime() >= todayMs) end = new Date(Date.UTC(y - 1, month, day));
      from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
    }
  }
  // Through the last instant of today's calendar day.
  return { from, to: new Date(todayMs + 86_400_000 - 1) };
}
