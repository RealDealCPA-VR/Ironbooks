/**
 * Shared form renderer + template designs: every form type renders, designs are normalized
 * safely, long documents paginate, logos embed (and bad logos never break printing), and text
 * outside the standard-font character set can't crash a PDF.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { FORM_TYPES, defaultDesign, normalizeDesign } from './design';
import { pdfSafe, renderFormPdf, sampleFormDocument, wrapText } from './template';
import { renderInvoicePdf } from './invoice';
import { StandardFonts } from 'pdf-lib';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

function isPdf(bytes: Uint8Array) {
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
}

describe('renderFormPdf', () => {
  for (const formType of FORM_TYPES) {
    it(`renders the sample ${formType} with the default design`, async () => {
      const bytes = await renderFormPdf(sampleFormDocument(formType, 'Acme'));
      isPdf(bytes);
      expect(await pageCount(bytes)).toBe(1);
    });
  }

  it('honors a customized design (font, colors, hidden columns, all fields)', async () => {
    const d = defaultDesign('invoice');
    d.font = 'times';
    d.accentColor = '#aa0000';
    d.columns = d.columns.map((c) => ({ ...c, show: c.key !== 'rate' }));
    for (const k of Object.keys(d.fields)) d.fields[k].show = true;
    d.headerText = 'License #12345';
    d.footerText = 'Remit to PO Box 1';
    d.logoPosition = 'right';
    const bytes = await renderFormPdf(sampleFormDocument('invoice'), d, { bytes: new Uint8Array(TINY_PNG), mimeType: 'image/png' });
    isPdf(bytes);
  });

  it('continues long documents onto more pages', async () => {
    const doc = sampleFormDocument('invoice');
    doc.lines = Array.from({ length: 120 }, (_, i) => ({
      description: `Line ${i + 1} with a fairly long description that will need to wrap onto a second line in the column`,
      quantity: 1,
      rate: '10.00',
      amount: '10.00',
    }));
    const bytes = await renderFormPdf(doc);
    expect(await pageCount(bytes)).toBeGreaterThan(2);
  });

  it('prints without the logo when the image is unreadable', async () => {
    const bytes = await renderFormPdf(sampleFormDocument('estimate'), null, {
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'image/png',
    });
    isPdf(bytes);
  });

  it('never crashes on characters the standard fonts cannot draw', async () => {
    const doc = sampleFormDocument('invoice', 'Café ☕ 日本');
    doc.lines[0].description = 'Emoji 🎉 and Ω ok — “quotes” …';
    doc.memo = 'Thanks 🙏';
    isPdf(await renderFormPdf(doc));
    expect(pdfSafe('a🎉b')).toBe('a?b');
    expect(pdfSafe('“ok” — €5 …')).toBe('“ok” — €5 …');
  });

  it('the invoice wrapper still renders the classic data shape', async () => {
    const bytes = await renderInvoicePdf({
      company: { name: 'Acme' },
      customerName: 'Jane',
      invoice: { number: 7, date: '2026-06-01', subtotal: '100', discount: '10', tax: '5', total: '95', balanceDue: '95' },
      lines: [{ description: 'Work', quantity: 1, rate: '100', amount: '100' }],
    });
    isPdf(bytes);
  });
});

describe('normalizeDesign', () => {
  it('fills missing parts and drops unknown/unsafe values', () => {
    const d = normalizeDesign('invoice', {
      title: 'BILL',
      font: 'comic-sans',
      fontSize: 99,
      accentColor: 'red',
      fields: { dueDate: { show: false, label: 'Pay by' }, hacker: { show: true, label: 'x' } },
      columns: [
        { key: 'amount', label: 'Total', show: true, width: 2 },
        { key: 'evil', label: 'x', show: true, width: 1 },
        { key: 'amount', label: 'dupe', show: true, width: 1 },
      ],
    });
    expect(d.title).toBe('BILL');
    expect(d.font).toBe('helvetica');
    expect(d.fontSize).toBe(10);
    expect(d.accentColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(d.fields.dueDate).toEqual({ show: false, label: 'Pay by' });
    expect(d.fields.hacker).toBeUndefined();
    expect(d.columns[0]).toEqual({ key: 'amount', label: 'Total', show: true, width: 2 });
    expect(d.columns.filter((c) => c.key === 'amount')).toHaveLength(1);
    expect(d.columns.some((c) => c.key === 'evil')).toBe(false);
    // Columns missing from a saved template come back hidden.
    expect(d.columns.find((c) => c.key === 'description')?.show).toBe(false);
  });

  it('always keeps at least one column visible', () => {
    const d = normalizeDesign('estimate', { columns: [] });
    expect(d.columns.some((c) => c.show)).toBe(true);
  });
});

describe('wrapText', () => {
  it('wraps words and hard-breaks over-long tokens', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines = wrapText('short words then Supercalifragilisticexpialidociouslylongtoken end', font, 10, 60);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(60.01);
  });
});
