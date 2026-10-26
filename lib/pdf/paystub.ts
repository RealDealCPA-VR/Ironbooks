/**
 * PDF renderer for employee pay stubs.
 *
 * Uses pdf-lib with standard Helvetica fonts (no external files needed).
 *
 * Layout (US Letter, portrait):
 *   - Company name header (top-left), "PAY STUB" label (top-right)
 *   - Pay period and pay date beneath the header
 *   - Employee name block
 *   - Horizontal rule separator
 *   - Earnings section (kind === 'earning' lines)
 *   - Taxes section (kind === 'tax' lines)
 *   - Deductions section (kind === 'deduction' lines)
 *   - Net pay highlighted box at the bottom
 *   - Footer rule
 */

import { PDFDocument, StandardFonts, rgb, PageSizes, degrees } from 'pdf-lib';
import { stampSandbox } from './sandboxStamp';
import { winAnsiText } from './payrollForms';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface PaystubLine {
  kind: 'earning' | 'tax' | 'deduction' | 'employer_contribution';
  name: string;
  amount: string | number;
  /** Calendar year-to-date total for this line. Renders a YTD column when present. */
  ytdAmount?: string | number | null;
}

export interface PaystubPdfData {
  company: { name: string };
  employee: { firstName: string; lastName: string };
  paycheck: {
    payDate: string;       // YYYY-MM-DD or human-readable
    periodStart?: string | null;
    periodEnd?: string | null;
    grossPay: string | number;
    netPay: string | number;
    /** Calendar year-to-date gross through this stub's pay date. */
    ytdGross?: string | number | null;
    /** Calendar year-to-date net through this stub's pay date. */
    ytdNet?: string | number | null;
  };
  lines: PaystubLine[];
  /**
   * Sick/vacation balances in hours. Optional and additive — a small balances
   * line is rendered beneath the net-pay box only when present.
   */
  accruals?: { sickBalance: string | number; vacationBalance: string | number } | null;
  /**
   * Taxable wages (federal income-tax wages and Social Security / Medicare wages), this check
   * and YTD. Optional; rendered as a small line beneath the net-pay box.
   */
  taxableWages?: {
    current: { federal: string | number; fica: string | number };
    ytd: { federal: string | number; fica: string | number };
  } | null;
  /** The paycheck was voided: the stub is stamped VOID. */
  isVoid?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a decimal string/number as USD currency. */
function fmt(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    isNaN(n) ? 0 : n,
  );
}

/** Truncate a string to max characters, adding ellipsis if needed. */
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

// Colors — matching the invoice/check palette
const COLOR_NAVY   = rgb(0.09, 0.13, 0.27);
const COLOR_ACCENT = rgb(0.20, 0.47, 0.96);
const COLOR_LIGHT  = rgb(0.90, 0.92, 0.95);
const COLOR_BLACK  = rgb(0, 0, 0);
const COLOR_GRAY   = rgb(0.45, 0.45, 0.50);
const COLOR_GREEN  = rgb(0.09, 0.55, 0.32);

// ---------------------------------------------------------------------------
// renderPaystubPdf
// ---------------------------------------------------------------------------

