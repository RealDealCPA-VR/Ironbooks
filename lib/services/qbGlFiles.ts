/**
 * QuickBooks report file readers — the "bytes → grid of cells" half of the General Ledger
 * migration (lib/services/qbGlParse.ts turns the grid into accounts + transactions).
 *
 * Everything here is pure (no DB) and runs in Node (API routes, tests):
 *   - readXlsx()  .xlsx workbooks, built on adm-zip + fast-xml-parser (shared strings, inline
 *                 strings, numbers, booleans, date serials via the cell's number format,
 *                 sparse cells addressed by column letters, the 1904 date system).
 *   - readCsv()   CSV via papaparse (BOM / UTF-16 / Windows-1252 tolerant via decodeText()).
 *   - readPdf()   QuickBooks "Save as PDF"/printed reports via pdfjs-dist (legacy build, no
 *                 worker). Text items are regrouped into lines by y, columns are detected from
 *                 the header line's x-ranges (text columns are left-aligned, amount columns
 *                 right-aligned), repeated page headers/footers and page numbers are dropped,
 *                 and the indentation (x) of account labels is preserved for the hierarchy.
 *   - loadGrid()  sniff the bytes (zip / %PDF / text) and dispatch.
 *
 * A grid is `GridRow[]`: `cells[i]` is the text of column i (''=empty). `indent` is set only
 * for PDF rows (x position of the leftmost label text); for xlsx/csv the column index of the
 * first non-empty cell (plus leading spaces) carries the same information.
 */
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import Papa from 'papaparse';
import { csvUnsafeText } from '@/lib/csv';
import { ServiceError } from './_base';

export interface GridRow {
  cells: string[];
  /** Horizontal position of the row's label text (PDF only); undefined for xlsx/csv. */
  indent?: number;
}

export interface GridSheet {
  name: string;
  rows: GridRow[];
}

export type ReportFileKind = 'xlsx' | 'csv' | 'pdf' | 'iif';

const fail = (msg: string) => new ServiceError('VALIDATION', msg);

// ---------------------------------------------------------------------------
// Text decoding
// ---------------------------------------------------------------------------

/**
 * Decode report text exported by QuickBooks / Excel. Handles UTF-8 (with or without BOM),
 * UTF-16 LE/BE ("Unicode Text" exports), and falls back to Windows-1252 — the encoding QB
 * Desktop uses for CSV, where the account-number separator "·" is byte 0xB7.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Parse CSV text into a grid. Cells are kept verbatim (leading spaces carry indentation). */
export function readCsv(text: string): GridRow[] {
  const clean = text.replace(/^﻿/, '');
  // Tab-separated text (Excel "Text (Tab delimited)") is common too — let papaparse sniff.
  const parsed = Papa.parse<string[]>(clean, { skipEmptyLines: false, delimiter: '' });
  // csvUnsafeText: our own report exports prefix formula-like cells ("-Acme") with an apostrophe.
  return parsed.data.map((r) => ({ cells: (r ?? []).map((c) => (c == null ? '' : csvUnsafeText(String(c)))) }));
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const XML_ARRAYS = new Set(['si', 'r', 'row', 'c', 'sheet', 'Relationship', 'xf', 'numFmt']);

function xmlParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    htmlEntities: true,
    isArray: (name) => XML_ARRAYS.has(name),
  });
}

/** Text content of a parsed XML node ('x', { '#text': 'x', '@_space': 'preserve' }, or ''). */
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    const t = (node as Record<string, unknown>)['#text'];
    return t == null ? '' : String(t);
  }
  return '';
}

/** Rich or plain string item (<si> / <is>): plain <t>, or the concatenated <r><t> runs. */
function stringItemText(item: Record<string, unknown> | undefined): string {
  if (!item) return '';
  if (item.t !== undefined) return textOf(item.t);
  const runs = item.r as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(runs)) return runs.map((r) => textOf(r.t)).join('');
  return '';
}

/** Spreadsheet column letters → 0-based index ('A' → 0, 'Z' → 25, 'AA' → 26). */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** Split a cell reference ('C12') into 0-based column and 1-based row. */
function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { col: columnIndex(m[1]), row: Number(m[2]) };
}

