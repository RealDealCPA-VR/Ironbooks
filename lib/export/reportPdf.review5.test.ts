/**
 * Review round 5 — report PDFs keep every character the PDF font can draw.
 *
 * The date-range subtitle of every report is "01/01/2026 – 03/31/2026" (an en dash): the PDF
 * showed "01/01/2026 ? 03/31/2026" because only Latin-1 survived, although Helvetica (WinAnsi)
 * draws en / em dashes, curly quotes and the euro sign; a cleared check mark showed as "?".
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildReportPdf, pdfSafeText } from './reportPdf';

describe('pdfSafeText', () => {
  it('keeps WinAnsi characters and replaces only what the font cannot draw', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(pdfSafeText('01/01/2026 – 03/31/2026', font)).toBe('01/01/2026 – 03/31/2026');
    expect(pdfSafeText('Owner’s draw — €12 “net”', font)).toBe('Owner’s draw — €12 “net”');
    expect(pdfSafeText('Café ✓', font)).toBe('Café X');
    expect(pdfSafeText('a\u0085b\nc\td', font)).toBe('a?b c d');
    expect(pdfSafeText('报表', font)).toBe('??');
  });
});

describe('buildReportPdf', () => {
  it('still renders C1 control characters and check marks without failing', async () => {
    const bytes = await buildReportPdf({
      title: 'GL \u0085',
      subtitle: '01/01/2026 – 03/31/2026',
      columns: [{ header: 'Memo' }, { header: 'Clr' }, { header: 'Amount', numeric: true }],
      rows: [['line\u0081 one', '✓', '1.00']],
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

/**
 * Long cells: fitText dropped one character at a time and measured the whole string again at each
 * step (quadratic). One 8,000-character memo took 1.6 s to fit; a General Ledger with long bank
 * descriptions took minutes to export. The cut is now a binary search with the same result.
 */
describe('fitText on long text', () => {
  it('measures a handful of times, not once per character, and cuts at the same place', async () => {
    const { fitText } = await import('./reportPdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let calls = 0;
    const counting = {
      getCharacterSet: () => font.getCharacterSet(),
      widthOfTextAtSize: (t: string, s: number) => {
        calls++;
        return font.widthOfTextAtSize(t, s);
      },
    };
    const long = 'Deposit from ACME CORP ref 0042 '.repeat(250); // 8,000 characters
    const out = fitText(long, counting, 8.5, 120);
    expect(calls).toBeLessThan(40);
    expect(out.endsWith('…')).toBe(true);
    expect(font.widthOfTextAtSize(out, 8.5)).toBeLessThanOrEqual(120);
    // The longest prefix that fits: one more character would not.
    const kept = out.slice(0, -1);
    expect(font.widthOfTextAtSize(`${long.slice(0, kept.length + 1)}…`, 8.5)).toBeGreaterThan(120);
    // Short text that fits is returned as is; a single wide character still shows.
    expect(fitText('Rent', counting, 8.5, 120)).toBe('Rent');
    expect(fitText('WWWW', counting, 8.5, 1)).toBe('W…');
  });
});
