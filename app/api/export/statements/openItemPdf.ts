/**
 * PDF renderer for OPEN-ITEM customer statements (QB "Open Item" format).
 *
 * Lives next to the export routes (not lib/pdf — owned by another package).
 * Mirrors lib/pdf/statement.ts styling: pdf-lib + standard Helvetica, US
 * Letter portrait, purple statement accent. Adds the QB aging summary footer
 * (Current / 1-30 / 31-60 / 61-90 / 90+).
 */
import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import type { OpenItemStatement } from '@/lib/services/statements';
import { stampSandbox } from '@/lib/pdf/sandboxStamp';

function fmt(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

const PAGE_W = PageSizes.Letter[0];
const PAGE_H = PageSizes.Letter[1];
const MARGIN_L = 48;
const MARGIN_R = PAGE_W - 48;
const CONTENT_W = MARGIN_R - MARGIN_L;

const COLOR_NAVY = rgb(0.09, 0.13, 0.27);
const COLOR_LIGHT = rgb(0.9, 0.92, 0.95);
const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_GRAY = rgb(0.45, 0.45, 0.5);
const COLOR_PURPLE = rgb(0.45, 0.15, 0.75);
const COLOR_RED = rgb(0.75, 0.15, 0.15);

export async function renderOpenItemStatementPdf(
  data: OpenItemStatement,
  companyName: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  let cursor = PAGE_H - 48;

  function drawRule(y: number, color = COLOR_LIGHT, thickness = 0.75) {
    page.drawLine({ start: { x: MARGIN_L, y }, end: { x: MARGIN_R, y }, thickness, color });
  }
  function drawRight(text: string, x: number, y: number, font = regular, size = 9, color = COLOR_BLACK) {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: x - w, y, font, size, color });
  }

  // ---- Header ----
  page.drawText(trunc(companyName, 40), { x: MARGIN_L, y: cursor, font: bold, size: 22, color: COLOR_NAVY });
  drawRight('STATEMENT (OPEN ITEM)', MARGIN_R, cursor, bold, 16, COLOR_PURPLE);
  cursor -= 22;
  drawRight(`As of ${fmtDate(data.asOf)}`, MARGIN_R, cursor, regular, 10, COLOR_GRAY);
  cursor -= 14;

  // ---- Customer block ----
  page.drawText('STATEMENT FOR', { x: MARGIN_L, y: cursor, font: bold, size: 8, color: COLOR_GRAY });
  cursor -= 14;
  page.drawText(trunc(data.customer.displayName, 45), { x: MARGIN_L, y: cursor, font: bold, size: 12, color: COLOR_NAVY });
  cursor -= 13;
  if (data.customer.companyName) {
    page.drawText(trunc(data.customer.companyName, 50), { x: MARGIN_L, y: cursor, font: regular, size: 10, color: COLOR_GRAY });
    cursor -= 13;
  }
  if (data.customer.email) {
    page.drawText(trunc(data.customer.email, 50), { x: MARGIN_L, y: cursor, font: regular, size: 9, color: COLOR_GRAY });
    cursor -= 13;
  }
  cursor -= 8;
  drawRule(cursor, COLOR_PURPLE, 1.5);
  cursor -= 18;

  // ---- Table header ----
  const COL_DATE = MARGIN_L;
  const COL_NUM = MARGIN_L + CONTENT_W * 0.16;
  const COL_DUE = MARGIN_L + CONTENT_W * 0.3;
  const COL_TOTAL = MARGIN_L + CONTENT_W * 0.58;
  const COL_DAYS = MARGIN_L + CONTENT_W * 0.74;
  const COL_BAL = MARGIN_R;
  const TH = 8;

  page.drawText('DATE', { x: COL_DATE, y: cursor, font: bold, size: TH, color: COLOR_GRAY });
  page.drawText('INVOICE #', { x: COL_NUM, y: cursor, font: bold, size: TH, color: COLOR_GRAY });
  page.drawText('DUE DATE', { x: COL_DUE, y: cursor, font: bold, size: TH, color: COLOR_GRAY });
  drawRight('AMOUNT', COL_TOTAL, cursor, bold, TH, COLOR_GRAY);
  drawRight('DAYS PAST DUE', COL_DAYS, cursor, bold, TH, COLOR_GRAY);
  drawRight('OPEN BALANCE', COL_BAL, cursor, bold, TH, COLOR_GRAY);
  cursor -= 6;
  drawRule(cursor);
  cursor -= 14;

  const ROW_H = 15;

  // ---- Rows ----
  if (data.lines.length === 0) {
    page.drawText('No open invoices — account is current.', {
      x: MARGIN_L, y: cursor, font: regular, size: 10, color: COLOR_GRAY,
    });
    cursor -= ROW_H;
  } else {
    let idx = 0;
    for (const line of data.lines) {
      if (cursor < 170) {
        page.drawText('(continued on next page)', { x: MARGIN_L, y: cursor, font: regular, size: 8, color: COLOR_GRAY });
        cursor -= ROW_H;
        break;
      }
      if (idx % 2 === 0) {
        page.drawRectangle({
          x: MARGIN_L - 4, y: cursor - 3, width: CONTENT_W + 8, height: ROW_H + 1,
          color: rgb(0.96, 0.96, 0.99),
        });
      }
      page.drawText(fmtDate(line.date), { x: COL_DATE, y: cursor, font: regular, size: 9, color: COLOR_BLACK });
      page.drawText(shortDocLabel(line), { x: COL_NUM, y: cursor, font: regular, size: 9, color: COLOR_BLACK });
      page.drawText(fmtDate(line.dueDate), { x: COL_DUE, y: cursor, font: regular, size: 9, color: COLOR_GRAY });
      drawRight(fmt(line.total), COL_TOTAL, cursor, regular, 9, COLOR_BLACK);
      drawRight(
        line.daysPastDue > 0 ? String(line.daysPastDue) : '—',
        COL_DAYS, cursor, regular, 9, line.daysPastDue > 0 ? COLOR_RED : COLOR_GRAY,
      );
      drawRight(fmt(line.balanceDue), COL_BAL, cursor, bold, 9, COLOR_NAVY);
      cursor -= ROW_H;
      drawRule(cursor + 2, COLOR_LIGHT, 0.4);
      cursor -= 3;
      idx++;
    }
  }

  // ---- Total due ----
  cursor -= 4;
  page.drawLine({ start: { x: MARGIN_L, y: cursor }, end: { x: MARGIN_R, y: cursor }, thickness: 1.5, color: COLOR_NAVY });
  cursor -= 16;
  page.drawRectangle({ x: MARGIN_L - 4, y: cursor - 4, width: CONTENT_W + 8, height: 22, color: rgb(0.93, 0.88, 1.0) });
  page.drawText('TOTAL DUE', { x: COL_DATE, y: cursor + 2, font: bold, size: 10, color: COLOR_PURPLE });
  drawRight(fmt(data.totalDue), COL_BAL, cursor + 2, bold, 12, COLOR_PURPLE);
  cursor -= 34;

  // ---- Aging summary footer (QB statement aging boxes) ----
  const buckets: Array<[string, string]> = [
    ['CURRENT', data.aging.current],
    ['1-30 DAYS', data.aging.days1_30],
    ['31-60 DAYS', data.aging.days31_60],
    ['61-90 DAYS', data.aging.days61_90],
    ['OVER 90 DAYS', data.aging.days90Plus],
  ];
  const boxW = CONTENT_W / buckets.length;
  const boxH = 30;
  buckets.forEach(([label, amount], i) => {
    const x = MARGIN_L + i * boxW;
    page.drawRectangle({
      x, y: cursor - boxH, width: boxW, height: boxH,
      borderColor: COLOR_LIGHT, borderWidth: 0.75,
    });
    const lw = bold.widthOfTextAtSize(label, 6.5);
    page.drawText(label, { x: x + (boxW - lw) / 2, y: cursor - 10, font: bold, size: 6.5, color: COLOR_GRAY });
    const amt = fmt(amount);
    const aw = bold.widthOfTextAtSize(amt, 9);
    page.drawText(amt, {
      x: x + (boxW - aw) / 2, y: cursor - 23, font: bold, size: 9,
      color: i === 0 ? COLOR_NAVY : COLOR_RED,
    });
  });

  // ---- Footer ----
  const FOOTER_Y = 36;
  drawRule(FOOTER_Y + 10, COLOR_LIGHT, 0.5);
  const footerText = `${companyName}  —  Questions? Contact us regarding this statement.`;
  const ftW = regular.widthOfTextAtSize(footerText, 8);
  page.drawText(footerText, {
    x: Math.max(MARGIN_L, (PAGE_W - ftW) / 2), y: FOOTER_Y, font: regular, size: 8, color: COLOR_GRAY,
  });

  await stampSandbox(pdfDoc); // printed from a sandbox copy: stamped SANDBOX
  return pdfDoc.save();
}

/** Short document column text: invoice number, "CM <no.>", "Pmt <ref>", "GJ #<no.>". */
function shortDocLabel(line: { type?: string; refNumber?: string; invoiceNumber: number }): string {
  const ref = line.refNumber || String(line.invoiceNumber || '');
  const text =
    line.type === 'credit_memo' ? `CM ${ref}` :
    line.type === 'payment' ? `Pmt ${ref}`.trim() :
    line.type === 'general_journal' ? ref :
    `#${ref}`;
  return text.slice(0, 15);
}
