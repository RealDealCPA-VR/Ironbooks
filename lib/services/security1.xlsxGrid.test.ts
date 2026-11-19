/**
 * Security 1.4 — an .xlsx that names an absurd row or column (lib/services/qbGlFiles.ts).
 *
 * A row number or cell reference is a few bytes of XML but was turned into that many array slots:
 * a 700-byte workbook with <row r="2000000000"> or a cell "ZZZZZZZ1" filled memory until the
 * process aborted (the server hosts the database, so that stopped everyone). Excel's own grid is
 * 1,048,576 rows by 16,384 columns; past that the workbook is refused as damaged, and the blank
 * cells/rows a sheet may legally skip are capped per workbook.
 */
import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { readXlsx, XLSX_GRID_LIMITS } from './qbGlFiles';
import { glXlsx, SAMPLE_GL } from '@/test/fixtures/qbGlFixtures';

/** The fixture GL workbook with its data sheet replaced by `sheetData` rows. */
function workbookWithSheet(sheetData: string): Buffer {
  const zip = new AdmZip(glXlsx(SAMPLE_GL));
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;
  zip.updateFile('xl/worksheets/sheet2.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

describe('xlsx grid bombs are refused without allocating', () => {
  it('a row number past Excel\'s last row is refused as damaged, quickly', () => {
    const bomb = workbookWithSheet(`<row r="1">${cell('A1', 'Date')}</row><row r="2000000000">${cell('A2000000000', 'x')}</row>`);
    expect(bomb.length).toBeLessThan(4000);
    const t0 = performance.now();
    expect(() => readXlsx(bomb)).toThrow(expect.objectContaining({ code: 'VALIDATION', message: expect.stringMatching(/damaged/) }));
    expect(performance.now() - t0).toBeLessThan(2000);
    // One past the limit is refused; the last real row is not (below).
    expect(() => readXlsx(workbookWithSheet(`<row r="${XLSX_GRID_LIMITS.maxRow + 1}">${cell('A1', 'x')}</row>`))).toThrow(/damaged/);
  });

  it('a column past XFD (or an absurdly long column name) is refused as damaged', () => {
    for (const ref of ['ZZZZZZZ1', 'XFE1', `${'Z'.repeat(400)}1`]) {
      const bomb = workbookWithSheet(`<row r="1">${cell(ref, 'x')}</row>`);
      expect(() => readXlsx(bomb)).toThrow(expect.objectContaining({ code: 'VALIDATION', message: expect.stringMatching(/damaged/) }));
    }
    // Cells without a reference walk right one column each; walking past XFD is refused too.
    const walk = workbookWithSheet(`<row r="1">${'<c><v>1</v></c>'.repeat(XLSX_GRID_LIMITS.maxColIndex + 2)}</row>`);
    expect(() => readXlsx(walk)).toThrow(/damaged/);
  });

  it('the last row and column Excel allows still read; skipped rows share one blank row', () => {
    const sheets = readXlsx(
      workbookWithSheet(`<row r="1">${cell('A1', 'first')}${cell('XFD1', 'far right')}</row><row r="1048576">${cell('B1048576', 'last')}</row>`),
    );
    const rows = sheets[1].rows;
    expect(rows.length).toBe(1_048_576);
    expect(rows[0].cells[0]).toBe('first');
    expect(rows[0].cells[16_383]).toBe('far right');
    expect(rows[1_048_575].cells).toEqual(['', 'last']);
    // The gap is one shared (frozen) blank row, not a million new objects.
    expect(rows[1].cells).toEqual([]);
    expect(rows[500_000]).toBe(rows[1]);
    expect(Object.isFrozen(rows[1])).toBe(true);
  });

  it('padding every row out to column XFD is capped per workbook ("too large")', () => {
    // 1,300 rows x 16,384 columns = 21.3 million cells from about 60 KB of XML.
    const rows = Array.from({ length: 1300 }, (_, i) => `<row r="${i + 1}">${cell(`XFD${i + 1}`, 'x')}</row>`).join('');
    const bomb = workbookWithSheet(rows);
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => readXlsx(bomb)).toThrow(expect.objectContaining({ code: 'VALIDATION', message: expect.stringMatching(/too large to read/) }));
  });

  it('a normal workbook reads exactly as before', () => {
    const sheets = readXlsx(glXlsx(SAMPLE_GL));
    expect(sheets.map((s) => s.name)).toEqual(['QuickBooks Export Tips', 'Sheet1']);
    const rows = sheets[1].rows;
    expect(rows.length).toBeGreaterThan(10);
    // Row numbers still line up with the sheet's own (row N is rows[N - 1]).
    expect(rows.some((r) => r.cells.includes('Type') && r.cells.includes('Date'))).toBe(true);
    expect(rows.some((r) => r.cells.includes('2700'))).toBe(true);
  });
});
