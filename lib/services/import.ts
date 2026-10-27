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
import { listBaseCode } from './fxLines';

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

/** A value that may be one node or several (SGML repeats become arrays). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const many = (v: any): any[] => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * Every statement in the file: its account id (ACCTID) and its BANKTRANLIST. Handles bank
 * (BANKMSGSRSV1) and credit-card (CREDITCARDMSGSRSV1) message sets, each with one or several
 * statements — a bank's "download all accounts" Web Connect file holds one per account.
 */
function findStatements(doc: OFXNode): Array<{ acctId: string | null; tranList: OFXNode | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = doc as any;
  const out: Array<{ acctId: string | null; tranList: OFXNode | null }> = [];
  for (const rs of many(d?.OFX?.BANKMSGSRSV1?.STMTTRNRS)) {
    for (const st of many(rs?.STMTRS)) {
      out.push({ acctId: st?.BANKACCTFROM?.ACCTID != null ? String(st.BANKACCTFROM.ACCTID) : null, tranList: st?.BANKTRANLIST ?? null });
    }
  }
  for (const rs of many(d?.OFX?.CREDITCARDMSGSRSV1?.CCSTMTTRNRS)) {
    for (const st of many(rs?.CCSTMTRS)) {
      out.push({ acctId: st?.CCACCTFROM?.ACCTID != null ? String(st.CCACCTFROM.ACCTID) : null, tranList: st?.BANKTRANLIST ?? null });
    }
  }
  return out;
}

const digitsOf = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/**
 * The statement to import. One statement: that one. Several (one per account): the one whose
 * ACCTID is the bank account's number (or, failing that, the only one ending in the same last
 * four digits). Several and no match: VALIDATION naming the accounts — the parser used to find
 * no transaction list at all in such a file and "import" 0 rows without a word.
 */
function pickStatement(
  statements: Array<{ acctId: string | null; tranList: OFXNode | null }>,
  accountNumber: string | null | undefined,
): OFXNode | null {
  if (statements.length === 0) return null;
  if (statements.length === 1) return statements[0].tranList;
  const want = digitsOf(accountNumber);
  if (want) {
    const exact = statements.filter((st) => digitsOf(st.acctId) === want);
    if (exact.length === 1) return exact[0].tranList;
    const last4 = statements.filter((st) => want.length >= 4 && digitsOf(st.acctId).slice(-4) === want.slice(-4));
    if (exact.length === 0 && last4.length === 1) return last4[0].tranList;
  }
  const ends = statements.map((st) => (st.acctId ? `…${digitsOf(st.acctId).slice(-4) || st.acctId}` : 'an unnamed account')).join(', ');
  throw new ServiceError(
    'VALIDATION',
    `This file has statements for ${statements.length} accounts (${ends}), and none of them is this bank account's number. Download one account at a time, or enter this account's number on the bank account.`,
  );
}

/**
 * An OFX TRNAMT as a 2dp string. The OFX specification lets the decimal symbol be a period OR a
 * comma ("-12,50" from a European bank's Web Connect file used to fail the whole import with a
 * parser error); a value that is not a number ("NaN", "", "12.5.1") is a plain VALIDATION error
 * instead of being staged as NaN.
 */
function ofxAmount(raw: unknown, index: number): string {
  let s = String(raw ?? '').trim();
  if (/^[+-]?\d*,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) {
    throw new ServiceError('VALIDATION', `Transaction ${index + 1}: "${s.slice(0, 40)}" is not an amount (TRNAMT).`);
  }
  return toAmountString(s);
}

/**
 * Parse an OFX or QBO file and return normalized transaction rows.
 * Handles SGML (unclosed tags) and arbitrary header lines before <OFX>. A file with statements
 * for several accounts yields the statement of `accountNumber` (see pickStatement).
 */
