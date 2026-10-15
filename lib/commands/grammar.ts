/**
 * Deterministic plain-English grammar for the command bar (Ctrl+K). Runs FIRST for every
 * command — in the browser for the live preview row and on the server before anything else —
 * and only when it recognizes nothing may the optional AI fallback be asked.
 *
 * Recognized (examples, not an exhaustive list):
 *   create   "invoice Acme 3 hours consulting", "quote Acme 10 widgets at $12",
 *            "bill from Staples 120 office supplies", "check to Shell $45.20 fuel",
 *            "spent $45 on fuel at Shell", "sold 2 widgets to Acme", "sales receipt Acme $80 repair"
 *   report   "show unpaid bills over 60 days", "overdue invoices from Acme", "who owes us",
 *            "p&l for last quarter", "a/p aging"
 *   question "what did we spend on fuel in Q3", "how much did we spend at Staples last month",
 *            "fuel expenses ytd", "how much did we make from Acme this year"
 *   action   "pay bills", "reconcile checking", "record deposit", "receive payment from Acme"
 *   navigate "go to chart of accounts", "open payroll"
 *
 * PURE: `today` is injected; no I/O. The output is a CommandIntent (lib/commands/intent.ts);
 * names are left as typed — the executor matches them against the company's lists.
 */
import { findDateProblem, parseDateRange, parseSingleDate, yearToDate, type DateRangeOptions } from './dates';
import type { CommandIntent, CreateIntent, FormKind, IntentLine, ReportIntent } from './intent';
import { isSalesForm } from './intent';
import { NEG_NUM_TOKEN, NUM_TOKEN, cut, isReasonableQuantity, looksLikeMoney, parseNumber, tidy } from './text';

const re = (src: string, flags = 'i') => new RegExp(src, flags);

/** Clean a command before parsing: trim, single spaces, no trailing punctuation. */
export function cleanCommand(input: string): string {
  return input
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?!.;,]+$/, '')
    .trim();
}

