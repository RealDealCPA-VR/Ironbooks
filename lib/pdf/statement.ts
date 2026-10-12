/**
 * PDF renderer for customer account statements.
 *
 * Mirrors the invoice.ts layout/quality using pdf-lib with standard Helvetica
 * fonts (embedded in every PDF viewer — no external font files required).
 *
 * Layout (US Letter, portrait):
 *   - Company name header (top-left), "STATEMENT" label (top-right)
 *   - Date range beneath the label
 *   - Customer information block
 *   - Horizontal rule separator
 *   - Transactions table (date | type | reference | charges | credits | balance)
 *   - Opening balance row (if date-ranged)
 *   - Closing balance footer row
 *   - Light footer rule at bottom
 */

import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import type { CustomerStatement } from '@/lib/services/statements';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// US Letter: 612 x 792 pt
const PAGE_W = PageSizes.Letter[0];
const PAGE_H = PageSizes.Letter[1];

const MARGIN_L = 48;
const MARGIN_R = PAGE_W - 48;
const CONTENT_W = MARGIN_R - MARGIN_L;

const COLOR_NAVY    = rgb(0.09, 0.13, 0.27);
const COLOR_LIGHT   = rgb(0.90, 0.92, 0.95);
const COLOR_BLACK   = rgb(0, 0, 0);
const COLOR_GRAY    = rgb(0.45, 0.45, 0.50);
// Purple accent to distinguish statement from invoice/estimate/PO
const COLOR_PURPLE  = rgb(0.45, 0.15, 0.75);
const COLOR_GREEN   = rgb(0.07, 0.53, 0.25);

// ---------------------------------------------------------------------------
// renderStatementPdf
// ---------------------------------------------------------------------------