export async function renderPaystubPdf(data: PaystubPdfData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // Track cursor from the top (pdf-lib draws from bottom-left).
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

  function drawText(
    s: string,
    x: number,
    y: number,
    opts: { size?: number; font?: typeof regular; color?: typeof COLOR_BLACK; rightAlign?: boolean } = {},
  ) {
    const { size = 10, font = regular, color = COLOR_BLACK, rightAlign = false } = opts;
    // Standard fonts are WinAnsi only: "Nguyễn" / "株式会社" used to throw (HTTP 500).
    const safe = winAnsiText(s);
    const drawX = rightAlign ? x - font.widthOfTextAtSize(safe, size) : x;
    page.drawText(safe, { x: drawX, y, font, size, color });
  }

  // -------------------------------------------------------------------------
  // HEADER — company name (left) + "PAY STUB" label (right)
  // -------------------------------------------------------------------------

  drawText(trunc(data.company.name, 40), MARGIN_L, cursor, {
    font: bold,
    size: 20,
    color: COLOR_NAVY,
  });

  drawText('PAY STUB', MARGIN_R, cursor, {
    font: bold,
    size: 16,
    color: COLOR_ACCENT,
    rightAlign: true,
  });

  cursor -= 20;

  // Pay date beneath the label (right-aligned)
  const payDateStr = `Pay Date: ${data.paycheck.payDate}`;
  drawText(payDateStr, MARGIN_R, cursor, {
    size: 10,
    color: COLOR_GRAY,
    rightAlign: true,
  });

  cursor -= 14;

  // Pay period (right-aligned)
  if (data.paycheck.periodStart && data.paycheck.periodEnd) {
    const periodStr = `Period: ${data.paycheck.periodStart} – ${data.paycheck.periodEnd}`;
    drawText(periodStr, MARGIN_R, cursor, {
      size: 9,
      color: COLOR_GRAY,
      rightAlign: true,
    });
    cursor -= 14;
  }

  // Employee name (left side, beneath company name)
  const empY = PAGE_H - 48 - 20 - 14; // align with pay date row
  drawText('EMPLOYEE', MARGIN_L, empY, { size: 8, color: COLOR_GRAY });
  const empName = `${data.employee.firstName} ${data.employee.lastName}`;
  drawText(empName, MARGIN_L, empY - 14, { font: bold, size: 13, color: COLOR_NAVY });

  // Move cursor past the header block
  cursor = Math.min(cursor, empY - 14) - 24;

  // -------------------------------------------------------------------------
  // SEPARATOR
  // -------------------------------------------------------------------------

  drawRule(cursor, COLOR_ACCENT, 1.5);
  cursor -= 18;

  // -------------------------------------------------------------------------
  // Section rendering helper
  // -------------------------------------------------------------------------

  // When any YTD figure is present, the current amount column shifts left and a
  // YTD column is rendered at the right margin.
  const hasYtd =
    data.paycheck.ytdGross != null ||
    data.paycheck.ytdNet != null ||
    data.lines.some((l) => l.ytdAmount != null);

  const COL_NAME  = MARGIN_L;
  const COL_YTD   = MARGIN_R;
  const COL_AMT   = hasYtd ? MARGIN_R - 110 : MARGIN_R;
  const ROW_H     = 16;
  const SECTION_LABEL_SIZE = 8;
  const LINE_SIZE = 10;

  function drawSection(
    label: string,
    sectionLines: PaystubLine[],
  ) {
    if (sectionLines.length === 0) return;

    // Section header
    drawText(label, COL_NAME, cursor, {
      font: bold,
      size: SECTION_LABEL_SIZE,
      color: COLOR_GRAY,
    });

    if (hasYtd) {
      drawText('CURRENT', COL_AMT, cursor, {
        font: bold,
        size: SECTION_LABEL_SIZE,
        color: COLOR_GRAY,
        rightAlign: true,
      });
      drawText('YTD', COL_YTD, cursor, {
        font: bold,
        size: SECTION_LABEL_SIZE,
        color: COLOR_GRAY,
        rightAlign: true,
      });
    }

    cursor -= 4;
    drawRule(cursor, COLOR_LIGHT, 0.5);
    cursor -= 12;

    // Lines
    for (const line of sectionLines) {
      drawText(trunc(line.name, hasYtd ? 48 : 60), COL_NAME, cursor, {
        size: LINE_SIZE,
        color: COLOR_BLACK,
      });
      drawText(fmt(line.amount), COL_AMT, cursor, {
        size: LINE_SIZE,
        color: COLOR_BLACK,
        rightAlign: true,
      });
      if (hasYtd && line.ytdAmount != null) {
        drawText(fmt(line.ytdAmount), COL_YTD, cursor, {
          size: LINE_SIZE,
          color: COLOR_GRAY,
          rightAlign: true,
        });
      }
      cursor -= ROW_H;
    }

    cursor -= 8;
  }

  // -------------------------------------------------------------------------
  // EARNINGS
  // -------------------------------------------------------------------------

  const earningLines = data.lines.filter((l) => l.kind === 'earning');
  drawSection('EARNINGS', earningLines);

  // -------------------------------------------------------------------------
  // TAXES
  // -------------------------------------------------------------------------

  const taxLines = data.lines.filter((l) => l.kind === 'tax');
  drawSection('TAXES WITHHELD', taxLines);

  // -------------------------------------------------------------------------
  // DEDUCTIONS
  // -------------------------------------------------------------------------

  const deductionLines = data.lines.filter((l) => l.kind === 'deduction');
  drawSection('DEDUCTIONS', deductionLines);

  // Employer contributions (informational, no effect on net)
  const contribLines = data.lines.filter((l) => l.kind === 'employer_contribution');
  drawSection('EMPLOYER CONTRIBUTIONS', contribLines);

  // -------------------------------------------------------------------------
  // GROSS PAY / NET PAY summary strip
  // -------------------------------------------------------------------------

  cursor -= 4;
  drawRule(cursor, COLOR_NAVY, 1);
  cursor -= 14;

  // Gross pay row
  drawText('Gross Pay', COL_NAME, cursor, { font: bold, size: 10, color: COLOR_NAVY });
  drawText(fmt(data.paycheck.grossPay), COL_AMT, cursor, {
    font: bold,
    size: 10,
    color: COLOR_NAVY,
    rightAlign: true,
  });
  if (hasYtd && data.paycheck.ytdGross != null) {
    drawText(fmt(data.paycheck.ytdGross), COL_YTD, cursor, {
      font: bold,
      size: 10,
      color: COLOR_GRAY,
      rightAlign: true,
    });
  }
  cursor -= ROW_H;

  // -------------------------------------------------------------------------
  // NET PAY highlighted box
  // -------------------------------------------------------------------------

  const NET_BOX_H = 30;
  cursor -= 6;

  page.drawRectangle({
    x: MARGIN_L,
    y: cursor - NET_BOX_H + 10,
    width: CONTENT_W,
    height: NET_BOX_H,
    color: rgb(0.09, 0.13, 0.27), // navy fill
  });

  const netLabel = 'NET PAY';
  drawText(netLabel, MARGIN_L + 12, cursor - 4, {
    font: bold,
    size: 12,
    color: rgb(1, 1, 1),
  });

  const netStr = fmt(data.paycheck.netPay);
  drawText(netStr, MARGIN_R - 12, cursor - 4, {
    font: bold,
    size: 14,
    color: rgb(0.76, 0.95, 0.80),
    rightAlign: true,
  });

  cursor -= NET_BOX_H + 16;

  // YTD net pay (beneath the box, right-aligned)
  if (hasYtd && data.paycheck.ytdNet != null) {
    drawText(`YTD Net Pay: ${fmt(data.paycheck.ytdNet)}`, MARGIN_R, cursor + 6, {
      font: bold,
      size: 9,
      color: COLOR_GRAY,
      rightAlign: true,
    });
    cursor -= 14;
  }

  // Sick/vacation balances (hours) — only when provided.
  if (data.accruals) {
    drawText(
      `Sick balance: ${data.accruals.sickBalance} hrs   •   Vacation balance: ${data.accruals.vacationBalance} hrs`,
      MARGIN_L,
      cursor + 6,
      { size: 9, color: COLOR_GRAY },
    );
    cursor -= 14;
  }

  // Taxable wages — differ from gross when 401(k) or Section 125 deductions apply.
  if (data.taxableWages) {
    const tw = data.taxableWages;
    drawText(
      `Federal taxable wages: ${fmt(tw.current.federal)} (YTD ${fmt(tw.ytd.federal)})   •   ` +
        `Social Security/Medicare wages: ${fmt(tw.current.fica)} (YTD ${fmt(tw.ytd.fica)})`,
      MARGIN_L,
      cursor + 6,
      { size: 8, color: COLOR_GRAY },
    );
    cursor -= 14;
  }

  // -------------------------------------------------------------------------
  // FOOTER
  // -------------------------------------------------------------------------

  const FOOTER_Y = 36;
  drawRule(FOOTER_Y + 10, COLOR_LIGHT, 0.5);

  const footerText = winAnsiText(`${data.company.name}  —  This is not a negotiable instrument.`);
  const ftW = regular.widthOfTextAtSize(footerText, 8);
  page.drawText(footerText, {
    x: (PAGE_W - ftW) / 2,
    y: FOOTER_Y,
    font: regular,
    size: 8,
    color: COLOR_GRAY,
  });

  // A voided paycheck was never paid: its stub says so in large letters (QB prints VOID).
  if (data.isVoid) {
    const voidText = 'VOID';
    const size = 120;
    const w = bold.widthOfTextAtSize(voidText, size);
    page.drawText(voidText, {
      x: (PAGE_W - w * Math.cos(Math.PI / 6)) / 2,
      y: PAGE_H / 2 - (w * Math.sin(Math.PI / 6)) / 2,
      font: bold,
      size,
      color: rgb(0.85, 0.15, 0.15),
      opacity: 0.35,
      rotate: degrees(30),
    });
  }

  await stampSandbox(pdfDoc); // printed from a sandbox copy: stamped SANDBOX
  return pdfDoc.save();
}
