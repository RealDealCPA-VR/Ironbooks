/**
 * Redaction for CLOUD model calls.
 *
 * Before any message leaves the machine for a cloud model, personal / sensitive data is
 * replaced with stable placeholders ("[CUSTOMER_1]", "[EMAIL_2]", …) and restored in the
 * model's reply. Local (loopback / LAN / tailnet) providers receive unredacted text.
 *
 * Two layers:
 *  1. Known entities from the company file (customer / vendor / employee names, their
 *     emails, phones and street addresses) — matched case-insensitively on word boundaries,
 *     longest first, so "Acme Corp East" wins over "Acme Corp".
 *  2. Pattern detectors for anything not in the lists: emails, SSN/ITIN, EIN, labeled tax
 *     ids, card numbers (Luhn-checked), IBANs, phone numbers, street addresses / PO boxes,
 *     labeled account/routing numbers and long digit runs.
 *
 * Protected spans (UUIDs, ISO dates, existing placeholders) are never touched, and money
 * amounts ("1,234.56", "12345678.90") are not mistaken for account numbers — the
 * assistant's numbers and record ids must survive the round trip.
 *
 * Placeholders are stable within a Redactor instance: the same value always maps to the
 * same placeholder, so a multi-turn conversation stays coherent.
 */

export type RedactionKind =
  | 'CUSTOMER'
  | 'VENDOR'
  | 'EMPLOYEE'
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'SSN'
  | 'EIN'
  | 'TAXID'
  | 'CARD'
  | 'IBAN'
  | 'ACCOUNT'
  | 'ADDRESS';

const KINDS: RedactionKind[] = [
  'CUSTOMER', 'VENDOR', 'EMPLOYEE', 'PERSON', 'EMAIL', 'PHONE', 'SSN', 'EIN', 'TAXID',
  'CARD', 'IBAN', 'ACCOUNT', 'ADDRESS',
];

export interface KnownEntity {
  text: string;
  kind: RedactionKind;
}

interface Span {
  start: number;
  end: number;
  kind: RedactionKind;
  original: string;
  /** Placeholder already assigned to this value by an earlier redact() call. */
  placeholder?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const onlyDigits = (s: string) => s.replace(/\D/g, '');

/** Spans that must never be altered. */
const PROTECTED: RegExp[] = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuids
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, // ISO dates
  /\[(?:CUSTOMER|VENDOR|EMPLOYEE|PERSON|EMAIL|PHONE|SSN|EIN|TAXID|CARD|IBAN|ACCOUNT|ADDRESS)_\d+\]/g,
];

const STREET_SUFFIX =
  'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Square|Sq|Trail|Trl|Plaza|Alley|Loop';

interface Detector {
  kind: RedactionKind;
  re: RegExp;
  /** Capture group holding the sensitive part (default: whole match). */
  group?: number;
  accept?: (value: string) => boolean;
}

