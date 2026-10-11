/**
 * Add/Edit Multiple List Entries — shared (client + server) column definitions and the
 * paste-from-Excel parser. Pure module: no database, no Node APIs.
 */

export type BulkList = 'customers' | 'vendors' | 'items';

export interface BulkColumn {
  key: string;
  label: string;
  required?: boolean;
  kind?: 'text' | 'money' | 'decimal' | 'bool' | 'enum';
  options?: readonly string[];
  /** Plain-language hint shown in the grid header tooltip. */
  hint?: string;
  width?: number;
}

export const ITEM_TYPES_FOR_BULK = ['service', 'inventory', 'non_inventory', 'other_charge'] as const;

export const BULK_COLUMNS: Record<BulkList, BulkColumn[]> = {
  customers: [
    { key: 'displayName', label: 'Customer name', required: true, width: 200 },
    { key: 'companyName', label: 'Company', width: 160 },
    { key: 'email', label: 'Email', width: 180 },
    { key: 'phone', label: 'Phone', width: 130 },
    { key: 'billLine1', label: 'Bill to street', width: 180 },
    { key: 'billCity', label: 'City', width: 120 },
    { key: 'billState', label: 'State', width: 70 },
    { key: 'billZip', label: 'ZIP', width: 80 },
    { key: 'terms', label: 'Terms', hint: 'A name from the Terms list, e.g. "Net 30"', width: 120 },
    { key: 'creditLimit', label: 'Credit limit', kind: 'money', width: 110 },
    { key: 'salesTaxCode', label: 'Tax code', hint: 'A code from the Sales Tax Code list, e.g. Tax or Non', width: 80 },
    { key: 'resaleNumber', label: 'Resale no.', width: 110 },
    { key: 'notes', label: 'Notes', width: 200 },
  ],
  vendors: [
    { key: 'displayName', label: 'Vendor name', required: true, width: 200 },
    { key: 'companyName', label: 'Company', width: 160 },
    { key: 'email', label: 'Email', width: 180 },
    { key: 'phone', label: 'Phone', width: 130 },
    { key: 'line1', label: 'Street', width: 180 },
    { key: 'city', label: 'City', width: 120 },
    { key: 'state', label: 'State', width: 70 },
    { key: 'zip', label: 'ZIP', width: 80 },
    { key: 'terms', label: 'Terms', hint: 'A name from the Terms list, e.g. "Net 30"', width: 120 },
    { key: 'is1099', label: '1099?', kind: 'bool', hint: 'yes / no', width: 70 },
    { key: 'notes', label: 'Notes', width: 200 },
  ],
  items: [
    { key: 'name', label: 'Item name', required: true, width: 200 },
    { key: 'type', label: 'Type', kind: 'enum', options: ITEM_TYPES_FOR_BULK, hint: 'service, inventory, non_inventory or other_charge (new items only)', width: 120 },
    { key: 'sku', label: 'SKU', width: 100 },
    { key: 'description', label: 'Description', width: 200 },
    { key: 'salesPrice', label: 'Sales price', kind: 'money', width: 100 },
    { key: 'purchaseCost', label: 'Cost', kind: 'money', width: 100 },
    { key: 'incomeAccount', label: 'Income account', hint: 'Account number or name', width: 140 },
    { key: 'expenseAccount', label: 'Expense/COGS account', hint: 'Account number or name', width: 140 },
    { key: 'assetAccount', label: 'Asset account', hint: 'Inventory items: account number or name', width: 140 },
    { key: 'taxable', label: 'Taxable?', kind: 'bool', width: 80 },
    { key: 'salesTaxCode', label: 'Tax code', hint: 'A code from the Sales Tax Code list, e.g. Tax or Non', width: 80 },
    { key: 'preferredVendor', label: 'Preferred vendor', width: 160 },
    { key: 'reorderPoint', label: 'Reorder point', kind: 'decimal', width: 100 },
    { key: 'unitOfMeasure', label: 'U/M', width: 70 },
  ],
};

/**
 * Parse tab-separated text as copied from Excel / Google Sheets: tabs between cells, CR/LF between
 * rows, cells containing tabs/newlines/quotes wrapped in double quotes with "" escapes.
 * Trailing empty rows are dropped.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/\r\n?/g, '\n');
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Turn pasted rows into column-keyed objects. When the first row looks like a header (it names at
 * least one known column by label or key) it maps columns by name; otherwise columns are taken in
 * the grid's order starting at `startColumn`.
 */
export function pastedRowsToRecords(
  list: BulkList,
  rows: string[][],
  startColumn = 0,
): { records: Array<Record<string, string>>; mappedColumns: string[]; usedHeader: boolean } {
  const cols = BULK_COLUMNS[list];
  if (rows.length === 0) return { records: [], mappedColumns: [], usedHeader: false };
  const lookup = new Map<string, string>();
  for (const c of cols) {
    lookup.set(norm(c.label), c.key);
    lookup.set(norm(c.key), c.key);
  }
  const header = rows[0].map((h) => lookup.get(norm(h)) ?? null);
  const usedHeader = header.some((h) => h !== null);
  const mapping: Array<string | null> = usedHeader
    ? header
    : rows[0].map((_, idx) => cols[startColumn + idx]?.key ?? null);
  const body = usedHeader ? rows.slice(1) : rows;
  const records = body.map((r) => {
    const rec: Record<string, string> = {};
    r.forEach((v, idx) => {
      const key = mapping[idx];
      if (key) rec[key] = v.trim();
    });
    return rec;
  });
  return { records, mappedColumns: mapping.filter((m): m is string => !!m), usedHeader };
}

/** "yes"/"y"/"true"/"1"/"x" → true, "no"/"n"/"false"/"0"/"" → false, else null (invalid). */
export function parseBool(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'x', '✓'].includes(s)) return true;
  if (['no', 'n', 'false', '0', ''].includes(s)) return false;
  return null;
}

/** "$1,234.50" / "(12.00)" → "1234.50" / "-12.00"; null when not a number. */
export function parseAmount(v: string): string | null {
  let s = v.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  if (s.startsWith('.')) s = '0' + s;
  return (negative ? '-' : '') + s;
}
