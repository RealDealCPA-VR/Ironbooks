/**
 * PDF renderer for invoices.
 *
 * Uses pdf-lib with the standard Helvetica / Helvetica-Bold fonts (embedded in every
 * PDF viewer — no external font files required).
 *
 * Layout (US Letter, portrait):
 *   - Company name header (top-left), "INVOICE #XXXX" label (top-right)
 *   - Invoice date / due date beneath the number
 *   - "Bill To" block
 *   - Horizontal rule separator
 *   - Line-items table (description | qty | rate | amount)
 *   - Totals block (subtotal, discount, tax, total, balance due)
 *   - Light footer rule at bottom
 */

import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { type SalesShippingInfo, drawShippingBand } from './salesForm';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface InvoicePdfLine {
  description: string;
  quantity: string | number;
  rate: string | number;
  amount: string | number;
}

export interface InvoicePdfData {
  company: { name: string };
  customerName: string;
  invoice: {
    number: number | string;
    date: string;       // ISO or any human-readable date string
    dueDate?: string | null;
    subtotal: string | number;
    discount: string | number;
    tax: string | number;
    total: string | number;
    balanceDue: string | number;
  };
  lines: InvoicePdfLine[];
  /** wave2 sales (B6): ship date / via / FOB / tracking # / ship-to / customer P.O. No. */
  shipping?: SalesShippingInfo | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a decimal string as USD currency. */
function fmt(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    isNaN(n) ? 0 : n,
  );
}

/** Truncate a string to a maximum number of characters (adds ellipsis). */
function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// US Letter: 612 x 792 pt
const PAGE_W = PageSizes.Letter[0]; // 612
const PAGE_H = PageSizes.Letter[1]; // 792

const MARGIN_L = 48;
const MARGIN_R = PAGE_W - 48;
const CONTENT_W = MARGIN_R - MARGIN_L;

// Brand-ish colors (Navy + Electric Blue accent from the app theme)
const COLOR_NAVY = rgb(0.09, 0.13, 0.27);      // #171f45 approx
const COLOR_ACCENT = rgb(0.20, 0.47, 0.96);    // #3378f5 approx
const COLOR_LIGHT = rgb(0.90, 0.92, 0.95);     // light rule
const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_GRAY = rgb(0.45, 0.45, 0.50);

