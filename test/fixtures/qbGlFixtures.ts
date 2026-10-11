/**
 * Test fixtures: realistic QuickBooks Desktop General Ledger exports, generated from one
 * balanced model so every format (CSV, .xlsx, PDF) carries exactly the same books.
 *
 * The generator mimics QB's layout: report title block, indentation columns for
 * 'Parent:Child' sub-accounts, account heading rows carrying the beginning balance (or QBO-style
 * 'Beginning Balance' rows), transaction rows with Split ('-SPLIT-' on the main line of a
 * multi-line transaction), running balances in each account's natural sign, 'Total <account>'
 * rows that roll up sub-accounts, and a final TOTAL. The PDF version is multi-page with the
 * title block + column header repeated on every page, 'Page n of N' footers, '(1,234.56)'
 * negatives, and wrapped memo lines.
 */
import AdmZip from 'adm-zip';
import Papa from 'papaparse';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';
import { QB_ACCOUNT_TYPES, isDebitNormal, type QbAccountType } from '@/lib/services/qbGlParse';

export interface FxAccount {
  number: string;
  name: string;
  type: QbAccountType;
  parent?: string;
  /** Beginning balance, debit-positive. */
  begin: string;
}
export interface FxLine {
  acct: string;
  /** Debit-positive amount. */
  amount: string;
  name?: string;
  memo?: string;
  cls?: string;
}
export interface FxTxn {
  type: string;
  /** MM/DD/YYYY */
  date: string;
  num?: string;
  name: string;
  memo?: string;
  /** lines[0] is the main line (bank side of a check, A/R side of an invoice, …). */
  lines: FxLine[];
}
export interface GlFixture {
  company: string;
  periodLabel: string;
  accounts: FxAccount[];
  txns: FxTxn[];
}