export function parseOFX(content: string, accountNumber?: string | null): ParsedTransaction[] {
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
  const stmtList = pickStatement(findStatements(doc), accountNumber) as any;
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
    // An unreadable date used to reach the duplicate key (toISOString → RangeError, HTTP 500) or
    // fail its row in the database; refuse the file plainly, as the CSV reader does.
    if (isNaN(date.getTime())) {
      throw new ServiceError('VALIDATION', `Transaction ${i + 1}: "${String(dtPosted).slice(0, 40)}" is not a date (DTPOSTED).`);
    }
    const amount = ofxAmount(t.TRNAMT, i);
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
  if (month < 1 || month > 12 || day < 1 || day > 31) return new Date(NaN);
  const out = new Date(Date.UTC(year, month - 1, day));
  // A day the month doesn't have (31/02/2026) used to roll over into the next month.
  return out.getUTCMonth() === month - 1 ? out : new Date(NaN);
}

/** `d` unless the M/D/Y or Y-M-D digits printed in `raw` name a day that does not exist. */
function realDayOrInvalid(raw: string, d: Date): Date {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(s);
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?!\d)/.exec(s);
  const [y, m, day] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : us ? [Number(us[3]), Number(us[1]), Number(us[2])] : [0, 0, 0];
  if (!m) return d;
  const check = new Date(Date.UTC(y < 100 ? 2000 + y : y, m - 1, day));
  return check.getUTCMonth() === m - 1 && check.getUTCDate() === day ? d : new Date(NaN);
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
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  // The zone must follow a time of day, so a date part like "01-31-2024" is never read as one.
  const zone = /\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:(Z|GMT|UTC)|(?:GMT|UTC)?([+-])(\d{2}):?(\d{2}))$/i.exec(s);
  if (zone) {
    const offsetMin = zone[1] ? 0 : (zone[2] === '-' ? -1 : 1) * (Number(zone[3]) * 60 + Number(zone[4]));
    const wall = new Date(d.getTime() + offsetMin * 60_000);
    return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
  }
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/**
 * A CSV money cell as a Decimal (null when blank): "$1,234.56", "-45.00", "45.00-", "(45.00)"
 * (accounting negative). Anything else — "N/A", "NaN", "12,5" … — is a VALIDATION error naming
 * the row, so the import fails as a whole instead of staging a wrong or NaN amount.
 */
