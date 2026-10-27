/**
 * Bank file import service — parse, dedupe, and stage bank transactions.
 *
 * Supports OFX (Open Financial Exchange), QFX (Quicken/Web Connect — OFX with an Intuit
 * header), QBO (QuickBooks Online export, which is OFX/SGML), and CSV. Parsed rows land in
 * the `bank_transactions` staging table with `matched = false`.
 * Categorization rules are applied immediately to set `suggestedAccountId`.
 *
 * IMPORTANT: No GL posting happens here. The reconcile/match step handles posting.
 */
import { createHash } from 'node:crypto';

// papaparse has no bundled types and @types/papaparse is not installed.
// We import via require and declare only the surface we use.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Papa = require('papaparse') as {
  parse<T>(
    input: string,
    config?: {
      header?: boolean;
      skipEmptyLines?: boolean;
      transformHeader?: (header: string) => string;
    },
  ): { data: T[]; errors: Array<{ message: string }>; meta?: { fields?: string[] } };
};
import { and, eq } from 'drizzle-orm';
import { csvUnsafeText } from '@/lib/csv';
import { refreshPlannerStats } from '@/lib/db/plannerStats';
import { bankAccounts, bankTransactions, fileImports } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { listRules, matchRule } from './rules';
import { foreignCurrencyOfAccount } from './fxLedger';
import { homeCode } from './fxLines';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ParsedTransaction {
  /** OFX financial-institution transaction ID — used for dedupe. */
  fitId?: string;
  date: Date;
  description: string;
  /** Positive = credit to bank account (deposit); negative = debit (payment). */
  amount: string; // decimal string, stored directly in DB
  /** Payee from the file (CSV payee column, or a reviewed statement row). */
  payee?: string;
  /**
   * The date earlier versions stored for this line when it differs from `date` (OFX times of day,
   * CSV dates without a format read as local midnight). Only used to recognize rows imported before
   * the date fix as duplicates; never stored.
   */
  legacyDate?: Date;
  /**
   * The description / fitId cell exactly as earlier versions read it, when it differs (they did
   * not drop the formula-guard apostrophe our exports add: "'-ATM" vs "-ATM"). Only used for the
   * same duplicate check; never stored.
   */
  legacyDescription?: string;
  legacyFitId?: string;
}

/** 'qfx' (Quicken/Web Connect) is structurally identical to OFX and parsed the same way. */
export type FileType = 'ofx' | 'qfx' | 'qbo' | 'csv' | 'rows';

export interface CsvMapping {
  /** Column name or 0-based index for each field. */
  dateCol: string | number;
  descriptionCol: string | number;
  amountCol: string | number;
  /** If the file has separate debit/credit columns, provide both; amountCol is ignored. */
  debitCol?: string | number;
  creditCol?: string | number;
  fitIdCol?: string | number;
  /** Moment/date-fns-style format hint, e.g. "MM/DD/YYYY". */
  dateFormat?: string;
  /** Number of leading lines to drop BEFORE the header row (bank export preambles). */
  skipRows?: number;
  /** Flip the sign of every amount (for banks that export withdrawals as positive). */
  flipSign?: boolean;
  /** Optional payee column (kept as the line's payee, used by rules and suggestions). */
  payeeCol?: string | number;
  /** Optional memo column (added to the description). */
  memoCol?: string | number;
  /** Optional check number column (the description starts "Check #1234"). */
  checkNumberCol?: string | number;
}

