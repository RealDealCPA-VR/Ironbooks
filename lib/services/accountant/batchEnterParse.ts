/**
 * Batch Enter Transactions — pure helpers shared by the grid UI and the service (no DB imports).
 * Column layouts per transaction type, a tolerant "paste from Excel / Google Sheets" parser with
 * header-based column mapping, and spreadsheet-style block paste.
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

// ---------------------------------------------------------------------------
// Clipboard grid parsing + column mapping ("Paste from Excel / Google Sheets")
// ---------------------------------------------------------------------------

/**
 * Split clipboard text into rows of cells. Excel and Google Sheets copy cells as TSV: a tab
 * between cells, CR/LF between rows, and a cell that itself holds a tab, line break or quote is
 * wrapped in double quotes with "" escapes. Text without any tab is read as CSV (commas).
 * Blank rows are dropped; cell text is trimmed.
 */
export function parseClipboardGrid(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n');
  const delim = src.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
      atCellStart = true;
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
    } else {
      cell += ch;
      if (ch !== ' ') atCellStart = false;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

/** Spreadsheet header words people actually use, per grid column (compared after normalizing). */
export const BATCH_COLUMN_ALIASES: Record<BatchColumn, string[]> = {
  date: ['date', 'txn date', 'transaction date', 'trans date', 'posting date', 'posted', 'check date', 'bill date', 'invoice date', 'entry date'],
  ref: ['ref', 'ref no', 'ref #', 'reference', 'no', 'num', 'number', '#', 'check no', 'check #', 'check number', 'chk', 'chk #', 'bill no', 'bill #', 'bill number', 'invoice no', 'invoice #', 'invoice number', 'doc no', 'document', 'entry no', 'entry #', 'je no', 'je #'],
  name: ['name', 'payee', 'vendor', 'supplier', 'customer', 'customer job', 'client', 'received from', 'pay to', 'paid to', 'pay to the order of', 'merchant', 'from'],
  account: ['account', 'acct', 'account no', 'account number', 'account name', 'gl account', 'category', 'expense account', 'income account', 'from account', 'split'],
  amount: ['amount', 'amt', 'total', 'value', 'sum', 'payment', 'charge', 'deposit'],
  debit: ['debit', 'debits', 'dr', 'debit amount'],
  credit: ['credit', 'credits', 'cr', 'credit amount'],
  memo: ['memo', 'description', 'desc', 'note', 'notes', 'details', 'detail', 'comment'],
  className: ['class', 'department', 'dept', 'division'],
  dueDate: ['due', 'due date', 'date due', 'due on'],
};

function normHeader(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();
}

/** The grid column a spreadsheet header names, or null. */
export function columnForHeader(header: string): BatchColumn | null {
  const h = normHeader(header);
  if (!h) return null;
  for (const [col, aliases] of Object.entries(BATCH_COLUMN_ALIASES) as Array<[BatchColumn, string[]]>) {
    if (aliases.some((a) => normHeader(a) === h)) return col;
  }
  return null;
}

/** Columns a type can receive from a paste (journal entries may also take one signed Amount). */
export function mappableColumns(type: BatchEnterType): BatchColumn[] {
  const cols = batchColumns(type);
  return type === 'journal' ? [...cols, 'amount'] : cols;
}

export interface ColumnMappingGuess {
  /** True when the first pasted row is a header row (it is then not imported). */
  hasHeader: boolean;
  /** Target grid column for each pasted column (null = ignore that column). */
  mapping: Array<BatchColumn | null>;
}

/** A cell that is clearly data (a date or a formatted amount), so its row is not a header. */
function looksLikeData(cell: string): boolean {
  if (/^\d{1,5}$/.test(cell)) return false; // could be a header like "#" neighbour or a number column
  if (normalizeDate(cell) !== null) return true;
  return /\d/.test(cell) && /[.,$]/.test(cell) && normalizeAmount(cell) !== null;
}

/**
 * Guess how pasted columns map onto the grid. A first row whose cells read like headers
 * ("Date", "Payee", "Check #", "Amount"...) is a header row and maps columns by name, in any
 * order; columns with unknown headers are ignored. Without a header the columns are taken in the
 * grid's own order (batchColumns).
 */
export function guessColumnMapping(grid: string[][], type: BatchEnterType): ColumnMappingGuess {
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const allowed = new Set(mappableColumns(type));
  const first = grid[0] ?? [];
  const named = first.map((c) => columnForHeader(c));
  const recognised = named.filter((c) => c !== null).length;
  const hasHeader = recognised > 0 && !first.some(looksLikeData);
  if (hasHeader) {
    const used = new Set<BatchColumn>();
    const mapping = Array.from({ length: width }, (_, i) => {
      let col = named[i] ?? null;
      // "Debit"/"Credit" headers on a single-amount type fold into Amount (first one wins).
      if (col && !allowed.has(col)) {
        col = (col === 'debit' || col === 'credit') && allowed.has('amount') ? 'amount' : null;
      }
      if (col && used.has(col)) col = null;
      if (col) used.add(col);
      return col;
    });
    return { hasHeader, mapping };
  }
  const cols = batchColumns(type);
  return { hasHeader: false, mapping: Array.from({ length: width }, (_, i) => cols[i] ?? null) };
}

/**
 * Turn pasted cells into grid rows using a column mapping. Rows with nothing in any mapped
 * column are skipped. For journal entries a mapped signed "Amount" fills Debit (positive) or
 * Credit (negative) when that row has neither.
 */
export function applyColumnMapping(
  grid: string[][],
  mapping: Array<BatchColumn | null>,
  options: { hasHeader: boolean; type: BatchEnterType },
): BatchEnterRow[] {
  const out: BatchEnterRow[] = [];
  const data = options.hasHeader ? grid.slice(1) : grid;
  for (const cells of data) {
    const row: BatchEnterRow = { date: '', account: '' };
    let any = false;
    mapping.forEach((col, j) => {
      const v = (cells[j] ?? '').trim();
      if (!col || v === '') return;
      (row as unknown as Record<string, string>)[col] = v;
      any = true;
    });
    if (!any) continue;
    if (options.type === 'journal' && row.amount !== undefined) {
      const amt = normalizeAmount(row.amount);
      if (!row.debit && !row.credit && amt !== null) {
        if (amt.startsWith('-')) row.credit = amt.slice(1);
        else row.debit = amt;
      }
      delete row.amount;
    }
    out.push(row);
  }
  return out;
}

/**
 * Parse text copied from Excel / Google Sheets (tab-separated; comma-separated accepted when no
 * tabs are present) into grid rows. A header row is recognised and used to map the columns;
 * without one the columns follow the grid's order. Blank lines are ignored.
 */
export function parseBatchPaste(text: string, type: BatchEnterType): BatchEnterRow[] {
  const grid = parseClipboardGrid(text);
  const guess = guessColumnMapping(grid, type);
  return applyColumnMapping(grid, guess.mapping, { hasHeader: guess.hasHeader, type });
}

/**
 * Paste a block of cells into the grid at a cell, the way a spreadsheet does: the block's top
 * left cell lands on (row, col) and the rest fills right and down, adding rows as needed. Cells
 * that fall past the last column are dropped. Returns the new rows (the input is not changed).
 */
export function pasteBlockAt(
  rows: BatchEnterRow[],
  at: { row: number; col: number },
  block: string[][],
  type: BatchEnterType,
): BatchEnterRow[] {
  const cols = batchColumns(type);
  const next = rows.map((r) => ({ ...r }));
  block.forEach((cells, i) => {
    const r = at.row + i;
    while (next.length <= r) next.push({ date: '', account: '' });
    cells.forEach((v, j) => {
      const col = cols[at.col + j];
      if (!col) return;
      (next[r] as unknown as Record<string, string>)[col] = v;
    });
  });
  return next;
}

/** True when nothing is typed in the row. */
export function isBlankBatchRow(row: BatchEnterRow): boolean {
  return !Object.values(row).some((v) => typeof v === 'string' && v.trim() !== '');
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
