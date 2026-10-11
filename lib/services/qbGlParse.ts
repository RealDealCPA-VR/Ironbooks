/**
 * QuickBooks General Ledger → balanced transactions (pure; no DB).
 *
 * Pipeline (each step unit-tested in qbGlParse.test.ts):
 *   1. parseGlGrid()      grid rows (lib/services/qbGlFiles.ts) → GlReport: the account tree
 *                         (numbers, names, 'Parent:Child' nesting from indentation / Total rows /
 *                         full-path labels), every transaction row under the account it appears
 *                         in, Beginning Balance / header balances, Total rows, the final TOTAL.
 *   2. parseReference*()  optional QB Account List / Trial Balance / IIF export → exact account
 *                         types and/or as-of balances for the reconciliation proof.
 *   3. analyzeGl()        resolves each account's QB type (reference > user override > parent >
 *                         heuristics: section order, number ranges, names, running-balance sign,
 *                         transaction types), converts every balance to a debit-positive figure,
 *                         self-checks the report (each account rolls forward to its Total row;
 *                         beginning and ending balances each net to zero across the ledger), and
 *                         rebuilds balanced double-entry transactions from the per-account
 *                         lines. Lines that cannot be paired into a balanced entry go to a
 *                         review list — they are never forced or silently posted.
 *
 * Money is decimal.js throughout (lib/money.ts); amounts leave this module as 2dp strings.
 * Debit-positive ("dr") convention: +100 = 100 debit balance, -100 = 100 credit balance.
 */
import { createHash } from 'node:crypto';
import type Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';
import { ServiceError } from './_base';
import type { GridRow, GridSheet } from './qbGlFiles';
import { parseIIF } from './qbImport';

// ---------------------------------------------------------------------------
// QuickBooks account types
// ---------------------------------------------------------------------------

/** QB Desktop account types, in the order QB lists them on every report. */
export const QB_ACCOUNT_TYPES = [
  'Bank',
  'Accounts Receivable',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Accounts Payable',
  'Credit Card',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
  'Income',
  'Cost of Goods Sold',
  'Expense',
  'Other Income',
  'Other Expense',
] as const;
export type QbAccountType = (typeof QB_ACCOUNT_TYPES)[number];

const DEBIT_NORMAL_QB = new Set<QbAccountType>([
  'Bank',
  'Accounts Receivable',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Cost of Goods Sold',
  'Expense',
  'Other Expense',
]);

export function isDebitNormal(t: QbAccountType): boolean {
  return DEBIT_NORMAL_QB.has(t);
}

const QB_TYPE_ALIASES: Record<string, QbAccountType> = {
  bank: 'Bank',
  accountsreceivable: 'Accounts Receivable',
  ar: 'Accounts Receivable',
  othercurrentasset: 'Other Current Asset',
  ocasset: 'Other Current Asset',
  fixedasset: 'Fixed Asset',
  fixasset: 'Fixed Asset',
  otherasset: 'Other Asset',
  oasset: 'Other Asset',
  accountspayable: 'Accounts Payable',
  ap: 'Accounts Payable',
  creditcard: 'Credit Card',
  ccard: 'Credit Card',
  othercurrentliability: 'Other Current Liability',
  ocliab: 'Other Current Liability',
  longtermliability: 'Long Term Liability',
  ltliab: 'Long Term Liability',
  equity: 'Equity',
  income: 'Income',
  inc: 'Income',
  costofgoodssold: 'Cost of Goods Sold',
  cogs: 'Cost of Goods Sold',
  expense: 'Expense',
  exp: 'Expense',
  otherincome: 'Other Income',
  exinc: 'Other Income',
  otherexpense: 'Other Expense',
  exexp: 'Other Expense',
};

/** Normalise a QB type as written in an Account List / IIF ('Other Current Asset', 'OCASSET'). */
export function normalizeQbType(raw: string | undefined | null): QbAccountType | null {
  const key = (raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return QB_TYPE_ALIASES[key] ?? null;
}

/** BookKeeper account type + subtype for a QB account type (name refines a few subtypes). */
export function toBookkeeperType(
  qbType: QbAccountType,
  name = '',
): { type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'; subtype: string } {
  const n = name.toLowerCase();
  switch (qbType) {
    case 'Bank':
      return { type: 'asset', subtype: /saving|money market/.test(n) ? 'savings' : 'checking' };
    case 'Accounts Receivable':
      return { type: 'asset', subtype: 'accounts_receivable' };
    case 'Other Current Asset':
      return {
        type: 'asset',
        subtype: /inventory/.test(n) ? 'inventory' : /undeposited/.test(n) ? 'undeposited_funds' : 'other_current_asset',
      };
    case 'Fixed Asset':
      return { type: 'asset', subtype: 'fixed_assets' };
    case 'Other Asset':
      return { type: 'asset', subtype: 'other_asset' };
    case 'Accounts Payable':
      return { type: 'liability', subtype: 'accounts_payable' };
    case 'Credit Card':
      return { type: 'liability', subtype: 'credit_card' };
    case 'Other Current Liability':
      return { type: 'liability', subtype: 'other_current_liability' };
    case 'Long Term Liability':
      return { type: 'liability', subtype: 'long_term_liability' };
    case 'Equity':
      return { type: 'equity', subtype: /retained earnings/.test(n) ? 'retained_earnings' : 'owners_equity' };
    case 'Income':
      return { type: 'revenue', subtype: /service|consult|fee/.test(n) ? 'service_revenue' : 'sales' };
    case 'Other Income':
      return { type: 'revenue', subtype: 'other_income' };
    case 'Cost of Goods Sold':
      return { type: 'expense', subtype: 'cost_of_goods_sold' };
    case 'Expense':
      return {
        type: 'expense',
        subtype: /payroll|wage|salar/.test(n) ? 'payroll' : /\btax/.test(n) ? 'taxes' : 'operating_expenses',
      };
    case 'Other Expense':
      return { type: 'expense', subtype: 'other_expense' };
  }
}

// ---------------------------------------------------------------------------
// Cell value helpers
// ---------------------------------------------------------------------------

/**
 * Parse a QB amount: '1,234.56', '(1,234.56)', '-1,234.56', '1,234.56-', '$5.00', and raw
 * spreadsheet numbers ('1234.5599999999999' → 1234.56). Returns null for an empty cell.
 */
export function parseAmount(raw: string | null | undefined): Decimal | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[$\s,]/g, '');
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
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const d = Money.round2(s);
  return neg ? d.negated() : d;
}

/** Parse a QB date cell ('01/15/2024', '1/5/24', '2024-01-15') → 'YYYY-MM-DD', or null. */
export function parseQbDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (match) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (!match) return null;
    m = Number(match[1]);
    d = Number(match[2]);
    y = Number(match[3]);
    if (match[3].length === 2) y += y < 50 ? 2000 : 1900;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function monthIndex(word: string): number {
  const w = word.toLowerCase();
  return MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
}