export const SAMPLE_GL: GlFixture = {
  company: 'Rock Castle Test Co',
  periodLabel: 'January 1 through March 31, 2024',
  accounts: [
    { number: '10100', name: 'Checking', type: 'Bank', begin: '25000.00' },
    { number: '10200', name: 'Savings', type: 'Bank', begin: '10000.00' },
    { number: '11000', name: 'Accounts Receivable', type: 'Accounts Receivable', begin: '3500.00' },
    { number: '12000', name: 'Undeposited Funds', type: 'Other Current Asset', begin: '0.00' },
    { number: '13000', name: 'Inventory Asset', type: 'Other Current Asset', begin: '0.00' },
    { number: '15000', name: 'Furniture and Equipment', type: 'Fixed Asset', begin: '12000.00' },
    { number: '17000', name: 'Accumulated Depreciation', type: 'Fixed Asset', begin: '-2400.00' },
    { number: '20000', name: 'Accounts Payable', type: 'Accounts Payable', begin: '-1800.00' },
    { number: '21000', name: 'Visa Card', type: 'Credit Card', begin: '-600.00' },
    { number: '24000', name: 'Payroll Liabilities', type: 'Other Current Liability', begin: '-900.00' },
    { number: '30000', name: 'Opening Balance Equity', type: 'Equity', begin: '-14800.00' },
    { number: '32000', name: 'Retained Earnings', type: 'Equity', begin: '-30000.00' },
    { number: '40000', name: 'Sales', type: 'Income', begin: '0.00' },
    { number: '40100', name: 'Consulting Income', type: 'Income', parent: '40000', begin: '0.00' },
    { number: '40200', name: 'Product Sales', type: 'Income', parent: '40000', begin: '0.00' },
    { number: '50000', name: 'Cost of Goods Sold', type: 'Cost of Goods Sold', begin: '0.00' },
    { number: '60000', name: 'Automobile', type: 'Expense', begin: '0.00' },
    { number: '60100', name: 'Fuel', type: 'Expense', parent: '60000', begin: '0.00' },
    { number: '60200', name: 'Repairs and Maintenance', type: 'Expense', parent: '60000', begin: '0.00' },
    { number: '62000', name: 'Rent Expense', type: 'Expense', begin: '0.00' },
    { number: '64000', name: 'Office Supplies', type: 'Expense', begin: '0.00' },
    { number: '66000', name: 'Payroll Expenses', type: 'Expense', begin: '0.00' },
    { number: '68000', name: 'Depreciation Expense', type: 'Expense', begin: '0.00' },
    { number: '70000', name: 'Interest Income', type: 'Other Income', begin: '0.00' },
  ],
  txns: [
    { type: 'Invoice', date: '01/05/2024', num: '1001', name: 'Acme Corp', lines: [
      { acct: '11000', amount: '2700.00' },
      { acct: '40100', amount: '-2000.00', cls: 'East', memo: 'Consulting - January' },
      { acct: '40200', amount: '-500.00', cls: 'East', memo: 'Widgets' },
      { acct: '50000', amount: '200.00', cls: 'East', memo: 'Widgets cost' },
      { acct: '13000', amount: '-200.00', memo: 'Widgets cost' },
      { acct: '40200', amount: '-200.00', cls: 'East', memo: 'Installation' },
    ] },
    { type: 'Bill', date: '01/10/2024', num: 'INV-77', name: 'Shell Oil', memo: 'Fleet fuel and service', lines: [
      { acct: '20000', amount: '-180.25' },
      { acct: '60100', amount: '120.25', memo: 'Fuel' },
      { acct: '60200', amount: '60.00', memo: 'Oil change' },
    ] },
    { type: 'Payment', date: '01/15/2024', num: '5521', name: 'Acme Corp', lines: [
      { acct: '12000', amount: '2700.00' },
      { acct: '11000', amount: '-2700.00' },
    ] },
    { type: 'Deposit', date: '01/16/2024', name: '', memo: 'Deposit', lines: [
      { acct: '10100', amount: '2500.00' },
      { acct: '12000', amount: '-2500.00', name: 'Acme Corp' },
    ] },
    { type: 'Bill Pmt -Check', date: '01/25/2024', num: '1002', name: 'Shell Oil', lines: [
      { acct: '10100', amount: '-180.25' },
      { acct: '20000', amount: '180.25' },
    ] },
    { type: 'Check', date: '02/01/2024', num: '1003', name: 'Landlord LLC', memo: 'February rent', lines: [
      { acct: '10100', amount: '-1500.00' },
      { acct: '62000', amount: '1500.00', cls: 'Admin' },
    ] },
    { type: 'Credit Card Charge', date: '02/03/2024', name: 'Staples', lines: [
      { acct: '21000', amount: '-85.40' },
      { acct: '64000', amount: '85.40', cls: 'Admin' },
    ] },
    { type: 'Paycheck', date: '02/15/2024', num: '1004', name: 'Smith, John', lines: [
      { acct: '10100', amount: '-1650.00' },
      { acct: '66000', amount: '2000.00', cls: 'Admin:Payroll', memo: 'Gross wages' },
      { acct: '24000', amount: '-350.00', memo: 'Federal withholding' },
      { acct: '66000', amount: '153.00', cls: 'Admin:Payroll', memo: 'Employer taxes' },
      { acct: '24000', amount: '-153.00', memo: 'Employer taxes' },
    ] },
    // Two checks on the same day with no number: must come back as two separate entries.
    { type: 'Check', date: '02/20/2024', name: 'Office Depot', lines: [
      { acct: '10100', amount: '-45.00' },
      { acct: '64000', amount: '45.00' },
    ] },
    { type: 'Check', date: '02/20/2024', name: "Joe's Garage", lines: [
      { acct: '10100', amount: '-300.00' },
      { acct: '60200', amount: '300.00' },
    ] },
    { type: 'Transfer', date: '03/05/2024', name: '', memo: 'Funds Transfer', lines: [
      { acct: '10200', amount: '-5000.00' },
      { acct: '10100', amount: '5000.00' },
    ] },
    { type: 'Deposit', date: '03/10/2024', name: '', memo: 'Interest', lines: [
      { acct: '10200', amount: '12.34' },
      { acct: '70000', amount: '-12.34' },
    ] },
    { type: 'Sales Receipt', date: '03/12/2024', num: '3001', name: 'Walk-in Customer', lines: [
      { acct: '12000', amount: '1234.56' },
      { acct: '40200', amount: '-1234.56', cls: 'West' },
    ] },
    { type: 'Liability Check', date: '03/15/2024', num: '1005', name: 'IRS', lines: [
      { acct: '10100', amount: '-503.00' },
      { acct: '24000', amount: '503.00' },
    ] },
    { type: 'Invoice', date: '03/20/2024', num: '1002', name: 'Acme Corp:Kitchen Remodel', memo: 'Quarterly service agreement for kitchen remodel project phase two', lines: [
      { acct: '11000', amount: '3210.00' },
      { acct: '40100', amount: '-3000.00', cls: 'East', memo: 'Quarterly service agreement for kitchen remodel project phase two' },
      { acct: '40200', amount: '-210.00', cls: 'East' },
    ] },
    { type: 'Credit Memo', date: '03/22/2024', num: '1003', name: 'Acme Corp', lines: [
      { acct: '11000', amount: '-100.00' },
      { acct: '40200', amount: '100.00', cls: 'East' },
    ] },
    // Main line with a mixed-sign detail (a return on the same check).
    { type: 'Check', date: '03/25/2024', num: '1006', name: 'Home Depot', lines: [
      { acct: '10100', amount: '-250.00' },
      { acct: '60200', amount: '275.00', memo: 'Brake job' },
      { acct: '64000', amount: '-25.00', memo: 'Returned toner' },
    ] },
    // Posting directly to a parent account that also has sub-accounts.
    { type: 'Check', date: '03/28/2024', num: '1007', name: 'City Parking', lines: [
      { acct: '10100', amount: '-20.00' },
      { acct: '60000', amount: '20.00' },
    ] },
    { type: 'General Journal', date: '03/31/2024', num: 'GJ-1', name: '', memo: 'Q1 depreciation', lines: [
      { acct: '68000', amount: '600.00' },
      { acct: '17000', amount: '-600.00' },
    ] },
  ],
};

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