/** Built-in Excel number formats that render as dates/times. */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

/** Does a custom number-format code render a date? (d/m/y tokens outside quotes/brackets.) */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .toLowerCase();
  if (stripped.includes('general')) return false;
  return /[dmy]/.test(stripped) && !/^[#0.,%\s;()_-]*$/.test(stripped);
}

/** Excel serial date → 'MM/DD/YYYY' (the format QB prints, so the GL parser sees one shape). */
export function excelSerialToDate(serial: number, date1904 = false): string {
  const whole = Math.floor(serial);
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(base + whole * 86_400_000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

function zipText(zip: AdmZip, entryPath: string): string | null {
  const entry = zip.getEntry(entryPath) ?? zip.getEntry(entryPath.replace(/^\//, ''));
  if (!entry) return null;
  return entry.getData().toString('utf8');
}

/**
 * Zip-bomb guard. An .xlsx is a zip: a few MB on disk can declare gigabytes of XML, and inflating
 * that (then parsing it) would exhaust memory and take the whole app down for everyone on the
 * company file. The archive's own directory says how big each part is, so refuse before
 * decompressing anything. (adm-zip caps every entry at its declared size, so a part cannot lie
 * its way past this check.) A real QuickBooks export is far below these limits.
 */
export const XLSX_LIMITS = { entryBytes: 200 * 1024 * 1024, totalBytes: 400 * 1024 * 1024, entries: 5000 } as const;

function assertReasonableXlsx(zip: AdmZip): void {
  const entries = zip.getEntries();
  if (entries.length > XLSX_LIMITS.entries) throw fail('This .xlsx workbook has too many parts to be a report export.');
  let total = 0;
  for (const e of entries) {
    const size = Number(e.header.size) || 0;
    total += size;
    if (size > XLSX_LIMITS.entryBytes || total > XLSX_LIMITS.totalBytes) {
      throw fail(
        'This .xlsx workbook is too large to read (it expands to more than ' +
          `${Math.round((size > XLSX_LIMITS.entryBytes ? XLSX_LIMITS.entryBytes : XLSX_LIMITS.totalBytes) / 1024 / 1024)} MB). ` +
          'Export a shorter date range, or save the report as CSV.',
      );
    }
  }
}

/**
 * Read every worksheet of an .xlsx workbook into grids. Cell values are returned as text:
 * strings verbatim, numbers as the stored decimal text (e.g. "1234.5" — callers parse with
 * decimal.js, never JS floats), date-formatted numbers as MM/DD/YYYY, booleans TRUE/FALSE.
 */
export function readXlsx(bytes: Uint8Array): GridSheet[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(bytes));
  } catch {
    throw fail('This file is not a readable .xlsx workbook.');
  }
  assertReasonableXlsx(zip);
  const parser = xmlParser();
  const workbookXml = zipText(zip, 'xl/workbook.xml');
  if (!workbookXml) throw fail('This .xlsx file has no workbook (xl/workbook.xml is missing).');
  const workbook = parser.parse(workbookXml)?.workbook ?? {};
  const date1904 = ['1', 'true'].includes(String(workbook.workbookPr?.['@_date1904'] ?? ''));

  // Sheet name → part path via the workbook relationships.
  const relsXml = zipText(zip, 'xl/_rels/workbook.xml.rels');
  const rels = new Map<string, string>();
  if (relsXml) {
    const relRoot = parser.parse(relsXml)?.Relationships ?? {};
    for (const rel of (relRoot.Relationship ?? []) as Array<Record<string, string>>) {
      const target = rel['@_Target'] ?? '';
      const full = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      rels.set(rel['@_Id'], full);
    }
  }

  // Shared strings.
  const sharedStrings: string[] = [];
  const sstXml = zipText(zip, 'xl/sharedStrings.xml');
  if (sstXml) {
    const sst = parser.parse(sstXml)?.sst ?? {};
    for (const si of (sst.si ?? []) as Array<Record<string, unknown>>) {
      sharedStrings.push(stringItemText(si));
    }
  }

  // Styles: which cellXfs indexes are date formats.
  const dateStyles = new Set<number>();
  const stylesXml = zipText(zip, 'xl/styles.xml');
  if (stylesXml) {
    const styles = parser.parse(stylesXml)?.styleSheet ?? {};
    const customDate = new Set<number>();
    for (const nf of (styles.numFmts?.numFmt ?? []) as Array<Record<string, string>>) {
      if (isDateFormatCode(nf['@_formatCode'] ?? '')) customDate.add(Number(nf['@_numFmtId']));
    }
    const xfs = (styles.cellXfs?.xf ?? []) as Array<Record<string, string>>;
    xfs.forEach((xf, i) => {
      const id = Number(xf['@_numFmtId'] ?? 0);
      if (BUILTIN_DATE_FORMATS.has(id) || customDate.has(id)) dateStyles.add(i);
    });
  }

  const sheetEntries = (workbook.sheets?.sheet ?? []) as Array<Record<string, string>>;
  const sheets: GridSheet[] = [];
  sheetEntries.forEach((s, i) => {
    const relId = s['@_id'];
    const partPath = rels.get(relId) ?? `xl/worksheets/sheet${i + 1}.xml`;
    const xml = zipText(zip, partPath);
    if (!xml) return;
    const name = s['@_name'] ?? `Sheet${i + 1}`;
    const uncalculated: string[] = [];
    sheets.push({ name, rows: readWorksheet(parser, xml, sharedStrings, dateStyles, date1904, uncalculated) });
    // A formula whose result was never saved (a workbook written by a script, never opened in
    // Excel) has no value to read: reading it as blank would silently drop an amount.
    if (uncalculated.length) {
      throw fail(
        `Cell ${uncalculated[0]} on the "${name}" sheet${uncalculated.length > 1 ? ` (and ${uncalculated.length - 1} more)` : ''} holds a formula whose result was never calculated. ` +
          'Open the workbook in Excel, save it, and upload it again.',
      );
    }
  });
  if (!sheets.length) throw fail('This .xlsx workbook contains no worksheets.');
  return sheets;
}

function readWorksheet(
  parser: XMLParser,
  xml: string,
  sharedStrings: string[],
  dateStyles: Set<number>,
  date1904: boolean,
  uncalculated: string[] = [],
): GridRow[] {
  const ws = parser.parse(xml)?.worksheet ?? {};
  const rowNodes = (ws.sheetData?.row ?? []) as Array<Record<string, unknown>>;
  const out: GridRow[] = [];
  let nextRow = 1;
  for (const rowNode of rowNodes) {
    const rowNum = Number(rowNode['@_r'] ?? nextRow) || nextRow;
    nextRow = rowNum + 1;
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of (rowNode.c ?? []) as Array<Record<string, unknown>>) {
      const ref = c['@_r'] ? parseCellRef(String(c['@_r'])) : null;
      const col = ref ? ref.col : nextCol;
      nextCol = col + 1;
      const t = String(c['@_t'] ?? 'n');
      const raw = textOf(c.v);
      if (c.f !== undefined && c.v === undefined && t !== 'inlineStr') {
        uncalculated.push(c['@_r'] ? String(c['@_r']) : `row ${rowNum}`);
      }
      let value = '';
      if (t === 's') {
        value = sharedStrings[Number(raw)] ?? '';
      } else if (t === 'inlineStr') {
        value = stringItemText(c.is as Record<string, unknown> | undefined);
      } else if (t === 'str') {
        value = raw;
      } else if (t === 'b') {
        value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
      } else if (t === 'e') {
        value = ''; // #N/A, #REF! … — never money
      } else if (t === 'd') {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
        value = m ? `${m[2]}/${m[3]}/${m[1]}` : raw;
      } else {
        value = raw;
        const style = Number(c['@_s'] ?? -1);
        if (raw !== '' && dateStyles.has(style)) {
          const serial = Number(raw);
          if (Number.isFinite(serial)) value = excelSerialToDate(serial, date1904);
        }
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (out.length < rowNum - 1) out.push({ cells: [] });
    out.push({ cells });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

interface PdfItem {
  x: number;
  right: number;
  y: number;
  str: string;
  size: number;
}
interface PdfLine {
  y: number;
  items: PdfItem[];
}

/**
 * pdfjs-dist is ESM-only; load the legacy (Node-compatible) build lazily. No worker thread:
 * registering the worker module on globalThis makes pdfjs run it in-process ("fake worker"),
 * and the static specifier lets Next's standalone tracing ship the worker file.
 */
async function loadPdfjs() {
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

/** Extract positioned text lines from each page (top-to-bottom, items left-to-right). */
export async function readPdfLines(bytes: Uint8Array): Promise<PdfLine[][]> {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch {
    throw fail('This PDF could not be opened. Re-save it from QuickBooks with File → Save as PDF.');
  }
  const pages: PdfLine[][] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: PdfItem[] = [];
      for (const raw of content.items as Array<Record<string, unknown>>) {
        const str = typeof raw.str === 'string' ? raw.str : '';
        if (!str.trim()) continue;
        const tr = raw.transform as number[];
        const x = tr[4];
        const width = Number(raw.width ?? 0);
        const size = Math.abs(tr[3]) || Number(raw.height ?? 8) || 8;
        items.push({ x, right: x + width, y: tr[5], str, size });
      }
      pages.push(groupLines(items));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/** Group text items into lines (same baseline within tolerance), left to right. */
function groupLines(items: PdfItem[]): PdfLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  for (const it of sorted) {
    const tol = Math.max(1.5, it.size * 0.3);
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

const AMOUNT_TEXT = /^\(?-?\$?\(?[\d,]*\.?\d+\)?-?\)?$/;
const PAGE_FOOTER = /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i;

/** Header tokens recognised in QuickBooks reports (GL, Trial Balance, Account Listing). */
const NUMERIC_HEADERS = new Set(['debit', 'credit', 'amount', 'balance', 'balance total']);

function lineText(line: PdfLine): string {
  return line.items.map((i) => i.str.trim()).join(' ').trim();
}

/**
 * Convert PDF lines into a grid. `isHeader` picks the column-header line (e.g. one containing
 * Type/Date/Debit for a GL). Column 0 of every row is the "label" column (text left of the
 * first header); columns 1..n follow the header items in x order.
 */
export function pdfLinesToGrid(
  pages: PdfLine[][],
  isHeader: (cells: string[]) => boolean,
): GridRow[] {
  let header: PdfItem[] | null = null;
  const out: GridRow[] = [];
  const title: GridRow[] = [];

  for (const lines of pages) {
    const hIdx = lines.findIndex((l) => isHeader(l.items.map((i) => i.str.trim())));
    let body: PdfLine[];
    if (hIdx >= 0) {
      if (!header) {
        header = lines[hIdx].items;
        // Lines above the first header are the report title block (company, title, dates).
        for (const l of lines.slice(0, hIdx)) title.push({ cells: [lineText(l)] });
        out.push({ cells: ['', ...header.map((h) => h.str.trim())] });
      }
      body = lines.slice(hIdx + 1); // repeated page header block (above the header) dropped
    } else {
      body = header ? lines : [];
      if (!header) for (const l of lines) title.push({ cells: [lineText(l)] });
    }
    if (!header) continue;
    for (const line of body) {
      const text = lineText(line);
      if (!text || PAGE_FOOTER.test(text)) continue;
      out.push(placeLine(line, header));
    }
  }
  if (!header) {
    // No recognisable header: return the raw lines so the caller can explain what it saw.
    return title;
  }
  return [...title, ...out];
}

/** Assign each text item on a line to a header column by x position. */
function placeLine(line: PdfLine, header: PdfItem[]): GridRow {
  const cells: string[] = new Array(header.length + 1).fill('');
  const firstLeft = header[0].x;
  const numericCols = header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => NUMERIC_HEADERS.has(h.str.trim().toLowerCase()));
  // A right-aligned amount always ends to the right of its column header's left edge; text in
  // the column just before (Split) never does.
  const numericZoneLeft = numericCols.length
    ? Math.min(...numericCols.map(({ h }) => h.x)) + 1
    : Number.POSITIVE_INFINITY;
  // Text column i starts halfway between header i-1's right edge and header i's left edge, so
  // data that starts slightly left of a (centred) header still lands in the right column.
  const bounds = header.map((h, i) => (i === 0 ? h.x - 2 : (header[i - 1].right + h.x) / 2));
  let indent: number | undefined;

  // Some PDF writers emit one word in several fragments: glue fragments that touch (within the
  // same column only — a long name running into the Memo column must stay separate).
  const lastRight: number[] = [];
  let current: PdfItem | null = null;
  const put = (col: number, s: string) => {
    const it = current!;
    const touching = lastRight[col] !== undefined && it.x - lastRight[col] < Math.max(0.6, it.size * 0.15);
    cells[col] = cells[col] ? `${cells[col]}${touching ? '' : ' '}${s}` : s;
    lastRight[col] = it.right;
  };

  for (const it of line.items) {
    const s = it.str.trim();
    if (!s) continue;
    current = it;
    if (it.x < firstLeft - 2) {
      put(0, s);
      if (indent === undefined) indent = it.x;
      continue;
    }
    if (numericCols.length && AMOUNT_TEXT.test(s.replace(/\s/g, '')) && it.right > numericZoneLeft) {
      // Amount columns are right-aligned: nearest header right edge wins.
      let best = numericCols[0];
      for (const c of numericCols) {
        if (Math.abs(c.h.right - it.right) < Math.abs(best.h.right - it.right)) best = c;
      }
      put(best.i + 1, s);
      continue;
    }
    // Text columns are left-aligned: the last header starting at/before the item.
    let col = 0;
    for (let i = 0; i < header.length; i++) {
      if (bounds[i] <= it.x + 0.5) col = i;
    }
    put(col + 1, s);
  }
  // Rows whose label was deep-indented past the first header still report their x position.
  return { cells, indent: indent ?? line.items[0]?.x };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Identify a report file by magic bytes (and extension as a tie-breaker). */
export function sniffKind(bytes: Uint8Array, fileName = ''): ReportFileKind {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'xlsx';
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11) {
    throw fail(
      'This is an old-style Excel .xls file. In Excel choose File → Save As → Excel Workbook (.xlsx), or export the report from QuickBooks as CSV.',
    );
  }
  const head = decodeText(bytes.subarray(0, 1024)).trimStart();
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('!') || /\.iif$/i.test(fileName)) return 'iif';
  return 'csv';
}

// ---------------------------------------------------------------------------
// Ironbooks' own shareable ledger workbook (lib/services/shareableLedger.ts)
// ---------------------------------------------------------------------------

const normCells = (cells: string[]) => cells.map((c) => (c ?? '').trim().toLowerCase());
const sameHeader = (cells: string[], want: string[]) => {
  const got = normCells(cells);
  return want.every((w, i) => got[i] === w);
};
/** Shareable ledger "General Ledger" sheet columns. */
const IB_GL_HEADER = ['account', 'date', 'entry #', 'description', 'reference', 'name', 'debit', 'credit', 'balance'];
/** Shareable ledger "Chart of Accounts" sheet columns. */
const IB_COA_HEADER = ['code', 'name', 'type', 'detail type'];

/** QB account type of an Ironbooks type + detail type ("checking", "accounts receivable", …). */
function qbTypeName(type: string, detail: string): string {
  const d = detail.trim().toLowerCase().replace(/_/g, ' ');
  switch (type.trim().toLowerCase()) {
    case 'asset':
      if (d === 'checking' || d === 'savings') return 'Bank';
      if (d === 'accounts receivable') return 'Accounts Receivable';
      if (d === 'fixed assets') return 'Fixed Asset';
      if (d === 'other asset') return 'Other Asset';
      return 'Other Current Asset';
    case 'liability':
      if (d === 'accounts payable') return 'Accounts Payable';
      if (d === 'credit card') return 'Credit Card';
      if (d === 'long term liability') return 'Long Term Liability';
      return 'Other Current Liability';
    case 'equity':
      return 'Equity';
    case 'revenue':
      return d === 'other income' ? 'Other Income' : 'Income';
    case 'expense':
      if (d === 'cost of goods sold') return 'Cost of Goods Sold';
      return d === 'other expense' ? 'Other Expense' : 'Expense';
    default:
      return '';
  }
}

/**
 * Read Ironbooks' own shareable ledger workbook like a QuickBooks export, so a ledger exported
 * from Ironbooks can come back in through the General Ledger import:
 *  - "General Ledger" (one row per line, account in the first column) → QB's GL layout: an
 *    account heading, a Beginning Balance row, General Journal rows (the entry # as Num and
 *    Trans #, so an entry's lines stay one transaction) and a "Total <account>" row;
 *  - "Chart of Accounts" (code, name, type, detail type) → an Account Listing with QB types.
 * Any other sheet is returned unchanged.
 */
function fromIronbooksLedger(sheet: GridSheet): GridSheet {
  const glIdx = sheet.rows.findIndex((r) => sameHeader(r.cells, IB_GL_HEADER));
  if (glIdx >= 0) {
    const out: GridRow[] = sheet.rows.slice(0, glIdx);
    out.push({ cells: ['', 'Type', 'Date', 'Num', 'Trans #', 'Name', 'Memo', 'Debit', 'Credit', 'Balance'] });
    let open: string | null = null;
    // Totals in whole cents (no binary-float drift over many lines).
    let debit = 0;
    let credit = 0;
    const cents = (v: string | undefined) => Math.round(Number(v || 0) * 100);
    const close = (balance: string) => {
      if (open === null) return;
      out.push({ cells: [`Total ${open}`, '', '', '', '', '', '', (debit / 100).toFixed(2), (credit / 100).toFixed(2), balance] });
      open = null;
    };
    for (const r of sheet.rows.slice(glIdx + 1)) {
      const [account, date, num, description, , name, dr, cr, balance] = r.cells.map((c) => (c ?? '').trim());
      if (!account) continue;
      if (account !== open) {
        close('');
        open = account;
        debit = 0;
        credit = 0;
        out.push({ cells: [account] });
      }
      if (!date && /^opening balance$/i.test(description ?? '')) {
        out.push({ cells: ['', '', '', '', '', '', 'Beginning Balance', '', '', balance ?? ''] });
      } else if (!date && /^closing balance$/i.test(description ?? '')) {
        close(balance ?? '');
      } else if (date) {
        debit += cents(dr);
        credit += cents(cr);
        out.push({ cells: ['', 'General Journal', date, num ?? '', num ?? '', name ?? '', description ?? '', dr ?? '', cr ?? '', balance ?? ''] });
      }
    }
    close('');
    return { name: sheet.name, rows: out };
  }
  const coaIdx = sheet.rows.findIndex((r) => sameHeader(r.cells, IB_COA_HEADER));
  if (coaIdx >= 0) {
    const out: GridRow[] = [{ cells: ['Account', 'Type', 'Accnt #'] }];
    for (const r of sheet.rows.slice(coaIdx + 1)) {
      const [code, name, type, detail] = r.cells.map((c) => (c ?? '').trim());
      const qbType = qbTypeName(type ?? '', detail ?? '');
      if (!code || !name || !qbType) continue;
      out.push({ cells: [`${code} · ${name}`, qbType, code] });
    }
    return { name: sheet.name, rows: out };
  }
  return sheet;
}

/** True when a row of cells looks like a QuickBooks GL column header. */
export function isGlHeaderCells(cells: string[]): boolean {
  const set = new Set(cells.map((c) => c.trim().toLowerCase()));
  return set.has('type') && set.has('date') && (set.has('debit') || set.has('amount'));
}

/**
 * Load a report file into grids (one per worksheet for xlsx). `isHeader` is used to locate the
 * column header for PDFs (defaults to the GL header).
 */
export async function loadGrid(
  bytes: Uint8Array,
  fileName = '',
  isHeader: (cells: string[]) => boolean = isGlHeaderCells,
): Promise<{ kind: ReportFileKind; sheets: GridSheet[]; text?: string }> {
  const kind = sniffKind(bytes, fileName);
  if (kind === 'xlsx') return { kind, sheets: readXlsx(bytes).map(fromIronbooksLedger) };
  if (kind === 'pdf') {
    const pages = await readPdfLines(bytes);
    return { kind, sheets: [{ name: 'PDF', rows: pdfLinesToGrid(pages, isHeader) }] };
  }
  const text = decodeText(bytes);
  if (kind === 'iif') return { kind, sheets: [], text };
  return { kind, sheets: [{ name: 'CSV', rows: readCsv(text) }], text };
}
