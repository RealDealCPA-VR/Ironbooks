/**
 * Bank feed rules — pure logic (no DB, no Node imports; safe on the client too).
 *
 *  - normalizeDescription: turns "PURCHASE AUTHORIZED ON 03/14 SHELL OIL 57444 HOUSTON TX CARD 1234"
 *    into "SHELL OIL" so the same merchant groups together across store numbers, dates and cards.
 *  - globMatch: the "matches pattern" operator — `*` = anything, `?` = one character. Implemented
 *    without RegExp (linear-time two-pointer matcher), so a user pattern can never hang the app.
 *  - ruleMatches / pickRule: rule conditions + precedence (priority high→low, then oldest first).
 *  - historyConfidence / combineSignals: the confidence math behind one suggestion per line.
 *
 * All money comparisons use lib/money (Decimal).
 */
import { Money } from '@/lib/money';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Bank boilerplate that precedes the merchant name. Longest first. */
const PREFIXES = [
  'PURCHASE AUTHORIZED ON',
  'RECURRING PAYMENT AUTHORIZED ON',
  'DEBIT CARD PURCHASE',
  'CREDIT CARD PURCHASE',
  'POS PURCHASE',
  'POS DEBIT',
  'CHECKCARD',
  'CHECK CARD',
  'DEBIT CARD',
  'CARD PURCHASE',
  'PURCHASE',
  'POS',
  'ACH DEBIT',
  'ACH CREDIT',
  'ACH',
  'ONLINE PAYMENT',
  'PAYMENT TO',
  'RECURRING',
  'VISA',
  'DDA',
];

const MONTHS = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';

/**
 * Normalize a bank description to a stable merchant pattern (UPPERCASE, single spaces).
 * Strips card digits, dates, store / reference numbers and bank boilerplate; cuts the text at
 * the first store-number-like token after the merchant name (city/state usually follow it).
 */
export function normalizeDescription(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = ` ${raw.toUpperCase()} `;
  // Card digits: "CARD 1234", "XXXX1234", "****1234", "X1234", "ENDING IN 1234".
  s = s.replace(/\b(?:CARD|ACCT|ACCOUNT|ENDING(?: IN)?)\s*#?\s*[X*]*\d{2,}\b/g, ' ');
  s = s.replace(/[X*]{2,}\d{2,}/g, ' ');
  // Dates: 03/14, 03/14/24, 03-14-2024, 2024-03-14, 14MAR, MAR 14, 14 MAR 2024.
  s = s.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ');
  s = s.replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ');
  s = s.replace(new RegExp(`\\b\\d{1,2}\\s?(?:${MONTHS})(?:\\s?\\d{2,4})?\\b`, 'g'), ' ');
  s = s.replace(new RegExp(`\\b(?:${MONTHS})\\s?\\d{1,2}(?:\\s?\\d{4})?\\b`, 'g'), ' ');
  // Times: 10:42, 10:42AM.
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?\b/g, ' ');
  // Punctuation → space (keep & and ' inside names), "*" separators too.
  s = s.replace(/[^A-Z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Bank boilerplate prefixes (repeat: "POS PURCHASE ..." etc.).
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of PREFIXES) {
      if (s === p) break;
      if (s.startsWith(`${p} `)) {
        s = s.slice(p.length + 1);
        changed = true;
        break;
      }
    }
  }

  const tokens = s.split(' ').filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    const hasDigit = /\d/.test(t);
    // A store / reference number (digits, "#123", "2K4AB1") ends the merchant name once we have one.
    if (hasDigit && (/^\d+$/.test(t) ? t.length >= 2 : (t.match(/\d/g) ?? []).length >= 2)) {
      if (out.length > 0) break;
      continue;
    }
    out.push(t);
  }
  // Trailing one-letter leftovers ("US*" → "US" is fine, but a lone "X" from masks is not).
  while (out.length > 1 && out[out.length - 1].length === 1) out.pop();
  const result = out.join(' ').slice(0, 255);
  if (result) return result;
  // Nothing meaningful left (description was all digits) — fall back to the digit-free text.
  return raw.toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 255);
}

