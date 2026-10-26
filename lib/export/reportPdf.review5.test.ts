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