function isoOf(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

/** Day before an ISO date. */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Read the report period from QB's title block: 'January 1 through December 31, 2024',
 * 'January 1, 2023 through June 30, 2024', 'January through December 2024',
 * '07/01/2024 - 12/31/2024', 'As of December 31, 2024'.
 */
export function parsePeriodLabel(text: string): { start?: string; end?: string } | null {
  const t = text.replace(/\s+/g, ' ').trim();
  const sep = '(?:through|thru|to|-|–)';
  let m = new RegExp(
    `([A-Za-z]+) (\\d{1,2})(?:, (\\d{4}))? ${sep} ([A-Za-z]+) (\\d{1,2}), (\\d{4})`,
    'i',
  ).exec(t);
  if (m && monthIndex(m[1]) >= 0 && monthIndex(m[4]) >= 0) {
    const endY = Number(m[6]);
    const startY = m[3] ? Number(m[3]) : endY;
    return {
      start: isoOf(startY, monthIndex(m[1]), Number(m[2])),
      end: isoOf(endY, monthIndex(m[4]), Number(m[5])),
    };
  }
  m = new RegExp(`([A-Za-z]+)(?: (\\d{4}))? ${sep} ([A-Za-z]+) (\\d{4})`, 'i').exec(t);
  if (m && monthIndex(m[1]) >= 0 && monthIndex(m[3]) >= 0) {
    const endY = Number(m[4]);
    const startY = m[2] ? Number(m[2]) : endY;
    const endM = monthIndex(m[3]);
    return { start: isoOf(startY, monthIndex(m[1]), 1), end: isoOf(endY, endM + 1, 0) };
  }
  m = new RegExp(`(\\d{1,2}/\\d{1,2}/\\d{2,4}) ?${sep} ?(\\d{1,2}/\\d{1,2}/\\d{2,4})`, 'i').exec(t);
  if (m) {
    const start = parseQbDate(m[1]);
    const end = parseQbDate(m[2]);
    if (start && end) return { start, end };
  }
  m = /as of ([A-Za-z]+) (\d{1,2}), (\d{4})/i.exec(t);
  if (m && monthIndex(m[1]) >= 0) {
    return { end: isoOf(Number(m[3]), monthIndex(m[1]), Number(m[2])) };
  }
  m = /as of (\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(t);
  if (m) {
    const end = parseQbDate(m[1]);
    if (end) return { end };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Account labels
// ---------------------------------------------------------------------------

/** '10100 · Checking' → { number: '10100', name: 'Checking' }; 'Checking' → { name }. */
export function parseAccountLabel(label: string): { number?: string; name: string } {
  const s = label.replace(/\s+/g, ' ').trim();
  let m = /^([A-Za-z0-9][\w.\-]*)\s*[·•·•�]\s*(.+)$/.exec(s);
  if (m) return { number: m[1], name: m[2].trim() };
  m = /^(\d[\d.\-]*)\s+-\s+(.+)$/.exec(s);
  if (m) return { number: m[1], name: m[2].trim() };
  return { name: s };
}

/** Comparable form of a label/segment: lowercase, single spaces, one separator glyph. */
export function normLabel(s: string): string {
  return s
    .replace(/[·•·•�]/g, '·')
    .replace(/\s*·\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Split a full-path label ('60000 · Automobile:60100 · Fuel') into parsed segments. */
export function parseAccountPath(label: string): Array<{ number?: string; name: string; label: string }> {
  return label
    .split(':')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => ({ ...parseAccountLabel(seg), label: seg }));
}

// ---------------------------------------------------------------------------
// GL report model
// ---------------------------------------------------------------------------

export interface GlLine {
  accountKey: string;
  /** 1-based row number in the source grid (for messages). */
  row: number;
  type: string;
  date: string;
  num: string;
  adj: boolean;
  name: string;
  memo: string;
  className: string;
  split: string;
  transId: string;
  /** Debit/Credit report variant (2dp strings, '0.00' when blank). */
  debit: string;
  credit: string;
  /** 'Amount' report variant: signed amount as printed. */
  amount: string | null;
  /** Running balance as printed (null when the column is absent/blank). */
  balance: string | null;
}

export interface GlTotals {
  debit: string | null;
  credit: string | null;
  amount: string | null;
  balance: string | null;
}

export interface GlAccount {
  key: string;
  label: string;
  number?: string;
  name: string;
  /** Names only, 'Parent:Child'. */
  fullName: string;
  parentKey?: string;
  depth: number;
  order: number;
  /** Created from a full-path label without its own heading row. */
  implicit?: boolean;
  /** Heading appeared inside its parent's section (so the parent's Total includes it). */
  nested?: boolean;
  /** Balance printed on the account heading row (QB Desktop style). */
  headerBalance: string | null;
  /** Balance on an explicit 'Beginning Balance' row. */
  beginningRow: string | null;
  total: GlTotals | null;
  lines: GlLine[];
}

export interface GlReport {
  title: string[];
  companyName?: string;
  period: { start?: string; end?: string; label?: string };
  columns: { debitCredit: boolean; amount: boolean; balance: boolean; transId: boolean };
  accounts: GlAccount[];
  grandTotal: GlTotals | null;
  errors: string[];
  warnings: string[];
}

type ColName =
  | 'type' | 'date' | 'num' | 'adj' | 'name' | 'memo' | 'class' | 'split'
  | 'debit' | 'credit' | 'amount' | 'balance' | 'transId';

const HEADER_NAMES: Record<string, ColName> = {
  type: 'type',
  'transaction type': 'type',
  date: 'date',
  num: 'num',
  no: 'num',
  number: 'num',
  'ref no': 'num',
  adj: 'adj',
  name: 'name',
  'source name': 'name',
  memo: 'memo',
  'memo/description': 'memo',
  description: 'memo',
  class: 'class',
  split: 'split',
  'split account': 'split',
  debit: 'debit',
  credit: 'credit',
  amount: 'amount',
  balance: 'balance',
  'trans #': 'transId',
  'trans no': 'transId',
  'trans': 'transId',
  'transaction #': 'transId',
};

function headerKey(cell: string): ColName | undefined {
  const k = cell.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  return HEADER_NAMES[k];
}

function isGlHeader(cells: string[]): boolean {
  const names = new Set(cells.map(headerKey).filter(Boolean));
  return names.has('type') && names.has('date') && (names.has('debit') || names.has('amount'));
}

const SPLIT_MARKER = /^-+\s*split\s*-+$/i;
export function isSplitMarker(s: string): boolean {
  return SPLIT_MARKER.test(s.trim());
}

const BEGINNING = /^beginning balance$/i;
const FOOTER_TEXT = /^(page\s*\d+(\s*(of|\/)\s*\d+)?|\d+\s*of\s*\d+)$/i;

function amountStr(d: Decimal | null): string | null {
  return d ? toAmountString(d) : null;
}

/**
 * Parse a QuickBooks General Ledger grid. Never throws for a malformed row: anything that
 * cannot be understood but carries money becomes a blocking `errors` entry (so nothing is
 * silently lost); harmless oddities become `warnings`.
 */
export function parseGlGrid(rows: GridRow[]): GlReport {
  const headerIdx = rows.findIndex((r) => isGlHeader(r.cells));
  if (headerIdx < 0) {
    throw new ServiceError(
      'VALIDATION',
      "We couldn't find the General Ledger column headings (Type, Date, … Debit, Credit). Make sure this is QuickBooks' General Ledger report (Reports → Accountant & Taxes → General Ledger).",
    );
  }
  const header = rows[headerIdx].cells;
  const col: Partial<Record<ColName, number>> = {};
  header.forEach((cell, i) => {
    const k = headerKey(cell);
    if (k && col[k] === undefined) col[k] = i;
  });
  const firstDataCol = Math.min(...Object.values(col).filter((v): v is number => v !== undefined));

  const title = rows
    .slice(0, headerIdx)
    .map((r) => r.cells.map((c) => c.trim()).filter(Boolean).join(' '))
    .filter(Boolean);
  const report: GlReport = {
    title,
    companyName: title[0],
    period: {},
    columns: {
      debitCredit: col.debit !== undefined && col.credit !== undefined,
      amount: col.amount !== undefined && col.debit === undefined,
      balance: col.balance !== undefined,
      transId: col.transId !== undefined,
    },
    accounts: [],
    grandTotal: null,
    errors: [],
    warnings: [],
  };
  for (const t of title) {
    const p = parsePeriodLabel(t);
    if (p) {
      report.period = { ...p, label: t };
      break;
    }
  }
  const titleSet = new Set(title.map((t) => t.toLowerCase()));

  const get = (cells: string[], name: ColName): string => {
    const i = col[name];
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };
  // Label = first non-empty cell left of the first data column; level = its column (and
  // leading spaces), or the x position for PDF rows.
  const labelOf = (row: GridRow): { text: string; level: number } | null => {
    for (let i = 0; i < Math.max(firstDataCol, 0); i++) {
      const raw = row.cells[i] ?? '';
      if (raw.trim()) {
        const spaces = raw.length - raw.trimStart().length;
        return { text: raw.trim(), level: row.indent ?? i * 1000 + spaces };
      }
    }
    return null;
  };

  // Does indentation distinguish nesting levels in this file? (If every heading sits at the
  // same level, nesting comes from the Total rows alone.)
  const headingLevels = new Set<number>();
  for (const r of rows.slice(headerIdx + 1)) {
    const l = labelOf(r);
    if (l && !/^total\b/i.test(l.text) && !parseQbDate(get(r.cells, 'date'))) headingLevels.add(l.level);
  }
  const indentInformative = headingLevels.size > 1;

  const byKey = new Map<string, GlAccount>();
  const stack: Array<{ acct: GlAccount; level: number }> = [];
  let lastLine: GlLine | null = null;

  const createAccount = (
    labelText: string,
    parent: GlAccount | undefined,
    implicit = false,
    nested = false,
  ): GlAccount => {
    const parsed = parseAccountLabel(labelText);
    const key = parent ? `${parent.key}:${normLabel(labelText)}` : normLabel(labelText);
    const existing = byKey.get(key);
    if (existing) return existing;
    const acct: GlAccount = {
      key,
      label: labelText,
      number: parsed.number,
      name: parsed.name,
      fullName: parent ? `${parent.fullName}:${parsed.name}` : parsed.name,
      parentKey: parent?.key,
      depth: parent ? parent.depth + 1 : 0,
      order: report.accounts.length,
      implicit: implicit || undefined,
      nested: nested || undefined,
      headerBalance: null,
      beginningRow: null,
      total: null,
      lines: [],
    };
    byKey.set(key, acct);
    report.accounts.push(acct);
    return acct;
  };

  const openAccount = (labelText: string, level: number, balance: string | null, rowNo: number) => {
    if (indentInformative) {
      while (stack.length && stack[stack.length - 1].level >= level) {
        const gone = stack.pop()!;
        if (!gone.acct.total) {
          report.warnings.push(`Account "${gone.acct.label}" has no Total row (closed at row ${rowNo}).`);
        }
      }
    }
    const open = stack.length ? stack[stack.length - 1].acct : undefined;
    let acct: GlAccount;
    const segs = labelText.split(':').map((s) => s.trim()).filter(Boolean);
    if (segs.length > 1) {
      // Full-path label ('Automobile:Fuel'): the path, not the stack, defines the parents.
      let parent: GlAccount | undefined;
      for (let i = 0; i < segs.length - 1; i++) parent = createAccount(segs[i], parent, true);
      acct = createAccount(segs[segs.length - 1], parent, false, !!parent && parent === open);
    } else {
      acct = createAccount(labelText, open, false, !!open);
    }
    if (balance !== null) acct.headerBalance = balance;
    if (acct.implicit) acct.implicit = undefined; // now has its own heading
    stack.push({ acct, level });
    lastLine = null;
  };

  const labelMatches = (acct: GlAccount, text: string): boolean => {
    const a = normLabel(acct.label);
    const b = normLabel(text);
    if (a === b) return true;
    const lastSeg = normLabel(text.split(':').pop() ?? text);
    if (a === lastSeg) return true;
    // PDF columns can truncate long labels.
    return b.length >= 8 && (a.startsWith(b) || b.startsWith(a));
  };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + 1;
    const cells = row.cells;
    const nonEmpty = cells.map((c) => (c ?? '').trim()).filter(Boolean);
    if (!nonEmpty.length) continue;
    if (isGlHeader(cells)) continue; // header repeated on each page
    const joined = nonEmpty.join(' ');
    if (nonEmpty.length === 1 && (FOOTER_TEXT.test(joined) || titleSet.has(joined.toLowerCase()))) continue;

    const label = labelOf(row);
    let typeTxt = get(cells, 'type');
    const date = parseQbDate(get(cells, 'date'));
    const debit = parseAmount(get(cells, 'debit'));
    const credit = parseAmount(get(cells, 'credit'));
    const amount = parseAmount(get(cells, 'amount'));
    const balance = parseAmount(get(cells, 'balance'));
    const hasMoney = !!(debit || credit || amount);
    const top = stack.length ? stack[stack.length - 1].acct : undefined;

    if ((label && BEGINNING.test(label.text)) || BEGINNING.test(typeTxt) || BEGINNING.test(get(cells, 'memo'))) {
      if (!top) {
        report.errors.push(`Row ${rowNo}: a Beginning Balance row appears before any account heading.`);
        continue;
      }
      const value = balance ?? amount ?? (debit || credit ? Money.of(debit).minus(Money.of(credit)) : null);
      top.beginningRow = amountStr(value) ?? '0.00';
      continue;
    }

    if (date) {
      if (!typeTxt && label) typeTxt = label.text; // centred PDF header: Type text left of it
      if (!top) {
        report.errors.push(`Row ${rowNo}: a transaction (${typeTxt} ${get(cells, 'date')}) appears before any account heading.`);
        continue;
      }
      const line: GlLine = {
        accountKey: top.key,
        row: rowNo,
        type: typeTxt,
        date,
        num: get(cells, 'num'),
        adj: /^(x|y|yes|true|✓|√|adj)$/i.test(get(cells, 'adj')),
        name: get(cells, 'name'),
        memo: get(cells, 'memo'),
        className: get(cells, 'class'),
        split: get(cells, 'split'),
        transId: get(cells, 'transId'),
        debit: toAmountString(debit ?? 0),
        credit: toAmountString(credit ?? 0),
        amount: report.columns.amount ? toAmountString(amount ?? 0) : null,
        balance: amountStr(balance),
      };
      if (debit?.isNegative() || credit?.isNegative()) {
        // A negative debit is a credit (and vice versa) — normalise rather than reject.
        const net = Money.of(debit).minus(Money.of(credit));
        line.debit = toAmountString(net.isPositive() ? net : 0);
        line.credit = toAmountString(net.isNegative() ? net.negated() : 0);
      }
      top.lines.push(line);
      lastLine = line;
      continue;
    }

    if (label && /^total\b/i.test(label.text)) {
      const rest = label.text.replace(/^total\s*/i, '').trim();
      const totals: GlTotals = {
        debit: amountStr(debit),
        credit: amountStr(credit),
        amount: amountStr(amount),
        balance: amountStr(balance),
      };
      lastLine = null;
      if (!rest) {
        report.grandTotal = totals;
        continue;
      }
      let idx = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (labelMatches(stack[s].acct, rest)) {
          idx = s;
          break;
        }
      }
      if (idx < 0) {
        if (!hasMoney) {
          // An account whose name merely starts with "Total" (QB Total rows always carry amounts).
          openAccount(label.text, label.level, amountStr(balance), rowNo);
        } else {
          report.errors.push(`Row ${rowNo}: "Total ${rest}" does not match any open account heading.`);
        }
        continue;
      }
      for (let s = stack.length - 1; s > idx; s--) {
        if (!stack[s].acct.total) {
          report.warnings.push(`Account "${stack[s].acct.label}" has no Total row.`);
        }
      }
      stack[idx].acct.total = totals;
      stack.length = idx;
      continue;
    }

    if (label) {
      openAccount(label.text, label.level, amountStr(balance), rowNo);
      continue;
    }

    // No label and no date: a wrapped memo/name line (PDF), a deep-indented heading, or junk.
    const textCols: ColName[] = ['type', 'num', 'name', 'memo', 'class', 'split'];
    const texts = textCols.filter((c) => get(cells, c));
    if (!hasMoney && balance === null && lastLine && texts.every((c) => ['name', 'memo', 'class', 'split'].includes(c))) {
      for (const c of texts) {
        const field = c === 'class' ? 'className' : c;
        const prev = (lastLine as unknown as Record<string, string>)[field];
        (lastLine as unknown as Record<string, string>)[field] = prev ? `${prev} ${get(cells, c)}` : get(cells, c);
      }
      continue;
    }
    if (!hasMoney && typeTxt && texts.length === 1) {
      openAccount(typeTxt, row.indent ?? (col.type ?? 0) * 1000, amountStr(balance), rowNo);
      continue;
    }
    if (hasMoney) {
      report.errors.push(`Row ${rowNo} has amounts but could not be read: "${joined}".`);
    } else {
      report.warnings.push(`Row ${rowNo} ignored: "${joined}".`);
    }
  }
  for (const s of stack) {
    if (!s.acct.total && !s.acct.implicit) report.warnings.push(`Account "${s.acct.label}" has no Total row.`);
  }
  if (!report.accounts.length) {
    report.errors.push('No accounts were found below the column headings.');
  }
  return report;
}

// ---------------------------------------------------------------------------
// Reference files: Account List / Trial Balance / IIF
// ---------------------------------------------------------------------------

export interface RefAccount {
  segments: Array<{ number?: string; name: string; label: string }>;
  qbType: QbAccountType | null;
  /** Trial Balance only: debit-positive balance. */
  balance: string | null;
}

export interface ReferenceData {
  kind: 'account-list' | 'trial-balance' | 'iif';
  asOf?: string;
  accounts: RefAccount[];
}

/** QB IIF chart of accounts (exact types via ACCNTTYPE; NAME is the 'Parent:Child' path). */
export function parseReferenceIif(text: string): ReferenceData {
  const parsed = parseIIF(text);
  const accounts: RefAccount[] = parsed.accounts.map((a) => {
    const segments = parseAccountPath(a.name);
    if (a.accnum && segments.length) segments[segments.length - 1].number = a.accnum.trim();
    return { segments, qbType: normalizeQbType(a.accntType), balance: null };
  });
  if (!accounts.length) {
    throw new ServiceError('VALIDATION', 'This IIF file has no chart of accounts (!ACCNT) section.');
  }
  return { kind: 'iif', accounts };
}

/**
 * QB Account Listing (Account + Type columns) or Trial Balance (Debit + Credit columns) grid.
 */
export function parseReferenceGrid(rows: GridRow[]): ReferenceData {
  const norm = (c: string) => c.trim().toLowerCase().replace(/\./g, '');
  const listIdx = rows.findIndex((r) => {
    const s = new Set(r.cells.map(norm));
    return s.has('account') && s.has('type');
  });
  if (listIdx >= 0) {
    const h = rows[listIdx].cells.map(norm);
    const accountCol = h.indexOf('account');
    const typeCol = h.indexOf('type');
    const numCol = h.findIndex((c) => ['accnt #', 'acct #', 'account #', 'number', 'acct no', 'account number'].includes(c));
    const accounts: RefAccount[] = [];
    for (const r of rows.slice(listIdx + 1)) {
      const name = (r.cells[accountCol] ?? '').trim();
      const qbType = normalizeQbType(r.cells[typeCol]);
      if (!name || !qbType) continue; // non-posting accounts, blank rows
      const segments = parseAccountPath(name);
      const num = numCol >= 0 ? (r.cells[numCol] ?? '').trim() : '';
      if (num && segments.length && !segments[segments.length - 1].number) {
        segments[segments.length - 1].number = num;
      }
      accounts.push({ segments, qbType, balance: null });
    }
    return { kind: 'account-list', accounts };
  }

  const tbIdx = rows.findIndex((r) => {
    const s = new Set(r.cells.map(norm));
    return s.has('debit') && s.has('credit') && !s.has('date');
  });
  if (tbIdx >= 0) {
    const h = rows[tbIdx].cells.map(norm);
    const dCol = h.indexOf('debit');
    const cCol = h.indexOf('credit');
    let asOf: string | undefined;
    for (const r of rows.slice(0, tbIdx)) {
      const p = parsePeriodLabel(r.cells.join(' '));
      if (p?.end) {
        asOf = p.end;
        break;
      }
    }
    const accounts: RefAccount[] = [];
    for (const r of rows.slice(tbIdx + 1)) {
      let label = '';
      for (let i = 0; i < Math.min(dCol, cCol); i++) {
        if ((r.cells[i] ?? '').trim()) {
          label = r.cells[i].trim();
          break;
        }
      }
      if (!label || /^total$/i.test(label)) continue;
      const d = parseAmount(r.cells[dCol]);
      const c = parseAmount(r.cells[cCol]);
      if (!d && !c) continue;
      accounts.push({
        segments: parseAccountPath(label),
        qbType: null,
        balance: toAmountString(Money.of(d).minus(Money.of(c))),
      });
    }
    return { kind: 'trial-balance', asOf, accounts };
  }
  throw new ServiceError(
    'VALIDATION',
    "This file doesn't look like a QuickBooks Account Listing (Account + Type columns) or Trial Balance (Debit + Credit columns).",
  );
}

/** Pick the first sheet that parses as a reference (Account List / Trial Balance). */
export function parseReferenceSheets(sheets: GridSheet[]): ReferenceData {
  let lastErr: unknown;
  for (const s of sheets) {
    try {
      return parseReferenceGrid(s.rows);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new ServiceError('VALIDATION', 'The reference file is empty.');
}

/** Pick the worksheet holding the GL (QB workbooks also carry a "QuickBooks Export Tips" sheet). */
export function parseGlSheets(sheets: GridSheet[]): GlReport {
  const sheet = sheets.find((s) => s.rows.some((r) => isGlHeader(r.cells)));
  if (!sheet) {
    // Re-run on the first sheet for the standard, friendly error.
    return parseGlGrid(sheets[0]?.rows ?? []);
  }
  return parseGlGrid(sheet.rows);
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type TypeSource = 'reference' | 'you' | 'parent' | 'guess';
export type Confidence = 'exact' | 'high' | 'medium' | 'low';

export interface GlAccountView {
  key: string;
  label: string;
  number?: string;
  name: string;
  fullName: string;
  parentKey?: string;
  depth: number;
  order: number;
  qbType: QbAccountType;
  typeSource: TypeSource;
  confidence: Confidence;
  typeReason: string;
  /** +1: printed balances are debit-positive for this account; -1: credit-positive. */
  sign: 1 | -1;
  signSource: 'running-balance' | 'account-type';
  /** Own (not rolled-up) balances, debit-positive. */
  beginning: string;
  ending: string;
  debits: string;
  credits: string;
  lineCount: number;
  /** As-of balance from the optional QB Trial Balance (debit-positive), when matched. */
  tbBalance: string | null;
}

export interface GlTxnLine {
  accountKey: string;
  debit: string;
  credit: string;
  memo: string;
  name: string;
  className: string;
}

export interface GlTxn {
  /** Stable journal sourceRef: 'qbgl:<hash>:<occurrence>'. */
  ref: string;
  type: string;
  date: string;
  num: string;
  adj: boolean;
  name: string;
  memo: string;
  lines: GlTxnLine[];
}

export interface GlReviewLine {
  accountKey: string;
  accountName: string;
  row: number;
  debit: string;
  credit: string;
  name: string;
  memo: string;
  split: string;
}

export interface GlReviewItem {
  id: string;
  type: string;
  date: string;
  num: string;
  reason: string;
  /** Debits minus credits of the unmatched lines. */
  difference: string;
  lines: GlReviewLine[];
}

export type NameRole = 'customer' | 'vendor' | 'employee' | 'other';

export interface GlAnalysis {
  meta: {
    companyName?: string;
    title: string[];
    periodStart: string | null;
    periodEnd: string | null;
    periodLabel?: string;
    firstDate: string | null;
    lastDate: string | null;
    columns: GlReport['columns'];
    /** How printed balances are signed: per account type (QB default) or debit-positive. */
    convention: 'natural' | 'debit-positive';
  };
  accounts: GlAccountView[];
  transactions: GlTxn[];
  review: GlReviewItem[];
  names: Array<{ name: string; role: NameRole; count: number }>;
  classes: string[];
  totals: {
    lineDebits: string;
    lineCredits: string;
    beginningSum: string;
    endingSum: string;
    reportTotalDebit: string | null;
    reportTotalCredit: string | null;
  };
  stats: { lines: number; zeroLines: number; transactions: number; reviewItems: number; reviewLines: number };
  reference?: { kind: ReferenceData['kind']; asOf?: string; matched: number; unmatched: string[] };
  /** Trial Balance rows that match no GL account (label, debit-positive balance). */
  tbUnmatched: Array<{ label: string; balance: string }>;
  errors: string[];
  warnings: string[];
}

export interface AnalyzeOptions {
  reference?: ReferenceData | null;
  /** User choices from the mapping step: account key → QB type. */
  typeOverrides?: Record<string, QbAccountType>;
  periodStart?: string | null;
  periodEnd?: string | null;
}

// ---- type inference --------------------------------------------------------

const NAME_RULES: Array<[RegExp, QbAccountType, number]> = [
  [/accounts? receivable|\ba\/r\b/, 'Accounts Receivable', 8],
  [/accounts? payable|\ba\/p\b/, 'Accounts Payable', 8],
  [/undeposited funds/, 'Other Current Asset', 8],
  [/\b(checking|savings|money market|petty cash|cash on hand|bank)\b/, 'Bank', 5],
  [/^cash$|\bcash (account|in bank)\b/, 'Bank', 5],
  [/prepaid|employee advances?|inventory|loans? to|due from|notes? receivable|other receivable/, 'Other Current Asset', 5],
  [/accumulated depreciation|accum\.? depr|furniture|equipment|vehicles?|buildings?|\bland\b|leasehold|machinery|fixed assets?|computers?/, 'Fixed Asset', 5],
  [/security deposits?|goodwill|organi[sz]ation costs?|intangible|other assets?/, 'Other Asset', 5],
  [/credit card|\bvisa\b|mastercard|master card|\bamex\b|american express|discover card/, 'Credit Card', 6],
  [/payroll liabilit|sales tax payable|accrued|unearned|deferred revenue|customer deposits?|due to|line of credit|gift (card|certificate)|payable/, 'Other Current Liability', 6],
  [/notes? payable|\bloans?\b|mortgage|long[- ]term/, 'Long Term Liability', 5],
  [/equity|retained earnings|capital|owner|draws?\b|distributions?|common stock|shareholder|partner|dividends paid|opening bal/, 'Equity', 6],
  [/other income|interest income|interest earned|dividend income|gain on|finance charge income|miscellaneous income/, 'Other Income', 7],
  [/income|sales|revenue|fees earned|consulting|service/, 'Income', 4],
  [/cost of goods|\bcogs\b|cost of sales|purchases|materials|subcontract|job (costs?|expenses?)/, 'Cost of Goods Sold', 5],
  [/other expense|loss on|ask my accountant|penalt/, 'Other Expense', 5],
  [/expense|fees|\brent\b|utilities|insurance|supplies|repairs|advertising|payroll|wages|salar|depreciation|travel|meals|telephone|postage|dues|licenses|taxes|professional|automobile|office|uncategorized|charitable/, 'Expense', 4],
];

function numberRangeScores(num: string | undefined, add: (t: QbAccountType, s: number) => void) {
  if (!num) return;
  const digits = /^\d+/.exec(num)?.[0];
  if (!digits) return;
  const lead = Number(digits[0]);
  const five = digits.length >= 5;
  const n = Number(digits.slice(0, 5).padEnd(5, '0')); // normalise to 5 digits
  switch (lead) {
    case 1:
      for (const t of ['Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset'] as const) add(t, 2);
      if (n < 11000) add('Bank', 1);
      else if (n < 12000) add('Accounts Receivable', 1);
      else if (n < 15000) add('Other Current Asset', 1);
      else if (n < 18000) add('Fixed Asset', 1);
      else add('Other Asset', 1);
      break;
    case 2:
      for (const t of ['Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability'] as const) add(t, 2);
      if (n < 21000) add('Accounts Payable', 1);
      else if (n < 22000) add('Credit Card', 1);
      else if (n < 27000) add('Other Current Liability', 1);
      else add('Long Term Liability', 1);
      break;
    case 3:
      add('Equity', 4);
      break;
    case 4:
      add('Income', 4);
      break;
    case 5:
      add('Cost of Goods Sold', 3);
      add('Expense', 1);
      break;
    case 6:
      add('Expense', 4);
      break;
    case 7:
      if (five) {
        add('Other Income', 3);
        add('Expense', 1);
      } else add('Expense', 4);
      break;
    case 8:
      if (five) add('Other Expense', 3);
      else add('Other Income', 2);
      add('Expense', 1);
      break;
    case 9:
      add('Other Expense', 3);
      break;
  }
}

/** Per-account evidence from transaction types (which side of which document it sits on). */
function txnSignals(lines: Array<{ type: string; split: string; dr: Decimal }>, add: (t: QbAccountType, s: number) => void) {
  const seen = new Set<string>();
  const once = (k: string, t: QbAccountType, s: number) => {
    if (seen.has(k)) return;
    seen.add(k);
    add(t, s);
  };
  for (const l of lines) {
    const t = l.type.toLowerCase().replace(/\s+/g, ' ').trim();
    const debitSide = l.dr.isPositive();
    const creditSide = l.dr.isNegative();
    const main = isSplitMarker(l.split);
    if ((t === 'invoice' || t === 'statement charge') && debitSide && main) once('inv', 'Accounts Receivable', 8);
    if (t === 'payment' && creditSide) once('pmt-cr', 'Accounts Receivable', 4);
    if (t === 'credit memo' && creditSide && main) once('cm', 'Accounts Receivable', 6);
    if (t === 'bill' && creditSide && main) once('bill', 'Accounts Payable', 8);
    if (t === 'item receipt' && creditSide && main) once('ir', 'Accounts Payable', 6);
    if (t.startsWith('bill pmt') && debitSide) once('billpmt-dr', 'Accounts Payable', 5);
    if (t === 'bill pmt -check' && creditSide) once('billpmt-cr', 'Bank', 6);
    if (t === 'bill pmt -ccard' && creditSide) once('billpmtcc-cr', 'Credit Card', 6);
    if ((t === 'check' || t === 'paycheck' || t === 'liability check') && creditSide && main) once('chk', 'Bank', 6);
    if (t === 'deposit' && debitSide && main) once('dep', 'Bank', 6);
    if (t === 'credit card charge' && creditSide && main) once('ccc', 'Credit Card', 8);
    if (t === 'credit card credit' && debitSide && main) once('cccr', 'Credit Card', 8);
    if (t === 'sales tax payment' && debitSide) once('stp', 'Other Current Liability', 5);
    if (t === 'liability check' && debitSide) once('lc', 'Other Current Liability', 4);
  }
}

// ---- reconstruction ------------------------------------------------------

interface RLine {
  id: number;
  src: GlLine;
  accountKey: string;
  splitKey: string | null;
  marker: boolean;
  dr: Decimal;
}

function sumDr(lines: RLine[]): Decimal {
  return lines.reduce((s, l) => s.plus(l.dr), Money.zero());
}

/** Unique subset of `cands` whose amounts sum to `target` (null when none or ambiguous). */
function uniqueSubset(cands: RLine[], target: Decimal): RLine[] | null {
  if (cands.length > 20) return null;
  const solutions: RLine[][] = [];
  const pick: RLine[] = [];
  const walk = (i: number, sum: Decimal) => {
    if (solutions.length > 1) return;
    if (i === cands.length) {
      if (pick.length && sum.equals(target)) solutions.push([...pick]);
      return;
    }
    pick.push(cands[i]);
    walk(i + 1, sum.plus(cands[i].dr));
    pick.pop();
    walk(i + 1, sum);
  };
  walk(0, Money.zero());
  return solutions.length === 1 ? solutions[0] : null;
}

/**
 * Split one candidate group (same type/date/num/adj, or same Trans #) into balanced entries:
 *  1. pairs  — line in A whose Split is B  ↔  line in B whose Split is A, equal and opposite;
 *  2. stars  — '-SPLIT-' main line in A + the lines whose Split is A that exactly offset it;
 *  3. rest   — whatever remains: one entry if it balances and no line's Split contradicts it,
 *              otherwise a review item.
 */
function solveGroup(
  lines: RLine[],
  byTransId: boolean,
): { txns: RLine[][]; leftover: RLine[]; contradicts: boolean } {
  const total = sumDr(lines);
  if (byTransId) {
    return total.isZero() ? { txns: [lines], leftover: [], contradicts: false } : { txns: [], leftover: lines, contradicts: false };
  }

  const used = new Set<number>();
  const txns: RLine[][] = [];
  const free = () => lines.filter((l) => !used.has(l.id));
  const score = (a: RLine, b: RLine) =>
    (a.src.name === b.src.name ? 2 : 0) + (a.src.memo === b.src.memo ? 1 : 0) + (a.src.className === b.src.className ? 0.5 : 0);

  // 1. pairs
  for (const x of lines) {
    if (used.has(x.id) || x.marker || !x.splitKey || x.splitKey === x.accountKey) continue;
    let best: RLine | null = null;
    for (const y of lines) {
      if (y === x || used.has(y.id) || y.marker) continue;
      if (y.accountKey !== x.splitKey || y.splitKey !== x.accountKey) continue;
      if (!y.dr.equals(x.dr.negated())) continue;
      if (!best || score(x, y) > score(x, best)) best = y;
    }
    if (best) {
      used.add(x.id);
      used.add(best.id);
      txns.push([x, best]);
    }
  }

  // 2. stars
  for (const m of lines) {
    if (used.has(m.id) || !m.marker) continue;
    const cands = free().filter((y) => y !== m && !y.marker && y.splitKey === m.accountKey);
    if (!cands.length) continue;
    const target = m.dr.negated();
    const mainsHere = free().filter((y) => y.marker && y.accountKey === m.accountKey).length;
    let chosen: RLine[] | null = null;
    if (mainsHere === 1 && sumDr(cands).equals(target)) chosen = cands;
    if (!chosen) {
      const sameName = cands.filter((c) => c.src.name === m.src.name);
      if (sameName.length && sumDr(sameName).equals(target)) chosen = sameName;
    }
    if (!chosen) chosen = uniqueSubset(cands, target);
    if (chosen) {
      used.add(m.id);
      for (const c of chosen) used.add(c.id);
      txns.push([m, ...chosen]);
    }
  }

  // 3. rest — only posted when the Split column agrees with the grouping (see splitsConsistent).
  const rest = free();
  if (!rest.length) return { txns, leftover: [], contradicts: false };
  if (sumDr(rest).isZero()) {
    // Prefer one entry per payee when each payee's lines balance on their own.
    const byName = new Map<string, RLine[]>();
    for (const l of rest) byName.set(l.src.name, [...(byName.get(l.src.name) ?? []), l]);
    const perPayee = [...byName.values()];
    if (byName.size > 1 && perPayee.every((g) => sumDr(g).isZero() && splitsConsistent(g))) {
      txns.push(...perPayee);
      return { txns, leftover: [], contradicts: false };
    }
    if (splitsConsistent(rest)) {
      txns.push(rest);
      return { txns, leftover: [], contradicts: false };
    }
    // Balanced, but the Split column says these lines belong to other transactions: never force it.
    return { txns, leftover: rest, contradicts: true };
  }
  return { txns, leftover: rest, contradicts: false };
}

/**
 * True when no line's Split contradicts putting `entry` together: every non-'-SPLIT-' line whose
 * Split names a known account must point at another line of the same entry. Lines with an empty
 * or unrecognised Split carry no evidence either way.
 */
function splitsConsistent(entry: RLine[]): boolean {
  return entry.every((l) => {
    if (l.marker || !l.splitKey) return true;
    return entry.some((o) => o !== l && o.accountKey === l.splitKey);
  });
}

function hashOf(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
}

const CUSTOMER_TYPES = new Set(['invoice', 'payment', 'credit memo', 'sales receipt', 'statement charge', 'refund', 'customer refund']);
const VENDOR_TYPES = new Set([
  'bill', 'bill pmt -check', 'bill pmt -ccard', 'check', 'credit card charge', 'credit card credit',
  'item receipt', 'credit', 'liability check', 'sales tax payment', 'vendor credit',
]);
const EMPLOYEE_TYPES = new Set(['paycheck', 'liability adjustment', 'ytd adjustment']);

function roleOfType(type: string): NameRole {
  const t = type.toLowerCase().replace(/\s+/g, ' ').trim();
  if (EMPLOYEE_TYPES.has(t)) return 'employee';
  if (CUSTOMER_TYPES.has(t)) return 'customer';
  if (VENDOR_TYPES.has(t)) return 'vendor';
  return 'other';
}

/** Run the full analysis. Pure and deterministic for the same inputs. */
export function analyzeGl(report: GlReport, opts: AnalyzeOptions = {}): GlAnalysis {
  const errors = [...report.errors];
  const warnings = [...report.warnings];
  const accounts = report.accounts;
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  const childrenOf = new Map<string, GlAccount[]>();
  for (const a of accounts) {
    if (a.parentKey) childrenOf.set(a.parentKey, [...(childrenOf.get(a.parentKey) ?? []), a]);
  }
  const topOf = (a: GlAccount): GlAccount => {
    let cur = a;
    while (cur.parentKey && byKey.get(cur.parentKey)) cur = byKey.get(cur.parentKey)!;
    return cur;
  };
  const subtreeLines = (a: GlAccount): GlLine[] => [
    ...a.lines,
    ...(childrenOf.get(a.key) ?? []).flatMap(subtreeLines),
  ];

  // ---- split-column resolution index ----
  const index = new Map<string, string | null>(); // normalised text → account key (null = ambiguous)
  const addIndex = (k: string, key: string) => {
    if (!k) return;
    if (index.has(k) && index.get(k) !== key) index.set(k, null);
    else index.set(k, key);
  };
  const labelPath = (a: GlAccount): string =>
    a.parentKey && byKey.get(a.parentKey) ? `${labelPath(byKey.get(a.parentKey)!)}:${a.label}` : a.label;
  for (const a of accounts) {
    addIndex(normLabel(labelPath(a)), a.key);
    addIndex(normLabel(a.fullName), a.key);
    addIndex(normLabel(a.label), a.key);
    if (a.number) addIndex(`#${a.number.toLowerCase()}`, a.key);
    addIndex(normLabel(a.name), a.key);
  }
  const resolveSplit = (raw: string): string | null => {
    const s = raw.trim();
    if (!s || isSplitMarker(s)) return null;
    for (const k of [normLabel(s), normLabel(s.split(':').pop() ?? s)]) {
      const hit = index.get(k);
      if (hit) return hit;
    }
    const last = parseAccountLabel(s.split(':').pop() ?? s);
    if (last.number) {
      const hit = index.get(`#${last.number.toLowerCase()}`);
      if (hit) return hit;
    }
    const byName = index.get(normLabel(last.name));
    return byName ?? null;
  };

  // ---- reference matching ----
  const ref = opts.reference ?? null;
  const refType = new Map<string, QbAccountType>();
  const tbBalance = new Map<string, Decimal>();
  const tbUnmatched: Array<{ label: string; balance: string }> = [];
  let refMatched = 0;
  const refUnmatched: string[] = [];
  if (ref) {
    for (const r of ref.accounts) {
      const leaf = r.segments[r.segments.length - 1];
      if (!leaf) continue;
      let key: string | null = null;
      if (leaf.number) key = index.get(`#${leaf.number.toLowerCase()}`) ?? null;
      if (!key) key = index.get(normLabel(r.segments.map((s) => s.name).join(':'))) ?? null;
      if (!key) key = index.get(normLabel(r.segments.map((s) => s.label).join(':'))) ?? null;
      if (!key && r.segments.length === 1) key = index.get(normLabel(leaf.name)) ?? null;
      const label = r.segments.map((s) => s.label).join(':');
      if (!key) {
        if (r.balance !== null && !Money.isZero(r.balance)) tbUnmatched.push({ label, balance: r.balance });
        else if (ref.kind !== 'trial-balance') refUnmatched.push(label);
        continue;
      }
      refMatched++;
      if (r.qbType) refType.set(key, r.qbType);
      if (r.balance !== null) tbBalance.set(key, Money.of(r.balance).plus(tbBalance.get(key) ?? 0));
    }
  }

  // ---- running-balance sign votes (Debit/Credit variant) ----
  const votes = new Map<string, { plus: number; minus: number; mismatch: number }>();
  for (const a of accounts) {
    const v = { plus: 0, minus: 0, mismatch: 0 };
    const hasChildren = (childrenOf.get(a.key) ?? []).length > 0;
    let prev: Decimal | null =
      !hasChildren && (a.beginningRow ?? a.headerBalance) !== null
        ? Money.of(a.beginningRow ?? a.headerBalance)
        : null;
    if (report.columns.debitCredit) {
      for (const l of a.lines) {
        const net = Money.of(l.debit).minus(l.credit);
        if (l.balance === null) continue;
        const bal = Money.of(l.balance);
        if (prev !== null && !net.isZero()) {
          const delta = bal.minus(prev);
          if (delta.equals(net)) v.plus++;
          else if (delta.equals(net.negated())) v.minus++;
          else v.mismatch++;
        }
        prev = bal;
      }
    }
    votes.set(a.key, v);
  }
  const anyMinus = [...votes.values()].some((v) => v.minus > v.plus);

  // ---- type inference ----
  const overrides = opts.typeOverrides ?? {};
  const guess = new Map<string, { t: QbAccountType; score: number; margin: number; reason: string }>();
  const scoreTop = (a: GlAccount, sideVote: number, withSignals: (add: (t: QbAccountType, s: number) => void) => void) => {
    const scores = new Map<QbAccountType, number>(QB_ACCOUNT_TYPES.map((t) => [t, 0]));
    const reasons: string[] = [];
    const add = (t: QbAccountType, s: number) => scores.set(t, (scores.get(t) ?? 0) + s);
    const nm = a.name.toLowerCase();
    for (const [re, t, s] of NAME_RULES) {
      if (re.test(nm)) {
        add(t, s);
        reasons.push(`name suggests ${t}`);
        break; // first (most specific) rule wins
      }
    }
    numberRangeScores(a.number, add);
    withSignals(add);
    if (sideVote !== 0) {
      for (const t of QB_ACCOUNT_TYPES) {
        if (isDebitNormal(t) !== sideVote > 0) add(t, -10);
      }
    }
    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]);
    return { ranked, reasons };
  };

  const tops = accounts.filter((a) => !a.parentKey || !byKey.get(a.parentKey));
  const decide = (signalLines: (a: GlAccount) => Array<{ type: string; split: string; dr: Decimal }>) => {
    guess.clear();
    // Pass 1: names, numbers, transaction types, balance sign.
    const first = new Map<string, ReturnType<typeof scoreTop>>();
    for (const a of tops) {
      const sub = [a, ...accounts.filter((x) => x !== a && topOf(x) === a)];
      let side = 0;
      for (const s of sub) {
        const v = votes.get(s.key)!;
        if (v.plus > v.minus) side += 1;
        if (v.minus > v.plus) side -= 1;
      }
      // Only a natural-sign report reveals the normal side through its running balances.
      const sideVote = anyMinus ? side : 0;
      first.set(a.key, scoreTop(a, sideVote, (add) => txnSignals(subtreeLines(a).length ? sub.flatMap(signalLines) : [], add)));
    }
    // Pass 2: QB lists accounts in type order — nudge weak guesses toward their neighbours.
    const rankOf = (t: QbAccountType) => QB_ACCOUNT_TYPES.indexOf(t);
    const confident = tops.map((a) => {
      const r = first.get(a.key)!.ranked;
      return r[0][1] >= 6 && r[0][1] - r[1][1] >= 3 ? rankOf(r[0][0]) : null;
    });
    tops.forEach((a, i) => {
      const { ranked, reasons } = first.get(a.key)!;
      let lo = 0;
      let hi = QB_ACCOUNT_TYPES.length - 1;
      for (let j = i - 1; j >= 0; j--) if (confident[j] !== null) { lo = confident[j]!; break; }
      for (let j = i + 1; j < tops.length; j++) if (confident[j] !== null) { hi = confident[j]!; break; }
      const adjusted = ranked
        .map(([t, s]) => [t, s + (lo <= hi && rankOf(t) >= lo && rankOf(t) <= hi ? 2 : 0) + (lo === hi && rankOf(t) === lo ? 2 : 0)] as const)
        .sort((x, y) => y[1] - x[1]);
      const [best, second] = adjusted;
      guess.set(a.key, {
        t: best[0],
        score: best[1],
        margin: best[1] - second[1],
        reason: reasons[0] ?? (a.number ? `account number ${a.number}` : 'position in the report'),
      });
    });
  };

  // Line debit-positive amounts depend on the report variant (and, for 'Amount', a hypothesis).
  let amountHypothesis: 'debit-positive' | 'natural' = 'debit-positive';
  const typeOf = new Map<string, { t: QbAccountType; source: TypeSource; confidence: Confidence; reason: string }>();
  const resolveTypes = () => {
    typeOf.clear();
    const visit = (a: GlAccount, parentType?: QbAccountType) => {
      let entry: { t: QbAccountType; source: TypeSource; confidence: Confidence; reason: string };
      if (overrides[a.key] && QB_ACCOUNT_TYPES.includes(overrides[a.key])) {
        entry = { t: overrides[a.key], source: 'you', confidence: 'exact', reason: 'chosen by you' };
      } else if (refType.has(a.key)) {
        entry = { t: refType.get(a.key)!, source: 'reference', confidence: 'exact', reason: 'from your QuickBooks account list' };
      } else if (parentType) {
        entry = { t: parentType, source: 'parent', confidence: 'high', reason: 'same type as its parent account' };
      } else {
        const g = guess.get(a.key)!;
        entry = {
          t: g.t,
          source: 'guess',
          confidence: g.score >= 8 && g.margin >= 3 ? 'high' : g.score >= 4 && g.margin >= 1 ? 'medium' : 'low',
          reason: g.reason,
        };
      }
      typeOf.set(a.key, entry);
      for (const c of childrenOf.get(a.key) ?? []) visit(c, entry.t);
    };
    for (const a of tops) visit(a);
  };

  const lineDr = (l: GlLine): Decimal => {
    if (!report.columns.amount) return Money.of(l.debit).minus(l.credit);
    const amt = Money.of(l.amount);
    if (amountHypothesis === 'debit-positive') return amt;
    const t = typeOf.get(l.accountKey)?.t ?? 'Expense';
    return isDebitNormal(t) ? amt : amt.negated();
  };

  // Initial pass without signals for the 'Amount' variant (sides unknown until a hypothesis).
  decide(report.columns.amount ? () => [] : (a) => a.lines.map((l) => ({ type: l.type, split: l.split, dr: lineDr(l) })));
  resolveTypes();
  if (report.columns.amount) {
    // Choose the reading of the Amount column under which more document groups balance.
    const balancedGroups = () => {
      const sums = new Map<string, Decimal>();
      for (const a of accounts) {
        for (const l of a.lines) {
          const k = l.transId || `${l.type}|${l.date}|${l.num}|${l.adj}`;
          sums.set(k, (sums.get(k) ?? Money.zero()).plus(lineDr(l)));
        }
      }
      return [...sums.values()].filter((s) => s.isZero()).length;
    };
    amountHypothesis = 'debit-positive';
    const dp = balancedGroups();
    amountHypothesis = 'natural';
    const nat = balancedGroups();
    amountHypothesis = nat > dp ? 'natural' : 'debit-positive';
    decide((a) => a.lines.map((l) => ({ type: l.type, split: l.split, dr: lineDr(l) })));
    resolveTypes();
  }

  const convention: 'natural' | 'debit-positive' = report.columns.amount
    ? amountHypothesis
    : anyMinus
      ? 'natural'
      : (() => {
          // No account printed a credit-positive running balance. If some credit-normal account
          // has activity whose running balance rises with debits, the report is debit-positive.
          for (const a of accounts) {
            const v = votes.get(a.key)!;
            const t = typeOf.get(a.key)!.t;
            if (!isDebitNormal(t) && v.plus > 0) return 'debit-positive';
          }
          return 'natural';
        })();

  // ---- balances ----
  const signOf = new Map<string, { s: 1 | -1; src: GlAccountView['signSource'] }>();
  for (const a of accounts) {
    const v = votes.get(a.key)!;
    const t = typeOf.get(a.key)!.t;
    if (!report.columns.amount && v.plus !== v.minus) {
      signOf.set(a.key, { s: v.plus > v.minus ? 1 : -1, src: 'running-balance' });
    } else {
      signOf.set(a.key, { s: convention === 'natural' && !isDebitNormal(t) ? -1 : 1, src: 'account-type' });
    }
    if (v.mismatch > 0 && !report.columns.amount) {
      warnings.push(`"${a.fullName}": the running balance doesn't follow the amounts on ${v.mismatch} row(s). The totals are still checked below.`);
    }
  }

  const own = new Map<string, { dr: Decimal; cr: Decimal; net: Decimal }>();
  for (const a of accounts) {
    let dr = Money.zero();
    let cr = Money.zero();
    for (const l of a.lines) {
      const x = lineDr(l);
      if (x.isPositive()) dr = dr.plus(x);
      else cr = cr.minus(x);
    }
    own.set(a.key, { dr, cr, net: dr.minus(cr) });
  }
  const subtreeActivity = (a: GlAccount): { dr: Decimal; cr: Decimal } => {
    const o = own.get(a.key)!;
    let dr = o.dr;
    let cr = o.cr;
    for (const c of childrenOf.get(a.key) ?? []) {
      const s = subtreeActivity(c);
      dr = dr.plus(s.dr);
      cr = cr.plus(s.cr);
    }
    return { dr, cr };
  };

  const subtreeNet = (a: GlAccount): Decimal =>
    (childrenOf.get(a.key) ?? []).reduce((acc, c) => acc.plus(subtreeNet(c)), own.get(a.key)!.net);

  const endCache = new Map<string, Decimal>(); // subtree ending (debit-positive)
  const ownEnd = new Map<string, Decimal>();
  const ownBegin = new Map<string, Decimal>();
  if (!report.columns.balance) {
    warnings.push(
      "This report has no Balance column, so it shows no beginning balances — only the period's activity will be imported. Add the Balance column in QuickBooks (Customize Report) to bring balances over.",
    );
  }
  const computeEnd = (a: GlAccount): Decimal => {
    if (endCache.has(a.key)) return endCache.get(a.key)!;
    const s = signOf.get(a.key)!.s;
    const kids = childrenOf.get(a.key) ?? [];
    const kidsEnd = kids.reduce((acc, c) => acc.plus(computeEnd(c)), Money.zero());
    const o = own.get(a.key)!;
    const explicitBegin = a.beginningRow ?? a.headerBalance;
    // Does the parent's Total row include its sub-accounts? QB Desktop's nested layout does;
    // a flat 'Parent:Child' layout does not. Prefer what the Total row's activity says.
    let rollup = kids.length > 0 && kids.every((k) => k.nested);
    if (a.total && kids.length && a.total.debit !== null && a.total.credit !== null) {
      const sub = subtreeActivity(a);
      const td = Money.of(a.total.debit);
      const tc = Money.of(a.total.credit);
      const matchesOwn = td.equals(o.dr) && tc.equals(o.cr);
      const matchesSub = td.equals(sub.dr) && tc.equals(sub.cr);
      if (matchesOwn !== matchesSub) rollup = matchesSub;
    }
    let mine: Decimal;
    if (a.total && report.columns.balance) {
      // A blank balance on a Total row is a zero balance.
      const shown = Money.of(a.total.balance ?? 0).times(s);
      mine = rollup ? shown.minus(kidsEnd) : shown;
    } else if (a.total) {
      // No Balance column: the Total row is the period activity; there is no beginning balance.
      mine = (explicitBegin !== null ? Money.of(explicitBegin).times(s) : Money.zero()).plus(o.net);
    } else {
      const lastBal = [...a.lines].reverse().find((l) => l.balance !== null)?.balance ?? null;
      if (lastBal !== null && !kids.length) mine = Money.of(lastBal).times(s);
      else if (explicitBegin !== null && !kids.length) mine = Money.of(explicitBegin).times(s).plus(o.net);
      else mine = o.net;
      if (!a.implicit && (a.lines.length || explicitBegin !== null)) {
        warnings.push(`"${a.fullName}" has no Total row; its ending balance was worked out from its rows.`);
      }
    }
    ownEnd.set(a.key, mine);
    ownBegin.set(a.key, mine.minus(o.net));
    const full = mine.plus(kidsEnd);
    endCache.set(a.key, full);
    return full;
  };
  for (const a of tops) computeEnd(a);

  // Self-checks: each account must roll forward from its beginning balance to its Total row,
  // and its rows must add up to the activity printed on the Total row.
  for (const a of accounts) {
    const s = signOf.get(a.key)!.s;
    const kids = childrenOf.get(a.key) ?? [];
    const explicitBegin = a.beginningRow ?? a.headerBalance;
    if (explicitBegin !== null && a.total && report.columns.balance) {
      const shown = Money.of(explicitBegin).times(s);
      const mine = ownBegin.get(a.key)!;
      const subtreeBegin = endCache.get(a.key)!.minus(subtreeNet(a));
      if (!shown.equals(mine) && !(kids.length && shown.equals(subtreeBegin))) {
        errors.push(
          `"${a.fullName}": the beginning balance (${toAmountString(shown)}) plus this period's activity does not equal the ending balance on its Total row (that needs a beginning balance of ${toAmountString(mine)}). Some rows may be missing from the export.`,
        );
      }
    }
    if (a.total && a.total.debit !== null && a.total.credit !== null && report.columns.debitCredit) {
      const o = own.get(a.key)!;
      const sub = subtreeActivity(a);
      const td = Money.of(a.total.debit);
      const tc = Money.of(a.total.credit);
      const okOwn = td.equals(o.dr) && tc.equals(o.cr);
      const okSub = td.equals(sub.dr) && tc.equals(sub.cr);
      if (!okOwn && !okSub) {
        errors.push(
          `"${a.fullName}": its rows add up to debits ${toAmountString(sub.dr)} / credits ${toAmountString(sub.cr)}, but the Total row shows ${toAmountString(td)} / ${toAmountString(tc)}. Some rows may be missing or misread.`,
        );
      }
    }
  }

  let beginningSum = Money.zero();
  let endingSum = Money.zero();
  let lineDebits = Money.zero();
  let lineCredits = Money.zero();
  for (const a of accounts) {
    beginningSum = beginningSum.plus(ownBegin.get(a.key)!);
    endingSum = endingSum.plus(ownEnd.get(a.key)!);
    lineDebits = lineDebits.plus(own.get(a.key)!.dr);
    lineCredits = lineCredits.plus(own.get(a.key)!.cr);
  }
  const guessedSign = accounts
    .filter((a) => signOf.get(a.key)!.src === 'account-type' && !ownEnd.get(a.key)!.isZero() && typeOf.get(a.key)!.confidence !== 'exact')
    .map((a) => a.fullName);
  const signHint = guessedSign.length
    ? ` Check the account types of: ${guessedSign.slice(0, 8).join(', ')}${guessedSign.length > 8 ? ', …' : ''} — their balance direction was worked out from the type.`
    : '';
  if (!beginningSum.isZero()) {
    errors.push(
      `The beginning balances in this report don't add up to zero (they are off by ${toAmountString(beginningSum)}). A complete General Ledger always nets to zero, so the opening entry can't be balanced. Export the GL for ALL accounts (no filters).${signHint}`,
    );
  }
  // An out-of-balance ending total (or report TOTAL row) is explained when it equals the
  // transactions that could not be matched (e.g. a report filtered to some accounts): those go
  // to review and the import can still proceed with the user's explicit variance acceptance.
  // Otherwise it means we misread the report, which blocks the import.
  const deferred: Array<{ amount: Decimal; message: string }> = [];
  if (!endingSum.isZero()) {
    deferred.push({
      amount: endingSum,
      message: `The ending balances in this report don't add up to zero (they are off by ${toAmountString(endingSum)}). Export the GL for ALL accounts (no filters).${signHint}`,
    });
  }
  if (report.grandTotal && report.columns.debitCredit) {
    const gd = report.grandTotal.debit !== null ? Money.of(report.grandTotal.debit) : null;
    const gc = report.grandTotal.credit !== null ? Money.of(report.grandTotal.credit) : null;
    if (gd && gc && !gd.equals(gc)) {
      deferred.push({
        amount: gd.minus(gc),
        message: `The report's own TOTAL row is out of balance (debits ${toAmountString(gd)} ≠ credits ${toAmountString(gc)}).`,
      });
    }
    if (gd && !gd.equals(lineDebits)) {
      errors.push(`The report's TOTAL debits are ${toAmountString(gd)} but the rows we read add up to ${toAmountString(lineDebits)}. Some rows were not read.`);
    }
    if (gc && !gc.equals(lineCredits)) {
      errors.push(`The report's TOTAL credits are ${toAmountString(gc)} but the rows we read add up to ${toAmountString(lineCredits)}. Some rows were not read.`);
    }
  }

  // ---- period ----
  const allLines = accounts.flatMap((a) => a.lines);
  const dates = allLines.map((l) => l.date).sort();
  const firstDate = dates[0] ?? null;
  const lastDate = dates[dates.length - 1] ?? null;
  const periodStart = opts.periodStart || report.period.start || firstDate;
  const periodEnd = opts.periodEnd || report.period.end || lastDate;
  if (periodStart && firstDate && firstDate < periodStart) {
    errors.push(`Some transactions (from ${firstDate}) are dated before the period start ${periodStart}. Check the report dates.`);
  }
  if (periodEnd && lastDate && lastDate > periodEnd) {
    errors.push(`Some transactions (to ${lastDate}) are dated after the period end ${periodEnd}. Check the report dates.`);
  }
  if (!periodStart && !beginningSum.isZero()) {
    errors.push('The report period start date is unknown; enter it so the opening balances can be dated.');
  }

  // ---- reconstruction ----
  let nextId = 0;
  const groups = new Map<string, { byTransId: boolean; lines: RLine[] }>();
  let zeroLines = 0;
  for (const a of accounts) {
    for (const l of a.lines) {
      const dr = lineDr(l);
      if (dr.isZero()) {
        zeroLines++;
        continue;
      }
      const byTransId = !!l.transId;
      const gk = byTransId ? `#${l.transId}` : `${l.type.toLowerCase()}|${l.date}|${l.num}|${l.adj}`;
      const g = groups.get(gk) ?? { byTransId, lines: [] };
      g.lines.push({
        id: nextId++,
        src: l,
        accountKey: a.key,
        splitKey: resolveSplit(l.split),
        marker: isSplitMarker(l.split),
        dr,
      });
      groups.set(gk, g);
    }
  }
  const transactions: GlTxn[] = [];
  const review: GlReviewItem[] = [];
  const occurrences = new Map<string, number>();
  const nameRoles = new Map<string, { customer: number; vendor: number; employee: number; other: number }>();
  const vote = (name: string, role: NameRole) => {
    if (!name) return;
    const v = nameRoles.get(name) ?? { customer: 0, vendor: 0, employee: 0, other: 0 };
    v[role]++;
    nameRoles.set(name, v);
  };
  const classes = new Set<string>();
  for (const l of allLines) if (l.className) classes.add(l.className);

  for (const [gk, g] of groups) {
    const { txns, leftover, contradicts } = solveGroup(g.lines, g.byTransId);
    for (const t of txns) {
      // Invariant: every rebuilt entry balances exactly (re-checked by postJournalEntry).
      if (!sumDr(t).isZero()) throw new ServiceError('INTERNAL', `Rebuilt entry ${gk} does not balance.`);
      const main = t.find((l) => l.marker) ?? t[0];
      const src = main.src;
      const header = {
        type: src.type,
        date: src.date,
        num: src.num,
        adj: src.adj,
        name: src.name || t.find((l) => l.src.name)?.src.name || '',
        memo: src.memo || t.find((l) => l.src.memo)?.src.memo || '',
      };
      const lines: GlTxnLine[] = t.map((l) => ({
        accountKey: l.accountKey,
        debit: toAmountString(l.dr.isPositive() ? l.dr : 0),
        credit: toAmountString(l.dr.isNegative() ? l.dr.negated() : 0),
        memo: l.src.memo,
        name: l.src.name,
        className: l.src.className,
      }));
      const fingerprint = hashOf([
        header.type.toLowerCase(),
        header.date,
        header.num,
        header.adj,
        lines
          .map((l) => [byKey.get(l.accountKey)!.fullName.toLowerCase(), l.debit, l.credit, l.name, l.memo, l.className])
          .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)),
      ]);
      const occ = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occ + 1);
      transactions.push({ ref: `qbgl:${fingerprint}:${occ}`, ...header, lines });
      const role = roleOfType(header.type);
      vote(header.name, role);
      for (const l of lines) {
        if (l.name && l.name !== header.name && l.name.includes(':')) vote(l.name, 'customer'); // jobs
      }
    }
    if (leftover.length) {
      const first = leftover[0].src;
      const diff = sumDr(leftover);
      const pairedElsewhere = txns.length > 0;
      review.push({
        id: hashOf([gk, leftover.map((l) => l.src.row)]).slice(0, 12),
        type: first.type,
        date: first.date,
        num: first.num,
        difference: toAmountString(diff),
        reason: contradicts
          ? `These lines offset each other, but their Split column says each one belongs with a different account, so they may be separate ${first.type || 'transaction'}s whose other halves are missing. Please check them in QuickBooks.`
          : pairedElsewhere
          ? `These lines are left over after matching the rest of this ${first.type || 'transaction'} group, and they don't balance (off by ${toAmountString(diff.abs())}).`
          : `The lines of this ${first.type || 'transaction'} don't balance (off by ${toAmountString(diff.abs())}). The other side may be in an account missing from the export.`,
        lines: leftover.map((l) => ({
          accountKey: l.accountKey,
          accountName: byKey.get(l.accountKey)!.fullName,
          row: l.src.row,
          debit: toAmountString(l.dr.isPositive() ? l.dr : 0),
          credit: toAmountString(l.dr.isNegative() ? l.dr.negated() : 0),
          name: l.src.name,
          memo: l.src.memo,
          split: l.src.split,
        })),
      });
    }
  }
  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const reviewNet = review.reduce((acc, r) => acc.plus(r.difference), Money.zero());
  for (const d of deferred) {
    if (review.length && d.amount.equals(reviewNet)) {
      warnings.push(`${d.message} This is exactly the amount of the transactions listed for review.`);
    } else {
      errors.push(d.message);
    }
  }
  review.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const names = [...nameRoles.entries()]
    .map(([name, v]) => {
      const order: NameRole[] = ['employee', 'customer', 'vendor'];
      let role: NameRole = 'other';
      let best = 0;
      for (const r of order) {
        if (v[r] > best) {
          best = v[r];
          role = r;
        }
      }
      return { name, role, count: v.customer + v.vendor + v.employee + v.other };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const views: GlAccountView[] = accounts.map((a) => {
    const t = typeOf.get(a.key)!;
    const o = own.get(a.key)!;
    return {
      key: a.key,
      label: a.label,
      number: a.number,
      name: a.name,
      fullName: a.fullName,
      parentKey: a.parentKey,
      depth: a.depth,
      order: a.order,
      qbType: t.t,
      typeSource: t.source,
      confidence: t.confidence,
      typeReason: t.reason,
      sign: signOf.get(a.key)!.s,
      signSource: signOf.get(a.key)!.src,
      beginning: toAmountString(ownBegin.get(a.key)!),
      ending: toAmountString(ownEnd.get(a.key)!),
      debits: toAmountString(o.dr),
      credits: toAmountString(o.cr),
      lineCount: a.lines.length,
      tbBalance: tbBalance.has(a.key) ? toAmountString(tbBalance.get(a.key)!) : ref?.kind === 'trial-balance' ? '0.00' : null,
    };
  });

  if (review.length) {
    warnings.push(
      `${review.length} transaction group(s) could not be matched into balanced entries. They are listed for review and will NOT be posted.`,
    );
  }

  return {
    meta: {
      companyName: report.companyName,
      title: report.title,
      periodStart: periodStart ?? null,
      periodEnd: periodEnd ?? null,
      periodLabel: report.period.label,
      firstDate,
      lastDate,
      columns: report.columns,
      convention,
    },
    accounts: views,
    transactions,
    review,
    names,
    classes: [...classes].sort(),
    totals: {
      lineDebits: toAmountString(lineDebits),
      lineCredits: toAmountString(lineCredits),
      beginningSum: toAmountString(beginningSum),
      endingSum: toAmountString(endingSum),
      reportTotalDebit: report.grandTotal?.debit ?? null,
      reportTotalCredit: report.grandTotal?.credit ?? null,
    },
    stats: {
      lines: allLines.length,
      zeroLines,
      transactions: transactions.length,
      reviewItems: review.length,
      reviewLines: review.reduce((n, r) => n + r.lines.length, 0),
    },
    reference: ref
      ? { kind: ref.kind, asOf: ref.asOf, matched: refMatched, unmatched: refUnmatched }
      : undefined,
    tbUnmatched,
    errors,
    warnings,
  };
}
