/**
 * Bank and credit card statement text → transaction rows, plus the statement's own opening and
 * closing balances so the extraction can be TIED OUT before anything is imported.
 *
 * Pure (no I/O): lib/services/statementImport.ts gets the text from a PDF's text layer or from
 * OCR of a scan and hands it here, one entry per visual line (with x positions when the PDF had
 * them). Sign convention matches every other import: positive = money INTO the account (a deposit,
 * a card payment or credit), negative = money OUT (a check, a withdrawal, a card purchase).
 *
 * How the sign of each row is decided, most reliable first:
 *   1. an explicit marker on the amount: "-", "(1.00)", "CR" / "DR";
 *   2. the running balance column: the change from the previous row's balance (or the opening
 *      balance) — when it equals the amount, it settles the sign;
 *   3. the column the amount sits in (Withdrawals / Deposits headers, by x position);
 *   4. the section the row is in ("Deposits and Additions", "Checks Paid", "Purchases"…);
 *   5. words in the description (DEPOSIT, PAYMENT THANK YOU, INTEREST PAID…) — flagged as a guess.
 * The tie-out then checks the whole: opening + rows = closing (bank), or for a card (whose balance
 * is what you owe) opening − rows = closing. A statement that does not tie is never imported
 * silently; the review screen shows the difference.
 */

export interface StatementLine {
  text: string;
  /** Text pieces with their x position, when the source had positions (PDF text layer). */
  cells?: Array<{ x: number; str: string }>;
}

export type StatementKind = 'bank' | 'card';

export interface StatementRow {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  /** Signed decimal string, 2 places: + into the account, − out of it. */
  amount: string;
  /** Running balance printed on the line, when there was one. */
  balance?: string;
  checkNumber?: string;
  /** How the sign was decided (the review screen highlights 'guess' and rows the AI read). */
  signFrom: 'marker' | 'balance' | 'column' | 'section' | 'guess' | 'ai';
  /** Index of the statement line it came from. */
  line: number;
}

export interface StatementParse {
  kind: StatementKind;
  rows: StatementRow[];
  openingBalance: string | null;
  closingBalance: string | null;
  period: { start: string; end: string } | null;
  warnings: string[];
}

export interface TieOut {
  /** What the statement says the account changed by (closing − opening; for a card, opening − closing). */
  expected: string | null;
  /** Sum of the extracted rows. */
  extracted: string;
  /** expected − extracted (0.00 when it ties). */
  difference: string | null;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Money (cents as integers — no floats anywhere)
// ---------------------------------------------------------------------------

/** "1,234.56", "$1,234.56", "(12.00)", "-12.00", "12.00-", "12.00 CR" → signed cents; null if not money. */
export function parseMoney(token: string): { cents: number; marker: boolean } | null {
  let t = token.trim();
  let neg = false;
  let marker = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    marker = true;
    t = t.slice(1, -1).trim();
  }
  const suffix = /\s*(CR|DR|-)$/i.exec(t);
  if (suffix) {
    marker = true;
    const s = suffix[1].toUpperCase();
    if (s === 'DR' || s === '-') neg = !neg;
    t = t.slice(0, suffix.index).trim();
  }
  if (t.startsWith('-')) {
    neg = !neg;
    marker = true;
    t = t.slice(1).trim();
  } else if (t.startsWith('+')) {
    marker = true;
    t = t.slice(1).trim();
  }
  t = t.replace(/^\$\s*/, '');
  if (!/^\d{1,3}(,\d{3})*\.\d{2}$|^\d+\.\d{2}$/.test(t)) return null;
  const [whole, frac] = t.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents)) return null;
  return { cents: neg ? -cents : cents, marker };
}

