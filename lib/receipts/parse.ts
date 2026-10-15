/**
 * Receipt text parser (receipt capture). Pure — no I/O — so it can be tested against many
 * real-world layouts and runs the same for PDF text, offline OCR output and phone photos.
 *
 * Input is the plain text of a receipt / vendor invoice (lines in reading order). Output is the
 * fields a bookkeeper needs to enter the purchase: who was paid, when, how much, how much of
 * that was sales tax, and the last four digits of the card used. Every field carries a
 * confidence (0-1) so the review screen can flag guesses. Money stays in decimal strings
 * (lib/money); nothing here uses floating point for amounts.
 *
 * The parser is deliberately conservative: a field it is not reasonably sure about is null,
 * and the person fills it in on the review screen.
 */
import Decimal from 'decimal.js';

export interface ParsedReceipt {
  vendorName: string | null;
  /** ISO day (yyyy-mm-dd). */
  date: string | null;
  /** 2dp decimal string. */
  total: string | null;
  subtotal: string | null;
  tax: string | null;
  /** Last four digits of the card used. */
  cardLast4: string | null;
  /** Card brand when printed (Visa, Mastercard, Amex, Discover, ...). */
  cardBrand: string | null;
  /** Vendor's invoice / receipt number when printed. */
  reference: string | null;
  confidence: {
    vendorName: number;
    date: number;
    total: number;
    tax: number;
    cardLast4: number;
  };
}