function csvAmount(cell: string, rowIndex: number) {
  let s = cell.replace(/[\s ]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  s = s.replace(/^([+-]?)\$/, '$1').replace(/,(?=\d{3}(?:\D|$))/g, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) {
    throw new ServiceError('VALIDATION', `CSV row ${rowIndex + 1}: "${cell}" is not an amount.`);
  }
  const v = Money.of(s);
  return neg ? v.negated() : v;
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
    // An impossible day ("02/30/2026") is refused: the engine rolled it over to March 2.
    const date = mapping.dateFormat ? parseWithFormat(rawDate, mapping.dateFormat) : realDayOrInvalid(rawDate, parseLooseDate(rawDate));
    if (isNaN(date.getTime())) {
      throw new ServiceError('VALIDATION', `CSV row ${i + 1}: cannot parse date "${rawDate}".`);
    }

    // Amount: prefer separate debit/credit columns if specified.
    let amount: string;
    if (mapping.debitCol !== undefined && mapping.creditCol !== undefined) {
      const debit = csvAmount(col(mapping.debitCol), i);
      const credit = csvAmount(col(mapping.creditCol), i);
      // Credit = money coming IN (positive); Debit = money going OUT (negative). The columns say
      // the direction, so their sign does not: a bank that prints debits as "-45.00" (or
      // "(45.00)") still means 45.00 out — it used to come in as a +45.00 deposit. Decimal math,
      // never parseFloat (an unparseable cell used to be staged as NaN).
      amount = toAmountString(Money.abs(credit ?? 0).minus(Money.abs(debit ?? 0)));
    } else {
      const amt = csvAmount(col(mapping.amountCol), i);
      if (amt === null) throw new ServiceError('VALIDATION', `CSV row ${i + 1}: missing amount value.`);
      amount = toAmountString(amt);
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
    const raw = String(r?.date ?? '');
    const date = parseLooseDate(raw);
    // The day must exist: "2026-02-30" (an OCR misread) would otherwise roll over to March 2.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
      throw validation(`Row ${i + 1}: the date must be a real day like 2026-01-31.`);
    }
    let amount: string;
    try {
      const v = typeof r.amount === 'string' || typeof r.amount === 'number' ? Money.of(r.amount) : null;
      // "NaN" / "Infinity" are valid decimal.js input and Postgres numeric stores NaN — never stage them.
      if (!v || !v.isFinite()) throw new Error('not finite');
      amount = toAmountString(v);
    } catch {
      throw validation(`Row ${i + 1}: "${r?.amount}" is not an amount.`);
    }
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
    .select({ id: bankAccounts.id, glAccountId: bankAccounts.accountId, accountNumber: bankAccounts.accountNumber })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, ctx.companyId)),
    );
  if (!bankAccount) throw notFound('Bank account');

  // p1 fx: amounts are staged in the account's own currency. A bank file that declares another
  // currency (OFX <CURDEF>) belongs to a different account — refuse it before anything is written.
  if (input.fileType !== 'csv') {
    const fileCurrency = parseOFXCurrency(input.content);
    // review5 fx: checked once the currency list has its home currency row. Without one the home
    // code may be only the USD default of a file that never set up currencies (homeCode would
    // say USD), and a Canadian bank's CAD statement must still import into its untagged account.
    const home = await listBaseCode(ctx);
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
      // file_imports.filename is varchar(255): keep the end (the extension) of a longer name.
      filename: (() => {
        const name = (typeof input.filename === 'string' && input.filename.trim()) || `import.${input.fileType}`;
        return name.length > 255 ? `…${name.slice(-254)}` : name;
      })(),
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
      parsed = parseOFX(input.content, bankAccount.accountNumber);
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
  // fit_id is varchar(255): compare and store the same (shortened) key, so a re-import dedupes.
  for (const t of parsed) if (t.fitId && t.fitId.length > 255) t.fitId = t.fitId.slice(0, 255);
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

  // 4b-7 run in ONE transaction: the duplicate check, the inserts and the counts. Two imports of
  // the same file at once (a double-clicked Import, two people with the same download) each used
  // to read "nothing staged yet" before either inserted, and every line was staged twice.
  const { importedCount, skippedDupes, errorLog } = await inTransaction(ctx, async (tx) => {
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
    const skippedDupes = parsed.length - toInsert.length;

    // 5. Pre-fetch active rules once for bulk application.
    const rules = await listRules(tx);

    // 6. Insert + apply rules row-by-row. Each row in its own savepoint: a row the database refuses
    // is logged and skipped without aborting the rest of the import.
    const errorLog: Array<{ line: number; error: string }> = [];
    let importedCount = 0;

    for (let i = 0; i < toInsert.length; i++) {
      const txn = toInsert[i];
      try {
        // Apply rules to get the suggested account and any payee override.
        const match = await matchRule(
          tx,
          { description: txn.description, payee: txn.payee, amount: txn.amount, bankAccountId: input.bankAccountId },
          rules,
        );

        await inTransaction(tx, (sp) =>
          sp.db.insert(bankTransactions).values({
            companyId: sp.companyId,
            bankAccountId: input.bankAccountId,
            fileImportId: importRow.id,
            // payee is varchar(255): a longer cell used to fail the row (logged as an error and
            // left out of the import). Keep it, shortened.
            fitId: txn.fitId ?? null,
            date: txn.date,
            description: txn.description,
            payee: (match?.setPayee ?? txn.payee)?.slice(0, 255) ?? null,
            amount: txn.amount,
            matched: false,
            suggestedAccountId: match?.setAccountId ?? null,
          }),
        );
        importedCount += 1;
      } catch (err) {
        errorLog.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 7. Update fileImports with final counts.
    const finalStatus = errorLog.length > 0 && importedCount === 0 ? 'failed' : 'completed';
    await tx.db
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
    await writeAudit(tx, {
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
    return { importedCount, skippedDupes, errorLog };
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