export function centsToString(c: number): string {
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

const MONEY_SRC = String.raw`\(?[-+]?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:CR|DR)\b|-(?=\s|$))?`;
const MONEY_RE = new RegExp(MONEY_SRC, 'gi');

/** Money tokens at the END of a line (amount, or amount + running balance), with their offsets. */
function trailingMoney(text: string): Array<{ token: string; index: number }> {
  const all = [...text.matchAll(MONEY_RE)].map((m) => ({ token: m[0], index: m.index ?? 0 }));
  const out: Array<{ token: string; index: number }> = [];
  let end = text.trimEnd().length;
  for (let i = all.length - 1; i >= 0 && out.length < 3; i--) {
    const m = all[i];
    const between = text.slice(m.index + m.token.length, end);
    if (between.trim() !== '') break;
    out.unshift(m);
    end = m.index;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

interface DateToken {
  month: number;
  day: number;
  year?: number;
  length: number;
}

/** A date at the start of `s`: 01/05, 1/5/26, 01-05-2026, Jan 5, Jan 05 2026, 05 Jan. */
function leadingDate(s: string): DateToken | null {
  let m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?(?=\s|$)/.exec(s);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    return { month, day, year, length: m[0].length };
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?=\s|$)/.exec(s);
  if (m) {
    const month = monthNumber(m[1]);
    const day = Number(m[2]);
    if (month && day >= 1 && day <= 31) return { month, day, year: m[3] ? Number(m[3]) : undefined, length: m[0].length };
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:\s+(\d{4}))?(?=\s|$)/.exec(s);
  if (m) {
    const month = monthNumber(m[2]);
    const day = Number(m[1]);
    if (month && day >= 1 && day <= 31) return { month, day, year: m[3] ? Number(m[3]) : undefined, length: m[0].length };
  }
  return null;
}

/** "Jan", "Sept", "January" → 1..12; anything else → undefined. */
function monthNumber(word: string): number | undefined {
  const w = word.toLowerCase();
  const n = MONTHS[w.slice(0, 4)] ?? MONTHS[w.slice(0, 3)];
  // Only a real month word ("Janitor" is not January).
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  return n !== undefined && (w.length <= 4 || full[n - 1].startsWith(w)) ? n : undefined;
}

const FULL_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b|\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;

function fullDates(text: string): Array<{ y: number; m: number; d: number }> {
  const out: Array<{ y: number; m: number; d: number }> = [];
  for (const g of text.matchAll(FULL_DATE_RE)) {
    if (g[1]) {
      const y = g[3].length === 2 ? 2000 + Number(g[3]) : Number(g[3]);
      out.push({ y, m: Number(g[1]), d: Number(g[2]) });
    } else {
      const mo = MONTHS[g[4].slice(0, 4).toLowerCase()] ?? MONTHS[g[4].slice(0, 3).toLowerCase()];
      if (mo) out.push({ y: Number(g[6]), m: mo, d: Number(g[5]) });
    }
  }
  return out.filter((x) => x.m >= 1 && x.m <= 12 && x.d >= 1 && x.d <= 31 && x.y >= 1990 && x.y <= 2100);
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// Sections and balances
// ---------------------------------------------------------------------------

type Section = 'in' | 'out' | 'checks' | 'skip' | null;

function sectionOf(lower: string, kind: StatementKind): Section | undefined {
  const t = lower.replace(/[^a-z& ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return undefined;
  if (/^(daily|ending daily|daily ending) (balance|ledger)|balance summary|^summary$|account summary/.test(t)) return 'skip';
  if (/^checks? (paid|cleared)|^checks$/.test(t)) return 'checks';
  if (kind === 'card') {
    if (/^(payments?|payments? and (other )?credits|credits|other credits)\b/.test(t)) return 'in';
    if (/^(purchases?|purchases and adjustments|charges|fees( charged)?|interest( charged)?|cash advances?|transactions)\b/.test(t)) return 'out';
  }
  if (/^(deposits?|deposits? (and|&) (other )?(additions|credits)|additions|credits|other credits|electronic deposits)\b/.test(t)) return 'in';
  if (/^(withdrawals?|electronic withdrawals|other withdrawals|withdrawals? (and|&) (other )?(debits|subtractions)|debits|subtractions|atm (&|and) debit card withdrawals|card purchases|fees|service fees)\b/.test(t)) return 'out';
  return undefined;
}

const OPENING_RE = /\b(beginning|opening|previous|starting|prior)\s+(statement\s+)?balance\b/i;
const CLOSING_RE = /\b(ending|closing|new)\s+(statement\s+)?balance\b/i;
const TOTAL_RE = /^\s*(total|subtotal)\b/i;

function lastMoneyCents(text: string): number | null {
  const tokens = [...text.matchAll(MONEY_RE)];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const p = parseMoney(tokens[i][0]);
    if (p) return p.cents;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const IN_WORDS = /\b(deposit|direct dep|payroll|refund|interest paid|interest earned|transfer from|xfer from|credit|reversal|payment[, ]+thank you|payment received|autopay payment|online payment)\b/i;

export function parseStatementText(lines: StatementLine[], opts: { kind: StatementKind; fallbackYear?: number }): StatementParse {
  const kind = opts.kind;
  const warnings: string[] = [];
  const texts = lines.map((l) => l.text.replace(/\s+/g, ' ').trim());

  // Statement period (dates with years near "period" / "statement" / "through" words, else all).
  let period: StatementParse['period'] = null;
  const periodLines = texts.filter((t) => /period|statement|through|closing date|cycle|from .* to /i.test(t)).slice(0, 12);
  const pDates = fullDates(periodLines.join(' ')).length >= 2 ? fullDates(periodLines.join(' ')) : fullDates(texts.slice(0, 60).join(' '));
  if (pDates.length >= 2) {
    const sorted = [...pDates].sort((a, b) => a.y - b.y || a.m - b.m || a.d - b.d);
    const a = sorted[0];
    const b = sorted[sorted.length - 1];
    if ((b.y - a.y) * 12 + (b.m - a.m) <= 2) period = { start: iso(a.y, a.m, a.d), end: iso(b.y, b.m, b.d) };
  }
  const startYear = period ? Number(period.start.slice(0, 4)) : undefined;
  const startMonth = period ? Number(period.start.slice(5, 7)) : undefined;
  const endYear = period ? Number(period.end.slice(0, 4)) : undefined;
  const yearFor = (month: number, given?: number): number => {
    if (given) return given;
    if (startYear !== undefined && endYear !== undefined) return startYear !== endYear && month < (startMonth ?? 1) ? endYear : startYear;
    return opts.fallbackYear ?? new Date().getFullYear();
  };
  if (!period) warnings.push('No statement period found; dates without a year use ' + (opts.fallbackYear ?? new Date().getFullYear()) + '.');

  // Opening / closing balances: the first opening line and the last closing line.
  let opening: number | null = null;
  let closing: number | null = null;
  // The amount is on the same line, or alone on the next one (never a dated row: "Daily Ending
  // Balance" tables are not the closing balance).
  const amountOn = (i: number): number | null => {
    const same = lastMoneyCents(texts[i]);
    if (same !== null) return same;
    const next = texts[i + 1];
    return next && !leadingDate(next) ? lastMoneyCents(next) : null;
  };
  texts.forEach((t, i) => {
    if (sectionOf(t.toLowerCase(), kind) === 'skip') return;
    if (opening === null && OPENING_RE.test(t)) opening = amountOn(i);
    if (CLOSING_RE.test(t)) {
      const c = amountOn(i);
      if (c !== null) closing = c;
    }
  });

  // Column headers (x positions of Withdrawals / Deposits headings).
  let outX: number | null = null;
  let inX: number | null = null;
  for (const l of lines) {
    if (!l.cells?.length) continue;
    for (const c of l.cells) {
      const s = c.str.trim().toLowerCase();
      if (/^(withdrawals?|debits?|payments?|charges?|amount debited|subtractions)$/.test(s) && kind === 'bank') outX = c.x;
      if (/^(deposits?|credits?|additions|amount credited)$/.test(s) && kind === 'bank') inX = c.x;
    }
  }

  const rows: StatementRow[] = [];
  let section: Section = null;
  let prevBalance: number | null = opening;
  let last: StatementRow | null = null;

  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (!t) continue;
    const lower = t.toLowerCase();
    // A heading never starts with a date ("01/03 DEPOSIT MOBILE" is a row, not "Deposits").
    const sec = leadingDate(t) ? undefined : sectionOf(lower, kind);
    if (sec !== undefined) {
      section = sec;
      last = null;
      continue;
    }
    if (OPENING_RE.test(t) || CLOSING_RE.test(t) || TOTAL_RE.test(t)) {
      last = null;
      continue;
    }
    if (section === 'skip') continue;

    // Checks Paid tables: "1234 01/05 150.00" (possibly several per line).
    if (section === 'checks') {
      const re = /(\d{3,6})\s*\*?\s+(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\s+(\$?\d{1,3}(?:,\d{3})*\.\d{2})/g;
      let any = false;
      for (const g of t.matchAll(re)) {
        const d = leadingDate(g[2]);
        const money = parseMoney(g[3]);
        if (!d || !money) continue;
        any = true;
        rows.push({
          date: iso(yearFor(d.month, d.year), d.month, d.day),
          description: `Check #${g[1]}`,
          amount: centsToString(-Math.abs(money.cents)),
          checkNumber: g[1],
          signFrom: 'section',
          line: i,
        });
      }
      if (any) {
        last = null;
        continue;
      }
    }

    const d1 = leadingDate(t);
    if (!d1) {
      // A wrapped description: text with no date and no money right after a row.
      if (last && !trailingMoney(t).length && t.length < 80 && !/page \d+|continued/i.test(t)) last.description = `${last.description} ${t}`.trim();
      continue;
    }
    let rest = t.slice(d1.length).trim();
    // Card statements print a transaction date and a posting date.
    const d2 = leadingDate(rest);
    if (d2) rest = rest.slice(d2.length).trim();

    const money = trailingMoney(rest);
    if (!money.length) {
      last = null;
      continue;
    }
    // amount [balance] — three tokens means separate debit and credit columns plus balance.
    let amountTok = money[0];
    let balanceTok: { token: string; index: number } | null = null;
    if (money.length >= 2) {
      amountTok = money[money.length - 2];
      balanceTok = money[money.length - 1];
    }
    const amt = parseMoney(amountTok.token);
    if (!amt || amt.cents === 0) continue;
    const bal = balanceTok ? parseMoney(balanceTok.token) : null;
    const description = rest.slice(0, money[0].index).replace(/\s+/g, ' ').trim() || 'Statement transaction';

    let cents = Math.abs(amt.cents);
    let signFrom: StatementRow['signFrom'];
    let signed: number;
    if (amt.marker) {
      signed = amt.cents;
      signFrom = 'marker';
      // A card statement's "-" / CR marks a payment or credit: money in for the card.
      if (kind === 'card') signed = amt.cents < 0 ? cents : -cents;
    } else if (bal && prevBalance !== null && Math.abs(bal.cents - prevBalance) === cents) {
      const up = bal.cents > prevBalance;
      // Bank balance up = money in; a card balance (owed) up = a purchase (money out).
      signed = (kind === 'bank' ? up : !up) ? cents : -cents;
      signFrom = 'balance';
    } else if (outX !== null && inX !== null && lines[i].cells?.length) {
      const cell = lines[i].cells!.find((c) => c.str.includes(amountTok.token.trim().replace(/^\(|\)$/g, '')));
      const x = cell?.x ?? null;
      if (x !== null) {
        signed = Math.abs(x - inX) < Math.abs(x - outX) ? cents : -cents;
        signFrom = 'column';
      } else {
        signed = IN_WORDS.test(description) ? cents : -cents;
        signFrom = 'guess';
      }
    } else if (section === 'in' || section === 'out' || section === 'checks') {
      signed = section === 'in' ? cents : -cents;
      signFrom = 'section';
    } else {
      signed = IN_WORDS.test(description) ? cents : -cents;
      signFrom = 'guess';
    }
    if (bal) prevBalance = bal.cents;
    else if (prevBalance !== null) prevBalance = kind === 'bank' ? prevBalance + signed : prevBalance - signed;
    cents = signed;

    // A check: "CHECK 1234", or a bare number in the Checks Paid section ("01/05 1234 150.00").
    const check = /\b(?:check|chk|ck)\s*#?\s*(\d{3,6})\b/i.exec(description) ?? (section === 'checks' ? /^#?(\d{3,6})$/.exec(description) : null);
    const row: StatementRow = {
      date: iso(yearFor(d1.month, d1.year), d1.month, d1.day),
      description: check && /^#?\d+$/.test(description) ? `Check #${check[1]}` : description,
      amount: centsToString(cents),
      ...(bal ? { balance: centsToString(bal.cents) } : {}),
      ...(check ? { checkNumber: check[1] } : {}),
      signFrom,
      line: i,
    };
    rows.push(row);
    last = row;
  }

  if (opening === null) warnings.push('No beginning balance found on the statement.');
  if (closing === null) warnings.push('No ending balance found on the statement.');
  const guesses = rows.filter((r) => r.signFrom === 'guess').length;
  if (guesses) warnings.push(`${guesses} row${guesses === 1 ? '' : 's'} had no balance, column or section to tell money in from money out; check the highlighted signs.`);

  return {
    kind,
    rows,
    openingBalance: opening === null ? null : centsToString(opening),
    closingBalance: closing === null ? null : centsToString(closing),
    period,
    warnings,
  };
}

/** Signed cents of a statement / row amount: parseMoney's forms, or a plain "-12", "12.5"; else null. */
function amountCents(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  const p = parseMoney(s);
  if (p) return p.cents;
  const m = /^([-+]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const c = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(c)) return null;
  return m[1] === '-' ? -c : c;
}

/** Does opening + rows = closing? (For a card, whose balance is what you owe: opening − rows = closing.) */
export function tieOut(
  rows: Array<Pick<StatementRow, 'amount'>>,
  openingBalance: string | null,
  closingBalance: string | null,
  kind: StatementKind,
): TieOut {
  // Every row must be read: an amount this can't parse ("5" without cents, "1.5", garbage) must
  // never count as zero — the /api/import route ties out the rows it is about to import, and a
  // row left out of the sum would let an untied statement through as "tied out".
  const cents = rows.map((r) => amountCents(r.amount));
  const sum = cents.reduce<number>((s, c) => s + (c ?? 0), 0);
  const o = openingBalance === null ? null : amountCents(openingBalance);
  const c = closingBalance === null ? null : amountCents(closingBalance);
  if (o === null || c === null || cents.some((x) => x === null)) {
    return { expected: o === null || c === null ? null : centsToString(kind === 'bank' ? c - o : o - c), extracted: centsToString(sum), difference: null, ok: false };
  }
  const expected = kind === 'bank' ? c - o : o - c;
  return { expected: centsToString(expected), extracted: centsToString(sum), difference: centsToString(expected - sum), ok: expected === sum };
}
