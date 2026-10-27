/**
 * Plain-English dates for the command bar: "Q3", "Q1 2025", "last month", "this year", "YTD",
 * "in September", "last 30 days", "since March", "from 2026-01-01 to 2026-03-31", "yesterday",
 * "on 10/3". PURE — `today` is always passed in, so results are deterministic and testable.
 *
 * Every date is a 'YYYY-MM-DD' calendar day (UTC, like the rest of the app). Quarters, "this /
 * last year", YTD and QTD follow the company's fiscal year when `fiscalStartMonth` is given
 * (calendar quarters/years otherwise). A quarter or month named without a year means the most
 * recent one that has started (in October, "Q4" is this year's; in May, "Q4" is last year's).
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
/**
 * Day `d` of month `m` (0-based, may be out of 0-11: the year rolls) clamped to that month's last
 * day: Feb 31 is Feb 28/29, never Mar 3.
 */
function sameDayClamped(y: number, m: number, d: number): string {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return ymd(y, m, Math.min(d, last));
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
 * A typed period that cannot be used as-is: a date that is not on the calendar ("2026-02-30",
 * "2/30", "Feb 30") or a "from X to Y" whose start is after its end. Returns a plain-language
 * message, or null when every date in the text is fine. Callers report it instead of silently
 * answering for some other period.
 */
export function findDateProblem(text: string, today: Date): string | null {
  let m: RegExpExecArray | null;
  const range = new RegExp(String.raw`\b(?:from|between)\s+(${EXPLICIT_DATE})\s+(?:to|and|through|thru|-)\s+(${EXPLICIT_DATE})(?![\d/])`, 'i').exec(text);
  if (range) {
    const a = parseExplicitDate(range[1], today);
    const b = parseExplicitDate(range[2], today);
    if (a && b && a > b) return `The start date (${a}) is after the end date (${b}). Swap them and try again.`;
  }
  const numeric = new RegExp(String.raw`(?<![\w/-])(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}(?:/(?:\d{4}|\d{2}))?)(?![\w/-])`, 'gi');
  while ((m = numeric.exec(text))) {
    if (!parseExplicitDate(m[1], today)) return `“${m[1]}” isn't a real date. Check the month and day.`;
  }
  // "Feb 30" / "February 30th 2026" ("July 2026" is a month and a year, not a day).
  const named = new RegExp(String.raw`\b(${MONTH_NC}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)(?!\d)`, 'gi');
  while ((m = named.exec(text))) {
    if (!parseExplicitDate(m[1], today)) return `“${m[1]}” isn't a real date. Check the month and day.`;
  }
  return null;
}

/** Options for {@link parseDateRange}. */
export interface DateRangeOptions {
  /**
   * First month of the company's fiscal year, 0-11 (0 = January = calendar year). Quarters,
   * "this/last year", YTD and QTD follow it. Fiscal years are named by the year they end in.
   */
  fiscalStartMonth?: number;
}

/**
 * The fiscal-year start month (0-11) from a company's `fiscalYearEnd` setting ('MM-DD'). A year
 * that ends on (or near) a month end starts on the 1st of the next month; any other end day
 * cannot be split into calendar-month quarters, so calendar quarters are used (0).
 */
export function fiscalStartMonthFromYearEnd(fiscalYearEnd: string | null | undefined): number {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(fiscalYearEnd ?? '');
  if (!m) return 0;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 28) return 0;
  return month % 12;
}

/** The fiscal year containing `today`: its first month's year and its name (the year it ends in). */
function fiscalYearOf(t: { y: number; m: number }, fs: number): { startY: number; name: number } {
  const startY = t.m >= fs ? t.y : t.y - 1;
  return { startY, name: fs === 0 ? startY : startY + 1 };
}

/**
 * Find a date RANGE in free text. Tries the most specific phrasings first. Returns null when
 * the text has no recognizable period.
 */
