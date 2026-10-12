/**
 * PDF renderers for the Sales Order Fulfillment Worksheet:
 *   - renderPickListPdf: one warehouse pick list for a batch — items aggregated across the
 *     selected orders (what to pull from the shelf), with the per-order breakdown underneath
 *     each item and a check box to tick. Paginates.
 *   - renderPackingSlipsPdf: one packing slip page per sales order (quantities to ship, no
 *     prices), built from lib/pdf/packingSlip.ts and merged into one document for printing.
 *
 * pdf-lib with standard Helvetica fonts, US Letter portrait — same look as packingSlip.ts.
 */
import { PDFDocument, StandardFonts, rgb, PageSizes, type PDFFont, type PDFPage } from 'pdf-lib';
import { renderPackingSlipPdf, type PackingSlipData } from './packingSlip';

export interface PickListOrderRef {
  orderNumber: number | string;
  customerName: string;
  quantity: string | number;
}

export interface PickListRow {
  itemName: string;
  sku?: string | null;
  description?: string | null;
  totalQuantity: string | number;
  orders: PickListOrderRef[];
}

export interface PickListData {
  company: { name: string };
  /** Printed date (YYYY-MM-DD or human readable). */
  date: string;
  rows: PickListRow[];
}

const PAGE_W = PageSizes.Letter[0];
const PAGE_H = PageSizes.Letter[1];
const MARGIN_L = 48;
const MARGIN_R = PAGE_W - 48;
const BOTTOM = 60;

const COLOR_NAVY = rgb(0.09, 0.13, 0.27);
const COLOR_ACCENT = rgb(0.2, 0.47, 0.96);
const COLOR_LIGHT = rgb(0.9, 0.92, 0.95);
const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_GRAY = rgb(0.45, 0.45, 0.5);

function fmtQty(value: string | number): string {
  let n = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(n)) return String(value);
  n = Math.round(n * 10000) / 10000;
  return String(n);
}

/** Standard fonts only cover WinAnsi; replace anything else so drawText never throws. */
function safe(s: string): string {
  return s.replace(/[^\x20-\x7E -ÿ–—…]/g, '?');
}

function trunc(s: string, max: number): string {
  const t = safe(s);
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

export async function renderPickListPdf(data: PickListData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  let pageNo = 1;
  let y = 0;

  const text = (s: string, x: number, yy: number, font: PDFFont, size: number, color = COLOR_BLACK) =>
    page.drawText(s, { x, y: yy, font, size, color });
  const right = (s: string, xr: number, yy: number, font: PDFFont, size: number, color = COLOR_BLACK) =>
    text(s, xr - font.widthOfTextAtSize(s, size), yy, font, size, color);
  const rule = (yy: number, color = COLOR_LIGHT, thickness = 0.75) =>
    page.drawLine({ start: { x: MARGIN_L, y: yy }, end: { x: MARGIN_R, y: yy }, thickness, color });

  const header = () => {
    y = PAGE_H - 48;
    text(trunc(data.company.name, 40), MARGIN_L, y, bold, 20, COLOR_NAVY);
    right('PICK LIST', MARGIN_R, y, bold, 18, COLOR_ACCENT);
    y -= 20;
    right(`Date: ${safe(data.date)}   Page ${pageNo}`, MARGIN_R, y, regular, 10, COLOR_GRAY);
    y -= 22;
    rule(y, COLOR_ACCENT, 1.5);
    y -= 16;
    text('PICKED', MARGIN_L, y, bold, 8, COLOR_GRAY);
    text('ITEM', MARGIN_L + 50, y, bold, 8, COLOR_GRAY);
    text('DESCRIPTION', MARGIN_L + 230, y, bold, 8, COLOR_GRAY);
    right('QTY TO PICK', MARGIN_R, y, bold, 8, COLOR_GRAY);
    y -= 8;
    rule(y);
    y -= 16;
  };
  const ensure = (needed: number) => {
    if (y - needed < BOTTOM) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      pageNo += 1;
      header();
    }
  };

  header();
  let totalUnits = 0;
  for (const row of data.rows) {
    ensure(18 + 13 * Math.min(row.orders.length, 1));
    page.drawRectangle({ x: MARGIN_L + 8, y: y - 2, width: 10, height: 10, borderColor: COLOR_NAVY, borderWidth: 0.8 });
    const name = row.sku ? `${row.itemName} (${row.sku})` : row.itemName;
    text(trunc(name, 32), MARGIN_L + 50, y, bold, 10, COLOR_NAVY);
    text(trunc(row.description ?? '', 40), MARGIN_L + 230, y, regular, 9);
    right(fmtQty(row.totalQuantity), MARGIN_R, y, bold, 11, COLOR_NAVY);
    const n = parseFloat(String(row.totalQuantity));
    if (!isNaN(n)) totalUnits += n;
    y -= 14;
    for (const o of row.orders) {
      ensure(13);
      text(trunc(`SO #${o.orderNumber} — ${o.customerName}`, 70), MARGIN_L + 62, y, regular, 8.5, COLOR_GRAY);
      right(fmtQty(o.quantity), MARGIN_R - 40, y, regular, 8.5, COLOR_GRAY);
      y -= 12;
    }
    y -= 2;
    rule(y + 4);
    y -= 8;
  }

  ensure(30);
  y -= 6;
  text('Total units to pick', MARGIN_L + 300, y, bold, 11, COLOR_NAVY);
  right(fmtQty(Math.round(totalUnits * 10000) / 10000), MARGIN_R, y, bold, 11, COLOR_NAVY);
  y -= 30;
  ensure(20);
  text('Picked by: ____________________     Checked by: ____________________', MARGIN_L, y, regular, 9, COLOR_GRAY);

  return pdf.save();
}

/** Merge one packing slip per order into a single printable PDF. */
export async function renderPackingSlipsPdf(slips: PackingSlipData[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const slip of slips) {
    const bytes = await renderPackingSlipPdf(slip);
    const doc = await PDFDocument.load(bytes);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  if (out.getPageCount() === 0) out.addPage([PAGE_W, PAGE_H]);
  return out.save();
}
