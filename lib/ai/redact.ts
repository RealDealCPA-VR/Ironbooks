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
    re: /\b(?:SSN|ITIN|TIN|EIN|FEIN|tax\s*id|social\s+security(?:\s+(?:no\.?|number|#))?)\b\s*(?:#|no\.?|number)?\s*[:#]?\s*(\d[\d -]{7,12}\d)/gi,
    group: 1,
    accept: (v) => onlyDigits(v).length === 9,
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

/** Entities from the person/organization lists all share their own kind's counter. */
export class Redactor {
  private readonly entities: { re: RegExp; kind: RedactionKind }[];
  private readonly byKey = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters = new Map<RedactionKind, number>();

  constructor(entities: KnownEntity[] = []) {
    const seen = new Set<string>();
    const cleaned = entities
      .map((e) => ({ kind: e.kind, text: (e.text ?? '').replace(/\s+/g, ' ').trim() }))
      // Too-short or purely numeric "names" would shred ordinary text.
      .filter((e) => e.text.length >= 3 && !/^[\d\s.,-]+$/.test(e.text))
      .filter((e) => {
        const k = e.text.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.text.length - a.text.length);
    this.entities = cleaned.map((e) => ({
      kind: e.kind,
      re: new RegExp(
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
  redact(text: string): string {
    if (!text) return text;
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
      spans.push({ start, end, kind, original: text.slice(start, end) });
    };

    for (const ent of this.entities) {
      ent.re.lastIndex = 0;
      for (const m of text.matchAll(ent.re)) add(m.index!, m.index! + m[0].length, ent.kind);
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
        while (e > s && /[\s-]/.test(text[e - 1])) e--;
        const v = text.slice(s, e);
        if (det.accept && !det.accept(v)) continue;
        add(s, e, det.kind);
      }
    }

    if (spans.length === 0) return text;
    spans.sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const sp of spans) {
      out += text.slice(pos, sp.start) + this.placeholderFor(sp.kind, sp.original);
      pos = sp.end;
    }
    return out + text.slice(pos);
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