export function parseCommand(input: string, today: Date = new Date(), opts: DateRangeOptions = {}): CommandIntent | null {
  const raw = cleanCommand(input);
  if (!raw || raw.length > 500) return null;

  const action = parseAction(raw);
  if (action) return action;

  // "go to …" / "open …": a report or question phrased as navigation still runs as one.
  const nav = re(String.raw`^(?:please\s+)?(?:go\s+to|goto|open(?:\s+up)?|take\s+me\s+to|navigate\s+to|jump\s+to|switch\s+to|bring\s+up)\s+(?:the\s+|my\s+|our\s+)?(.+)$`).exec(raw);
  if (nav) {
    const inner = parseQuestion(nav[1], today, opts) ?? parseReport(nav[1], today, opts) ?? parseReport(raw, today, opts);
    return inner ?? { kind: 'navigate', target: tidy(nav[1]) };
  }

  const q = parseQuestion(raw, today, opts);
  if (q) return q;
  const r = parseReport(raw, today, opts);
  if (r) return r;
  const c = parseCreate(raw, today);
  if (c) return c;

  const show = re(String.raw`^(?:show|see|view|display|find)\s+(?:me\s+)?(?:the\s+|my\s+|our\s+)?(.+)$`).exec(raw);
  if (show) return { kind: 'navigate', target: tidy(show[1]) };
  return null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function parseAction(raw: string): CommandIntent | null {
  let m: RegExpExecArray | null;
  if (re(String.raw`^(?:i\s+(?:need|want)\s+to\s+)?pay(?:ing)?\s+(?:the\s+|my\s+|our\s+|some\s+|all\s+)?(?:open\s+|unpaid\s+)?(?:bills?|vendors?|suppliers?)(?:\s+(?:due|now|today))?$`).test(raw)) {
    return { kind: 'action', action: 'pay_bills' };
  }
  if ((m = re(String.raw`^(?:start\s+(?:a\s+)?|do\s+(?:a\s+)?|begin\s+(?:a\s+)?)?reconcil(?:e|iation|ing)\b(?:\s+(?:the|my|our|for))?\s*(.*)$`).exec(raw))) {
    const target = tidy(m[1].replace(/\b(?:account|statement|bank\s+statement)\b/gi, ''));
    return { kind: 'action', action: 'reconcile', ...(target ? { target } : {}) };
  }
  if ((m = re(String.raw`^(?:(?:record|make|enter|new|add|create)\s+(?:an?\s+)?(?:bank\s+)?)?deposits?(?:\s+(?:to|into|in)\s+(?:the\s+|my\s+|our\s+)?(.+))?$`).exec(raw))) {
    return { kind: 'action', action: 'record_deposit', ...(m[1] ? { target: tidy(m[1]) } : {}) };
  }
  if ((m = re(String.raw`^(?:(?:receive|record|enter|new|add|take)\s+(?:an?\s+)?)?(?:customer\s+)?payments?(?:\s+(?:from|by|for)\s+(.+))?$`).exec(raw))) {
    return { kind: 'action', action: 'receive_payment', ...(m[1] ? { target: tidy(m[1]) } : {}) };
  }
  if ((m = re(String.raw`^(?:i\s+|we\s+)?got\s+paid(?:\s+(?:by|from)\s+(.+))?$`).exec(raw))) {
    return { kind: 'action', action: 'receive_payment', ...(m[1] ? { target: tidy(m[1]) } : {}) };
  }
  if (re(String.raw`^(?:transfer|move)\s+(?:some\s+)?(?:money|funds|cash)\b`).test(raw) || re(String.raw`^transfer(?:\s+funds)?$`).test(raw)) {
    return { kind: 'action', action: 'transfer_funds' };
  }
  if (re(String.raw`^(?:(?:new|make|create|record|enter|add)\s+(?:an?\s+)?)?(?:general\s+)?journal(?:\s+entry)?$|^(?:new\s+)?je$`).test(raw)) {
    return { kind: 'action', action: 'journal_entry' };
  }
  if (re(String.raw`^(?:run|do|process|start)\s+(?:the\s+)?payroll$|^pay\s+(?:my\s+|the\s+|our\s+)?(?:employees|staff|team)$`).test(raw)) {
    return { kind: 'action', action: 'run_payroll' };
  }
  if (re(String.raw`^(?:bank\s+feeds?|download\s+(?:bank\s+)?transactions|import\s+(?:bank\s+)?(?:transactions|statement))$`).test(raw)) {
    return { kind: 'action', action: 'bank_feeds' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Questions: "what did we spend on fuel in Q3"
// ---------------------------------------------------------------------------

const FILLER = /\b(?:money|in\s+total|total|altogether|overall|so\s+far|all\s+together|exactly|roughly|approximately)\b/gi;

function cleanSubject(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = tidy(
    s
      .replace(FILLER, ' ')
      .replace(/^(?:on|for|at|with|to|in|from|by|of|the|our|my)\s+/i, '')
      .replace(/^(?:on|for|at|with|to|in|from|by|of|the|our|my)\s+/i, '')
      .replace(/\s+(?:on|for|at|with|to|in|from|by)$/i, ''),
  );
  if (!t || /^(?:everything|anything|all|stuff|things|it|that|this)$/i.test(t)) return undefined;
  return t;
}

/**
 * Words that name a period the date parser could not read ("in Q5", "for Q0 2026", "next
 * quarter", "in Septmber 2026", "fifth quarter", "FY27"). Without this the question would be
 * answered for year to date — a silent replacement of what was asked.
 */
const UNKNOWN_PERIOD = re(
  // Forward-looking phrases ("next quarter") need no preposition; the rest do ("in Q5").
  String.raw`\b(?:(?:in|during|for|over|of)\s+(?:the\s+)?)?((?:next|coming|following|upcoming)\s+(?:\d+\s+)?(?:days?|weeks?|months?|quarters?|years?|fiscal\s+years?|half|periods?))` +
    String.raw`(?=\s*$|\s+(?:on|for|at|with|from|to|by)\b)|` +
    String.raw`\b(?:in|during|for|over|of)\s+(?:the\s+)?(` +
    [
      String.raw`q\d+(?:\s*(?:of\s+|,\s*)?(?:\d{4}|'\d{2}))?`,
      String.raw`(?:fy|fiscal\s+year)\s*'?\d{2,4}`,
      String.raw`h[1-4](?:\s+\d{4})?`,
      String.raw`(?:first|second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th))\s+(?:quarter|half)(?:\s+(?:of\s+)?\d{4})?`,
      String.raw`(?:next|coming|following|upcoming|last|this|previous|prior|current|past)\s+(?:\d+\s+)?(?:days?|weeks?|months?|quarters?|years?|fiscal\s+years?|calendar\s+years?|half|periods?|seasons?)`,
      String.raw`\d{1,4}(?:[-/]\d{1,2}){1,2}`,
      String.raw`(?:1[0-8]|2[1-9])\d{2}`,
      String.raw`[a-z]{3,}\s+(?:19|20)\d{2}`,
    ].join('|') +
    String.raw`)(?=\s*$|\s+(?:on|for|at|with|from|to|by)\b)`,
  'gi',
);

/**
 * Period words in `text` that the date parser cannot read in full ("Q5", "Q0 2026", "Septmber
 * 2026", "next quarter"), or null. "Q3 2025" or "July 2026" are read in full, so they pass.
 */
export function findUnknownPeriod(text: string, today: Date, opts: DateRangeOptions = {}): { words: string; matched: string } | null {
  const norm = (x: string) => x.trim().replace(/\s+/g, ' ').toLowerCase();
  UNKNOWN_PERIOD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UNKNOWN_PERIOD.exec(text))) {
    const words = m[1] ?? m[2];
    const known = parseDateRange(words, today, opts);
    if (known && norm(known.matched) === norm(words)) continue;
    return { words, matched: m[0] };
  }
  return null;
}

function unknownPeriodMessage(words: string): string {
  return `I don't know the period “${words.slice(0, 40)}” — use Q1–Q4, a month, “last month”, “this year”, or from/to dates.`;
}

export function parseQuestion(raw: string, today: Date, opts: DateRangeOptions = {}): CommandIntent | null {
  const rm = parseDateRange(raw, today, opts);
  // A period that is there but unreadable ("in Q5") is reported, never replaced by year to date.
  const unknown = findUnknownPeriod(raw, today, opts);
  const base = unknown ? cut(raw, unknown.matched) : raw;
  const rest = cleanCommand(rm && base.includes(rm.matched) ? cut(base, rm.matched) : base);
  let m: RegExpExecArray | null;
  let measure: 'spend' | 'income' | null = null;
  let subject: string | undefined;

  const WHO = String.raw`(?:we|i|you|the\s+company|the\s+business|they)`;
  const SPEND_V = String.raw`(?:spend|spent|pay|paid|pay\s+out|paid\s+out|shell\s+out)`;
  const INCOME_V = String.raw`(?:make|made|earn|earned|sell|sold|bring\s+in|brought\s+in|take\s+in|took\s+in|bill|billed|invoice|invoiced|collect|collected|get|got)`;
  const SPEND_N = String.raw`(?:spending|spend|expenses?|expenditures?|costs?|outgoings?)`;
  const INCOME_N = String.raw`(?:income|revenue|sales|earnings|takings)`;

  if ((m = re(String.raw`^(?:so\s+)?(?:what|how\s+much)\s+(?:money\s+)?(?:did|have|has|do|does)\s+${WHO}\s+${SPEND_V}\b\s*(.*)$`).exec(rest))) {
    measure = 'spend';
    subject = m[1];
  } else if ((m = re(String.raw`^(?:so\s+)?(?:what|how\s+much)\s+(?:money\s+)?(?:did|have|has|do|does)\s+${WHO}\s+${INCOME_V}\b\s*(.*)$`).exec(rest))) {
    measure = 'income';
    subject = m[1];
  } else if ((m = re(String.raw`^(?:what|how\s+much)\s+(?:was|were|is|are|did)\s+(?:our|my|the|we)?\s*(?:total\s+)?(.*?)\s*${SPEND_N}(?:\s+(?:on|for|at|with)\s+(.+))?$`).exec(rest))) {
    measure = 'spend';
    subject = m[2] ?? m[1];
  } else if ((m = re(String.raw`^(?:what|how\s+much)\s+(?:was|were|is|are|did)\s+(?:our|my|the|we)?\s*(?:total\s+)?(.*?)\s*${INCOME_N}(?:\s+(?:from|for|on|with)\s+(.+))?$`).exec(rest))) {
    measure = 'income';
    subject = m[2] ?? m[1];
  } else if ((m = re(String.raw`^how\s+much\s+(?:went\s+(?:to|on)|was\s+spent\s+on|did\s+(?:.+?)\s+cost(?:\s+us)?)\s*(.*)$`).exec(rest))) {
    measure = 'spend';
    subject = m[1];
  } else if ((rm || unknown) && !/\d/.test(rest) && (m =re(String.raw`^(?:${WHO}\s+)?(?:spent|spend|paid)\s+((?:on|at|for|with|to)\s+.+)$`).exec(rest))) {
    // "spent on Shell Oil in July": a period but no amount — a question, not a new expense.
    measure = 'spend';
    subject = m[1];
  } else if (rm || unknown || /^total\b/i.test(rest)) {
    // Terse forms need a period (or "total") so a page name like "expenses" still navigates.
    if ((m = re(String.raw`^(?:total\s+)?(.*?)\s*${SPEND_N}(?:\s+(?:on|for|at|with)\s+(.+))?$`).exec(rest))) {
      measure = 'spend';
      subject = m[2] ?? m[1];
    } else if ((m = re(String.raw`^(?:total\s+)?${SPEND_N}\s+(?:on|for|at|with)\s+(.+)$`).exec(rest))) {
      measure = 'spend';
      subject = m[1];
    } else if ((m = re(String.raw`^(?:total\s+)?(.*?)\s*${INCOME_N}(?:\s+(?:from|for|on|with)\s+(.+))?$`).exec(rest))) {
      measure = 'income';
      subject = m[2] ?? m[1];
    }
  }
  if (!measure) return null;
  const range = rm?.range ?? yearToDate(today, opts);
  const s = cleanSubject(subject);
  const problem = findDateProblem(raw, today) ?? (unknown ? unknownPeriodMessage(unknown.words) : null);
  return {
    kind: 'question',
    measure,
    ...(s ? { subject: s } : {}),
    from: range.from,
    to: range.to,
    rangeLabel: range.label,
    ...(problem ? { dateProblem: problem } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reports: "show unpaid bills over 60 days"
// ---------------------------------------------------------------------------

/** The most "days past due" a report filter accepts (the same limit as the report params). */
export const MAX_OVER_DAYS = 3650;

function parseOverDays(s: string): { days: number; matched: string } | null {
  let m: RegExpExecArray | null;
  // Any number of digits is read, so an out-of-range filter is reported instead of vanishing.
  const n = (tok: string) => Number(tok.replace(/,/g, ''));
  if ((m = re(String.raw`\b(?:that\s+are\s+|which\s+are\s+)?(over|more\s+than|older\s+than|greater\s+than|longer\s+than|beyond|past|at\s+least|>=?)\s*(\d[\d,]*)\s*\+?\s*days?(?:\s+(?:old|overdue|past\s+due|late))?`).exec(s))) {
    return { days: /least|>=/i.test(m[1]) ? Math.max(0, n(m[2]) - 1) : n(m[2]), matched: m[0] };
  }
  if ((m = re(String.raw`(\d[\d,]*)\s*\+\s*days?(?:\s+(?:old|overdue|past\s+due|late))?`).exec(s))) {
    return { days: Math.max(0, n(m[1]) - 1), matched: m[0] };
  }
  if ((m = re(String.raw`\b(\d[\d,]*)\s+days?\s+(?:overdue|past\s+due|late|old)`).exec(s))) {
    return { days: Math.max(0, n(m[1]) - 1), matched: m[0] };
  }
  return null;
}

export function parseReport(raw: string, today: Date, opts: DateRangeOptions = {}): ReportIntent | null {
  const r = parseReportInner(raw, today, opts);
  if (!r) return null;
  const problem = findDateProblem(raw, today);
  return problem ? { ...r, dateProblem: problem } : r;
}

/** A report as parsed, before the overdue filter is range-checked. */
type ReportDraft = Omit<ReportIntent, 'overDays'> & { overDays?: number };

function parseReportInner(raw: string, today: Date, opts: DateRangeOptions): ReportIntent | null {
  const r = parseReportDraft(raw, today, opts);
  if (!r) return null;
  // A filter beyond the limit is never dropped (that would list every unpaid bill): it is reported.
  if (r.overDays !== undefined && r.overDays > MAX_OVER_DAYS) {
    const { overDays, ...rest } = r;
    return { ...rest, dateProblem: `“${overDays} days” is more than the overdue filter allows — use ${MAX_OVER_DAYS} days or fewer.` };
  }
  return r as ReportIntent;
}

function parseReportDraft(raw: string, today: Date, opts: DateRangeOptions): ReportDraft | null {
  let s = cleanCommand(
    raw.replace(re(String.raw`^(?:please\s+)?(?:show|list|find|view|display|see|give|pull\s+up|run|get|print)\s+(?:me\s+)?(?:a\s+list\s+of\s+)?(?:all\s+)?(?:the\s+|my\s+|our\s+)?`), ''),
  );
  const over = parseOverDays(s);
  if (over) s = cut(s, over.matched);
  const overdueWord = /\b(?:overdue|past[\s-]due|late)\b/i.test(s);

  const rm = parseDateRange(s, today, opts);
  const unknown = findUnknownPeriod(s, today, opts);
  const withRange = (r: ReportDraft): ReportDraft =>
    unknown
      ? { ...r, dateProblem: unknownPeriodMessage(unknown.words) }
      : rm
        ? { ...r, from: rm.range.from, to: rm.range.to, period: rm.range.label }
        : r;

  if (re(String.raw`\b(?:p\s*&\s*l|p\s+and\s+l|pnl|profit\s+(?:and|&)\s+loss|income\s+statement)\b`).test(s)) {
    return withRange({ kind: 'report', report: 'profit_loss' });
  }
  if (re(String.raw`\bbalance\s+sheet\b`).test(s)) {
    return withRange({ kind: 'report', report: 'balance_sheet' });
  }

  const ovr = over ? { overDays: over.days } : overdueWord ? { overDays: 0 } : {};
  const party = (str: string, doc: RegExp): string | undefined => {
    const left = cut(str, (doc.exec(str) ?? [''])[0]);
    const pm = re(String.raw`(?:^|\s)(?:from|for|to|with|by|of)\s+(?:vendor\s+|customer\s+)?(.+)$`).exec(left);
    const p = pm ? tidy(pm[1]) : undefined;
    return p && !/^(?:me|us|we|them|everyone|anyone|all)$/i.test(p) ? p : undefined;
  };

  if (re(String.raw`\b(?:a\/?p|ap|payables?)\s+aging\b`).test(s)) return { kind: 'report', report: 'ap_aging', ...ovr };
  if (re(String.raw`\b(?:a\/?r|ar|receivables?)\s+aging\b`).test(s)) return { kind: 'report', report: 'ar_aging', ...ovr };

  const BILL_DOC = re(String.raw`\b(?:(?:unpaid|open|outstanding|overdue|past[\s-]due|late|due)\s+(?:vendor\s+)?bills?|bills?\s+(?:that\s+are\s+|which\s+are\s+|still\s+)?(?:unpaid|overdue|past[\s-]due|outstanding|open|due|not\s+(?:yet\s+)?paid|to\s+pay|we\s+owe)|bills?\b(?=.*\b(?:overdue|past[\s-]due|late|unpaid)\b))`);
  const INV_DOC = re(String.raw`\b(?:(?:unpaid|open|outstanding|overdue|past[\s-]due|late)\s+(?:customer\s+)?invoices?|invoices?\s+(?:that\s+are\s+|which\s+are\s+|still\s+)?(?:unpaid|overdue|past[\s-]due|outstanding|open|not\s+(?:yet\s+)?paid)|invoices?\b(?=.*\b(?:overdue|past[\s-]due|late|unpaid)\b))`);

  if (BILL_DOC.test(s) || (over && /^bills?\b/i.test(s))) {
    const p = party(s, BILL_DOC);
    return { kind: 'report', report: 'unpaid_bills', ...ovr, ...(p ? { party: p } : {}) };
  }
  if (INV_DOC.test(s) || (over && /^invoices?\b/i.test(s))) {
    const p = party(s, INV_DOC);
    return { kind: 'report', report: 'unpaid_invoices', ...ovr, ...(p ? { party: p } : {}) };
  }
  if (re(String.raw`^(?:who|what)\s+do\s+(?:we|i)\s+owe(?:\s+money)?(?:\s+to)?$|^(?:what|who)\s+(?:we|i)\s+owe$`).test(s)) {
    return { kind: 'report', report: 'unpaid_bills', ...ovr };
  }
  if (re(String.raw`^who\s+(?:still\s+)?owes\s+(?:me|us)(?:\s+money)?$|^(?:overdue|late)\s+customers$|^who\s+hasn'?t\s+paid(?:\s+(?:me|us))?$`).test(s)) {
    return { kind: 'report', report: 'unpaid_invoices', ...ovr };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Create forms: "invoice Acme 3 hours consulting"
// ---------------------------------------------------------------------------

type Mode = 'party-first' | 'marker';

const CREATE_PREFIXES: Array<{ re: RegExp; form: FormKind; mode?: Mode }> = [
  { re: re(String.raw`^(?:(?:new|create|make|start|draft|send|write|prepare|add)\s+(?:an?\s+)?)?invoice\b(?:\s+(?:to|for)\b)?`), form: 'invoice' },
  { re: re(String.raw`^(?:charge|bill)\s+(?:the\s+)?(?:customer|client)\b`), form: 'invoice' },
  { re: re(String.raw`^charge\b`), form: 'invoice' },
  { re: re(String.raw`^(?:(?:new|create|make|start|draft|prepare|send|write|add)\s+(?:an?\s+)?)?(?:estimate|quote|bid|proposal)\b(?:\s+(?:to|for)\b)?`), form: 'estimate' },
  { re: re(String.raw`^(?:(?:new|create|make|record|enter|ring\s+up|add)\s+(?:an?\s+)?)?(?:sales\s+receipt|cash\s+sale)\b(?:\s+(?:to|for)\b)?`), form: 'sales_receipt' },
  { re: re(String.raw`^(?:i\s+|we\s+)?sold\b`), form: 'sales_receipt', mode: 'marker' },
  { re: re(String.raw`^(?:(?:new|create|make|record|enter|add)\s+(?:an?\s+)?|(?:i\s+|we\s+)?(?:got|received)\s+(?:an?\s+)?)?(?:vendor\s+)?bill\b(?:\s+(?:from|for|to)\b)?`), form: 'bill' },
  { re: re(String.raw`^(?:(?:new|write|create|make|record|enter|add)\s+(?:an?\s+)?)?(?:check|cheque|expense)\b(?:\s+(?:payable\s+to|to|for|from|at)\b)?`), form: 'expense' },
  { re: re(String.raw`^(?:i\s+|we\s+)?(?:spent|bought|purchased)\b`), form: 'expense', mode: 'marker' },
  { re: re(String.raw`^(?:i\s+|we\s+)?paid\b(?!\s+(?:for\s+)?(?:the\s+)?bills?\b)`), form: 'expense' },
];

const UNIT = String.raw`(?:hours?|hrs?|h|units?|pcs?|pieces?|items?|ea|each|days?|boxes?|cases?|bags?|lbs?|pounds?|gallons?|gal|sessions?|visits?|months?|weeks?|licen[cs]es?|seats?|users?)`;

export function parseLine(s: string, form: FormKind): IntentLine | null {
  const sales = isSalesForm(form);
  let t = s.replace(/\s+/g, ' ').trim();
  let quantity: string | undefined;
  let rate: string | undefined;
  let amount: string | undefined;
  let amountMaybeCount = false;
  const unclear: string[] = [];
  let m: RegExpExecArray | null;
  /** A typed number that has no place on the line is kept for a note, never silently dropped. */
  const keep = (tok: string) => {
    const k = tidy(tok);
    if (k && unclear.length < 5) unclear.push(k.slice(0, 40));
  };
  /** Parse a token; zero is never a usable quantity, rate or amount. */
  const num = (tok: string): string | null => {
    const v = parseNumber(tok);
    if (v === null) return null;
    if (!/[1-9]/.test(v)) {
      keep(tok);
      return null;
    }
    return v;
  };
  const setAmount = (tok: string, v: string) => {
    if (amount) keep(tok);
    else amount = v;
  };
  const setQuantity = (tok: string, v: string) => {
    if (quantity || !isReasonableQuantity(v)) keep(tok);
    else quantity = v;
  };

  // Negative numbers ("-5 widgets", "($20) refund") are a credit, not a charge: never filled in
  // with the sign dropped. They are reported (the executor refuses them with a clear message).
  t = t.replace(re(String.raw`(^|\s)(${NEG_NUM_TOKEN})(?=\s|$|[a-z])`, 'gi'), (_all, pre: string, tok: string) => {
    keep(tok);
    return `${pre} `;
  });
  t = tidy(t);

  // Rate: "at $150", "@ 150/hr", "$150 each", "150 per hour".
  if ((m = re(String.raw`\s*(?:@|\bat\b)\s*(${NUM_TOKEN})(?:\s*(?:each|ea|per\s+\w+|an?\s+(?:hour|unit|item|piece|day)|\/\s*\w+))?`).exec(t))) {
    rate = num(m[1]) ?? undefined;
    t = cut(t, m[0]);
  } else if ((m = re(String.raw`(${NUM_TOKEN})\s*(?:each|ea|per\s+\w+|\/\s*(?:hr|hour|h|unit|ea|each|item|piece|pc|day))\b`).exec(t))) {
    rate = num(m[1]) ?? undefined;
    t = cut(t, m[0]);
  }
  // Total: "consulting for $500", "= 500".
  if ((m = re(String.raw`\s*(?:\bfor\b|\btotal(?:l?ing)?\b|=)\s*(${NUM_TOKEN})\s*$`).exec(t)) && !re(String.raw`^${UNIT}\b`).test(t.slice(m.index + m[0].length))) {
    amount = num(m[1]) ?? undefined;
    t = cut(t, m[0]);
  }

  // Leading number ("3 hours consulting", "$80 repair") and/or trailing number ("office
  // supplies 120", "2 widgets $100"). Both are read — a typed amount is never ignored.
  let lead: { tok: string; x: boolean; unit: boolean } | null = null;
  if ((m = re(String.raw`^(${NUM_TOKEN})\s*(x\b|×|\*)?\s*(${UNIT}\b)?\s*(?:of\b)?\s*`).exec(t)) && m[0].trim() && parseNumber(m[1]) !== null) {
    lead = { tok: m[1], x: !!m[2], unit: !!m[3] };
    t = tidy(t.slice(m[0].length));
  }
  let trail: { tok: string; unit: boolean } | null = null;
  if ((m = re(String.raw`\s(${NUM_TOKEN})\s*(${UNIT})?\s*$`).exec(` ${t}`)) && parseNumber(m[1]) !== null) {
    trail = { tok: m[1], unit: !!m[2] };
    t = tidy(` ${t}`.slice(0, m.index));
  }
  const bareWhole = (tok: string) => !looksLikeMoney(tok) && /^\d+$/.test(parseNumber(tok) ?? '');

  if (lead && trail) {
    // "2 widgets $100": the first number counts, the last one is the line total.
    const lv = num(lead.tok);
    const tv = num(trail.tok);
    const leadIsMoney = looksLikeMoney(lead.tok) && !lead.x && !lead.unit;
    if (leadIsMoney) {
      // "$100 widgets 2" / "$100 consulting 3 hours".
      if (lv) setAmount(lead.tok, lv);
      if (tv) {
        if (!looksLikeMoney(trail.tok)) setQuantity(trail.tok, tv);
        else keep(trail.tok);
      }
    } else {
      if (lv) setQuantity(lead.tok, lv);
      if (tv) {
        if (trail.unit) keep(trail.tok);
        else setAmount(trail.tok, tv);
      }
    }
  } else if (lead || trail) {
    const tok = (lead ?? trail)!.tok;
    const v = num(tok);
    if (v !== null) {
      const unitish = lead ? lead.x || lead.unit : trail!.unit;
      const isQty = !looksLikeMoney(tok) && (unitish || (sales && !/\.\d{2}$/.test(tok)));
      if (isQty && isReasonableQuantity(v)) setQuantity(tok, v);
      else if (!amount) {
        amount = v;
        // Purchases: "3 widgets" may be three widgets, not $3 — the executor decides once it
        // knows whether the words name an item.
        if (!sales && bareWhole(tok) && !quantity && !rate && isReasonableQuantity(v)) amountMaybeCount = true;
      } else if (!quantity && !looksLikeMoney(tok) && isReasonableQuantity(v)) quantity = v; // "3 widgets for $500"
      else keep(tok);
    }
  }
  const text = tidy(t.replace(/^(?:of|for|on|in|worth\s+of)\s+/i, '').replace(/\s+(?:for|at|on|of)$/i, ''));
  if (!text && !quantity && !rate && !amount && !unclear.length) return null;
  return {
    ...(text ? { text } : {}),
    ...(quantity ? { quantity } : {}),
    ...(rate ? { rate } : {}),
    ...(amount ? { amount } : {}),
    ...(amountMaybeCount && amount ? { amountMaybeCount: true } : {}),
    ...(unclear.length ? { unclear } : {}),
  };
}

/** Start of a number, signed or not ("5", "$5", "-5", "−$5", "(5)"). */
const NUM_START = String.raw`(?:[-−(]\s?)?\$?\s?[-−]?\d`;
const LINE_SPLIT = re(String.raw`\s*(?:,\s+|,(?!\d{3}(?:\D|$))|;|\band\b|\bplus\b|\+)\s*(?=${NUM_START})`);
const STARTS_NUM = re(String.raw`^(?:${NEG_NUM_TOKEN}|${NUM_TOKEN})`);
/** Words that make "from X" a bank or card ("from Amex", "from the business checking"). */
const PAY_ACCOUNT_WORD = re(
  String.raw`\b(?:card|credit|debit|bank|checking|chequing|savings|account|acct|amex|american\s+express|visa|master\s?card|mc|discover|petty\s+cash|cash)\b`,
);

function parseLines(s: string, form: FormKind): IntentLine[] {
  const out: IntentLine[] = [];
  for (const part of s.split(LINE_SPLIT)) {
    const l = parseLine(part, form);
    if (l) out.push(l);
  }
  return out;
}

export function parseCreate(raw: string, today: Date): CreateIntent | null {
  const prefix = CREATE_PREFIXES.map((p) => ({ p, m: p.re.exec(raw) })).find((x) => x.m);
  if (!prefix || !prefix.m) return null;
  const form = prefix.p.form;
  const sales = isSalesForm(form);
  let body = tidy(raw.slice(prefix.m[0].length));
  const intent: CreateIntent = { kind: 'create', form, lines: [] };

  // "bill" followed by a report-ish word is not a create ("bills over 60 days" handled earlier).
  const d = parseSingleDate(body, today);
  if (d) {
    intent.date = d.date;
    body = cut(body, d.matched);
  }
  let m: RegExpExecArray | null;
  if ((m = re(String.raw`\s*\b(?:memo|note|notes)\b\s*[:\-]?\s*(.+)$`).exec(body))) {
    intent.memo = tidy(m[1].replace(/^["']|["']$/g, ''));
    body = tidy(body.slice(0, m.index));
  }
  if (form === 'expense') {
    const pay =
      re(String.raw`\s+(?:paid\s+)?(?:with|using|via)\s+(?:the\s+|my\s+|our\s+)?([a-z][\w&' -]*?)(?:\s+(?:card|account|acct))?$`).exec(body) ??
      re(String.raw`\s+(?:on|by)\s+(?:the\s+|my\s+|our\s+)?([a-z][\w&' -]*?)\s+(?:credit\s+card|debit\s+card|card)$`).exec(body);
    if (pay && !/\d/.test(pay[1])) {
      intent.paymentAccount = tidy(pay[1]);
      body = tidy(body.slice(0, pay.index));
    } else {
      // A trailing "from <bank/card>": "check to Shell Oil 45.20 fuel from Amex". "from" also
      // introduces the payee ("expense 45 fuel from Shell"), so it is the payment account only
      // when the words name a bank or card, or when the payee is already named elsewhere.
      const from = re(String.raw`\s+from\s+(?:the\s+|my\s+|our\s+)?([a-z][\w&' -]*?)(?:\s+(?:card|account|acct))?$`).exec(body);
      if (from && !/\d/.test(from[1])) {
        const before = body.slice(0, from.index);
        const prefixNamesPayee = /\b(?:to|at|from)\s*$/i.test(prefix.m[0]);
        const payeeMarker = re(String.raw`(?:^|\s)(?:to|at|payable\s+to)\s+(?![-−(]?\$?\s?\d)`).test(before);
        const partyFirst = !prefix.p.mode && !STARTS_NUM.test(before) && !re(String.raw`^(?:from|to|at|payable\s+to)\s`).test(before) && /\d/.test(before);
        if (PAY_ACCOUNT_WORD.test(from[0]) || prefixNamesPayee || payeeMarker || partyFirst) {
          intent.paymentAccount = tidy(from[1]);
          body = tidy(before);
        }
      }
    }
  }

  const markers = sales ? String.raw`(?:to|for)` : String.raw`(?:from|to|at|payable\s+to)`;
  const mode: Mode = prefix.p.mode ?? (STARTS_NUM.test(body) || re(`^${markers}\\s`).test(body) ? 'marker' : 'party-first');

  if (mode === 'party-first') {
    // Party = the words before the first number ("Acme Corp 3 hours consulting").
    // "-5" right against the number is a minus sign; "Acme - 5 widgets" is a separator.
    const num = re(String.raw`(?:^|\s)(?:for\s+|-\s+|:\s*)?(${NEG_NUM_TOKEN}|${NUM_TOKEN})(?=\s|$|[a-z])`).exec(body);
    if (num) {
      intent.party = tidy(body.slice(0, num.index).replace(/\s+(?:for|-|:)$/i, '')) || undefined;
      intent.lines = parseLines(body.slice(num.index + num[0].length - num[1].length), form);
    } else {
      const forSplit = re(String.raw`\s+(?:for|-|:)\s+`).exec(body);
      if (forSplit) {
        intent.party = tidy(body.slice(0, forSplit.index)) || undefined;
        const l = parseLine(body.slice(forSplit.index + forSplit[0].length), form);
        if (l) intent.lines = [l];
      } else if (body) {
        intent.party = body;
      }
    }
  } else {
    // Marker mode: the party follows "to/for" (sales) or "from/to/at" (purchases).
    const pm = re(String.raw`(?:^|\s)${markers}\s+(?!${NUM_START})(.+?)(?=\s+(?:for|on|with|@)\s|\s+${NUM_START}|$)`).exec(body);
    if (pm) {
      intent.party = tidy(pm[1]);
      body = tidy(body.slice(0, pm.index) + ' ' + body.slice(pm.index + pm[0].length));
    }
    if (body) intent.lines = parseLines(body, form);
  }
  if (intent.party && /^(?:a|an|the|new|one)$/i.test(intent.party)) delete intent.party;
  if (!intent.party) delete intent.party;
  return intent;
}
