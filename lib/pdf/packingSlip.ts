/**
 * PDF renderer for packing slips.
 *
 * A packing slip is an invoice rendered WITHOUT prices — ship-to address,
 * item descriptions, and quantities only — so it can ride along in the box.
 *
 * Uses pdf-lib with the standard Helvetica / Helvetica-Bold fonts (embedded in
 * every PDF viewer — no external font files required), mirroring
 * lib/pdf/invoice.ts.
 *
 * Layout (US Letter, portrait):
 *   - Company name header (top-left), "PACKING SLIP" label (top-right)
 *   - Invoice number / date beneath the label
 *   - "Ship To" block (falls back to the customer name when no address)
 *   - Horizontal rule separator
 *   - Line-items table (item | description | qty) — NO rate / amount columns
 *   - Total units line
 *   - Light footer rule at bottom
 */

import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface PackingSlipLine {
  /** Item name (optional — free-form lines have none). */
  itemName?: string | null;
  description: string;
  quantity: string | number;
}

export interface PackingSlipData {
  company: { name: string };
  customerName: string;
  /** Ship-to address lines (already formatted); customer name is printed above them. */
  shipToLines?: string[];
  slip: {
    /** The invoice number this slip accompanies. */
    invoiceNumber: number | string;
    /** ISO or human-readable date string. */
    date: string;
    /** Optional sales-order number for reference. */
    orderNumber?: number | string | null;
    /** Override the document reference line (default "Invoice #<invoiceNumber>"). */
    label?: string | null;
  };
  /** The document's own shipping details (printed under the number, when present). */
  shipping?: {
    shipVia?: string | null;
    trackingNumber?: string | null;
    shipDate?: string | null;
    fob?: string | null;
    poNumber?: string | null;
  } | null;
  lines: PackingSlipLine[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render a quantity without trailing decimal noise ("2.0000" -> "2"). */
function fmtQty(value: string | number): string {
  let n = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(n)) return String(value);
  n = Math.round(n * 10000) / 10000; // avoid float drift in summed totals
  return String(n);
}

/** Truncate a string to a maximum number of characters (adds ellipsis). */
function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// US Letter: 612 x 792 pt
const PAGE_W = PageSizes.Letter[0];
const PAGE_H = PageSizes.Letter[1];

const MARGIN_L = 48;
const MARGIN_R = PAGE_W - 48;
const CONTENT_W = MARGIN_R - MARGIN_L;

const COLOR_NAVY = rgb(0.09, 0.13, 0.27);
const COLOR_ACCENT = rgb(0.2, 0.47, 0.96);
const COLOR_LIGHT = rgb(0.9, 0.92, 0.95);
const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_GRAY = rgb(0.45, 0.45, 0.5);

// ---------------------------------------------------------------------------
// renderPackingSlipPdf
// ---------------------------------------------------------------------------

export async function renderPackingSlipPdf(data: PackingSlipData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  let cursor = PAGE_H - 48;

  function drawRule(y: number, color = COLOR_LIGHT, thickness = 0.75) {
    page.drawLine({
      start: { x: MARGIN_L, y },
      end: { x: MARGIN_R, y },
      thickness,
      color,
    });
  }

  // --- HEADER — company name (left) + "PACKING SLIP" (right) ----------------

  page.drawText(trunc(data.company.name, 40), {
    x: MARGIN_L,
    y: cursor,
    font: bold,
    size: 22,
    color: COLOR_NAVY,
  });

  const label = 'PACKING SLIP';
  const labelW = bold.widthOfTextAtSize(label, 18);
  page.drawText(label, {
    x: MARGIN_R - labelW,
    y: cursor,
    font: bold,
    size: 18,
    color: COLOR_ACCENT,
  });

  cursor -= 22;

  const numStr = data.slip.label || `Invoice #${data.slip.invoiceNumber}`;
  const numW = bold.widthOfTextAtSize(numStr, 12);
  page.drawText(numStr, {
    x: MARGIN_R - numW,
    y: cursor,
    font: bold,
    size: 12,
    color: COLOR_NAVY,
  });

  cursor -= 16;

  const dateStr = `Date: ${data.slip.date}`;
  const dateW = regular.widthOfTextAtSize(dateStr, 10);
  page.drawText(dateStr, {
    x: MARGIN_R - dateW,
    y: cursor,
    font: regular,
    size: 10,
    color: COLOR_GRAY,
  });
  cursor -= 14;

  if (data.slip.orderNumber != null && data.slip.orderNumber !== '') {
    const soStr = `Sales Order #${data.slip.orderNumber}`;
    const soW = regular.widthOfTextAtSize(soStr, 10);
    page.drawText(soStr, {
      x: MARGIN_R - soW,
      y: cursor,
      font: regular,
      size: 10,
      color: COLOR_GRAY,
    });
    cursor -= 14;
  }

  // Shipping details from the document (Ship Via, tracking number, ...).
  const sh = data.shipping ?? {};
  const shipDetails: Array<[string, string | null | undefined]> = [
    ['P.O. No.', sh.poNumber],
    ['Ship Date', sh.shipDate],
    ['Ship Via', sh.shipVia],
    ['Tracking #', sh.trackingNumber],
    ['F.O.B.', sh.fob],
  ];
  for (const [label, value] of shipDetails) {
    if (!value || !String(value).trim()) continue;
    const str = trunc(`${label}: ${String(value).trim()}`, 48);
    const w = regular.widthOfTextAtSize(str, 9);
    page.drawText(str, { x: MARGIN_R - w, y: cursor, font: regular, size: 9, color: COLOR_GRAY });
    cursor -= 12;
  }

  // --- SHIP TO block (left side) ---------------------------------------------

  const shipToY = PAGE_H - 48 - 22 - 16;

  page.drawText('SHIP TO', {
    x: MARGIN_L,
    y: shipToY,
    font: bold,
    size: 8,
    color: COLOR_GRAY,
  });

  page.drawText(trunc(data.customerName, 45), {
    x: MARGIN_L,
    y: shipToY - 14,
    font: bold,
    size: 12,
    color: COLOR_NAVY,
  });

  let leftCursor = shipToY - 14;
  for (const addrLine of (data.shipToLines ?? []).slice(0, 5)) {
    if (!addrLine.trim()) continue;
    leftCursor -= 13;
    page.drawText(trunc(addrLine, 55), {
      x: MARGIN_L,
      y: leftCursor,
      font: regular,
      size: 10,
      color: COLOR_BLACK,
    });
  }

  cursor = Math.min(cursor, leftCursor) - 28;

  // --- SEPARATOR -------------------------------------------------------------

  drawRule(cursor, COLOR_ACCENT, 1.5);
  cursor -= 18;

  // --- LINE-ITEMS TABLE HEADER (no prices) ------------------------------------

  const COL_ITEM = MARGIN_L;
  const COL_DESC = MARGIN_L + CONTENT_W * 0.28;
  const COL_QTY = MARGIN_R; // right-aligned

  const HEADER_SIZE = 8;

  page.drawText('ITEM', {
    x: COL_ITEM,
    y: cursor,
    font: bold,
    size: HEADER_SIZE,
    color: COLOR_GRAY,
  });
  page.drawText('DESCRIPTION', {
    x: COL_DESC,
    y: cursor,
    font: bold,
    size: HEADER_SIZE,
    color: COLOR_GRAY,
  });
  const qtyLabel = 'QTY SHIPPED';
  const qtyLabelW = bold.widthOfTextAtSize(qtyLabel, HEADER_SIZE);
  page.drawText(qtyLabel, {
    x: COL_QTY - qtyLabelW,
    y: cursor,
    font: bold,
    size: HEADER_SIZE,
    color: COLOR_GRAY,
  });

  cursor -= 6;
  drawRule(cursor);
  cursor -= 14;

  // --- LINE ITEMS --------------------------------------------------------------

  const ROW_H = 16;
  const LINE_SIZE = 10;
  let totalUnits = 0;

  for (const line of data.lines) {
    if (cursor < 130) {
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

    const itemStr = trunc(String(line.itemName ?? ''), 24);
    const desc = trunc(String(line.description || '—'), 48);
    const qtyStr = fmtQty(line.quantity);
    const qtyNum = parseFloat(String(line.quantity));
    if (!isNaN(qtyNum)) totalUnits += qtyNum;

    if (itemStr) {
      page.drawText(itemStr, {
        x: COL_ITEM,
        y: cursor,
        font: regular,
        size: LINE_SIZE,
        color: COLOR_BLACK,
      });
    }

    page.drawText(desc, {
      x: COL_DESC,
      y: cursor,
      font: regular,
      size: LINE_SIZE,
      color: COLOR_BLACK,
    });

    const qtyW = regular.widthOfTextAtSize(qtyStr, LINE_SIZE);
    page.drawText(qtyStr, {
      x: COL_QTY - qtyW,
      y: cursor,
      font: regular,
      size: LINE_SIZE,
      color: COLOR_BLACK,
    });

    cursor -= ROW_H;
    drawRule(cursor + 2);
    cursor -= 4;
  }

  cursor -= 10;

  // --- TOTAL UNITS ---------------------------------------------------------------

  const totLabel = 'Total units';
  page.drawText(totLabel, {
    x: MARGIN_L + CONTENT_W * 0.62,
    y: cursor,
    font: bold,
    size: 11,
    color: COLOR_NAVY,
  });
  const totStr = fmtQty(totalUnits);
  const totW = bold.widthOfTextAtSize(totStr, 11);
  page.drawText(totStr, {
    x: COL_QTY - totW,
    y: cursor,
    font: bold,
    size: 11,
    color: COLOR_NAVY,
  });

  // --- FOOTER ----------------------------------------------------------------------

  const FOOTER_Y = 36;
  drawRule(FOOTER_Y + 10, COLOR_LIGHT, 0.5);

  const footerText = `${data.company.name}  —  Packing slip (no prices). Please verify contents on receipt.`;
  const ftW = regular.widthOfTextAtSize(footerText, 8);
  page.drawText(footerText, {
    x: (PAGE_W - ftW) / 2,
    y: FOOTER_Y,
    font: regular,
    size: 8,
    color: COLOR_GRAY,
  });

  return pdfDoc.save();
}