export function parseDateRange(text: string, today: Date, opts: DateRangeOptions = {}): RangeMatch | null {
  const t = todayParts(today);
  const now = todayStr(today);
  const fs = opts.fiscalStartMonth && opts.fiscalStartMonth >= 1 && opts.fiscalStartMonth <= 11 ? Math.floor(opts.fiscalStartMonth) : 0;
  const fiscal = fs !== 0;
  const fy = fiscalYearOf(t, fs);
  const curQ = Math.floor(((t.m - fs + 12) % 12) / 3) + 1;
  /** Quarter q of the fiscal year whose first month falls in startY. */
  const quarter = (q: number, startY: number): DateRange => {
    const m0 = fs + (q - 1) * 3;
    const from = ymd(startY, m0, 1);
    const to = lastDay(startY, m0 + 2);
    if (!fiscal) return quarterRange(q, startY);
    return { from, to, label: `fiscal Q${q} FY${startY + 1} (${from} to ${to})` };
  };
  /** Fiscal year named `name` → its first month's year. */
  const startYearOfNamed = (name: number) => (fiscal ? name - 1 : name);
  const fyLabel = (startY: number) => (fiscal ? `fiscal year FY${startY + 1}` : String(startY));
  let m: RegExpExecArray | null;
  const re = (src: string) => new RegExp(src, 'i');

  // Explicit "from X to Y" / "between X and Y". An inverted range is returned as typed (the
  // caller reports "the start date is after the end date") — never swapped for another period.
  if ((m = re(String.raw`\b(?:from|between)\s+(${EXPLICIT_DATE})\s+(?:to|and|through|thru|-)\s+(${EXPLICIT_DATE})(?![\d/])`).exec(text))) {
    const a = parseExplicitDate(m[1], today);
    const b = parseExplicitDate(m[2], today);
    if (a && b) return { range: { from: a, to: b, label: `${a} to ${b}` }, matched: m[0] };
  }

  // Year to date / quarter to date / month to date (year and quarter follow the fiscal year).
  if ((m = re(String.raw`\b(?:(?:for|in)\s+(?:the\s+)?)?(?:ytd|year[\s-]to[\s-]date|so far this year)\b`).exec(text))) {
    return { range: { from: ymd(fy.startY, fs, 1), to: now, label: `year to date (${fyLabel(fy.startY)})` }, matched: m[0] };
  }
  if ((m = re(String.raw`\b(?:(?:for|in)\s+(?:the\s+)?)?(?:qtd|quarter[\s-]to[\s-]date)\b`).exec(text))) {
    const r = quarter(curQ, fy.startY);
    return { range: { from: r.from, to: now, label: `quarter to date (${fiscal ? `fiscal Q${curQ} FY${fy.name}` : `Q${curQ} ${t.y}`})` }, matched: m[0] };
  }
  if ((m = re(String.raw`\b(?:(?:for|in)\s+(?:the\s+)?)?(?:mtd|month[\s-]to[\s-]date)\b`).exec(text))) {
    return { range: { from: ymd(t.y, t.m, 1), to: now, label: `month to date (${MONTH_SHORT[t.m]} ${t.y})` }, matched: m[0] };
  }

  // Q1..Q4 [year] / first..fourth quarter [of year]. A year names the fiscal year (the year it ends in).
  if ((m = re(String.raw`\b${PREP}q([1-4])(?:\s*(?:of\s+|,\s*)?(\d{4}|'\d{2}))?\b`).exec(text))) {
    const q = Number(m[1]);
    const y = m[2] ? startYearOfNamed(fullYear(m[2], t.y)) : q > curQ ? fy.startY - 1 : fy.startY;
    return { range: quarter(q, y), matched: m[0] };
  }
  if ((m = re(String.raw`\b${PREP}(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter(?:\s+(?:of\s+)?(\d{4}))?\b`).exec(text))) {
    const q = ({ first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 } as Record<string, number>)[m[1].toLowerCase()];
    const y = m[2] ? startYearOfNamed(Number(m[2])) : q > curQ ? fy.startY - 1 : fy.startY;
    return { range: quarter(q, y), matched: m[0] };
  }
  if ((m = re(String.raw`\b${PREP}(last|previous|prior|this|current)\s+quarter\b`).exec(text))) {
    const last = !/this|current/i.test(m[1]);
    const q = last ? (curQ === 1 ? 4 : curQ - 1) : curQ;
    const y = last && curQ === 1 ? fy.startY - 1 : fy.startY;
    const r = quarter(q, y);
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

  // Years: the fiscal year, unless "calendar year" is said.
  if ((m = re(String.raw`\b${PREP}(last|previous|prior|this|current)\s+(calendar\s+|fiscal\s+)?year\b`).exec(text))) {
    const last = !/this|current/i.test(m[1]);
    if (fiscal && !/calendar/i.test(m[2] ?? '')) {
      const y = last ? fy.startY - 1 : fy.startY;
      return { range: { from: ymd(y, fs, 1), to: lastDay(y + 1, fs - 1), label: `${last ? 'last' : 'this'} ${fyLabel(y)}` }, matched: m[0] };
    }
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
    else if (unit === 'month') from = addDays(sameDayClamped(t.y, t.m - n, t.d), 1);
    else from = addDays(sameDayClamped(t.y - n, t.m, t.d), 1);
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
  if ((m = re(String.raw`\b(?:(?:in|for|during)\s+)?((?:19|20)\d{2})\b(?![-/]\d)`).exec(text))) {
    const y = Number(m[1]);
    return { range: { from: ymd(y, 0, 1), to: ymd(y, 11, 31), label: String(y) }, matched: m[0] };
  }

  if ((m = re(String.raw`\b(?:for\s+|on\s+)?(today|yesterday)\b`).exec(text))) {
    const d = m[1].toLowerCase() === 'today' ? now : addDays(now, -1);
    return { range: { from: d, to: d, label: m[1].toLowerCase() }, matched: m[0] };
  }

  return null;
}

/** Year to date (the fiscal year when one is given) — the default period for a question that names none. */
export function yearToDate(today: Date, opts: DateRangeOptions = {}): DateRange {
  return parseDateRange('ytd', today, opts)!.range;
}
