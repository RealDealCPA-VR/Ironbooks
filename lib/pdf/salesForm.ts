/**
 * Shared PDF layout for A/R sales forms (wave2 sales, C8): sales receipts, credit memos/refunds
 * and sales orders all print through `renderSalesFormPdf`, which mirrors the invoice layout
 * (lib/pdf/invoice.ts): company header, form title + number, dates, Bill To / Ship To blocks,
 * an optional shipping band (B6), the line-items table, a totals block and a footer note.
 *
 * pdf-lib with the standard Helvetica fonts (no external font files). Multi-page: the table
 * continues on a new page when it runs out of room.
 */
import { PDFDocument, PageSizes, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface SalesShippingInfo {
  shipDate?: string | null;
  shipVia?: string | null;
  fob?: string | null;
  trackingNumber?: string | null;
  poNumber?: string | null;
  /** Ship-to address lines (line1, line2, city, state, zip, country, …). */
  shipTo?: Record<string, string> | null;
}

export interface SalesFormPdfLine {
  description: string;
  quantity: string | number;
  rate: string | number;
  amount: string | number;
}

export interface SalesFormPdfData {
  company: { name: string };
  /** Upper-case form title, e.g. 'SALES RECEIPT'. */
  title: string;
  number: string | number;
  date: string;
  /** Extra header rows under the date (label, value). */
  headerRows?: Array<[string, string]>;
  billToLabel?: string;
  customerName: string;
  shipping?: SalesShippingInfo | null;
  lines: SalesFormPdfLine[];
  /** Totals block rows; the LAST row is drawn emphasised. */
  totals: Array<[string, string | number]>;
  /** Optional note printed under the totals (e.g. payment method, memo). */
  note?: string | null;
}

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

export function fmtMoney(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(isNaN(n) ? 0 : n);
}

function fmtQty(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(n)) return String(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

export function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** pdf-lib's standard fonts are WinAnsi only — replace anything they cannot encode. */
export function safeText(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF…]/g, '?');
}

/** Human-readable ship-to address lines (ordered, blanks dropped). */
export function shipToLines(shipTo: Record<string, string> | null | undefined): string[] {
  if (!shipTo) return [];
  const order = ['name', 'line1', 'line2', 'street', 'city', 'state', 'zip', 'postalCode', 'country'];
  const keys = [...order.filter((k) => k in shipTo), ...Object.keys(shipTo).filter((k) => !order.includes(k))];
  const cityLine = [shipTo.city, shipTo.state, shipTo.zip ?? shipTo.postalCode].filter(Boolean).join(' ');
  const out: string[] = [];
  for (const k of keys) {
    if (['city', 'state', 'zip', 'postalCode'].includes(k)) continue;
    const v = (shipTo[k] ?? '').trim();
    if (v) out.push(v);
    if (k === 'line2' || (k === 'line1' && !shipTo.line2) || (k === 'street' && !shipTo.line2)) {
      if (cityLine && !out.includes(cityLine)) out.push(cityLine);
    }
  }
  if (cityLine && !out.includes(cityLine)) out.push(cityLine);
  return out;
}

/** The label/value pairs of the shipping band (empty when nothing to show). */
export function shippingSummary(ship: SalesShippingInfo | null | undefined): Array<[string, string]> {
  if (!ship) return [];
  const rows: Array<[string, string]> = [];
  if (ship.poNumber) rows.push(['P.O. NO.', ship.poNumber]);
  if (ship.shipDate) rows.push(['SHIP DATE', ship.shipDate]);
  if (ship.shipVia) rows.push(['SHIP VIA', ship.shipVia]);
  if (ship.fob) rows.push(['F.O.B.', ship.fob]);
  if (ship.trackingNumber) rows.push(['TRACKING #', ship.trackingNumber]);
  return rows;
}

/**
 * Draw the shipping band (ship-to block + P.O./ship date/via/FOB/tracking columns) starting at
 * `top`; returns the new cursor below it. Draws nothing (returns `top`) when there is no data.
 */
export function drawShippingBand(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  ship: SalesShippingInfo,
  top: number,
  left = MARGIN_L,
  right = MARGIN_R,
): number {
  const cols = shippingSummary(ship);
  const addr = shipToLines(ship.shipTo);
  if (cols.length === 0 && addr.length === 0) return top;
  let y = top;
  if (addr.length > 0) {
    page.drawText('SHIP TO', { x: left, y, font: fonts.bold, size: 8, color: COLOR_GRAY });
    y -= 12;
    for (const line of addr.slice(0, 5)) {
      page.drawText(trunc(safeText(line), 60), { x: left, y, font: fonts.regular, size: 10, color: COLOR_BLACK });
      y -= 12;
    }
    y -= 6;
  }
  if (cols.length > 0) {
    const w = (right - left) / cols.length;
    cols.forEach(([label, value], i) => {
      const x = left + i * w;
      page.drawText(label, { x, y, font: fonts.bold, size: 7, color: COLOR_GRAY });
      page.drawText(trunc(safeText(value), Math.max(8, Math.floor(w / 5.5))), {
        x,
        y: y - 11,
        font: fonts.regular,
        size: 9,
        color: COLOR_BLACK,
      });
    });
    y -= 26;
  }
  return y;
}

