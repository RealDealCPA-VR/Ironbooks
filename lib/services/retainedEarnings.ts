/**
 * The company's Retained Earnings account, chosen ONE way for the year-end close and every report
 * (Balance Sheet, Trial Balance, their QuickZooms). Reports took the first "retained" account by
 * number while the close posted to an active one, 3900 first, or a legacy account numbered 3900 /
 * named "Retained Earnings" — so a legacy chart showed both the 3900 account (holding the closing
 * entries) and a computed "Retained Earnings" line, and an inactive 3000 could hold the earnings.
 *
 * Order: accounts with the Retained Earnings detail type, else legacy equity accounts numbered
 * 3900 or named "Retained Earnings" (never Opening Balance Equity); among them active first,
 * then 3900, then by number.
 */
export interface RetainedEarningsCandidate {
  code: string;
  name: string;
  subtype: string | null;
  isActive: boolean;
  /** Report section / account type: only equity accounts qualify. */
  equity: boolean;
}

export function pickRetainedEarnings<T extends RetainedEarningsCandidate>(rows: Iterable<T>): T | null {
  const equity = [...rows].filter((r) => r.equity);
  const byCode = (a: T, b: T) =>
    a.code === '3900' ? -1 : b.code === '3900' ? 1 : a.code.localeCompare(b.code, undefined, { numeric: true });
  const pick = (list: T[]) => [...list].sort((a, b) => Number(b.isActive) - Number(a.isActive) || byCode(a, b))[0] ?? null;
  const typed = equity.filter((r) => r.subtype === 'retained_earnings');
  if (typed.length) return pick(typed);
  const legacy = equity.filter(
    (r) => (r.code === '3900' || /^retained earnings$/i.test(r.name.trim())) && !/opening balance equity/i.test(r.name),
  );
  return pick(legacy);
}
