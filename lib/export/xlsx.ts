/**
 * Minimal .xlsx writer with zero new dependencies — builds the Office Open XML
 * package by hand (it is just a zip of XML parts) using adm-zip, which the app
 * already ships for backups/imports.
 *
 * Scope: one worksheet, inline strings + raw numbers, optional title/subtitle
 * rows and bold-ish totals rows (no styles part beyond the minimal default, so
 * "bold" is structural only — totals are still plain rows). That is all a
 * report export needs, and every spreadsheet app (Excel, LibreOffice, Numbers,
 * Google Sheets) opens it.
 */
import AdmZip from 'adm-zip';

export interface XlsxColumn {
  header: string;
  /** Hint: values in this column should be written as numbers when they parse. */
  numeric?: boolean;
}

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheetInput {
  /** Worksheet tab name (sanitized + truncated to Excel's 31-char limit). */
  sheetName?: string;
  /** Optional report title placed in A1. */
  title?: string;
  /** Optional subtitle (date range etc.) placed under the title. */
  subtitle?: string;
  columns: XlsxColumn[];
  rows: XlsxCell[][];
  /** Optional totals/footer rows appended after the data rows. */
  totals?: XlsxCell[][];
}

/** Escape a string for use inside XML text/attributes. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0-based column index -> spreadsheet column letters (0 -> A, 26 -> AA). */
export function columnRef(index: number): string {
  let ref = '';
  let i = index;
  while (i >= 0) {
    ref = String.fromCharCode(65 + (i % 26)) + ref;
    i = Math.floor(i / 26) - 1;
  }
  return ref;
}

/** Excel forbids []:*?/\ in sheet names and caps them at 31 chars. */
function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim();
  return (cleaned || 'Report').slice(0, 31);
}

/** True when the cell should be emitted as a real number cell. */
function isNumericValue(value: XlsxCell, columnNumeric: boolean): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!columnNumeric) return false;
  if (typeof value !== 'string' || value.trim() === '') return false;
  // Money strings like "1234.50" / "-12.00" — but not "1,234.50" or "12%".
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

function cellXml(ref: string, value: XlsxCell, columnNumeric: boolean): string {
  if (value === null || value === undefined || value === '') return '';
  if (isNumericValue(value, columnNumeric)) {
    return `<c r="${ref}"><v>${Number(value)}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function rowXml(rowNumber: number, cells: XlsxCell[], columns: XlsxColumn[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const xml = cellXml(`${columnRef(i)}${rowNumber}`, cells[i], columns[i]?.numeric ?? false);
    if (xml) parts.push(xml);
  }
  return `<row r="${rowNumber}">${parts.join('')}</row>`;
}

/** Build the worksheet XML part from the sheet input. */
function worksheetXml(input: XlsxSheetInput): string {
  const rows: string[] = [];
  let rowNumber = 1;
  if (input.title) {
    rows.push(rowXml(rowNumber++, [input.title], input.columns));
  }
  if (input.subtitle) {
    rows.push(rowXml(rowNumber++, [input.subtitle], input.columns));
  }
  if (input.title || input.subtitle) rowNumber++; // blank spacer row
  rows.push(rowXml(rowNumber++, input.columns.map((c) => c.header), input.columns));
  for (const dataRow of input.rows) {
    rows.push(rowXml(rowNumber++, dataRow, input.columns));
  }
  for (const totalsRow of input.totals ?? []) {
    rows.push(rowXml(rowNumber++, totalsRow, input.columns));
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>'
  );
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '</Relationships>';

function workbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

/**
 * Build a complete .xlsx file (as a Buffer) from columns + rows.
 * Inline strings only — no shared-strings table — so the part set stays tiny.
 */
export function buildXlsx(input: XlsxSheetInput): Buffer {
  if (!input.columns?.length) {
    throw new Error('buildXlsx requires at least one column.');
  }
  const sheetName = sanitizeSheetName(input.sheetName ?? input.title ?? 'Report');
  const zip = new AdmZip();
  const add = (path: string, xml: string) => zip.addFile(path, Buffer.from(xml, 'utf-8'));
  add('[Content_Types].xml', CONTENT_TYPES_XML);
  add('_rels/.rels', ROOT_RELS_XML);
  add('xl/workbook.xml', workbookXml(sheetName));
  add('xl/_rels/workbook.xml.rels', WORKBOOK_RELS_XML);
  add('xl/worksheets/sheet1.xml', worksheetXml(input));
  return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// Multi-sheet workbooks (shareable ledger export). Same minimal part set, one
// worksheet part per sheet; sheet names are de-duplicated (Excel requires it).
// ---------------------------------------------------------------------------

/** Build an .xlsx workbook with one worksheet per input sheet. */
export function buildXlsxWorkbook(sheets: XlsxSheetInput[]): Buffer {
  if (!sheets.length) throw new Error('buildXlsxWorkbook requires at least one sheet.');
  const names: string[] = [];
  for (const s of sheets) {
    if (!s.columns?.length) throw new Error('buildXlsxWorkbook: every sheet needs at least one column.');
    const base = sanitizeSheetName(s.sheetName ?? s.title ?? 'Sheet');
    let name = base;
    for (let i = 2; names.some((n) => n.toLowerCase() === name.toLowerCase()); i++) {
      const suffix = ` (${i})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    names.push(name);
  }
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    names
      .map(
        (_n, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '</Types>';
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    names
      .map(
        (_n, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    '</Relationships>';
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';

  const zip = new AdmZip();
  const add = (path: string, xml: string) => zip.addFile(path, Buffer.from(xml, 'utf-8'));
  add('[Content_Types].xml', contentTypes);
  add('_rels/.rels', ROOT_RELS_XML);
  add('xl/workbook.xml', workbook);
  add('xl/_rels/workbook.xml.rels', workbookRels);
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, worksheetXml(s)));
  return zip.toBuffer();
}