export async function renderSalesFormPdf(data: SalesFormPdfData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let cursor = PAGE_H - 48;

  const rule = (y: number, color = COLOR_LIGHT, thickness = 0.75) =>
    page.drawLine({ start: { x: MARGIN_L, y }, end: { x: MARGIN_R, y }, thickness, color });
  const right = (text: string, y: number, font: PDFFont, size: number, color = COLOR_BLACK, x = MARGIN_R) =>
    page.drawText(text, { x: x - font.widthOfTextAtSize(text, size), y, font, size, color });

  // Header
  page.drawText(trunc(safeText(data.company.name), 40), { x: MARGIN_L, y: cursor, font: bold, size: 22, color: COLOR_NAVY });
  right(safeText(data.title), cursor, bold, 18, COLOR_ACCENT);
  cursor -= 22;
  right(`#${safeText(String(data.number))}`, cursor, bold, 12, COLOR_NAVY);
  cursor -= 16;
  right(`Date: ${safeText(data.date)}`, cursor, regular, 10, COLOR_GRAY);
  cursor -= 14;
  for (const [label, value] of data.headerRows ?? []) {
    if (!value) continue;
    right(`${safeText(label)}: ${safeText(value)}`, cursor, regular, 10, COLOR_GRAY);
    cursor -= 14;
  }

  // Bill To
  const billToY = PAGE_H - 48 - 22 - 16;
  page.drawText(safeText(data.billToLabel ?? 'BILL TO'), { x: MARGIN_L, y: billToY, font: bold, size: 8, color: COLOR_GRAY });
  page.drawText(trunc(safeText(data.customerName), 45), { x: MARGIN_L, y: billToY - 14, font: bold, size: 12, color: COLOR_NAVY });
  cursor = Math.min(cursor, billToY - 14) - 28;

  if (data.shipping) {
    cursor = drawShippingBand(page, { regular, bold }, data.shipping, cursor + 10);
  }

  rule(cursor, COLOR_ACCENT, 1.5);
  cursor -= 18;

  const COL_QTY = MARGIN_L + CONTENT_W * 0.58;
  const COL_RATE = MARGIN_L + CONTENT_W * 0.72;
  const tableHeader = () => {
    page.drawText('DESCRIPTION', { x: MARGIN_L, y: cursor, font: bold, size: 8, color: COLOR_GRAY });
    right('QTY', cursor, bold, 8, COLOR_GRAY, COL_QTY + 12);
    right('RATE', cursor, bold, 8, COLOR_GRAY, COL_RATE + 30);
    right('AMOUNT', cursor, bold, 8, COLOR_GRAY);
    cursor -= 6;
    rule(cursor);
    cursor -= 14;
  };
  tableHeader();

  for (const line of data.lines) {
    if (cursor < 120) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      cursor = PAGE_H - 60;
      tableHeader();
    }
    page.drawText(trunc(safeText(line.description), 58), { x: MARGIN_L, y: cursor, font: regular, size: 10, color: COLOR_BLACK });
    right(fmtQty(line.quantity), cursor, regular, 10, COLOR_BLACK, COL_QTY + 12);
    right(fmtMoney(line.rate), cursor, regular, 10, COLOR_BLACK, COL_RATE + 30);
    right(fmtMoney(line.amount), cursor, regular, 10);
    cursor -= 16;
  }

  cursor -= 4;
  rule(cursor);
  cursor -= 18;
  if (cursor < 40 + data.totals.length * 16) {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    cursor = PAGE_H - 60;
  }
  data.totals.forEach(([label, value], i) => {
    const last = i === data.totals.length - 1;
    const font = last ? bold : regular;
    const size = last ? 12 : 10;
    right(safeText(label), cursor, font, size, last ? COLOR_NAVY : COLOR_GRAY, MARGIN_R - 110);
    right(typeof value === 'number' || /^-?\d/.test(String(value)) ? fmtMoney(value) : safeText(String(value)), cursor, font, size, last ? COLOR_NAVY : COLOR_BLACK);
    cursor -= last ? 20 : 15;
  });

  if (data.note) {
    cursor -= 6;
    page.drawText(trunc(safeText(data.note), 95), { x: MARGIN_L, y: Math.max(cursor, 40), font: regular, size: 9, color: COLOR_GRAY });
  }

  // Footer rule on every page.
  for (const p of pdfDoc.getPages()) {
    p.drawLine({ start: { x: MARGIN_L, y: 32 }, end: { x: MARGIN_R, y: 32 }, thickness: 0.5, color: COLOR_LIGHT });
  }
  return pdfDoc.save();
}
