/**
 * Review round 5 — report CSV downloads open correctly in Excel.
 *
 * Excel reads a UTF-8 CSV without a byte-order mark as Windows-1252: every report's title line
 * ("Profit & Loss — 01/01/2026 – 03/31/2026") and any accented customer name came out as
 * "â€”" / "Ã©". The list exports and scheduled report files carried the mark; the report page
 * downloads did not.
 */
import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvFile, csvQuoted } from './csv';

describe('csvFile', () => {
  it('starts with the UTF-8 byte-order mark and uses CRLF line ends', () => {
    const text = csvFile([csvQuoted('Profit & Loss — 01/01/2026 – 03/31/2026'), '', [csvQuoted('Café'), csvQuoted('=1+1')].join(',')]);
    expect(CSV_BOM).toBe('\uFEFF');
    expect(text.startsWith('\uFEFF"Profit & Loss — 01/01/2026 – 03/31/2026"\r\n')).toBe(true);
    expect(text).toContain('"Café","\'=1+1"');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('never doubles the mark', () => {
    expect(csvFile(['\uFEFFa']).startsWith('\uFEFF\uFEFF')).toBe(false);
  });
});