export interface ImportSummary {
  fileImportId: string;
  parsed: number;
  imported: number;
  skippedDupes: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// OFX / QBO date parsing
// ---------------------------------------------------------------------------

/**
 * Parse an OFX DTPOSTED value. Formats observed in the wild:
 *   20240115120000.000[-5:EST]  (full with tz offset — we strip and parse as UTC)
 *   20240115120000
 *   20240115
 */
function parseOFXDate(raw: string): Date {
  // Strip everything after the dot (fractional seconds + tz annotation).
  // Also drop a "[tz]" annotation that directly follows the time (no fractional part).
  const clean = raw.trim().replace(/[.[].*$/, '');
  const year = Number(clean.slice(0, 4));
  const month = Number(clean.slice(4, 6));
  const day = Number(clean.slice(6, 8));
  if (!/^\d{8}/.test(clean) || month < 1 || month > 12 || day < 1 || day > 31) return new Date(NaN);
  // Date-only, UTC midnight of the posting day (the app's date convention). Keeping the time of
  // day (often 12:00:00) would push the line outside "as of <that day>" filters.
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * The date earlier versions stored for a DTPOSTED (time of day kept, read as UTC). Only used to
 * recognize lines imported before the date fix as duplicates (see importTransactions).
 */
function legacyOFXDate(raw: string): Date {
  const clean = raw.trim().replace(/\..*$/, '');
  const year = clean.slice(0, 4);
  const month = clean.slice(4, 6);
  const day = clean.slice(6, 8);
  const hour = clean.slice(8, 10) || '00';
  const min = clean.slice(10, 12) || '00';
  const sec = clean.slice(12, 14) || '00';
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
}

/** `legacy` when it is a valid date different from `date` (else undefined). */
function legacyIfDifferent(date: Date, legacy: Date): Date | undefined {
  return !isNaN(legacy.getTime()) && legacy.getTime() !== date.getTime() ? legacy : undefined;
}

// ---------------------------------------------------------------------------
// Amounts and calendar days
// ---------------------------------------------------------------------------

/**
 * A bank file's amount cell → a 2dp string: "1,234.56", "$1,234.56", "-12.50", "12.50-",
 * "(12.50)", "+5". `null` for a cell with no digits at all (blank, or the "-" / "—" / "N/A" some
 * banks print in an empty Debit or Credit cell); 'bad' for anything else that is not a number.
 * decimal.js reads "NaN" and "Infinity" as numbers, and Postgres stores NaN in a numeric
 * column, so a cell is only money when it really looks like money.
 */
export function readBankAmount(raw: unknown): string | null | 'bad' {
  if (typeof raw !== 'string' && typeof raw !== 'number') return raw == null ? null : 'bad';
  let s = String(raw).replace(/[\s $,]/g, '');
  if (!/\d/.test(s)) return s === '' || /^[-–—]+$|^n\/?a$/i.test(s) ? null : 'bad';
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return 'bad';
  const v = Money.round2(s);
  return toAmountString(neg && !v.isZero() ? v.negated() : v);
}

/** True when y-m-d (1-based month) names a real calendar day (no Feb 30, no 31 April). */
function isCalendarDay(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// OFX / QBO SGML parser (line-based; does NOT require XML conversion)
// ---------------------------------------------------------------------------

/**
 * Minimal recursive-descent parser for OFX/QBO SGML.
 *
 * Real-world OFX/QBO files use SGML with unclosed leaf tags — they cannot be
 * processed by an XML parser without a brittle regex-replacement pass that
 * re-breaks on its own output.  Instead we walk the file line-by-line:
 *   <CONTAINER>       → push a new object onto the stack
 *   </CONTAINER>      → pop back to parent
 *   <LEAF>value       → assign value to current object
 *
 * When the same leaf or container tag appears more than once at the same level
 * (as STMTTRN always does) we promote the value to an array automatically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OFXNode = Record<string, any>;

function parseOFXSgml(content: string): OFXNode {
  // Strip the text header that QuickBooks / most banks emit before <OFX>.
  const idx = content.search(/<OFX[\s>]/i);
  const body = idx === -1 ? content.trim() : content.slice(idx).trim();

  // Normalize: insert a line break before every tag so single-line SGML/XML files
  // become one-tag-per-line (semantically a no-op for already-multiline files).
  // Note ">\n<" alone would NOT be enough: in single-line SGML a leaf value is
  // followed directly by the next "<" with no ">" boundary (<TRNTYPE>DEBIT<DTPOSTED>…),
  // so we split before every "<". Stray close tags this produces for XML leafs
  // (e.g. "</NAME>" after "<NAME>ACME") are ignored by the close-tag handler below.
  const lines = body.replace(/</g, '\n<').split(/\r?\n/);
  // Stack entries: the object being built + the tag name that opened it.
  const stack: Array<{ tag: string; obj: OFXNode }> = [];
  const root: OFXNode = {};
  let current: OFXNode = root;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Processing instruction (<?xml ...?> / <?OFX ...?> in OFX 2.x) — skip.
    if (line.startsWith('<?')) continue;

    // Closing tag: </TAG>. Pop back to the matching container; a close tag that
    // matches no open container (an XML leaf's close that landed on its own line
    // after normalization) is ignored rather than popping the wrong frame.
    const closeMatch = line.match(/^<\/([A-Z0-9_.]+)>$/i);
    if (closeMatch) {
      const tag = closeMatch[1].toUpperCase();
      const idx = stack.map((f) => f.tag).lastIndexOf(tag);
      if (idx !== -1) {
        stack.length = idx;
        current = stack.length > 0 ? stack[stack.length - 1].obj : root;
      }
      continue;
    }

    // Leaf tag with value on same line: <TAG>value (SGML, no closing tag) or
    // <TAG>value</TAG> (OFX 2.x XML) — the optional matching close tag is stripped.
    const leafMatch = line.match(/^<([A-Z0-9_.]+)>([^<]+?)(?:<\/\1>)?$/i);
    if (leafMatch) {
      const tag = leafMatch[1].toUpperCase();
      const value = leafMatch[2].trim();
      const existing = current[tag];
      if (existing === undefined) {
        current[tag] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        current[tag] = [existing, value];
      }
      continue;
    }

    // Container opening tag: <TAG> alone on a line
    const openMatch = line.match(/^<([A-Z0-9_.]+)>$/i);
    if (openMatch) {
      const tag = openMatch[1].toUpperCase();
      const newObj: OFXNode = {};
      const existing = current[tag];
      if (existing === undefined) {
        current[tag] = newObj;
      } else if (Array.isArray(existing)) {
        existing.push(newObj);
      } else {
        current[tag] = [existing, newObj];
      }
      stack.push({ tag, obj: newObj });
      current = newObj;
      continue;
    }
    // Any other line (e.g. "OFXHEADER:100") is silently skipped.
  }

  return root;
}

/**
 * Navigate the parsed SGML tree to the BANKTRANLIST node.
 * Handles both bank (BANKMSGSRSV1) and credit-card (CREDITCARDMSGSRSV1) message sets.
 */
function findBankTranList(doc: OFXNode): OFXNode | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = doc as any;
  return (
    d?.OFX?.BANKMSGSRSV1?.STMTTRNRS?.STMTRS?.BANKTRANLIST ??
    d?.OFX?.CREDITCARDMSGSRSV1?.CCSTMTTRNRS?.CCSTMTRS?.BANKTRANLIST ??
    null
  );
}

/**
 * Parse an OFX or QBO file and return normalized transaction rows.
 * Handles SGML (unclosed tags) and arbitrary header lines before <OFX>.
 */
export function parseOFX(content: string): ParsedTransaction[] {
  let doc: OFXNode;
  try {
    doc = parseOFXSgml(content);
  } catch (err) {
    throw new ServiceError('VALIDATION', `Failed to parse OFX/QBO content: ${(err as Error).message}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ofxRoot = (doc as any)?.OFX;
  // A string-valued OFX root means the file did not parse into a tree (e.g. a
  // malformed single-line body) — fail loudly rather than "succeeding" with 0 rows.
  if (!ofxRoot || typeof ofxRoot !== 'object') {
    throw new ServiceError('VALIDATION', 'No <OFX> root element found.');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmtList = findBankTranList(doc) as any;
  if (!stmtList) return []; // valid OFX with no transactions

  // STMTTRN: single object (one txn) or array (multiple txns).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawTxns: any[] = Array.isArray(stmtList.STMTTRN)
    ? stmtList.STMTTRN
    : stmtList.STMTTRN
      ? [stmtList.STMTTRN]
      : [];

  return rawTxns.map((t, i) => {
    const fitId = t.FITID != null ? String(t.FITID) : undefined;
    const dtPosted = t.DTPOSTED ?? t.DTUSER ?? '';
    if (!dtPosted) throw new ServiceError('VALIDATION', `Transaction ${i + 1}: missing DTPOSTED.`);
    const date = parseOFXDate(String(dtPosted));
    // OFX amounts are plain decimals ("-12.50"). decimal.js would also read "NaN" / "Infinity",
    // which Postgres stores in a numeric column — refuse anything that is not a number.
    const trnAmt = String(t.TRNAMT ?? '0').trim();
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trnAmt)) {
      throw new ServiceError('VALIDATION', `Transaction ${i + 1}: "${trnAmt}" is not an amount.`);
    }
    const amount = toAmountString(trnAmt);
    const name = String(t.NAME ?? t.PAYEE ?? '');
    const memo = String(t.MEMO ?? '');
    const description = [name, memo].filter(Boolean).join(' — ') || 'Imported transaction';
    const legacyDate = legacyIfDifferent(date, legacyOFXDate(String(dtPosted)));

    return { fitId, date, description, amount, ...(legacyDate ? { legacyDate } : {}) };
  });
}

/**
 * p1 fx: the statement currency declared by an OFX / QFX / QBO file (<CURDEF>), upper-cased, or
 * null when the file does not say.
 */
export function parseOFXCurrency(content: string): string | null {
  const m = /<CURDEF>\s*([A-Za-z]{3})/.exec(content);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Alias so callers can name the format explicitly; QBO is structurally identical to OFX.
 */
export const parseQBO = parseOFX;

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

/**
 * Parse a bank CSV export using the caller-supplied column mapping.
 * Positive amounts are deposits; negative are withdrawals (standard convention).
 * If debitCol/creditCol are provided, debits are stored as negative and credits as positive.
 */
/**
 * Parse a date string against an explicit format hint (e.g. "DD/MM/YYYY", "MM-DD-YYYY",
 * "YYYY/MM/DD"). Tokenizes both the format and the value on / - . and assigns components by
 * the format token, building a UTC date (mirroring parseOFXDate to avoid local-tz drift).
 * Returns an Invalid Date on any structural mismatch so the caller surfaces a VALIDATION error.
 */
function parseWithFormat(rawDate: string, format: string): Date {
  const sep = /[/.\-]/;
  const fmtTokens = format.split(sep);
  const valTokens = rawDate.split(sep);
  if (fmtTokens.length !== valTokens.length) return new Date(NaN);

  let day = 1;
  let month = 1;
  let year = 1970;
  for (let k = 0; k < fmtTokens.length; k++) {
    const t = fmtTokens[k].trim().toUpperCase();
    const raw = valTokens[k].trim();
    const v = parseInt(raw, 10);
    if (Number.isNaN(v)) return new Date(NaN);
    if (t.startsWith('D')) day = v;
    else if (t.startsWith('M')) month = v;
    else if (t.startsWith('Y')) year = raw.length === 2 ? 2000 + v : v;
  }
  // A real calendar day only: Date.UTC would move "31/04" to May 1 and "02/30" into March.
  if (!isCalendarDay(year, month, day)) return new Date(NaN);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Parse a CSV date with no format hint as a calendar DAY at UTC midnight — the day the bank
 * printed:
 *   - a value that starts with an ISO date ("2024-01-31", "2024-01-31T23:30:00-05:00"): that date,
 *     whatever time or zone follows (converting "23:30 -05:00" to UTC would make it Feb 1);
 *   - another value with an explicit zone (Z / GMT / UTC / ±hh:mm): the wall-clock day in that zone;
 *   - anything else ("01/31/2024", parsed by the engine as LOCAL time): the local calendar day
 *     (east of UTC, local midnight is the previous UTC day).
 */
function parseLooseDate(rawDate: string): Date {
  const d = new Date(rawDate);
  if (isNaN(d.getTime())) return d;
  const s = rawDate.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(s);
  if (iso) {
    // The engine rolls an impossible day over ("2026-02-30" → March 2): refuse it instead.
    if (!isCalendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return new Date(NaN);
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }
  // "02/30/2026" (read by the engine as month/day/year) rolls over the same way.
  const mdy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s);
  if (mdy && (d.getMonth() + 1 !== Number(mdy[1]) || d.getDate() !== Number(mdy[2]))) return new Date(NaN);
  // The zone must follow a time of day, so a date part like "01-31-2024" is never read as one.
  const zone = /\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:(Z|GMT|UTC)|(?:GMT|UTC)?([+-])(\d{2}):?(\d{2}))$/i.exec(s);
  if (zone) {
    const offsetMin = zone[1] ? 0 : (zone[2] === '-' ? -1 : 1) * (Number(zone[3]) * 60 + Number(zone[4]));
    const wall = new Date(d.getTime() + offsetMin * 60_000);
    return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
  }
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/** Drop the first `skipRows` physical lines (bank-export preamble before the header). */
function applySkipRows(content: string, skipRows?: number): string {
  if (!skipRows || skipRows <= 0) return content;
  return content.split(/\r?\n/).slice(skipRows).join('\n');
}

export function parseCSV(content: string, mapping: CsvMapping): ParsedTransaction[] {
  const result = Papa.parse<Record<string, string>>(applySkipRows(content, mapping.skipRows), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (result.errors.length) {
    // Non-fatal parse warnings — log but continue.
  }

  return result.data.map((row, i) => {
    // The cell as read (earlier versions used it as is).
    const rawCol = (key: string | number): string => {
      if (typeof key === 'number') {
        const vals = Object.values(row);
        return vals[key]?.trim() ?? '';
      }
      return (row[key] ?? row[key.toString()] ?? '').trim();
    };
    // csvUnsafeText: a CSV written by our own exports prefixes formula-like cells with "'".
    const col = (key: string | number): string => csvUnsafeText(rawCol(key));

    // Date — honor the caller's declared dateFormat so ambiguous values like "03/04/2024"
    // are not silently misread by the engine's locale-dependent Date parser.
    const rawDate = col(mapping.dateCol);
    if (!rawDate) throw new ServiceError('VALIDATION', `CSV row ${i + 1}: missing date value.`);
    const date = mapping.dateFormat ? parseWithFormat(rawDate, mapping.dateFormat) : parseLooseDate(rawDate);
    if (isNaN(date.getTime())) {
      throw new ServiceError('VALIDATION', `CSV row ${i + 1}: cannot parse date "${rawDate}".`);
    }

    // Amount: prefer separate debit/credit columns if specified.
    // Amounts through readBankAmount (decimal, never parseFloat): an unreadable cell refuses the
    // file with its row number instead of staging NaN.
    const money = (raw: string): string | null => {
      const v = readBankAmount(raw);
      if (v === 'bad') throw new ServiceError('VALIDATION', `CSV row ${i + 1}: "${raw}" is not an amount.`);
      return v;
    };
    let amount: string;
    if (mapping.debitCol !== undefined && mapping.creditCol !== undefined) {
      // The column says the direction: Credit = money coming IN (positive), Debit = money going
      // OUT (negative) — also when the bank prints the debit signed ("-25.00") or bracketed.
      const debit = Money.abs(money(col(mapping.debitCol)) ?? 0);
      const credit = Money.abs(money(col(mapping.creditCol)) ?? 0);
      amount = toAmountString(credit.minus(debit));
    } else {
      const rawAmt = col(mapping.amountCol);
      const v = money(rawAmt);
      if (v === null) {
        throw new ServiceError('VALIDATION', rawAmt ? `CSV row ${i + 1}: "${rawAmt}" is not an amount.` : `CSV row ${i + 1}: missing amount value.`);
      }
      amount = v;
    }

    // Sign flip — for banks that export withdrawals as positive numbers.
    if (mapping.flipSign) {
      amount = toAmountString(Money.neg(amount));
    }

    // Description, with the optional check number and memo columns folded in.
    const baseDescription = col(mapping.descriptionCol) || 'Imported transaction';
    const checkNo = mapping.checkNumberCol !== undefined ? col(mapping.checkNumberCol) : '';
    const memo = mapping.memoCol !== undefined ? col(mapping.memoCol) : '';
    const description = [checkNo ? `Check #${checkNo}` : '', baseDescription, memo && memo !== baseDescription ? memo : '']
      .filter(Boolean)
      .join(' — ');
    const payee = mapping.payeeCol !== undefined ? col(mapping.payeeCol) || undefined : undefined;

    // Optional fitId
    const fitId =
      mapping.fitIdCol !== undefined
        ? col(mapping.fitIdCol) || undefined
        : undefined;

    // Earlier versions stored a format-less date as the engine parsed it (local midnight), and the
    // description / fitId cells with the formula-guard apostrophe still on.
    const legacyDate = mapping.dateFormat ? undefined : legacyIfDifferent(date, new Date(rawDate));
    const rawDescription = rawCol(mapping.descriptionCol) || 'Imported transaction';
    // Only plain description mappings existed before; folded columns have no legacy form.
    const folded = Boolean(checkNo || (memo && memo !== baseDescription));
    const legacyDescription = !folded && rawDescription !== description ? rawDescription : undefined;
    const rawFitId = mapping.fitIdCol !== undefined ? rawCol(mapping.fitIdCol) || undefined : undefined;
    const legacyFitId = rawFitId !== fitId ? rawFitId : undefined;

    return {
      fitId,
      date,
      description,
      amount,
      ...(payee ? { payee } : {}),
      ...(legacyDate ? { legacyDate } : {}),
      ...(legacyDescription !== undefined ? { legacyDescription } : {}),
      ...(legacyFitId !== undefined ? { legacyFitId } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// CSV preview (mapper UI support) — parse WITHOUT committing anything
// ---------------------------------------------------------------------------

export interface CsvPreviewRow {
  /** ISO date string of the parsed transaction date. */
  date: string;
  description: string;
  amount: string;
  fitId?: string;
}

export interface CsvPreviewResult {
  /** Header names detected after skipRows are applied (for column dropdowns). */
  headers: string[];
  /** Up to `limit` parsed rows. Empty when `error` is set. */
  rows: CsvPreviewRow[];
  /** Total rows the full parse produced (0 when `error` is set). */
  totalParsed: number;
  /** Parse/mapping error message, or null when the mapping parses cleanly. */
  error: string | null;
}

/**
 * Dry-run a CSV mapping: returns the detected headers plus the first `limit`
 * parsed rows. Never throws for mapping/parse problems — they come back in
 * `error` so the UI can keep the headers visible for re-mapping.
 */
export function previewCSV(content: string, mapping: CsvMapping, limit = 10): CsvPreviewResult {
  // Headers are detected independently of the field mapping, so a wrong
  // mapping still yields the header list the user needs to fix it.
  const head = Papa.parse<Record<string, string>>(applySkipRows(content, mapping.skipRows), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const headers =
    head.meta?.fields?.map((f) => f.trim()).filter(Boolean) ??
    (head.data[0] ? Object.keys(head.data[0]) : []);

  try {
    const parsed = parseCSV(content, mapping);
    return {
      headers,
      rows: parsed.slice(0, Math.max(0, limit)).map((t) => ({
        date: t.date.toISOString(),
        description: t.description,
        amount: t.amount,
        ...(t.fitId ? { fitId: t.fitId } : {}),
      })),
      totalParsed: parsed.length,
      error: null,
    };
  } catch (err) {
    return {
      headers,
      rows: [],
      totalParsed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Hash-based fitId fallback for CSV rows that lack an explicit fitId
// ---------------------------------------------------------------------------

/**
 * Derive a stable dedup key for a parsed transaction when the source file
 * doesn't provide a financial-institution transaction ID (fitId).
 *
 * The hash is a short SHA-256 prefix over "date|description|amount", which is
 * stable across repeated CSV re-imports of the same file and virtually
 * collision-free for the transaction volumes a small-business sees.
 *
 * We prefix it with "csv-hash:" so it cannot collide with a real OFX FITID.
 */
function hashFitId(
  txn: { date: Date; description: string; amount: string },
  occurrence = 0,
): string {
  // The occurrence index disambiguates legitimately-repeated identical lines within one file
  // (e.g. two $5.00 coffees on the same day), so they are not collapsed into a single key and
  // a re-import still round-trips each occurrence to its own prior row.
  const raw = `${txn.date.toISOString()}|${txn.description}|${txn.amount}|${occurrence}`;
  return 'csv-hash:' + createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Import orchestrator
// ---------------------------------------------------------------------------

/** One reviewed statement row (fileType 'rows'). Positive = money into the account. */
export interface ImportRowInput {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  amount: string;
  payee?: string | null;
}

/** Rows a person reviewed (statement PDF / scan) → the same shape every parser returns. */
export function parseRows(rows: ImportRowInput[]): ParsedTransaction[] {
  if (!Array.isArray(rows) || rows.length === 0) throw validation('There are no rows to import.');
  if (rows.length > 5000) throw validation('Import at most 5,000 rows at a time.');
  return rows.map((r, i) => {
    if (!r || typeof r !== 'object') throw validation(`Row ${i + 1} is not a statement row.`);
    const date = parseLooseDate(String(r?.date ?? ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r?.date ?? '')) || isNaN(date.getTime())) {
      throw validation(`Row ${i + 1}: the date must be a real day written like 2026-01-31 ("${String(r?.date ?? '')}" is not).`);
    }
    // Never decimal.js directly: it reads "NaN" / "Infinity", which would be staged as such.
    const amount = readBankAmount(r.amount);
    if (amount === null || amount === 'bad') throw validation(`Row ${i + 1}: "${String(r.amount ?? '')}" is not an amount.`);
    if (Money.isZero(amount)) throw validation(`Row ${i + 1}: the amount is zero.`);
    const description = String(r.description ?? '').trim().slice(0, 500) || 'Statement transaction';
    const payee = typeof r.payee === 'string' && r.payee.trim() ? r.payee.trim().slice(0, 255) : undefined;
    return { date, description, amount, ...(payee ? { payee } : {}) };
  });
}

export interface ImportTransactionsInput {
  bankAccountId: string;
  /** 'ofx', 'qfx', and 'qbo' are treated identically (same parser); 'rows' takes `rows`. */
  fileType: FileType;
  content: string;
  /** fileType 'rows': the reviewed rows. */
  rows?: ImportRowInput[];
  /** fileType 'rows' from a statement: how it tied out (recorded in the audit trail). */
  statementCheck?: { tieOut: { ok: boolean; difference: string | null }; acknowledgedDifference: boolean };
  csvMapping?: CsvMapping;
  /** Optional filename for audit purposes. */
  filename?: string;
}

/**
 * Full import pipeline:
 *  1. Validate bankAccountId belongs to company.
 *  2. Create a fileImports row (status = processing).
 *  3. Parse the file content.
 *  4. Dedupe: skip any fitId already present in bank_transactions for this account.
 *  5. Insert new rows into bank_transactions (matched = false).
 *  6. Apply categorization rules to set suggestedAccountId.
 *  7. Update fileImports with final counts and status = completed (or failed).
 *  8. Return ImportSummary.
 */
export async function importTransactions(
  ctx: ServiceContext,
  input: ImportTransactionsInput,
): Promise<ImportSummary> {
  // 1. Verify the bank account belongs to this company.
  const [bankAccount] = await ctx.db
    .select({ id: bankAccounts.id, glAccountId: bankAccounts.accountId })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, ctx.companyId)),
    );
  if (!bankAccount) throw notFound('Bank account');

  // p1 fx: amounts are staged in the account's own currency. A bank file that declares another
  // currency (OFX <CURDEF>) belongs to a different account — refuse it before anything is written.
  if (input.fileType !== 'csv') {
    const fileCurrency = parseOFXCurrency(input.content);
    const home = await homeCode(ctx);
    if (fileCurrency && home) {
      const acctCurrency = (await foreignCurrencyOfAccount(ctx, bankAccount.glAccountId)) ?? home;
      if (fileCurrency !== acctCurrency) {
        throw validation(
          `This file is a ${fileCurrency} statement, but the account is in ${acctCurrency}. Import it into a ${fileCurrency} account instead.`,
        );
      }
    }
  }

  // Map fileType enum for the fileImports row. 'qfx' is OFX-on-the-wire and the
  // file_type enum predates it (schema is frozen), so it is stored as 'ofx'.
  const fileTypeForDb =
    input.fileType === 'csv' || input.fileType === 'rows' ? 'csv' : input.fileType === 'qbo' ? 'qbo' : 'ofx';

  // 2. Create fileImports row.
  const [importRow] = await ctx.db
    .insert(fileImports)
    .values({
      companyId: ctx.companyId,
      filename: input.filename ?? `import.${input.fileType}`,
      fileType: fileTypeForDb as never,
      status: 'processing',
      uploadedBy: ctx.userId ?? '00000000-0000-0000-0000-000000000000',
    })
    .returning();

  let parsed: ParsedTransaction[] = [];
  let parseError: string | null = null;

  // 3. Parse.
  try {
    if (input.fileType === 'csv') {
      if (!input.csvMapping) {
        throw validation('csvMapping is required for CSV imports.');
      }
      parsed = parseCSV(input.content, input.csvMapping);
    } else if (input.fileType === 'rows') {
      parsed = parseRows(input.rows ?? []);
    } else {
      // ofx and qbo use the same parser.
      parsed = parseOFX(input.content);
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  // If parsing failed entirely, mark the import as failed and bail.
  if (parseError) {
    await ctx.db
      .update(fileImports)
      .set({ status: 'failed', errorLog: [{ line: 0, error: parseError }], completedAt: new Date() })
      .where(eq(fileImports.id, importRow.id));
    throw new ServiceError('VALIDATION', `Failed to parse import file: ${parseError}`);
  }

  // 4a. Apply hash-based fitId fallback for CSV rows that have no fitId.
  //     This ensures re-importing the same CSV doesn't create duplicate rows.
  //     Rows staged by earlier versions were keyed with what those versions read: the date they
  //     stored (OFX time of day, format-less CSV dates at local midnight) and the description /
  //     fitId cell with the formula-guard apostrophe still on. The same line's legacy key counts
  //     as a duplicate too, so re-importing an old file adds nothing. Legacy occurrence numbers
  //     are counted over every row's legacy tuple, exactly as those versions counted them.
  const tupleCounts = new Map<string, number>();
  const legacyTupleCounts = new Map<string, number>();
  const legacyKeys = new Map<ParsedTransaction, string>();
  for (const txn of parsed) {
    if (!txn.fitId) {
      const key = `${txn.date.toISOString()}|${txn.description}|${txn.amount}`;
      const n = tupleCounts.get(key) ?? 0;
      tupleCounts.set(key, n + 1);
      const old = {
        date: txn.legacyDate ?? txn.date,
        description: txn.legacyDescription ?? txn.description,
        amount: txn.amount,
      };
      const lkey = `${old.date.toISOString()}|${old.description}|${old.amount}`;
      const ln = legacyTupleCounts.get(lkey) ?? 0;
      legacyTupleCounts.set(lkey, ln + 1);
      if (txn.legacyDate || txn.legacyDescription !== undefined) legacyKeys.set(txn, hashFitId(old, ln));
      txn.fitId = hashFitId(txn, n);
    } else if (txn.legacyFitId) {
      legacyKeys.set(txn, txn.legacyFitId);
    }
  }

  // 4b–6 run in ONE transaction: reading the fitIds already staged and inserting the new lines
  // must be atomic, or the same file imported twice at once (a double click, two windows, two
  // users) stages every line twice. Each line still succeeds or fails on its own (a savepoint
  // per line), as before.
  const { skippedDupes, errorLog, importedCount } = await inTransaction(ctx, async (tx) => {
    // 4b. Dedupe: collect fitIds already staged for this bank account.
    const existingFitIds = new Set<string>();
    {
      const existing = await tx.db
        .select({ fitId: bankTransactions.fitId })
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.companyId, tx.companyId),
            eq(bankTransactions.bankAccountId, input.bankAccountId),
          ),
        );
      for (const row of existing) {
        if (row.fitId) existingFitIds.add(row.fitId);
      }
    }

    // Dedupe against both already-staged rows AND earlier rows in THIS batch, so two rows that
    // genuinely share a fitId within one file don't both insert.
    const seenInBatch = new Set<string>();
    const toInsert = parsed.filter((p) => {
      if (!p.fitId) return true;
      if (existingFitIds.has(p.fitId) || seenInBatch.has(p.fitId)) return false;
      const legacy = legacyKeys.get(p);
      if (legacy && existingFitIds.has(legacy)) return false;
      seenInBatch.add(p.fitId);
      return true;
    });

    // 5. Pre-fetch active rules once for bulk application.
    const rules = await listRules(tx);

    // 6. Insert + apply rules row-by-row.
    const errors: Array<{ line: number; error: string }> = [];
    let imported = 0;

    for (let i = 0; i < toInsert.length; i++) {
      const txn = toInsert[i];
      try {
        // Apply rules to get the suggested account and any payee override.
        const match = await matchRule(
          tx,
          { description: txn.description, payee: txn.payee, amount: txn.amount, bankAccountId: input.bankAccountId },
          rules,
        );

        await tx.db.transaction(async (sp) => {
          await sp.insert(bankTransactions).values({
            companyId: tx.companyId,
            bankAccountId: input.bankAccountId,
            fileImportId: importRow.id,
            fitId: txn.fitId ?? null,
            date: txn.date,
            description: txn.description,
            payee: match?.setPayee ?? txn.payee ?? null,
            amount: txn.amount,
            matched: false,
            suggestedAccountId: match?.setAccountId ?? null,
          });
        });
        imported += 1;
      } catch (err) {
        errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { skippedDupes: parsed.length - toInsert.length, errorLog: errors, importedCount: imported };
  });

  // 7. Update fileImports with final counts.
  const finalStatus = errorLog.length > 0 && importedCount === 0 ? 'failed' : 'completed';
  await ctx.db
    .update(fileImports)
    .set({
      status: finalStatus,
      totalTransactions: parsed.length,
      importedTransactions: importedCount,
      failedTransactions: errorLog.length,
      errorLog: errorLog.length ? errorLog : null,
      completedAt: new Date(),
    })
    .where(eq(fileImports.id, importRow.id));

  // Audit trail.
  await writeAudit(ctx, {
    action: 'create',
    entityType: 'file_import',
    entityId: importRow.id,
    newValues: {
      fileType: input.fileType,
      bankAccountId: input.bankAccountId,
      parsed: parsed.length,
      imported: importedCount,
      skippedDupes,
      errors: errorLog.length,
      ...(input.statementCheck
        ? { tiedOut: input.statementCheck.tieOut.ok, difference: input.statementCheck.tieOut.difference, acknowledgedDifference: input.statementCheck.acknowledgedDifference }
        : {}),
    },
  });
  // A bulk load: give the planner fresh statistics (PGlite has no autovacuum; best-effort).
  if (importedCount > 0) await refreshPlannerStats(ctx.db, 'bank import');

  return {
    fileImportId: importRow.id,
    parsed: parsed.length,
    imported: importedCount,
    skippedDupes,
    errors: errorLog.length,
  };
}