export interface ParseOptions {
  /** Day/month order for ambiguous numeric dates such as 03/04/2026 (default 'mdy', US). */
  dateOrder?: 'mdy' | 'dmy';
  /** "Today" for rejecting future dates (tests pass a fixed day). */
  today?: Date;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Money tokens: $1,234.56 · 1234.56 · 1 234,56 € · (12.50) · 12.50- · USD 9.99 · 9,99.
 * Requires exactly two decimals so quantities, store numbers and phone numbers never match.
 */
const MONEY_RE =
  /(?:^|[^\d.,])(\(?-?)\s*(?:[$€£¥]|USD|CAD|EUR|GBP|AUD)?\s*(\d{1,3}(?:[,. \u00a0]\d{3})+|\d+)([.,])(\d{2})(?!\d)(?:\s*(\)|-|CR\b))?/gi;

/** Every money amount on a line, left to right, as 2dp strings (negative when shown so). */
export function amountsInLine(line: string): string[] {
  const out: string[] = [];
  MONEY_RE.lastIndex = 0;
  for (let m = MONEY_RE.exec(line); m; m = MONEY_RE.exec(line)) {
    const [, open, intPart, sep, cents, close] = m;
    // "1.234,56" or "1,234.56": the thousands separator must differ from the decimal one.
    const groups = intPart.replace(/[ \u00a0]/g, sep === ',' ? '.' : ',');
    if (sep === ',' && /,/.test(groups)) continue; // 1,234,56 — not a real amount
    if (sep === '.' && /\./.test(groups)) continue; // 1.234.56
    const digits = groups.replace(/[.,]/g, '');
    let value = new Decimal(`${digits}.${cents}`);
    const negative = open.includes('-') || (open.includes('(') && close === ')') || close === '-' || /^cr$/i.test(close ?? '');
    if (negative) value = value.negated();
    out.push(value.toFixed(2));
  }
  return out;
}

/** The last amount on a line (receipts print the amount at the right). */
function lastAmount(line: string): string | null {
  const a = amountsInLine(line);
  return a.length ? a[a.length - 1] : null;
}

/** The amount on this line, or on the next line when the label stands alone ("TOTAL\n$22.79"). */
function amountAt(lines: string[], i: number): string | null {
  const own = lastAmount(stripPercent(lines[i]));
  if (own !== null) return own;
  const next = lines[i + 1];
  if (next !== undefined && /^[\s$€£¥(\-]*[\d.,\s]+[)\-]?\s*(USD|CAD|EUR|GBP)?\s*$/i.test(next)) return lastAmount(next);
  return null;
}

/** "6.25%" / "8.875 %" would otherwise read as an amount. */
function stripPercent(line: string): string {
  return line.replace(/\d+(?:[.,]\d+)?\s*%/g, ' ');
}

// ---------------------------------------------------------------------------
// Total / subtotal / tax
// ---------------------------------------------------------------------------

type Kind = 'grand' | 'total' | 'due' | 'paid';

const NOT_TOTAL =
  /sub\s*-?\s*total|total\s*(savings|saved|discount|items?|qty|quantity|units|tips?\s*suggest|points|before|excl|pre-?tax|tax\b|vat\b|gst\b|hst\b|weight|number of)|(savings|discount|you saved|points|previous|prior|last)\s.*total|tax\s*total|total\s*tax|#\s*items|items?\s*sold/i;

function totalKind(line: string): Kind | null {
  const l = line.toLowerCase();
  if (NOT_TOTAL.test(l)) return null;
  if (/grand\s*total|total\s*(amount\s*)?(due|payable|charged|to pay)|invoice\s*total|order\s*total|total\s*sale|total\s*purchase|amount\s*charged|total\s*(usd|cad|eur|gbp)|total\s*incl/.test(l)) return 'grand';
  if (/\btotal\b|\bttl\b|\btotl\b/.test(l)) return 'total';
  if (/balance\s*due|amount\s*due|amount\s*payable|net\s*payable|please\s*pay|\bdue\b\s*[:$]/.test(l)) return 'due';
  if (/amount\s*paid|total\s*paid|\bpaid\b|\bcharged?\b|\bpurchase\b\s*[:$]|\bsale\s*amount|\bamount\b\s*[:$]?\s*[$€£]?\s*\d/.test(l)) return 'paid';
  return null;
}

const KIND_RANK: Record<Kind, number> = { grand: 4, total: 3, due: 2, paid: 1 };

/** Lines like "CASH 50.00" / "CHANGE 27.21" — tendered and change amounts are never the total. */
const TENDER_RE = /\b(cash|change|tendered|tender|rounding|tip\s*suggest|gratuity\s*suggest)\b/i;

function findTotal(lines: string[]): { value: string | null; confidence: number } {
  let best: { value: string; rank: number; idx: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const kind = totalKind(lines[i]);
    if (!kind) continue;
    if (TENDER_RE.test(lines[i]) && kind !== 'grand') continue;
    const value = amountAt(lines, i);
    if (value === null || new Decimal(value).lte(0)) continue;
    const rank = KIND_RANK[kind];
    // Higher rank wins; on a tie the LATER line wins (the final total follows partial totals).
    if (!best || rank > best.rank || (rank === best.rank && i > best.idx)) best = { value, rank, idx: i };
  }
  if (best) return { value: best.value, confidence: best.rank >= 3 ? 0.9 : 0.7 };
  return { value: null, confidence: 0 };
}

function findSubtotal(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/sub\s*-?\s*total|total\s*before\s*tax|net\s*amount|amount\s*before\s*tax|total\s*excl/i.test(lines[i])) {
      const v = amountAt(lines, i);
      if (v !== null) return v;
    }
  }
  return null;
}

const TAX_LABEL = /\b(sales\s*tax|tax|hst|gst|pst|qst|vat|iva|tva|tps|tvq|mwst|ust|moms|use\s*tax|state\s*tax|city\s*tax|county\s*tax|local\s*tax)\b/i;
const NOT_TAX = /tax\s*(id|no\b|number|#|reg|exempt\s*(id|no|#|number))|tin\b|ein\b|before\s*tax|pre-?tax|excl(uding)?\.?\s*(tax|vat|gst)|tax\s*invoice|total\s*incl|incl(uding)?\.?\s*(tax|vat|gst)\s*$|non-?tax|taxable\s*(amount|sales|subtotal)|tax\s*free/i;

function findTax(lines: string[]): { value: string | null; confidence: number } {
  // A "Total tax" line is authoritative; otherwise add up the individual tax lines (TAX1 + TAX2,
  // GST + PST, state + city).
  for (const line of lines) {
    if (/total\s*(sales\s*)?tax|tax\s*total|total\s*(vat|gst|hst)/i.test(line) && !NOT_TAX.test(line)) {
      const v = lastAmount(stripPercent(line));
      if (v !== null) return { value: v, confidence: 0.9 };
    }
  }
  let sum = new Decimal(0);
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TAX_LABEL.test(line) || NOT_TAX.test(line) || totalKind(line) === 'grand') continue;
    const v = amountAt(lines, i);
    if (v === null) continue;
    sum = sum.plus(v);
    found += 1;
  }
  if (!found) return { value: null, confidence: 0 };
  return { value: sum.toFixed(2), confidence: found === 1 ? 0.85 : 0.75 };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