export async function renderStatementPdf(
  data: CustomerStatement,
  companyName: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  let cursor = PAGE_H - 48;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function drawRule(y: number, color = COLOR_LIGHT, thickness = 0.75) {
    page.drawLine({
      start: { x: MARGIN_L, y },
      end:   { x: MARGIN_R, y },
      thickness,
      color,
    });
  }

  // -------------------------------------------------------------------------
  // HEADER — company name (left) + STATEMENT label (right)
  // -------------------------------------------------------------------------

  page.drawText(trunc(companyName, 40), {
    x: MARGIN_L,
    y: cursor,
    font: bold,
    size: 22,
    color: COLOR_NAVY,
  });

  const stmtLabel  = 'STATEMENT';
  const stmtLabelW = bold.widthOfTextAtSize(stmtLabel, 18);
  page.drawText(stmtLabel, {
    x: MARGIN_R - stmtLabelW,
    y: cursor,
    font: bold,
    size: 18,
    color: COLOR_PURPLE,
  });

  cursor -= 22;

  // Date range beneath the label
  const today = new Date().toISOString().slice(0, 10);
  const rangeStr =
    data.from && data.to
      ? `${fmtDate(data.from)} – ${fmtDate(data.to)}`
      : data.from
        ? `From ${fmtDate(data.from)}`
        : data.to
          ? `Through ${fmtDate(data.to)}`
          : `As of ${fmtDate(today)}`;

  const rangeLabelW = regular.widthOfTextAtSize(rangeStr, 10);
  page.drawText(rangeStr, {
    x: MARGIN_R - rangeLabelW,
    y: cursor,
    font: regular,
    size: 10,
    color: COLOR_GRAY,
  });

  cursor -= 14;

  const printedStr  = `Printed: ${fmtDate(today)}`;
  const printedLabelW = regular.widthOfTextAtSize(printedStr, 10);
  page.drawText(printedStr, {
    x: MARGIN_R - printedLabelW,
    y: cursor,
    font: regular,
    size: 10,
    color: COLOR_GRAY,
  });

  cursor -= 14;

  // -------------------------------------------------------------------------
  // CUSTOMER block (left side)
  // -------------------------------------------------------------------------

  const custY = PAGE_H - 48 - 22 - 16;

  page.drawText('STATEMENT FOR', {
    x: MARGIN_L,
    y: custY,
    font: bold,
    size: 8,
    color: COLOR_GRAY,
  });

  page.drawText(trunc(data.customer.displayName, 45), {
    x: MARGIN_L,
    y: custY - 14,
    font: bold,
    size: 12,
    color: COLOR_NAVY,
  });

  let custSubY = custY - 14 - 13;

  if (data.customer.companyName) {
    page.drawText(trunc(data.customer.companyName, 50), {
      x: MARGIN_L,
      y: custSubY,
      font: regular,
      size: 10,
      color: COLOR_GRAY,
    });
    custSubY -= 13;
  }

  if (data.customer.email) {
    page.drawText(trunc(data.customer.email, 50), {
      x: MARGIN_L,
      y: custSubY,
      font: regular,
      size: 9,
      color: COLOR_GRAY,
    });
  }

  cursor = Math.min(cursor, custSubY) - 20;

  // -------------------------------------------------------------------------
  // SEPARATOR
  // -------------------------------------------------------------------------

  drawRule(cursor, COLOR_PURPLE, 1.5);
  cursor -= 18;

  // -------------------------------------------------------------------------
  // TABLE HEADER — date | type | reference | charges | credits | balance
  // -------------------------------------------------------------------------

  const COL_DATE = MARGIN_L;
  const COL_TYPE = MARGIN_L + CONTENT_W * 0.15;
  const COL_REF  = MARGIN_L + CONTENT_W * 0.28;
  const COL_CHGS = MARGIN_L + CONTENT_W * 0.55;
  const COL_CRDT = MARGIN_L + CONTENT_W * 0.73;
  const COL_BAL  = MARGIN_R;

  const TH_SIZE = 8;

  page.drawText('DATE', {
    x: COL_DATE,
    y: cursor,
    font: bold,
    size: TH_SIZE,
    color: COLOR_GRAY,
  });

  page.drawText('TYPE', {
    x: COL_TYPE,
    y: cursor,
    font: bold,
    size: TH_SIZE,
    color: COLOR_GRAY,
  });

  page.drawText('REFERENCE', {
    x: COL_REF,
    y: cursor,
    font: bold,
    size: TH_SIZE,
    color: COLOR_GRAY,
  });

  const chargesLabel  = 'CHARGES';
  const chargesLabelW = bold.widthOfTextAtSize(chargesLabel, TH_SIZE);
  page.drawText(chargesLabel, {
    x: COL_CHGS - chargesLabelW,
    y: cursor,
    font: bold,
    size: TH_SIZE,
    color: COLOR_GRAY,
  });

  const creditsLabel  = 'CREDITS';
  const creditsLabelW = bold.widthOfTextAtSize(creditsLabel, TH_SIZE);
  page.drawText(creditsLabel, {
    x: COL_CRDT - creditsLabelW,
    y: cursor,
    font: bold,
    size: TH_SIZE,
    color: COLOR_GRAY,
  });

  const balLabel  = 'BALANCE';
  const balLabelW = bold.widthOfTextAtSize(balLabel, TH_SIZE);
  page.drawText(balLabel, {
    x: COL_BAL - balLabelW,
    y: cursor,
    font: bold,
    size: TH_SIZE,
    color: COLOR_GRAY,
  });

  cursor -= 6;
  drawRule(cursor);
  cursor -= 14;

  // -------------------------------------------------------------------------
  // OPENING BALANCE ROW (when date-ranged)
  // -------------------------------------------------------------------------

  const ROW_H     = 15;
  const LINE_SIZE = 9;

  function drawTableRow(
    date: string,
    type: string,
    ref: string,
    chargesStr: string,
    creditsStr: string,
    balStr: string,
    opts: { isHeader?: boolean; altShade?: boolean } = {},
  ) {
    if (opts.altShade) {
      page.drawRectangle({
        x: MARGIN_L - 4,
        y: cursor - 3,
        width: CONTENT_W + 8,
        height: ROW_H + 1,
        color: rgb(0.96, 0.96, 0.99),
      });
    }

    const f = opts.isHeader ? bold : regular;

    page.drawText(trunc(date, 15), {
      x: COL_DATE,
      y: cursor,
      font: f,
      size: LINE_SIZE,
      color: COLOR_BLACK,
    });

    page.drawText(trunc(type, 12), {
      x: COL_TYPE,
      y: cursor,
      font: f,
      size: LINE_SIZE,
      color: COLOR_GRAY,
    });

    page.drawText(trunc(ref, 18), {
      x: COL_REF,
      y: cursor,
      font: f,
      size: LINE_SIZE,
      color: COLOR_BLACK,
    });

    if (chargesStr) {
      const cW = f.widthOfTextAtSize(chargesStr, LINE_SIZE);
      page.drawText(chargesStr, {
        x: COL_CHGS - cW,
        y: cursor,
        font: f,
        size: LINE_SIZE,
        color: COLOR_BLACK,
      });
    }

    if (creditsStr) {
      const crW = f.widthOfTextAtSize(creditsStr, LINE_SIZE);
      page.drawText(creditsStr, {
        x: COL_CRDT - crW,
        y: cursor,
        font: f,
        size: LINE_SIZE,
        color: COLOR_GREEN,
      });
    }

    const bW = f.widthOfTextAtSize(balStr, LINE_SIZE);
    page.drawText(balStr, {
      x: COL_BAL - bW,
      y: cursor,
      font: f,
      size: LINE_SIZE,
      color: COLOR_NAVY,
    });

    cursor -= ROW_H;
    drawRule(cursor + 2, COLOR_LIGHT, 0.4);
    cursor -= 3;
  }

  if (data.from) {
    drawTableRow(
      fmtDate(data.from),
      'Opening Bal.',
      '',
      '',
      '',
      fmt(data.openingBalance),
      { altShade: true },
    );
  }

  // -------------------------------------------------------------------------
  // TRANSACTION ROWS
  // -------------------------------------------------------------------------

  if (data.lines.length === 0) {
    page.drawText('No activity in this period.', {
      x: MARGIN_L,
      y: cursor - 10,
      font: regular,
      size: 10,
      color: COLOR_GRAY,
    });
    cursor -= 30;
  } else {
    let rowIdx = 0;
    for (const line of data.lines) {
      if (cursor < 120) {
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

      // Charges increase the balance; payments, discounts and credit memos reduce it.
      // General Journal amounts are signed: + is a charge, − a credit.
      const isJournal = line.type === 'general_journal';
      const isCharge =
        line.type === 'invoice' || line.type === 'statement_charge' || line.type === 'bounced_check' ||
        (isJournal && !line.amount.startsWith('-'));
      const absAmount = line.amount.replace(/^-/, '');
      const refStr    = line.type === 'invoice' && line.ref ? `Inv #${line.ref}` : (line.ref ?? '—');
      const typeLabel: Record<string, string> = {
        invoice: 'Invoice',
        statement_charge: 'Statement Charge',
        bounced_check: 'Returned Check',
        credit_memo: 'Credit Memo',
        discount: 'Discount',
        payment: 'Payment',
        general_journal: 'General Journal',
      };

      drawTableRow(
        fmtDate(line.date),
        typeLabel[line.type] ?? 'Payment',
        refStr,
        isCharge ? fmt(absAmount) : '',
        isCharge ? '' : fmt(absAmount),
        fmt(line.runningBalance),
        { altShade: rowIdx % 2 === 0 },
      );

      rowIdx++;
    }
  }

  // -------------------------------------------------------------------------
  // CLOSING BALANCE — highlighted footer row
  // -------------------------------------------------------------------------

  cursor -= 4;

  page.drawLine({
    start: { x: MARGIN_L, y: cursor },
    end:   { x: MARGIN_R, y: cursor },
    thickness: 1.5,
    color: COLOR_NAVY,
  });
  cursor -= 16;

  // Background rectangle
  page.drawRectangle({
    x: MARGIN_L - 4,
    y: cursor - 4,
    width: CONTENT_W + 8,
    height: 22,
    color: rgb(0.93, 0.88, 1.0),
  });

  page.drawText('CLOSING BALANCE', {
    x: COL_DATE,
    y: cursor + 2,
    font: bold,
    size: 10,
    color: COLOR_PURPLE,
  });

  const closingStr = fmt(data.closingBalance);
  const closingW   = bold.widthOfTextAtSize(closingStr, 12);
  page.drawText(closingStr, {
    x: COL_BAL - closingW,
    y: cursor + 2,
    font: bold,
    size: 12,
    color: COLOR_PURPLE,
  });

  cursor -= 30;

  // -------------------------------------------------------------------------
  // FOOTER
  // -------------------------------------------------------------------------

  const FOOTER_Y = 36;
  drawRule(FOOTER_Y + 10, COLOR_LIGHT, 0.5);

  const footerText = `${companyName}  —  Questions? Contact us regarding this statement.`;
  const ftW = regular.widthOfTextAtSize(footerText, 8);
  page.drawText(footerText, {
    x: Math.max(MARGIN_L, (PAGE_W - ftW) / 2),
    y: FOOTER_Y,
    font: regular,
    size: 8,
    color: COLOR_GRAY,
  });

  // -------------------------------------------------------------------------
  // Finalize
  // -------------------------------------------------------------------------

  return pdfDoc.save();
}