/** Ordered most-specific first; earlier detectors win overlaps. */
const DETECTORS: Detector[] = [
  { kind: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    // Labeled tax ids: "SSN 123456789", "EIN: 12-3456789", "Tax ID #123-45-6789"
    kind: 'TAXID',
    // The capture tries the valid 9-digit shapes FIRST (SSN 3-2-4, EIN 2-7, each ending on a
    // digit boundary that is not a decimal fraction), so a trailing number ("SSN 123 45 6789 2
    // dependents") can't make a greedy capture overshoot to 10 digits and fail the check. The
    // loose form stays as a fallback for odd groupings (still exactly 9 digits after `accept`).
    re: /\b(?:SSN|ITIN|TIN|EIN|FEIN|tax\s*id|social\s+security(?:\s+(?:no\.?|number|#))?)\b\s*(?:#|no\.?|number)?\s*[:#]?\s*((?:\d{3}[ .-]?\d{2}[ .-]?\d{4}|\d{2}[ .-]?\d{7})(?!\d|[.,]\d)|\d[\d .-]{7,12}\d)/gi,
    group: 1,
    // Exactly 9 digits, and never a money amount ("EIN 1234567.89").
    accept: (v) => onlyDigits(v).length === 9 && !/[.,]\d{1,2}$/.test(v),
  },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, accept: (v) => v.replace(/\s/g, '').length >= 15 },
  {
    kind: 'CARD',
    re: /(?<![\d.,])(?:\d[ -]?){12,18}\d(?![\d]|[.,]\d)/g,
    accept: (v) => {
      const d = onlyDigits(v);
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  { kind: 'SSN', re: /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g },
  // Unlabeled SSN written with spaces: "123 45 6789" (not part of a longer digit sequence).
  // Only a single plain space joins digit groups; a tab or newline next to a digit (TSV
  // columns, line breaks) is a field boundary, not part of the number.
  { kind: 'SSN', re: /(?<![\d.,]|\d )\d{3} \d{2} \d{4}(?!\d|[.,]\d| \d)/g },
  // Unlabeled SSN written with dots: "123.45.6789" (not part of a longer dotted number).
  { kind: 'SSN', re: /(?<![\d.,])\d{3}\.\d{2}\.\d{4}(?!\d|[.,]\d)/g },
  { kind: 'EIN', re: /(?<![\d-])\d{2}-\d{7}(?![\d-])/g },
  {
    kind: 'PHONE',
    re: /(?<![\w+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w])/g,
  },
  {
    kind: 'PHONE',
    re: /(?<![\w])\+\d{1,3}(?:[\s.-]?\d{2,4}){2,5}(?![\w])/g,
    accept: (v) => onlyDigits(v).length >= 8 && !/[.,]\d{2}$/.test(v),
  },
  {
    kind: 'ADDRESS',
    re: new RegExp(
      `\\b\\d{1,6}(?:-\\d+)?\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Za-z0-9'.-]+\\s+){0,4}(?:${STREET_SUFFIX})\\b\\.?(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\\.?\\s*[A-Za-z0-9-]+)?`,
      'gi',
    ),
  },
  { kind: 'ADDRESS', re: /\bP\.?\s?O\.?\s*Box\s+\d+/gi },
  {
    // Labeled account / routing numbers of 6+ digits (chart-of-accounts codes are shorter).
    kind: 'ACCOUNT',
    re: /\b(?:acct|account|a\/c|routing|aba|bank\s+account)\b\.?\s*(?:#|no\.?|number|num)?\s*[:#]?\s*([x*•]*\d[\d -]{4,}\d)/gi,
    group: 1,
    accept: (v) => onlyDigits(v).length >= 6,
  },
  {
    // Bare long digit runs (8–17) that are not money ("12345678.90") or part of a number.
    kind: 'ACCOUNT',
    re: /(?<![\d$.,])\d{8,17}(?![\d]|[.,]\d)/g,
  },
];

function normalizeKey(kind: RedactionKind, value: string): string {
  if (['PHONE', 'SSN', 'EIN', 'TAXID', 'CARD', 'ACCOUNT'].includes(kind)) return `${kind}:${onlyDigits(value)}`;
  return `${kind}:${value.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/** Known-entity kinds that are identifiers matched on digits rather than as text. */
const NUMERIC_KINDS = new Set<RedactionKind>(['PHONE', 'SSN', 'EIN', 'TAXID', 'ACCOUNT', 'CARD']);
/** Shorter known numbers (e.g. "4567") would shred amounts and account codes. */
const MIN_NUMERIC_ENTITY_DIGITS = 6;

/** Entities from the person/organization lists all share their own kind's counter. */
export class Redactor {
  private readonly entities: { re: RegExp; kind: RedactionKind; numeric: boolean }[];
  private readonly byKey = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters = new Map<RedactionKind, number>();

  constructor(entities: KnownEntity[] = []) {
    const seen = new Set<string>();
    const cleaned = entities
      .map((e) => {
        const text = (e.text ?? '').replace(/\s+/g, ' ').trim();
        // Phones / tax ids / account numbers are matched on their digits, whatever the
        // separators ("555-0100" ≈ "555 0100" ≈ "5550100").
        const digits = NUMERIC_KINDS.has(e.kind) ? onlyDigits(text) : '';
        return { kind: e.kind, text, digits };
      })
      .filter((e) =>
        NUMERIC_KINDS.has(e.kind)
          ? e.digits.length >= MIN_NUMERIC_ENTITY_DIGITS
          : // Too-short or purely numeric "names" would shred ordinary text.
            e.text.length >= 3 && !/^[\d\s.,-]+$/.test(e.text),
      )
      .filter((e) => {
        const k = e.digits ? `#${e.digits}` : e.text.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => (b.digits || b.text).length - (a.digits || a.text).length);
    this.entities = cleaned.map((e) => ({
      kind: e.kind,
      numeric: !!e.digits,
      // Digits may be joined by spaces, dots, dashes or parens ("123.45.6789"). Money amounts
      // stay safe through the boundary guards plus the post-match check in redact() that
      // rejects a match ending in a decimal fraction ("$1234567.89").
      re: e.digits
        ? new RegExp(
            `(?<![\\d.,])${e.digits.split('').join('[\\s.()-]*')}(?![\\d]|[.,]\\d)`,
            'g',
          )
        : new RegExp(
            `(?<![A-Za-z0-9])${e.text.split(' ').map(escapeRegex).join('\\s+')}(?![A-Za-z0-9])`,
            'gi',
          ),
    }));
  }

  /** Number of distinct values replaced so far. */
  get size(): number {
    return this.byPlaceholder.size;
  }

  private placeholderFor(kind: RedactionKind, original: string): string {
    const key = normalizeKey(kind, original);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const ph = `[${kind}_${n}]`;
    this.byKey.set(key, ph);
    this.byPlaceholder.set(ph, original);
    return ph;
  }

  /** Replace sensitive values in `text` with placeholders. */
  redact(input: string): string {
    if (!input) return input;
    // Detection runs on a same-length copy in which non-breaking / figure / thin / narrow
    // no-break spaces (common in text pasted from PDFs or the web) are plain spaces, so the
    // detectors' literal ' ' matches them. Offsets carry over 1:1; replaced values and the
    // untouched text are always sliced from `input`.
    // Normalization: every Unicode space separator (\p{Zs}: NBSP, en / em / figure / thin /
    // punctuation / ideographic spaces, \u2026) becomes a plain space; line / paragraph separators
    // (\p{Zl}, \p{Zp}) become newlines (field boundaries, like '\n'); zero-width spaces / joiners
    // and the BOM, invisible characters that can split a number, become spaces. Each of these
    // is a single UTF-16 unit, so the copy keeps the same length.
    const text = input
      .replace(/[\p{Zl}\p{Zp}]/gu, '\n')
      .replace(/[\p{Zs}\u200B-\u200D\u2060\uFEFF]/gu, ' ');
    const taken: Array<[number, number]> = [];
    const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

    for (const re of PROTECTED) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) taken.push([m.index!, m.index! + m[0].length]);
    }
    const spans: Span[] = [];
    const add = (start: number, end: number, kind: RedactionKind) => {
      if (end <= start || overlaps(start, end)) return;
      taken.push([start, end]);
      spans.push({ start, end, kind, original: input.slice(start, end) });
    };

    // Values this instance already replaced are re-redacted verbatim (longest first), whatever
    // detector first found them. A value detected only through its context ("acct # 123456")
    // would otherwise slip through when it reappears without that context.
    if (this.byPlaceholder.size > 0) {
      const known = [...this.byPlaceholder.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [placeholder, original] of known) {
        if (!original.trim()) continue;
        const body = original.trim().split(/\s+/).map(escapeRegex).join('\\s+');
        const re = /^\d|\d$/.test(original.trim())
          ? new RegExp(`(?<![\\d.,])${body}(?![\\d]|[.,]\\d)`, 'g')
          : new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi');
        for (const m of text.matchAll(re)) {
          const start = m.index!;
          const end = start + m[0].length;
          if (end <= start || overlaps(start, end)) continue;
          taken.push([start, end]);
          spans.push({ start, end, kind: 'PERSON', original: input.slice(start, end), placeholder });
        }
      }
    }

    for (const ent of this.entities) {
      ent.re.lastIndex = 0;
      for (const m of text.matchAll(ent.re)) {
        // A digit-matched entity never ends on a decimal fraction: "55501.00" is a money
        // amount, not the phone 555-0100.
        if (ent.numeric && /[.,]\d{1,2}$/.test(m[0])) continue;
        add(m.index!, m.index! + m[0].length, ent.kind);
      }
    }

    for (const det of DETECTORS) {
      const re = new RegExp(det.re.source, det.re.flags.includes('d') ? det.re.flags : det.re.flags + 'd');
      for (const m of text.matchAll(re)) {
        const g = det.group ?? 0;
        const value = m[g];
        if (!value) continue;
        const idx = (m as RegExpMatchArray & { indices?: Array<[number, number]> }).indices?.[g];
        if (!idx) continue;
        // Trim trailing separators captured by greedy digit groups.
        let [s, e] = idx;
        while (e > s && /[\s.-]/.test(text[e - 1])) e--;
        const v = text.slice(s, e);
        if (det.accept && !det.accept(v)) continue;
        add(s, e, det.kind);
      }
    }

    if (spans.length === 0) return input;
    spans.sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const sp of spans) {
      out += input.slice(pos, sp.start) + (sp.placeholder ?? this.placeholderFor(sp.kind, sp.original));
      pos = sp.end;
    }
    return out + input.slice(pos);
  }

  /** Put the original values back. Tolerates a model dropping the brackets. */
  restore(text: string): string {
    if (!text || this.byPlaceholder.size === 0) return text;
    let out = text.replace(/\[([A-Z]+)_(\d+)\]/g, (whole) => this.byPlaceholder.get(whole) ?? whole);
    out = out.replace(/\b([A-Z]+)_(\d+)\b/g, (whole, kind: string, n: string) => {
      if (!KINDS.includes(kind as RedactionKind)) return whole;
      return this.byPlaceholder.get(`[${kind}_${n}]`) ?? whole;
    });
    return out;
  }

  /** Restore every string inside a parsed JSON value. */
  restoreDeep<T>(value: T): T {
    if (typeof value === 'string') return this.restore(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.restoreDeep(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.restoreDeep(v);
      return out as T;
    }
    return value;
  }
}

/** Collect redaction entities from a free-form address object (jsonb). */
export function addressEntities(addr: Record<string, unknown> | null | undefined): KnownEntity[] {
  if (!addr || typeof addr !== 'object') return [];
  const out: KnownEntity[] = [];
  for (const [k, v] of Object.entries(addr)) {
    if (typeof v !== 'string') continue;
    if (/^(line\d?|street\d?|address\d?|addr\d?)$/i.test(k) && v.trim().length >= 5) {
      out.push({ text: v, kind: 'ADDRESS' });
    }
  }
  return out;
}
