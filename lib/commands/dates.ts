/**
 * Plain-English dates for the command bar: "Q3", "Q1 2025", "last month", "this year", "YTD",
 * "in September", "last 30 days", "since March", "from 2026-01-01 to 2026-03-31", "yesterday",
 * "on 10/3". PURE — `today` is always passed in, so results are deterministic and testable.
 *
 * Every date is a 'YYYY-MM-DD' calendar day (UTC, like the rest of the app). Quarters and years
 * are calendar quarters/years. A quarter or month named without a year means the most recent
 * one that has started (in October, "Q4" is this year's; in May, "Q4" is last year's).
 */

export interface DateRange {
  from: string;
  to: string;
  /** Human label, e.g. "Q3 2026", "last month (Sep 2026)". */
  label: string;
}

export interface RangeMatch {
  range: DateRange;
  /** The exact text that expressed the range (so callers can cut it out). */
  matched: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const PREP = String.raw`(?:(?:in|for|during|over|from|of|within)\s+(?:the\s+)?)?`;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
export function ymd(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m, d));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function lastDay(y: number, m: number): string {
  return ymd(y, m + 1, 0);
}
function todayParts(today: Date) {
  return { y: today.getUTCFullYear(), m: today.getUTCMonth(), d: today.getUTCDate() };
}
export function todayStr(today: Date): string {
  const t = todayParts(today);
  return ymd(t.y, t.m, t.d);
}
function monthIndex(name: string): number {
  const n = name.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(n));
}
function fullYear(y: string | undefined, fallback: number): number {
  if (!y) return fallback;
  const s = y.replace(/^'/, '');
  return s.length === 2 ? 2000 + Number(s) : Number(s);
}
function addDays(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number);
  return ymd(y, m - 1, d + n);
}
function validYmd(y: number, m: number, d: number): boolean {
  if (m < 0 || m > 11 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCMonth() === m && dt.getUTCDate() === d;
}

function quarterRange(q: number, y: number): DateRange {
  const m0 = (q - 1) * 3;
  return { from: ymd(y, m0, 1), to: lastDay(y, m0 + 2), label: `Q${q} ${y}` };
}
function monthRange(m: number, y: number, label?: string): DateRange {
  return { from: ymd(y, m, 1), to: lastDay(y, m), label: label ?? `${MONTH_SHORT[m]} ${y}` };
}

/**
 * Parse one explicit calendar date: "2026-10-03", "10/3", "10/3/2026", "Oct 3", "October 3rd
 * 2026", "3 Oct". Month/day order is US (M/D). Null when it is not a real date.
 */
export function parseExplicitDate(s: string, today: Date): string | null {
  const t = s.trim().toLowerCase().replace(/,/g, '');
  const { y: ty } = todayParts(today);
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t))) {
    const [mo, d, y] = [Number(m[1]) - 1, Number(m[2]), fullYear(m[3], ty)];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  if ((m = new RegExp(`^${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?$`).exec(t))) {
    const [mo, d, y] = [monthIndex(m[1]), Number(m[2]), fullYear(m[3], ty)];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  if ((m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?(?:\\s+(\\d{4}))?$`).exec(t))) {
    const [mo, d, y] = [monthIndex(m[2]), Number(m[1]), fullYear(m[3], ty)];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  return null;
}

const MONTH_NC = MONTH_RE.replace(/^\(/, '(?:');
const EXPLICIT_DATE = String.raw`(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}(?:/(?:\d{4}|\d{2}))?|${MONTH_NC}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)`;

/** Find a single transaction date in free text ("today", "yesterday", "on 10/3", "dated Oct 3"). */
export function parseSingleDate(text: string, today: Date): { date: string; matched: string } | null {
  let m: RegExpExecArray | null;
  if ((m = /\b(?:dated\s+|on\s+)?(today|yesterday)\b/i.exec(text))) {
    const t = todayStr(today);
    return { date: m[1].toLowerCase() === 'today' ? t : addDays(t, -1), matched: m[0] };
  }
  if ((m = new RegExp(String.raw`\b(?:dated|on)\s+(${EXPLICIT_DATE})(?![\d/])`, 'i').exec(text))) {
    const d = parseExplicitDate(m[1], today);
    if (d) return { date: d, matched: m[0] };
  }
  return null;
}

/**
 * Find a date RANGE in free text. Tries the most specific phrasings first. Returns null when
 * the text has no recognizable period.
 */
export function parseDateRange(text: string, today: Date): RangeMatch | null {
  const t = todayParts(today);
  const now = todayStr(today);
  const curQ = Math.floor(t.m / 3) + 1;
  let m: RegExpExecArray | null;
  const re = (src: string) => new RegExp(src, 'i');

  // Explicit "from X to Y" / "between X and Y".
  if ((m = re(String.raw`\b(?:from|between)\s+(${EXPLICIT_DATE})\s+(?:to|and|through|thru|-)\s+(${EXPLICIT_DATE})(?![\d/])`).exec(text))) {
    const a = parseExplicitDate(m[1], today);
    const b = parseExplicitDate(m[2], today);
    if (a && b && a <= b) return { range: { from: a, to: b, label: `${a} to ${b}` }, matched: m[0] };
  }

  // Year to date / quarter to date / month to date.
  if ((m = re(String.raw`\b(?:(?:for|in)\s+(?:the\s+)?)?(?:ytd|year[\s-]to[\s-]date|so far this year)\b`).exec(text))) {
    return { range: { from: ymd(t.y, 0, 1), to: now, label: `year to date (${t.y})` }, matched: m[0] };
  }
  if ((m = re(String.raw`\b(?:(?:for|in)\s+(?:the\s+)?)?(?:qtd|quarter[\s-]to[\s-]date)\b`).exec(text))) {
    return { range: { from: ymd(t.y, (curQ - 1) * 3, 1), to: now, label: `quarter to date (Q${curQ} ${t.y})` }, matched: m[0] };
  }
  if ((m = re(String.raw`\b(?:(?:for|in)\s+(?:the\s+)?)?(?:mtd|month[\s-]to[\s-]date)\b`).exec(text))) {
    return { range: { from: ymd(t.y, t.m, 1), to: now, label: `month to date (${MONTH_SHORT[t.m]} ${t.y})` }, matched: m[0] };
  }

  // Q1..Q4 [year] / first..fourth quarter [of year].
  if ((m = re(String.raw`\b${PREP}q([1-4])(?:\s*(?:of\s+|,\s*)?(\d{4}|'\d{2}))?\b`).exec(text))) {
    const q = Number(m[1]);
    const y = m[2] ? fullYear(m[2], t.y) : q > curQ ? t.y - 1 : t.y;
    return { range: quarterRange(q, y), matched: m[0] };
  }
  if ((m = re(String.raw`\b${PREP}(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter(?:\s+(?:of\s+)?(\d{4}))?\b`).exec(text))) {
    const q = ({ first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 } as Record<string, number>)[m[1].toLowerCase()];
    const y = m[2] ? Number(m[2]) : q > curQ ? t.y - 1 : t.y;
    return { range: quarterRange(q, y), matched: m[0] };
  }
  if ((m = re(String.raw`\b${PREP}(last|previous|prior|this|current)\s+quarter\b`).exec(text))) {
    const last = !/this|current/i.test(m[1]);
    const q = last ? (curQ === 1 ? 4 : curQ - 1) : curQ;
    const y = last && curQ === 1 ? t.y - 1 : t.y;
    const r = quarterRange(q, y);
    return { range: { ...r, label: `${last ? 'last' : 'this'} quarter (${r.label})` }, matched: m[0] };
  }

  // Months.
  if ((m = re(String.raw`\b${PREP}(last|previous|prior|this|current)\s+month\b`).exec(text))) {
    const last = !/this|current/i.test(m[1]);
    const mo = last ? (t.m + 11) % 12 : t.m;
    const y = last && t.m === 0 ? t.y - 1 : t.y;
    const r = monthRange(mo, y);
    return { range: { ...r, label: `${last ? 'last' : 'this'} month (${r.label})` }, matched: m[0] };
  }

  // Years.
  if ((m = re(String.raw`\b${PREP}(last|previous|prior|this|current)\s+(?:calendar\s+|fiscal\s+)?year\b`).exec(text))) {
    const last = !/this|current/i.test(m[1]);
    const y = last ? t.y - 1 : t.y;
    return { range: { from: ymd(y, 0, 1), to: ymd(y, 11, 31), label: `${last ? 'last' : 'this'} year (${y})` }, matched: m[0] };
  }

  // Weeks (Monday-based).
  if ((m = re(String.raw`\b${PREP}(last|previous|prior|this|current)\s+week\b`).exec(text))) {
    const last = !/this|current/i.test(m[1]);
    const dow = (new Date(Date.UTC(t.y, t.m, t.d)).getUTCDay() + 6) % 7;
    const monday = addDays(now, -dow - (last ? 7 : 0));
    return { range: { from: monday, to: addDays(monday, 6), label: `${last ? 'last' : 'this'} week` }, matched: m[0] };
  }

  // Rolling "last 30 days" / "past 3 months" / "last 2 weeks".
  if ((m = re(String.raw`\b(?:(?:in|for|over|during)\s+)?(?:the\s+)?(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month|year)s?\b`).exec(text))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    let from: string;
    if (unit === 'day') from = addDays(now, -(n - 1));
    else if (unit === 'week') from = addDays(now, -(n * 7 - 1));
    else if (unit === 'month') from = addDays(ymd(t.y, t.m - n, t.d), 1);
    else from = addDays(ymd(t.y - n, t.m, t.d), 1);
    return { range: { from, to: now, label: `last ${n} ${unit}${n === 1 ? '' : 's'}` }, matched: m[0] };
  }

  // "since March" / "since 2026-03-01".
  if ((m = re(String.raw`\bsince\s+(${EXPLICIT_DATE}|${MONTH_NC}(?:\s+\d{4})?)(?![\d/])`).exec(text))) {
    let from = parseExplicitDate(m[1], today);
    if (!from) {
      const [mon, yr] = m[1].trim().split(/\s+/);
      const mo = monthIndex(mon);
      const y = yr ? Number(yr) : mo > t.m ? t.y - 1 : t.y;
      from = ymd(y, mo, 1);
    }
    if (from <= now) return { range: { from, to: now, label: `since ${from}` }, matched: m[0] };
  }

  // "in September" / "for Sep 2025" / "September 2025".
  if ((m = re(String.raw`\b(?:(?:in|for|during|of)\s+)?${MONTH_RE}\.?(?:\s+(\d{4}))?\b(?!\s*\d{1,2}\b)`).exec(text))) {
    // Guard against "may" used as a verb ("we may…") — only accept it with a preposition or year.
    const isMayVerb = /^may$/i.test(m[0].trim());
    if (!isMayVerb) {
      const mo = monthIndex(m[1]);
      const y = m[2] ? Number(m[2]) : mo > t.m ? t.y - 1 : t.y;
      return { range: monthRange(mo, y), matched: m[0] };
    }
  }

  // "in 2025" / bare year.
  if ((m = re(String.raw`\b(?:(?:in|for|during)\s+)?((?:19|20)\d{2})\b`).exec(text))) {
    const y = Number(m[1]);
    return { range: { from: ymd(y, 0, 1), to: ymd(y, 11, 31), label: String(y) }, matched: m[0] };
  }

  if ((m = re(String.raw`\b(?:for\s+|on\s+)?(today|yesterday)\b`).exec(text))) {
    const d = m[1].toLowerCase() === 'today' ? now : addDays(now, -1);
    return { range: { from: d, to: d, label: m[1].toLowerCase() }, matched: m[0] };
  }

  return null;
}

/** Calendar year to date — the default period for a question that names none. */
export function yearToDate(today: Date): DateRange {
  const t = todayParts(today);
  return { from: ymd(t.y, 0, 1), to: todayStr(today), label: `year to date (${t.y})` };
}