/** Human-friendly form of a pattern for prompts: "SHELL OIL" stays as the bank shows it. */
export function patternOf(txn: { description?: string | null; payee?: string | null }): string {
  return normalizeDescription(txn.description || txn.payee || '');
}

// ---------------------------------------------------------------------------
// Pattern operator (safe wildcard match)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive wildcard match of the WHOLE text: `*` = any run of characters, `?` = exactly
 * one. Every other character is literal (no regex), and the matcher is the classic linear
 * two-pointer algorithm with single backtrack point, so no input can cause catastrophic runtime.
 */
export function globMatch(text: string, pattern: string): boolean {
  const t = text.toLowerCase();
  const p = pattern.toLowerCase();
  let ti = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || (p[pi] !== '*' && p[pi] === t[ti]))) {
      ti++;
      pi++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = ti;
    } else if (star !== -1) {
      pi = star + 1;
      ti = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

// ---------------------------------------------------------------------------
// Rule shape + matching
// ---------------------------------------------------------------------------

export type RuleField = 'description' | 'payee' | 'any' | 'amount';
export type RuleOperator = 'contains' | 'starts_with' | 'equals' | 'pattern';
export type RuleDirection = 'any' | 'in' | 'out';
export type RuleMode = 'suggest' | 'auto';

export const RULE_FIELDS: readonly RuleField[] = ['description', 'payee', 'any', 'amount'];
export const RULE_OPERATORS: readonly RuleOperator[] = ['contains', 'starts_with', 'equals', 'pattern'];
export const RULE_DIRECTIONS: readonly RuleDirection[] = ['any', 'in', 'out'];
export const RULE_MODES: readonly RuleMode[] = ['suggest', 'auto'];

export interface RuleSplit {
  accountId: string;
  classId?: string | null;
  /** Percentage as a decimal string, e.g. "60" or "33.33". */
  percent: string;
}

/** The subset of a transaction_rules row needed to evaluate it. */
export interface RuleLike {
  id: string;
  name: string;
  matchField: string;
  matchOperator: string;
  matchValue: string;
  bankAccountId?: string | null;
  direction?: string | null;
  amountMin?: string | null;
  amountMax?: string | null;
  priority: number;
  enabled?: boolean;
  isActive?: boolean;
  createdAt?: Date | string | null;
}

export interface TxnLike {
  description?: string | null;
  payee?: string | null;
  amount: string;
  bankAccountId?: string | null;
}

function textMatches(value: string, op: RuleOperator, want: string): boolean {
  const v = value.toLowerCase().replace(/\s+/g, ' ').trim();
  const w = want.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!w) return true;
  switch (op) {
    case 'contains':
      return v.includes(w);
    case 'starts_with':
      return v.startsWith(w);
    case 'equals':
      return v === w;
    case 'pattern':
      return globMatch(v, w);
  }
}

/** Texts a text condition is checked against: the raw text and its normalized form. */
function candidates(txn: TxnLike, field: RuleField): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    if (!s) return;
    out.push(s);
    const n = normalizeDescription(s);
    if (n && n !== s.toUpperCase()) out.push(n);
  };
  if (field === 'description' || field === 'any') add(txn.description);
  if (field === 'payee' || field === 'any') add(txn.payee);
  return out;
}

/** Does this single rule's every condition hold for the transaction? (enabled is not checked) */
export function ruleMatches(rule: RuleLike, txn: TxnLike): boolean {
  const amount = Money.of(txn.amount);
  const dir = (rule.direction ?? 'any') as RuleDirection;
  if (dir === 'in' && !amount.greaterThan(0)) return false;
  if (dir === 'out' && !amount.lessThan(0)) return false;
  if (rule.bankAccountId && txn.bankAccountId && rule.bankAccountId !== txn.bankAccountId) return false;
  if (rule.bankAccountId && !txn.bankAccountId) return false;
  const abs = amount.abs();
  if (rule.amountMin != null && rule.amountMin !== '' && abs.lessThan(Money.of(rule.amountMin))) return false;
  if (rule.amountMax != null && rule.amountMax !== '' && abs.greaterThan(Money.of(rule.amountMax))) return false;

  const field = rule.matchField as RuleField;
  const op = (RULE_OPERATORS as string[]).includes(rule.matchOperator) ? (rule.matchOperator as RuleOperator) : 'contains';
  const want = (rule.matchValue ?? '').trim();
  if (!want) return true; // amount / direction / account-only rule
  if (field === 'amount') {
    // Legacy amount rules: compare numerically (signed as typed, or absolute when unsigned).
    let target;
    try {
      target = Money.of(want);
    } catch {
      return false;
    }
    return want.startsWith('-') || want.startsWith('+') ? amount.equals(target) : abs.equals(target.abs());
  }
  return candidates(txn, field).some((v) => textMatches(v, op, want));
}