// ---------------------------------------------------------------------------
// renderInvoicePdf
// ---------------------------------------------------------------------------

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // pdf-lib draws from the bottom-left; we track a cursor from the top.
  let cursor = PAGE_H - 48; // start 48pt from top

  // ---------------------------------------------------------------------------
  // Helper: draw a horizontal rule
  // ---------------------------------------------------------------------------
  function drawRule(y: number, color = COLOR_LIGHT, thickness = 0.75) {
    page.drawLine({
      start: { x: MARGIN_L, y },
      end: { x: MARGIN_R, y },
      thickness,
      color,
    });
  }

  // ---------------------------------------------------------------------------
  // HEADER — company name (left) + invoice label (right)
  // ---------------------------------------------------------------------------

  // Company name — large, bold, navy
  page.drawText(trunc(data.company.name, 40), {
    x: MARGIN_L,
    y: cursor,
    font: bold,
    size: 22,
    color: COLOR_NAVY,
  });

  // "INVOICE" label — right-aligned
  const invoiceLabel = 'INVOICE';
  const invoiceLabelW = bold.widthOfTextAtSize(invoiceLabel, 18);
  page.drawText(invoiceLabel, {
    x: MARGIN_R - invoiceLabelW,
    y: cursor,
    font: bold,
    size: 18,
    color: COLOR_ACCENT,
  });

  cursor -= 22;

  // Invoice number beneath the label
  const numStr = `#${data.invoice.number}`;
  const numW = bold.widthOfTextAtSize(numStr, 12);
  page.drawText(numStr, {
    x: MARGIN_R - numW,
    y: cursor,
    font: bold,
    size: 12,
    color: COLOR_NAVY,
  });

  cursor -= 16;

  // Invoice date & due date beneath the number
  const dateStr = `Date: ${data.invoice.date}`;
  const dateLabelW = regular.widthOfTextAtSize(dateStr, 10);
  page.drawText(dateStr, {
    x: MARGIN_R - dateLabelW,
    y: cursor,
    font: regular,
    size: 10,
    color: COLOR_GRAY,
  });

  cursor -= 14;

  if (data.invoice.dueDate) {
    const dueStr = `Due: ${data.invoice.dueDate}`;
    const dueLabelW = regular.widthOfTextAtSize(dueStr, 10);
    page.drawText(dueStr, {
      x: MARGIN_R - dueLabelW,
      y: cursor,
      font: regular,
      size: 10,
      color: COLOR_GRAY,
    });
    cursor -= 14;
  }

  // ---------------------------------------------------------------------------
  // BILL TO block (left side)
  // ---------------------------------------------------------------------------

  // Reset left cursor to where we left off after the company name
  const billToY = PAGE_H - 48 - 22 - 16; // align with first sub-line after company name

  page.drawText('BILL TO', {
    x: MARGIN_L,
    y: billToY,
    font: bold,
    size: 8,
    color: COLOR_GRAY,
  });

  page.drawText(trunc(data.customerName, 45), {
    x: MARGIN_L,
    y: billToY - 14,
    font: bold,
    size: 12,
    color: COLOR_NAVY,
  });

  // Move cursor past the header block — leave some breathing room
  cursor = Math.min(cursor, billToY - 14) - 28;

  // Shipping details band (only when the invoice carries any).
  if (data.shipping) {
    cursor = drawShippingBand(page, { regular, bold }, data.shipping, cursor + 10, MARGIN_L, MARGIN_R);
  }

  // ---------------------------------------------------------------------------
  // SEPARATOR
  // ---------------------------------------------------------------------------

  drawRule(cursor, COLOR_ACCENT, 1.5);
  cursor -= 18;

  // ---------------------------------------------------------------------------
  // LINE-ITEMS TABLE HEADER
  // ---------------------------------------------------------------------------

  // Column x positions
  const COL_DESC = MARGIN_L;
  const COL_QTY = MARGIN_L + CONTENT_W * 0.58;
  const COL_RATE = MARGIN_L + CONTENT_W * 0.72;
  const COL_AMT = MARGIN_R; // right-aligned

  const TABLE_HEADER_SIZE = 8;

  // Header labels
  page.drawText('DESCRIPTION', {
    x: COL_DESC,
    y: cursor,
    font: bold,
    size: TABLE_HEADER_SIZE,
    color: COLOR_GRAY,
  });

  const qtyLabel = 'QTY';
  const qtyLabelW = bold.widthOfTextAtSize(qtyLabel, TABLE_HEADER_SIZE);
  page.drawText(qtyLabel, {
    x: COL_QTY - qtyLabelW / 2,
    y: cursor,
    font: bold,
    size: TABLE_HEADER_SIZE,
    color: COLOR_GRAY,
  });

  const rateLabel = 'RATE';
  const rateLabelW = bold.widthOfTextAtSize(rateLabel, TABLE_HEADER_SIZE);
  page.drawText(rateLabel, {
    x: COL_RATE - rateLabelW / 2,
    y: cursor,
    font: bold,
    size: TABLE_HEADER_SIZE,
    color: COLOR_GRAY,
  });

  const amtLabel = 'AMOUNT';
  const amtLabelW = bold.widthOfTextAtSize(amtLabel, TABLE_HEADER_SIZE);
  page.drawText(amtLabel, {
    x: COL_AMT - amtLabelW,
    y: cursor,
    font: bold,
    size: TABLE_HEADER_SIZE,
    color: COLOR_GRAY,
  });

  cursor -= 6;
  drawRule(cursor);
  cursor -= 14;

  // ---------------------------------------------------------------------------
  // LINE ITEMS
  // ---------------------------------------------------------------------------

  const ROW_H = 16;
  const LINE_SIZE = 10;

  for (const line of data.lines) {
    // Guard: stop if we're getting close to the bottom (leave 160pt for totals + footer)
    if (cursor < 160) {
      page.drawText('(continued on next page)', {
        x: MARGIN_L,
        y: cursor,
        font: regular,
        size: 8,
        color: COLOR_GRAY,
      });
      cursor -= ROW_H;
      break;
    }

    const desc = trunc(String(line.description || '—'), 55);
    const qtyStr = String(line.quantity ?? '');
    const rateStr = fmt(line.rate);
    const amtStr = fmt(line.amount);

    page.drawText(desc, {
      x: COL_DESC,
      y: cursor,
      font: regular,
      size: LINE_SIZE,
      color: COLOR_BLACK,
    });

    // Qty — centered under header
    const qtyW = regular.widthOfTextAtSize(qtyStr, LINE_SIZE);
    page.drawText(qtyStr, {
      x: COL_QTY - qtyW / 2,
      y: cursor,
      font: regular,
      size: LINE_SIZE,
      color: COLOR_BLACK,
    });

    // Rate — centered under header
    const rateW = regular.widthOfTextAtSize(rateStr, LINE_SIZE);
    page.drawText(rateStr, {
      x: COL_RATE - rateW / 2,
      y: cursor,
      font: regular,
      size: LINE_SIZE,
      color: COLOR_BLACK,
    });

    // Amount — right-aligned
    const amtW = regular.widthOfTextAtSize(amtStr, LINE_SIZE);
    page.drawText(amtStr, {
      x: COL_AMT - amtW,
      y: cursor,
      font: regular,
      size: LINE_SIZE,
      color: COLOR_BLACK,
    });

    cursor -= ROW_H;

    // Light row separator
    drawRule(cursor + 2);
    cursor -= 4;
  }

  cursor -= 8;

  // ---------------------------------------------------------------------------
  // TOTALS BLOCK (right-aligned)
  // ---------------------------------------------------------------------------

  const TOT_LABEL_X = MARGIN_L + CONTENT_W * 0.62;
  const TOT_VALUE_X = MARGIN_R;
  const TOT_SIZE = 10;
  const TOT_ROW = 16;

  function drawTotalRow(
    label: string,
    value: string,
    opts: { bold?: boolean; size?: number } = {},
  ) {
    const sz = opts.size ?? TOT_SIZE;
    const font = opts.bold ? bold : regular;
    const color = opts.bold ? COLOR_NAVY : COLOR_GRAY;

    page.drawText(label, {
      x: TOT_LABEL_X,
      y: cursor,
      font,
      size: sz,
      color,
    });

    const valW = font.widthOfTextAtSize(value, sz);
    page.drawText(value, {
      x: TOT_VALUE_X - valW,
      y: cursor,
      font,
      size: sz,
      color,
    });

    cursor -= TOT_ROW;
  }

  // Subtotal
  drawTotalRow('Subtotal', fmt(data.invoice.subtotal));

  // Discount — only if non-zero
  const discountVal = parseFloat(String(data.invoice.discount)) || 0;
  if (discountVal !== 0) {
    drawTotalRow('Discount', `(${fmt(data.invoice.discount)})`);
  }

  // Tax — only if non-zero
  const taxVal = parseFloat(String(data.invoice.tax)) || 0;
  if (taxVal !== 0) {
    drawTotalRow('Tax', fmt(data.invoice.tax));
  }

  cursor -= 2;
  // Rule before total
  page.drawLine({
    start: { x: TOT_LABEL_X, y: cursor },
    end: { x: TOT_VALUE_X, y: cursor },
    thickness: 0.75,
    color: COLOR_NAVY,
  });
  cursor -= 14;

  drawTotalRow('Total', fmt(data.invoice.total), { bold: true, size: 12 });

  // Balance due (highlighted)
  const bdVal = parseFloat(String(data.invoice.balanceDue)) || 0;
  if (bdVal > 0) {
    // Tinted rectangle behind balance due row
    const rectH = 20;
    page.drawRectangle({
      x: TOT_LABEL_X - 6,
      y: cursor - 4,
      width: TOT_VALUE_X - TOT_LABEL_X + 12,
      height: rectH,
      color: rgb(0.93, 0.96, 1.0),
    });

    const bdLabel = 'Balance Due';
    page.drawText(bdLabel, {
      x: TOT_LABEL_X,
      y: cursor + 2,
      font: bold,
      size: 11,
      color: COLOR_ACCENT,
    });

    const bdStr = fmt(data.invoice.balanceDue);
    const bdW = bold.widthOfTextAtSize(bdStr, 11);
    page.drawText(bdStr, {
      x: TOT_VALUE_X - bdW,
      y: cursor + 2,
      font: bold,
      size: 11,
      color: COLOR_ACCENT,
    });

    cursor -= TOT_ROW + 4;
  }

  // ---------------------------------------------------------------------------
  // FOOTER
  // ---------------------------------------------------------------------------

  const FOOTER_Y = 36;
  drawRule(FOOTER_Y + 10, COLOR_LIGHT, 0.5);

  const footerText = `${data.company.name}  —  Thank you for your business.`;
  const ftW = regular.widthOfTextAtSize(footerText, 8);
  page.drawText(footerText, {
    x: (PAGE_W - ftW) / 2,
    y: FOOTER_Y,
    font: regular,
    size: 8,
    color: COLOR_GRAY,
  });

  // ---------------------------------------------------------------------------
  // Finalize
  // ---------------------------------------------------------------------------

  return pdfDoc.save();
}