interface DateHit {
  iso: string;
  idx: number;
  labelled: boolean;
  ambiguous: boolean;
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // Feb 30
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function datesInLine(line: string, order: 'mdy' | 'dmy'): Array<{ iso: string; ambiguous: boolean }> {
  const out: Array<{ iso: string; ambiguous: boolean }> = [];
  const push = (v: string | null, ambiguous = false) => {
    if (v) out.push({ iso: v, ambiguous });
  };
  // 2026-03-14 · 2026/03/14 · 2026.03.14
  for (const m of line.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) push(iso(+m[1], +m[2], +m[3]));
  // 03/14/2026 · 14/03/2026 · 3-14-26 · 03.14.26
  for (const m of line.matchAll(/(?<![\d/.-])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?![\d/.-]|\.\d)/g)) {
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    if (a > 12 && b <= 12) push(iso(y, b, a));
    else if (b > 12 && a <= 12) push(iso(y, a, b));
    else push(order === 'dmy' ? iso(y, b, a) : iso(y, a, b), a !== b);
  }
  // Mar 14, 2026 · March 14 2026 · MAR-14-2026
  for (const m of line.matchAll(new RegExp(`${MONTH_NAME}[\\s-]*(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?,?[\\s-]*(\\d{4}|'?\\d{2})(?!\\d)`, 'gi'))) {
    push(iso(+m[3].replace("'", ''), MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]));
  }
  // 14 Mar 2026 · 14-MAR-26 · 14th March, 2026
  for (const m of line.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*${MONTH_NAME}[\\s,-]*(\\d{4}|\\d{2})(?!\\d)`, 'gi'))) {
    push(iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]));
  }
  return out;
}

const DATE_LABEL = /\b(date|dated|transaction\s*date|trans\s*date|invoice\s*date|purchase\s*date|order\s*date|sale\s*date|issued|bill\s*date)\b/i;
const NOT_PURCHASE_DATE = /\b(due|expir|exp\b|valid|return|ship|deliver|next|member\s*since|best\s*before|use\s*by|period|from|through|to\s*date|birth)\b/i;

function findDate(lines: string[], opts: ParseOptions): { value: string | null; confidence: number } {
  const order = opts.dateOrder ?? 'mdy';
  const today = opts.today ?? new Date();
  const latest = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + 1)).toISOString().slice(0, 10);
  const hits: DateHit[] = [];
  lines.forEach((line, idx) => {
    if (NOT_PURCHASE_DATE.test(line) && !DATE_LABEL.test(line.replace(NOT_PURCHASE_DATE, ''))) return;
    for (const d of datesInLine(line, order)) {
      if (d.iso < '2000-01-01' || d.iso > latest) continue;
      hits.push({ iso: d.iso, idx, labelled: DATE_LABEL.test(line), ambiguous: d.ambiguous });
    }
  });
  if (!hits.length) return { value: null, confidence: 0 };
  const labelled = hits.find((h) => h.labelled);
  const pick = labelled ?? hits[0];
  let confidence = labelled ? 0.95 : 0.8;
  if (pick.ambiguous) confidence -= 0.15;
  return { value: pick.iso, confidence };
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

const BRANDS: Array<[RegExp, string]> = [
  [/\bvisa\b/i, 'Visa'],
  [/\b(master\s*card|mastercard|\bmc\b)/i, 'Mastercard'],
  [/\b(amex|american\s*express)\b/i, 'American Express'],
  [/\bdiscover\b/i, 'Discover'],
  [/\b(debit|interac)\b/i, 'Debit'],
];

function findCard(lines: string[]): { last4: string | null; brand: string | null; confidence: number } {
  const patterns: Array<[RegExp, number]> = [
    // ************4417 · XXXX XXXX XXXX 4417 · ....4417 · •••• 4417
    [/(?:[*xX•.#]{2,}[\s-]*){1,4}(\d{4})(?!\d)/, 0.95],
    // ending in 4417 · ends with 4417 · last 4: 4417 · last four digits 4417
    [/(?:ending\s*(?:in|with)?|ends\s*(?:in|with)|last\s*(?:4|four)(?:\s*digits)?)\s*[:#]?\s*(\d{4})(?!\d)/i, 0.9],
    // Card # 4417 · Acct: 4417 · VISA 4417 · AMEX x1234
    [/(?:card|acct|account|visa|mastercard|amex|discover|debit|credit)\s*(?:no\.?|number|#)?\s*[:#]?\s*[xX*]?(\d{4})(?!\d)/i, 0.7],
  ];
  for (const [re, confidence] of patterns) {
    for (const line of lines) {
      // Phone numbers, dates and times never count as card digits.
      if (/\b(tel|phone|fax|ph)\b/i.test(line)) continue;
      const m = re.exec(line);
      if (!m) continue;
      const brand = BRANDS.find(([b]) => b.test(line))?.[1] ?? lines.map((l) => BRANDS.find(([b]) => b.test(l))?.[1]).find(Boolean) ?? null;
      return { last4: m[1], brand, confidence };
    }
  }
  return { last4: null, brand: null, confidence: 0 };
}

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

const SKIP_VENDOR =
  /^(receipt|sales\s*receipt|customer\s*copy|merchant\s*copy|copy|invoice|tax\s*invoice|order|order\s*confirmation|thank\s*you|thanks|welcome|duplicate|original|transaction\s*record|purchase|sale|store|cashier|register|terminal|server|table|guests?|check|ticket|statement|bill\s*to|ship\s*to|sold\s*to|page\s*\d+)\b/i;
const ADDRESS_LIKE =
  /^\d+\s+\S+.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|ct|court|pl|place|suite|ste|unit)\b|^(p\.?o\.?\s*box)|\b[A-Z]{2}\s+\d{5}(-\d{4})?\b|^\d{5}(-\d{4})?$/i;
const CONTACT_LIKE = /(https?:\/\/|www\.|\.com\b|\.net\b|\.org\b|@|\btel\b|\bphone\b|\bfax\b|\(\d{3}\)\s*\d{3}|\d{3}[-.\s]\d{3}[-.\s]\d{4})/i;

/** "HOME DEPOT" → "Home Depot"; mixed-case names are kept as printed. */
export function tidyName(name: string): string {
  const s = name.replace(/\s{2,}/g, ' ').trim();
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/&(.'])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    .replace(/\b(Llc|Inc|Ltd|Co|Usa|Us|Ups|Usps|Atm|Cvs|Bp|Kfc)\b/g, (w) => w.toUpperCase())
    .replace(/'S\b/g, "'s");
}

function cleanVendor(line: string): string {
  return line
    .replace(/^(welcome\s+to|thank\s+you\s+for\s+shopping\s+(at|with)|thanks\s+for\s+shopping\s+(at|with))\s+/i, '')
    .replace(/\s*(store|str|loc|location|unit|shop)?\s*#\s*\d+.*$/i, '')
    .replace(/\s+(store|branch)\s+\d+.*$/i, '')
    .replace(/[|*=_~]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[,.:;-]+$/, '')
    .trim();
}

function findVendor(lines: string[]): { value: string | null; confidence: number } {
  // "Merchant: X" / "Vendor: X" / "Sold by X" / "From: X" are explicit.
  for (const line of lines.slice(0, 25)) {
    const m = /^\s*(merchant(?:\s*name)?|vendor|seller|sold\s*by|payee|store\s*name|business\s*name|from)\s*[:\-]\s*(.{2,80})$/i.exec(line);
    if (m) {
      const v = cleanVendor(m[2]);
      if (v && /[a-z]/i.test(v)) return { value: tidyName(v), confidence: 0.9 };
    }
  }
  // Otherwise the first line near the top that looks like a business name.
  for (const raw of lines.slice(0, 8)) {
    const line = raw.trim();
    if (line.length < 2) continue;
    const welcome = /^(welcome\s+to|thank\s+you\s+for\s+shopping\s+(at|with))\s+/i.test(line);
    if (!welcome && SKIP_VENDOR.test(line)) continue;
    if (ADDRESS_LIKE.test(line) || CONTACT_LIKE.test(line)) continue;
    if (amountsInLine(line).length) continue;
    if (datesInLine(line, 'mdy').length) continue;
    const letters = (line.match(/[a-z]/gi) ?? []).length;
    if (letters < 2 || letters / line.replace(/\s/g, '').length < 0.5) continue; // OCR noise / numbers
    const v = cleanVendor(line);
    if (v.length < 2 || !/[a-z]{2}/i.test(v)) continue;
    return { value: tidyName(v.slice(0, 120)), confidence: welcome ? 0.85 : 0.6 };
  }
  return { value: null, confidence: 0 };
}

function findReference(lines: string[]): string | null {
  for (const line of lines) {
    const m =
      /\b(?:invoice|inv|receipt|order|transaction|trans|txn|ref(?:erence)?|ticket|confirmation)\s*(?:no\.?|number|num|#|id)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,30})\b/i.exec(line);
    if (m && /\d/.test(m[1])) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Split raw text into trimmed, non-empty lines (handles \r\n and form feeds between PDF pages). */
export function receiptLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\t\u00a0]+/g, ' ').replace(/\s{2,}/g, '  ').trim())
    .filter((l) => l.length > 0);
}

export function parseReceiptText(text: string, opts: ParseOptions = {}): ParsedReceipt {
  const lines = receiptLines(text ?? '');
  const total = findTotal(lines);
  const subtotal = findSubtotal(lines);
  const tax = findTax(lines);
  const date = findDate(lines, opts);
  const card = findCard(lines);
  const vendor = findVendor(lines);

  let totalValue = total.value;
  let totalConfidence = total.confidence;
  // No labelled total but a subtotal and tax: the total is their sum.
  if (!totalValue && subtotal) {
    totalValue = new Decimal(subtotal).plus(tax.value ?? '0').toFixed(2);
    totalConfidence = tax.value ? 0.6 : 0.4;
  }
  // Last resort: the largest amount on the receipt (ignoring cash tendered / change lines).
  if (!totalValue) {
    let max: Decimal | null = null;
    for (const line of lines) {
      if (TENDER_RE.test(line)) continue;
      for (const a of amountsInLine(stripPercent(line))) {
        const d = new Decimal(a);
        if (d.gt(0) && (!max || d.gt(max))) max = d;
      }
    }
    if (max) {
      totalValue = max.toFixed(2);
      totalConfidence = 0.3;
    }
  }
  // A tax amount larger than the total is a misread; drop it.
  let taxValue = tax.value;
  if (taxValue && totalValue && new Decimal(taxValue).gte(totalValue)) taxValue = null;
  // Sanity boost: subtotal + tax = total means all three were read right.
  if (total.value && subtotal && taxValue && new Decimal(subtotal).plus(taxValue).equals(total.value)) {
    totalConfidence = Math.max(totalConfidence, 0.97);
  }

  return {
    vendorName: vendor.value,
    date: date.value,
    total: totalValue,
    subtotal,
    tax: taxValue,
    cardLast4: card.last4,
    cardBrand: card.brand,
    reference: findReference(lines),
    confidence: {
      vendorName: vendor.confidence,
      date: date.confidence,
      total: totalValue ? totalConfidence : 0,
      tax: taxValue ? tax.confidence : 0,
      cardLast4: card.confidence,
    },
  };
}
