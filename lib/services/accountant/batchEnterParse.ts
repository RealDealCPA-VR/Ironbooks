/**
 * Batch Enter Transactions — pure helpers shared by the grid UI and the service (no DB imports).
 * Column layouts per transaction type and a tolerant "paste from Excel" (tab-separated) parser.
 */

export const BATCH_ENTER_TYPES = [
  'check',
  'deposit',
  'cc_charge',
  'cc_credit',
  'invoice',
  'credit_memo',
  'bill',
  'bill_credit',
  'journal',
] as const;
export type BatchEnterType = (typeof BATCH_ENTER_TYPES)[number];

export const BATCH_ENTER_LABELS: Record<BatchEnterType, string> = {
  check: 'Checks',
  deposit: 'Deposits',
  cc_charge: 'Credit Card Charges',
  cc_credit: 'Credit Card Credits',
  invoice: 'Invoices',
  credit_memo: 'Credit Memos',
  bill: 'Bills',
  bill_credit: 'Bill Credits',
  journal: 'Journal Entries',
};

/** One grid row. Amount fields are strings as typed/pasted ("1,234.50", "(12.00)", "$9"). */
export interface BatchEnterRow {
  date: string;
  /** Check no. / bill no. / reference; for journal entries rows with the same ref form one entry. */
  ref?: string;
  /** Payee, customer, vendor or "received from" (by name). */
  name?: string;
  /** Account by code, name, or "code · name". */
  account: string;
  amount?: string;
  /** Journal entries only. */
  debit?: string;
  credit?: string;
  memo?: string;
  /** Class by name (optional). */
  className?: string;
  /** Bills only (optional). */
  dueDate?: string;
}

export type BatchColumn = keyof BatchEnterRow;

/** Column order used by the grid and expected when pasting from a spreadsheet. */
export function batchColumns(type: BatchEnterType): BatchColumn[] {
  switch (type) {
    case 'journal':
      return ['date', 'ref', 'account', 'debit', 'credit', 'memo', 'name', 'className'];
    case 'bill':
      return ['date', 'ref', 'name', 'account', 'amount', 'memo', 'className', 'dueDate'];
    case 'deposit':
      return ['date', 'name', 'account', 'amount', 'memo', 'className'];
    default:
      return ['date', 'ref', 'name', 'account', 'amount', 'memo', 'className'];
  }
}

export const BATCH_COLUMN_LABELS: Record<BatchColumn, string> = {
  date: 'Date',
  ref: 'Ref / No.',
  name: 'Name',
  account: 'Account',
  amount: 'Amount',
  debit: 'Debit',
  credit: 'Credit',
  memo: 'Memo',
  className: 'Class',
  dueDate: 'Due date',
};

const HEADER_HINTS = /^(date|txn date|transaction date)$/i;

/**
 * Parse text copied from Excel / Google Sheets (tab-separated; comma-separated accepted when no
 * tabs are present). A first row whose first cell reads "Date" is treated as a header and skipped.
 * Blank lines are ignored.
 */
export function parseBatchPaste(text: string, type: BatchEnterType): BatchEnterRow[] {
  const cols = batchColumns(type);
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  const useTabs = lines.some((l) => l.includes('\t'));
  const rows: BatchEnterRow[] = [];
  lines.forEach((line, i) => {
    const cells = (useTabs ? line.split('\t') : splitCsv(line)).map((c) => c.trim());
    if (i === 0 && HEADER_HINTS.test(cells[0] ?? '')) return;
    const row: BatchEnterRow = { date: '', account: '' };
    cols.forEach((c, j) => {
      const v = cells[j];
      if (v !== undefined && v !== '') (row as unknown as Record<string, string>)[c] = v;
    });
    rows.push(row);
  });
  return rows;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Normalize a spreadsheet amount: strips currency symbols, thousands separators and spaces;
 * "(12.50)" and "12.50-" become "-12.50". Returns null when it is not a number.
 */
export function normalizeAmount(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  s = s.replace(/[$€£¥,\s]/g, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const n = s.startsWith('.') ? `0${s}` : s;
  return neg ? `-${n}` : n;
}

/**
 * Parse a spreadsheet date: ISO "2026-03-31", US "3/31/2026" / "03/31/26", or an Excel serial
 * number (days since 1899-12-30). Returns 'YYYY-MM-DD' or null.
 */
export function normalizeDate(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (mt) {
    y = +mt[1];
    m = +mt[2];
    d = +mt[3];
  } else if ((mt = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) {
    m = +mt[1];
    d = +mt[2];
    y = +mt[3];
    if (y < 100) y += 2000;
  } else if (/^\d{5}$/.test(s)) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000);
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