const typeRank = (t: QbAccountType) => QB_ACCOUNT_TYPES.indexOf(t);

export function fxByNumber(fx: GlFixture): Map<string, FxAccount> {
  return new Map(fx.accounts.map((a) => [a.number, a]));
}

export function fxFullName(fx: GlFixture, num: string, withNumbers = false): string {
  const map = fxByNumber(fx);
  const a = map.get(num)!;
  const seg = withNumbers ? `${a.number} · ${a.name}` : a.name;
  return a.parent ? `${fxFullName(fx, a.parent, withNumbers)}:${seg}` : seg;
}

/** Expected own ending balance per account number (debit-positive). */
export function fxEnding(fx: GlFixture): Map<string, Decimal> {
  const out = new Map(fx.accounts.map((a) => [a.number, Money.of(a.begin)]));
  for (const t of fx.txns) for (const l of t.lines) out.set(l.acct, out.get(l.acct)!.plus(l.amount));
  return out;
}

/** Accounts in QB report order (type order, then number; children right after parents). */
function orderedTree(fx: GlFixture): Array<{ acct: FxAccount; depth: number }> {
  const kids = (parent?: string) =>
    fx.accounts
      .filter((a) => a.parent === parent)
      .sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.number.localeCompare(b.number));
  const out: Array<{ acct: FxAccount; depth: number }> = [];
  const walk = (a: FxAccount, depth: number) => {
    out.push({ acct: a, depth });
    for (const c of kids(a.number)) walk(c, depth + 1);
  };
  for (const a of kids(undefined)) walk(a, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Logical report rows
// ---------------------------------------------------------------------------

export type ColKey =
  | 'type' | 'date' | 'num' | 'adj' | 'name' | 'memo' | 'class' | 'split'
  | 'debit' | 'credit' | 'amount' | 'balance' | 'transId';

export interface ReportRow {
  kind: 'account' | 'beginning' | 'line' | 'total' | 'grand';
  depth: number;
  label?: string;
  cells: Partial<Record<ColKey, string>>;
}

export interface GlRowOptions {
  /** Prefix account numbers ('10100 · Checking'). Default true. */
  numbers?: boolean;
  /** Single signed 'Amount' column instead of Debit/Credit. */
  amountColumn?: boolean;
  /** QBO-style 'Beginning Balance' rows instead of balances on heading rows. */
  beginningRows?: boolean;
  /** Add QB's 'Trans #' column. */
  transIds?: boolean;
  /** Leave one transaction line out of the report (makes that transaction unbalanced). */
  dropLine?: { txn: number; line: number };
}

export function glColumns(opts: GlRowOptions = {}): ColKey[] {
  const cols: ColKey[] = opts.transIds ? ['transId'] : [];
  cols.push('type', 'date', 'num', 'adj', 'name', 'memo', 'class', 'split');
  if (opts.amountColumn) cols.push('amount');
  else cols.push('debit', 'credit');
  cols.push('balance');
  return cols;
}

const HEADER_TEXT: Record<ColKey, string> = {
  transId: 'Trans #', type: 'Type', date: 'Date', num: 'Num', adj: 'Adj', name: 'Name', memo: 'Memo',
  class: 'Class', split: 'Split', debit: 'Debit', credit: 'Credit', amount: 'Amount', balance: 'Balance',
};
export const headerText = (c: ColKey) => HEADER_TEXT[c];

/** Raw number text as an exporter writes it ('1234.5', '-600'). */
const raw = (d: Decimal) => d.toString();

export function glReportRows(fx: GlFixture, opts: GlRowOptions = {}): ReportRow[] {
  const numbers = opts.numbers ?? true;
  const label = (a: FxAccount) => (numbers ? `${a.number} · ${a.name}` : a.name);
  const fullLabel = (num: string) => fxFullName(fx, num, numbers);
  const map = fxByNumber(fx);
  const natural = (a: FxAccount) => (isDebitNormal(a.type) ? 1 : -1);

  // Lines per account (with split text), in date order.
  interface Placed { txnIdx: number; t: FxTxn; l: FxLine; split: string }
  const perAccount = new Map<string, Placed[]>();
  fx.txns.forEach((t, txnIdx) => {
    t.lines.forEach((l, i) => {
      if (opts.dropLine && opts.dropLine.txn === txnIdx && opts.dropLine.line === i) return;
      let split: string;
      if (t.lines.length === 2) split = fullLabel(t.lines[1 - i].acct);
      else split = i === 0 ? '-SPLIT-' : fullLabel(t.lines[0].acct);
      perAccount.set(l.acct, [...(perAccount.get(l.acct) ?? []), { txnIdx, t, l, split }]);
    });
  });
  const isoKey = (d: string) => `${d.slice(6)}${d.slice(0, 2)}${d.slice(3, 5)}`;
  for (const list of perAccount.values()) {
    list.sort((a, b) => isoKey(a.t.date).localeCompare(isoKey(b.t.date)) || a.txnIdx - b.txnIdx);
  }

  const children = (num: string) => fx.accounts.filter((a) => a.parent === num);
  const subtree = (num: string): FxAccount[] => [map.get(num)!, ...children(num).flatMap((c) => subtree(c.number))];

  const rows: ReportRow[] = [];
  let grandDr = Money.zero();
  let grandCr = Money.zero();
  const emit = (a: FxAccount, depth: number) => {
    const s = natural(a);
    const sub = subtree(a.number);
    const subBegin = sub.reduce((acc, x) => acc.plus(x.begin), Money.zero());
    const head: ReportRow = { kind: 'account', depth, label: label(a), cells: {} };
    if (!opts.beginningRows) head.cells.balance = raw(subBegin.times(s));
    rows.push(head);
    if (opts.beginningRows) {
      rows.push({ kind: 'beginning', depth: depth + 1, label: 'Beginning Balance', cells: { balance: raw(Money.of(a.begin).times(s)) } });
    }
    let running = Money.of(a.begin);
    for (const p of perAccount.get(a.number) ?? []) {
      running = running.plus(p.l.amount);
      const amt = Money.of(p.l.amount);
      const cells: ReportRow['cells'] = {
        type: p.t.type,
        date: p.t.date,
        num: p.t.num ?? '',
        name: p.l.name ?? p.t.name,
        memo: p.l.memo ?? p.t.memo ?? '',
        class: p.l.cls ?? '',
        split: p.split,
        balance: raw(running.times(s)),
      };
      if (opts.transIds) cells.transId = String(p.txnIdx + 1);
      if (opts.amountColumn) cells.amount = raw(amt.times(s));
      else if (amt.isPositive()) cells.debit = raw(amt);
      else if (amt.isNegative()) cells.credit = raw(amt.negated());
      rows.push({ kind: 'line', depth: depth + 1, cells });
    }
    for (const c of children(a.number).sort((x, y) => x.number.localeCompare(y.number))) emit(c, depth + 1);
    // Total row (rolls up sub-accounts).
    let dr = Money.zero();
    let cr = Money.zero();
    let end = Money.zero();
    for (const x of sub) {
      end = end.plus(x.begin);
      for (const p of perAccount.get(x.number) ?? []) {
        const amt = Money.of(p.l.amount);
        end = end.plus(amt);
        if (amt.isPositive()) dr = dr.plus(amt);
        else cr = cr.minus(amt);
      }
    }
    const totalCells: ReportRow['cells'] = { balance: raw(end.times(s)) };
    if (opts.amountColumn) totalCells.amount = raw(dr.minus(cr).times(s));
    else {
      totalCells.debit = raw(dr);
      totalCells.credit = raw(cr);
    }
    rows.push({ kind: 'total', depth, label: `Total ${label(a)}`, cells: totalCells });
    if (depth === 0) {
      grandDr = grandDr.plus(dr);
      grandCr = grandCr.plus(cr);
    }
  };
  for (const a of fx.accounts
    .filter((x) => !x.parent)
    .sort((x, y) => typeRank(x.type) - typeRank(y.type) || x.number.localeCompare(y.number))) {
    emit(a, 0);
  }
  const grand: ReportRow['cells'] = { balance: '0' };
  if (opts.amountColumn) grand.amount = '0';
  else {
    grand.debit = raw(grandDr);
    grand.credit = raw(grandCr);
  }
  rows.push({ kind: 'grand', depth: 0, label: 'TOTAL', cells: grand });
  return rows;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const LABEL_COLS = 3; // QB exports one indentation column per level

/** Grid (string cells) like QB's CSV/Excel export. Amounts formatted '1,234.56' unless rawNumbers. */
export function glGrid(fx: GlFixture, opts: GlRowOptions = {}, rawNumbers = false): string[][] {
  const cols = glColumns(opts);
  const out: string[][] = [
    [fx.company],
    ['General Ledger'],
    [fx.periodLabel],
    [],
    [...new Array(LABEL_COLS).fill(''), ...cols.map(headerText)],
  ];
  const money = (s: string | undefined) => (s === undefined ? '' : rawNumbers ? s : fmtMoney(Money.of(s), false));
  for (const r of glReportRows(fx, opts)) {
    const row = new Array(LABEL_COLS + cols.length).fill('');
    if (r.label !== undefined) row[Math.min(r.depth, LABEL_COLS - 1)] = r.label;
    cols.forEach((c, i) => {
      const v = r.cells[c];
      if (v === undefined) return;
      row[LABEL_COLS + i] = ['debit', 'credit', 'amount', 'balance'].includes(c) ? money(v) : v;
    });
    out.push(row);
  }
  return out;
}

export function fmtMoney(d: Decimal, parens = true): string {
  const abs = d.abs().toFixed(2);
  const [whole, frac] = abs.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = `${withCommas}.${frac}`;
  if (!d.isNegative()) return s;
  return parens ? `(${s})` : `-${s}`;
}

export function glCsv(fx: GlFixture, opts: GlRowOptions = {}): string {
  return Papa.unparse(glGrid(fx, opts));
}

// ---- xlsx -------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colLetters(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function excelSerial(mmddyyyy: string): number {
  const [m, d, y] = mmddyyyy.split('/').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/**
 * A minimal but genuine .xlsx (zip of SpreadsheetML parts) holding the GL like QB's
 * "Export to Excel": numbers as numeric cells, dates as serials with a date format, text in
 * the shared-string table (memos as inline strings), sparse rows, and a leading
 * "QuickBooks Export Tips" sheet.
 */
export function glXlsx(fx: GlFixture, opts: GlRowOptions = {}): Buffer {
  const grid = glGrid(fx, opts, true);
  const cols = glColumns(opts);
  const memoCol = LABEL_COLS + cols.indexOf('memo');
  const dateCol = LABEL_COLS + cols.indexOf('date');
  const numericCols = new Set(
    cols.map((c, i) => (['debit', 'credit', 'amount', 'balance'].includes(c) ? LABEL_COLS + i : -1)),
  );
  const shared: string[] = [];
  const sharedIdx = new Map<string, number>();
  const sst = (s: string) => {
    if (!sharedIdx.has(s)) {
      sharedIdx.set(s, shared.length);
      shared.push(s);
    }
    return sharedIdx.get(s)!;
  };
  const headerRow = 5;
  const sheetRows = grid
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          if (v === '') return '';
          const ref = `${colLetters(c)}${r + 1}`;
          if (r + 1 > headerRow && c === dateCol) return `<c r="${ref}" s="1"><v>${excelSerial(v)}</v></c>`;
          if (r + 1 > headerRow && numericCols.has(c)) return `<c r="${ref}" s="2"><v>${v}</v></c>`;
          if (c === memoCol && r + 1 > headerRow) {
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
          }
          return `<c r="${ref}" t="s"><v>${sst(v)}</v></c>`;
        })
        .join('');
      return cells ? `<row r="${r + 1}">${cells}</row>` : '';
    })
    .join('');
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const tipsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>QuickBooks Export Tips</t></is></c></row></sheetData></worksheet>`;
  // Rich-text shared string for the company name exercises <r><t> runs.
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((s, i) =>
      i === 0 && s.includes(' ')
        ? `<si><r><t xml:space="preserve">${esc(s.slice(0, s.indexOf(' ') + 1))}</t></r><r><rPr><b/></rPr><t>${esc(s.slice(s.indexOf(' ') + 1))}</t></r></si>`
        : `<si><t xml:space="preserve">${esc(s)}</t></si>`,
    )
    .join('')}</sst>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;\\(#,##0.00\\)"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="QuickBooks Export Tips" sheetId="1" r:id="rId1"/><sheet name="Sheet1" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(rootRels, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(workbookXml, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(relsXml, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(tipsXml, 'utf8'));
  zip.addFile('xl/worksheets/sheet2.xml', Buffer.from(sheetXml, 'utf8'));
  zip.addFile('xl/sharedStrings.xml', Buffer.from(sstXml, 'utf8'));
  zip.addFile('xl/styles.xml', Buffer.from(stylesXml, 'utf8'));
  return zip.toBuffer();
}

// ---- pdf --------------------------------------------------------------------

/** Column layout of the printed report (landscape letter, 7pt Helvetica). */
const PDF_COLS: Record<ColKey, { x: number; align: 'left' | 'right'; width: number }> = {
  transId: { x: 52, align: 'left', width: 16 },
  type: { x: 70, align: 'left', width: 62 },
  date: { x: 135, align: 'left', width: 38 },
  num: { x: 176, align: 'left', width: 30 },
  adj: { x: 208, align: 'left', width: 10 },
  name: { x: 222, align: 'left', width: 78 },
  memo: { x: 302, align: 'left', width: 96 },
  class: { x: 400, align: 'left', width: 44 },
  split: { x: 446, align: 'left', width: 110 },
  debit: { x: 620, align: 'right', width: 56 },
  credit: { x: 682, align: 'right', width: 56 },
  amount: { x: 650, align: 'right', width: 56 },
  balance: { x: 752, align: 'right', width: 60 },
};

/**
 * Printed-to-PDF General Ledger. Multi-page; each page repeats the title block and column
 * header and ends with 'Page n of N'. Negative amounts print as (1,234.56). Memos wider than
 * their column wrap onto a continuation line.
 */
export async function glPdf(fx: GlFixture, opts: GlRowOptions = {}, rowsPerPage = 30): Promise<Uint8Array> {
  const cols = glColumns(opts);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 7;
  type Line = { depth: number; label?: string; cells: Partial<Record<ColKey, string>>; bold?: boolean };
  const lines: Line[] = [];
  for (const r of glReportRows(fx, opts)) {
    const cells: Partial<Record<ColKey, string>> = {};
    let overflow: string | null = null;
    for (const c of cols) {
      const v = r.cells[c];
      if (v === undefined || v === '') continue;
      if (['debit', 'credit', 'amount', 'balance'].includes(c)) cells[c] = fmtMoney(Money.of(v));
      else if (c === 'date') cells[c] = v.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$1/$2/$3');
      else cells[c] = v;
      if (c === 'memo' && font.widthOfTextAtSize(v, size) > PDF_COLS.memo.width) {
        // Wrap at a word boundary.
        const words = v.split(' ');
        let first = '';
        while (words.length && font.widthOfTextAtSize(`${first} ${words[0]}`.trim(), size) <= PDF_COLS.memo.width) {
          first = `${first} ${words.shift()}`.trim();
        }
        cells.memo = first;
        overflow = words.join(' ');
      }
    }
    lines.push({ depth: r.depth, label: r.label, cells, bold: r.kind === 'total' || r.kind === 'account' });
    if (overflow) lines.push({ depth: r.depth, cells: { memo: overflow } });
  }
  const pages = Math.ceil(lines.length / rowsPerPage);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([792, 612]);
    const center = (text: string, y: number, f = bold, s = 10) =>
      page.drawText(text, { x: (792 - f.widthOfTextAtSize(text, s)) / 2, y, size: s, font: f });
    page.drawText('10:32 AM', { x: 20, y: 580, size, font });
    page.drawText('04/02/24', { x: 20, y: 570, size, font });
    page.drawText('Accrual Basis', { x: 20, y: 560, size, font });
    center(fx.company, 580, bold, 11);
    center('General Ledger', 566, bold, 12);
    center(fx.periodLabel, 553, font, 8);
    let y = 530;
    for (const c of cols) {
      const spec = PDF_COLS[c];
      const t = headerText(c);
      const x = spec.align === 'right' ? spec.x - bold.widthOfTextAtSize(t, size) : spec.x;
      page.drawText(t, { x, y, size, font: bold });
    }
    y -= 14;
    for (const line of lines.slice(p * rowsPerPage, (p + 1) * rowsPerPage)) {
      const f = line.bold ? bold : font;
      if (line.label) page.drawText(line.label, { x: 20 + line.depth * 8, y, size, font: f });
      for (const c of cols) {
        const v = line.cells[c];
        if (!v) continue;
        const spec = PDF_COLS[c];
        const x = spec.align === 'right' ? spec.x - f.widthOfTextAtSize(v, size) : spec.x;
        page.drawText(v, { x, y, size, font: f });
      }
      y -= 14;
    }
    center(`Page ${p + 1} of ${pages}`, 20, font, 7);
  }
  return doc.save();
}

// ---- reference exports --------------------------------------------------------

/** QB 'Account Listing' report as CSV (full 'Parent:Child' names with numbers). */
export function accountListCsv(fx: GlFixture): string {
  const rows = [
    [fx.company],
    ['Account Listing'],
    ['March 31, 2024'],
    ['Account', 'Type', 'Balance Total', 'Description', 'Accnt. #'],
    ...orderedTree(fx).map(({ acct }) => [fxFullName(fx, acct.number, true), acct.type, '', '', acct.number]),
  ];
  return Papa.unparse(rows);
}

/** QB 'Trial Balance' as CSV (as of the period end). */
export function trialBalanceCsv(fx: GlFixture, adjust?: { acct: string; by: string }): string {
  const end = fxEnding(fx);
  if (adjust) end.set(adjust.acct, end.get(adjust.acct)!.plus(adjust.by));
  const rows: string[][] = [
    [fx.company],
    ['Trial Balance'],
    ['As of March 31, 2024'],
    ['', 'Mar 31, 24', ''],
    ['', 'Debit', 'Credit'],
  ];
  for (const { acct } of orderedTree(fx)) {
    const b = end.get(acct.number)!;
    if (b.isZero()) continue;
    rows.push([fxFullName(fx, acct.number, true), b.isPositive() ? fmtMoney(b) : '', b.isNegative() ? fmtMoney(b.negated()) : '']);
  }
  rows.push(['TOTAL', '', '']);
  return Papa.unparse(rows);
}

/** Convenience: wrap bytes as the API's {name, data(base64)} upload shape. */
export function upload(name: string, bytes: Uint8Array | Buffer | string) {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return { name, data: buf.toString('base64') };
}

export { toAmountString };
