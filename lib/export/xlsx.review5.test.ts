/**
 * Review round 5 — Excel exports must always open.
 *
 * XML 1.0 forbids most control characters, so one memo carrying e.g. a vertical tab or a stray
 * \u0001 (imported bank or IIF data, pasted text) made the whole workbook unreadable ("We found a
 * problem with some content"). Sheet names may not start or end with an apostrophe either.
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { buildXlsx, buildXlsxWorkbook } from './xlsx';

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function parts(buf: Buffer): Record<string, string> {
  const zip = new AdmZip(buf);
  return Object.fromEntries(zip.getEntries().map((e) => [e.entryName, e.getData().toString('utf-8')]));
}

describe('xlsx export with control characters', () => {
  it('drops characters XML cannot carry and keeps the rest of the text', () => {
    const buf = buildXlsx({
      title: 'Report \u0001',
      columns: [{ header: 'Memo\u000B' }, { header: 'Amount', numeric: true }],
      rows: [['Deposit\u0002 from ACME\u001F', '10.00'], ['half \uD83D pair', '1.00'], ['ok 🚀 tab\tline\nend', '2.00']],
    });
    const xml = parts(buf)['xl/worksheets/sheet1.xml'];
    expect(INVALID_XML.test(xml)).toBe(false);
    expect(xml).toContain('Deposit from ACME');
    expect(xml).toContain('ok 🚀 tab\tline\nend');
  });

  it('sheet names never start or end with an apostrophe and stay valid XML', () => {
    const buf = buildXlsxWorkbook([
      { sheetName: "'Quoted'", columns: [{ header: 'A' }], rows: [] },
      { sheetName: 'Bad\u0007Name', columns: [{ header: 'A' }], rows: [] },
    ]);
    const wb = parts(buf)['xl/workbook.xml'];
    expect(INVALID_XML.test(wb)).toBe(false);
    const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    for (const n of names) {
      expect(n.startsWith('&apos;')).toBe(false);
      expect(n.endsWith('&apos;')).toBe(false);
      expect(n.length).toBeGreaterThan(0);
    }
  });
});