/** Precedence: higher priority first; ties → the older rule first (then name for stability). */
export function sortRules<T extends RuleLike>(rules: T[]): T[] {
  const time = (r: RuleLike) => (r.createdAt ? new Date(r.createdAt).getTime() : 0);
  return [...rules].sort(
    (a, b) => b.priority - a.priority || time(a) - time(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/** The first enabled, active rule (in precedence order) whose conditions hold, or null. */
export function pickRule<T extends RuleLike>(rules: T[], txn: TxnLike): T | null {
  for (const r of sortRules(rules)) {
    if (r.enabled === false || r.isActive === false) continue;
    if (ruleMatches(r, txn)) return r;
  }
  return null;
}

/** Validate split percentages: ≥ 2 lines, each > 0, summing to exactly 100. Returns an error or null. */
export function splitError(splits: RuleSplit[] | null | undefined): string | null {
  if (!splits || splits.length === 0) return null;
  if (splits.length < 2) return 'A split needs at least two lines.';
  let total = Money.zero();
  for (const s of splits) {
    if (!s.accountId) return 'Every split line needs an account.';
    let p;
    try {
      p = Money.of(s.percent);
    } catch {
      return 'Split percentages must be numbers.';
    }
    if (!p.greaterThan(0)) return 'Split percentages must be more than 0.';
    if (p.decimalPlaces() > 4) return 'Use at most 4 decimal places in split percentages.';
    total = total.plus(p);
  }
  if (!total.equals(100)) return `Split percentages must add up to 100 (they add up to ${total.toString()}).`;
  return null;
}

// ---------------------------------------------------------------------------
// Confidence math
// ---------------------------------------------------------------------------

/** A past categorization of the same pattern. */
export interface HistoryEvent {
  accountId: string;
  classId: string | null;
  createdAt: Date;
}

export interface HistoryVote {
  accountId: string;
  classId: string | null;
  /** How many times this exact choice was made. */
  count: number;
  /** Total past categorizations of the pattern (all choices). */
  total: number;
  /** 0..1 */
  confidence: number;
}

/** Recency half-life for history weights. */
export const HISTORY_HALF_LIFE_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * History signal: each past choice weighs 0.5^(age / 90 days). The winning choice's share of the
 * total weight is scaled by how often it was chosen (1×: 0.65, 2×: 0.75, 3×: 0.85, 4+×: 0.95,
 * capped 0.97) and by how recent the latest choice is (older than a year fades, floor 0.7).
 */
export function historyConfidence(events: HistoryEvent[], now: Date = new Date()): HistoryVote | null {
  if (events.length === 0) return null;
  const groups = new Map<string, { accountId: string; classId: string | null; weight: number; count: number; last: number }>();
  let totalWeight = 0;
  for (const e of events) {
    const age = Math.max(0, (now.getTime() - e.createdAt.getTime()) / DAY_MS);
    const w = Math.pow(0.5, age / HISTORY_HALF_LIFE_DAYS);
    totalWeight += w;
    const key = `${e.accountId}|${e.classId ?? ''}`;
    const g = groups.get(key) ?? { accountId: e.accountId, classId: e.classId, weight: 0, count: 0, last: 0 };
    g.weight += w;
    g.count += 1;
    g.last = Math.max(g.last, e.createdAt.getTime());
    groups.set(key, g);
  }
  const best = [...groups.values()].sort((a, b) => b.weight - a.weight || b.count - a.count || b.last - a.last)[0];
  const share = totalWeight > 0 ? best.weight / totalWeight : 0;
  const countFactor = Math.min(0.97, 0.55 + 0.1 * best.count);
  const daysSince = (now.getTime() - best.last) / DAY_MS;
  const recency = Math.max(0.7, Math.min(1, Math.pow(0.5, Math.max(0, daysSince - 365) / 365)));
  return {
    accountId: best.accountId,
    classId: best.classId,
    count: best.count,
    total: events.length,
    confidence: round4(share * countFactor * recency),
  };
}

export type SignalSource = 'rule' | 'history' | 'ai';

export interface Signal {
  source: SignalSource;
  accountId: string;
  classId?: string | null;
  /** 0..1 */
  confidence: number;
  reason: string;
}

export interface Combined {
  accountId: string;
  classId: string | null;
  /** 0..100 integer percent. */
  confidence: number;
  source: SignalSource;
  /** Every signal that agrees with the pick, strongest first. */
  agreeing: SignalSource[];
  reason: string;
}

/** Rule matches are the strongest signal (explicit user instruction). */
export const RULE_CONFIDENCE = 0.98;
/** AI is never trusted beyond this on its own (its self-reported confidence is not calibrated). */
export const AI_CONFIDENCE_CAP = 0.85;
/** Bulk "Accept all high-confidence" threshold. */
export const HIGH_CONFIDENCE = 90;

/**
 * Merge rule / history / AI signals into one suggestion:
 *  - a rule wins outright (98%, 99% when history or AI agrees);
 *  - otherwise signals for the same account combine as independent evidence
 *    (1 − Π(1 − c), capped 99%), and the best-supported account is picked;
 *  - a competing account pulls confidence down by a quarter of its own strength.
 */
export function combineSignals(signals: Signal[]): Combined | null {
  const usable = signals
    .filter((s) => s.accountId && s.confidence > 0)
    .map((s) => ({ ...s, confidence: s.source === 'ai' ? Math.min(s.confidence, AI_CONFIDENCE_CAP) : Math.min(s.confidence, 1) }));
  if (usable.length === 0) return null;

  const rule = usable.find((s) => s.source === 'rule');
  if (rule) {
    const agree = usable.filter((s) => s !== rule && s.accountId === rule.accountId);
    return {
      accountId: rule.accountId,
      classId: rule.classId ?? null,
      confidence: toPercent(
        agree.length ? Math.min(0.99, 1 - agree.reduce((acc, s) => acc * (1 - s.confidence), 1 - rule.confidence)) : rule.confidence,
      ),
      source: 'rule',
      agreeing: ['rule', ...agree.map((a) => a.source)],
      reason: [rule.reason, ...agree.map((a) => a.reason)].join(' · '),
    };
  }

  const byAccount = new Map<string, typeof usable>();
  for (const s of usable) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);
  const scored = [...byAccount.entries()].map(([accountId, list]) => {
    const sorted = [...list].sort((a, b) => b.confidence - a.confidence);
    const p = Math.min(0.99, 1 - sorted.reduce((acc, s) => acc * (1 - s.confidence), 1));
    return { accountId, list: sorted, p };
  });
  scored.sort((a, b) => b.p - a.p);
  const [best, runnerUp] = scored;
  const conf = Math.max(0, best.p - (runnerUp ? 0.25 * runnerUp.p : 0));
  const lead = best.list[0];
  const classId = best.list.find((s) => s.classId)?.classId ?? null;
  return {
    accountId: best.accountId,
    classId,
    confidence: toPercent(conf),
    source: lead.source,
    agreeing: best.list.map((s) => s.source),
    reason:
      best.list.map((s) => s.reason).join(' · ') +
      (runnerUp ? ` · but ${runnerUp.list[0].reason.charAt(0).toLowerCase()}${runnerUp.list[0].reason.slice(1)}` : ''),
  };
}

export function toPercent(p: number): number {
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Learning threshold: offer a rule once the same pattern went to the same place this many times. */
export const LEARN_THRESHOLD = 2;
