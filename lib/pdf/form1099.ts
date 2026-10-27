/**
 * PDF renderer for IRS Form 1099-NEC (Nonemployee Compensation).
 *
 * Uses pdf-lib with standard Helvetica fonts (no external files needed).
 *
 * Layout (US Letter, portrait) — a simplified but recognisable 1099-NEC box
 * layout. The form renders one recipient per page with the key boxes:
 *
 *   Box 1  — Nonemployee Compensation
 *   Payer  — company name / address
 *   Recipient — vendor name / tax ID
 *   Year   — calendar year
 *
 * This is a presentational PDF for record-keeping. For official IRS filing
 * you must use IRS-approved paper or electronic filing channels.
 */

import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { stampSandbox } from './sandboxStamp';
import { pdfText } from './check';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface Form1099NecPdfData {
  /** Payer: name, single-line `address` (legacy) or `addressLines`, and the payer's TIN (EIN). */
  company: { name: string; address?: string | null; addressLines?: string[] | null; tin?: string | null; phone?: string | null };
  /** Recipient: name, TIN and mailing address lines. */
  vendor: { name: string; taxId?: string | null; addressLines?: string[] | null };
  year: number;
  nonemployeeComp: string | number;
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

/** Draw a labelled box and return the y-position after the box. */
type BoxOpts = {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: string;
  labelSize?: number;
  valueSize?: number;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
};

function drawBox({
  x, y, w, h, label, value, labelSize = 7, valueSize = 11,
  page, regular, bold,
}: BoxOpts) {
  const C_NAVY  = rgb(0.09, 0.13, 0.27);
  const C_GRAY  = rgb(0.45, 0.45, 0.50);
  const C_LIGHT = rgb(0.90, 0.92, 0.95);
  const C_BLACK = rgb(0, 0, 0);

  // Border rectangle
  page.drawRectangle({
    x,
    y: y - h,
    width: w,
    height: h,
    borderColor: C_NAVY,
    borderWidth: 0.75,
  });

  // Label (top-left inside box)
  page.drawText(label, {
    x: x + 4,
    y: y - labelSize - 4,
    font: regular,
    size: labelSize,
    color: C_GRAY,
  });

  // Value (centered vertically, slightly indented)
  page.drawText(value, {
    x: x + 6,
    y: y - h / 2 - valueSize / 3,
    font: bold,
    size: valueSize,
    color: C_BLACK,
  });
}

// ---------------------------------------------------------------------------
// Layout constants (US Letter)
// ---------------------------------------------------------------------------

const PAGE_W = PageSizes.Letter[0]; // 612
const PAGE_H = PageSizes.Letter[1]; // 792

const ML = 48;  // left margin
const MR = PAGE_W - 48; // right margin
const FORM_W = MR - ML;

const COLOR_NAVY   = rgb(0.09, 0.13, 0.27);
const COLOR_ACCENT = rgb(0.20, 0.47, 0.96);
const COLOR_LIGHT  = rgb(0.90, 0.92, 0.95);
const COLOR_GRAY   = rgb(0.45, 0.45, 0.50);
const COLOR_BLACK  = rgb(0, 0, 0);

// ---------------------------------------------------------------------------
// render1099NecPdf
// ---------------------------------------------------------------------------

export async function render1099NecPdf(input: Form1099NecPdfData): Promise<Uint8Array> {
  // Names / addresses the standard fonts cannot encode ("Łódź", "Nguyễn") failed the whole PDF.
  const lines = (ls: string[] | null | undefined) => (ls ?? []).map((l) => pdfText(l)).filter((l) => l.trim());
  const data: Form1099NecPdfData = {
    ...input,
    company: {
      ...input.company,
      name: pdfText(input.company.name),
      address: input.company.address ? pdfText(input.company.address) : input.company.address,
      addressLines: lines(input.company.addressLines),
      tin: input.company.tin ? pdfText(input.company.tin) : null,
      phone: input.company.phone ? pdfText(input.company.phone) : null,
    },
    vendor: {
      name: pdfText(input.vendor.name),
      taxId: input.vendor.taxId ? pdfText(input.vendor.taxId) : null,
      addressLines: lines(input.vendor.addressLines),
    },
  };
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  let cursor = PAGE_H - 48;

  // -------------------------------------------------------------------------
  // Title header
  // -------------------------------------------------------------------------

  // Form title (centred)
  const title = `Form 1099-NEC`;
  const titleW = bold.widthOfTextAtSize(title, 18);
  page.drawText(title, {
    x: (PAGE_W - titleW) / 2,
    y: cursor,
    font: bold,
    size: 18,
    color: COLOR_NAVY,
  });

  cursor -= 18;

  const subtitle = `Nonemployee Compensation  —  Tax Year ${data.year}`;
  const subW = regular.widthOfTextAtSize(subtitle, 10);
  page.drawText(subtitle, {
    x: (PAGE_W - subW) / 2,
    y: cursor,
    font: regular,
    size: 10,
    color: COLOR_GRAY,
  });

  cursor -= 8;

  // Thick accent rule under title
  page.drawLine({
    start: { x: ML, y: cursor },
    end:   { x: MR, y: cursor },
    thickness: 2,
    color: COLOR_ACCENT,
  });

  cursor -= 24;

  // -------------------------------------------------------------------------
  // PAYER block (top-left)
  // -------------------------------------------------------------------------

  page.drawText('PAYER\'S NAME, ADDRESS', {
    x: ML,
    y: cursor,
    font: regular,
    size: 7,
    color: COLOR_GRAY,
  });
  cursor -= 14;

  page.drawText(data.company.name, {
    x: ML,
    y: cursor,
    font: bold,
    size: 13,
    color: COLOR_NAVY,
  });
  cursor -= 14;

  const payerLines = [
    ...(data.company.addressLines?.length ? data.company.addressLines : data.company.address ? [data.company.address] : []),
    ...(data.company.phone ? [data.company.phone] : []),
  ];
  for (const line of payerLines) {
    page.drawText(line, {
      x: ML,
      y: cursor,
      font: regular,
      size: 10,
      color: COLOR_BLACK,
    });
    cursor -= 14;
  }
  // The payer's TIN is required on every 1099 (QB prints the company EIN from My Company).
  page.drawText(`PAYER'S TIN: ${data.company.tin?.trim() || 'Not on file — enter the EIN in Company Information'}`, {
    x: ML,
    y: cursor,
    font: regular,
    size: 10,
    color: data.company.tin?.trim() ? COLOR_BLACK : COLOR_GRAY,
  });
  cursor -= 14;

  cursor -= 10;

  // Thin rule
  page.drawLine({
    start: { x: ML, y: cursor },
    end:   { x: MR, y: cursor },
    thickness: 0.5,
    color: COLOR_LIGHT,
  });
  cursor -= 20;

  // -------------------------------------------------------------------------
  // RECIPIENT block
  // -------------------------------------------------------------------------

  page.drawText('RECIPIENT\'S NAME', {
    x: ML,
    y: cursor,
    font: regular,
    size: 7,
    color: COLOR_GRAY,
  });
  cursor -= 14;

  page.drawText(data.vendor.name, {
    x: ML,
    y: cursor,
    font: bold,
    size: 13,
    color: COLOR_NAVY,
  });
  cursor -= 14;

  // Recipient's mailing address (QB prints it for window envelopes).
  for (const line of data.vendor.addressLines ?? []) {
    page.drawText(line, {
      x: ML,
      y: cursor,
      font: regular,
      size: 10,
      color: COLOR_BLACK,
    });
    cursor -= 14;
  }

  const taxIdDisplay = data.vendor.taxId
    ? `RECIPIENT'S TIN: ${data.vendor.taxId}`
    : "RECIPIENT'S TIN: Not on file";
  page.drawText(taxIdDisplay, {
    x: ML,
    y: cursor,
    font: regular,
    size: 10,
    color: COLOR_GRAY,
  });
  cursor -= 22;

  // Thin rule
  page.drawLine({
    start: { x: ML, y: cursor },
    end:   { x: MR, y: cursor },
    thickness: 0.5,
    color: COLOR_LIGHT,
  });
  cursor -= 28;

  // -------------------------------------------------------------------------
  // BOXES — 1099-NEC official box layout (simplified)
  // -------------------------------------------------------------------------

  // Box 1: Nonemployee Compensation (wide, prominent)
  const BOX1_W = FORM_W * 0.55;
  const BOX1_H = 60;

  drawBox({
    x: ML,
    y: cursor,
    w: BOX1_W,
    h: BOX1_H,
    label: 'Box 1 — Nonemployee Compensation',
    value: fmt(data.nonemployeeComp),
    labelSize: 8,
    valueSize: 18,
    page,
    regular,
    bold,
  });

  // Box 4: Federal income tax withheld (right of Box 1)
  const BOX4_X = ML + BOX1_W + 6;
  const BOX4_W = FORM_W - BOX1_W - 6;

  drawBox({
    x: BOX4_X,
    y: cursor,
    w: BOX4_W,
    h: BOX1_H,
    label: 'Box 4 — Federal Income Tax Withheld',
    value: '$0.00',
    labelSize: 8,
    valueSize: 14,
    page,
    regular,
    bold,
  });

  cursor -= BOX1_H + 8;

  // Box 5/6 strip — state info
  const STRIP_H = 36;
  const BOX5_W = FORM_W * 0.30;
  const BOX6_W = FORM_W * 0.35;
  const BOX7_W = FORM_W - BOX5_W - BOX6_W;

  drawBox({
    x: ML,
    y: cursor,
    w: BOX5_W,
    h: STRIP_H,
    label: 'Box 5 — State tax withheld',
    value: '$0.00',
    labelSize: 7,
    valueSize: 10,
    page,
    regular,
    bold,
  });

  drawBox({
    x: ML + BOX5_W,
    y: cursor,
    w: BOX6_W,
    h: STRIP_H,
    label: 'Box 6 — State/Payer\'s state no.',
    value: '—',
    labelSize: 7,
    valueSize: 10,
    page,
    regular,
    bold,
  });

  drawBox({
    x: ML + BOX5_W + BOX6_W,
    y: cursor,
    w: BOX7_W,
    h: STRIP_H,
    label: 'Box 7 — State income',
    value: '$0.00',
    labelSize: 7,
    valueSize: 10,
    page,
    regular,
    bold,
  });

  cursor -= STRIP_H + 28;

  // -------------------------------------------------------------------------
  // Threshold note
  // -------------------------------------------------------------------------

  page.drawText(
    'Note: IRS requires 1099-NEC for nonemployee compensation totalling $600 or more in a calendar year.',
    {
      x: ML,
      y: cursor,
      font: regular,
      size: 8,
      color: COLOR_GRAY,
    },
  );
  cursor -= 14;

  page.drawText(
    'This document is for record-keeping purposes. File Copy A with the IRS via official channels.',
    {
      x: ML,
      y: cursor,
      font: regular,
      size: 8,
      color: COLOR_GRAY,
    },
  );

  cursor -= 28;

  // -------------------------------------------------------------------------
  // Copy labels
  // -------------------------------------------------------------------------

  page.drawLine({
    start: { x: ML, y: cursor },
    end:   { x: MR, y: cursor },
    thickness: 0.5,
    color: COLOR_LIGHT,
  });
  cursor -= 16;

  page.drawText('Copy B — To Be Filed with Recipient\'s Federal Tax Return', {
    x: ML,
    y: cursor,
    font: regular,
    size: 9,
    color: COLOR_NAVY,
  });

  // -------------------------------------------------------------------------
  // FOOTER
  // -------------------------------------------------------------------------

  const FOOTER_Y = 36;
  page.drawLine({
    start: { x: ML, y: FOOTER_Y + 10 },
    end:   { x: MR, y: FOOTER_Y + 10 },
    thickness: 0.5,
    color: COLOR_LIGHT,
  });

  const footerText = `${data.company.name}  —  Form 1099-NEC  —  Tax Year ${data.year}`;
  const ftW = regular.widthOfTextAtSize(footerText, 8);
  page.drawText(footerText, {
    x: (PAGE_W - ftW) / 2,
    y: FOOTER_Y,
    font: regular,
    size: 8,
    color: COLOR_GRAY,
  });

  await stampSandbox(pdfDoc); // printed from a sandbox copy: stamped SANDBOX
  return pdfDoc.save();
}
