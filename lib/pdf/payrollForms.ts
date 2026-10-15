/**
 * PDF renderers for IRS payroll tax forms.
 *
 * renderW2Pdf   — Employee W-2 Wage and Tax Statement (simplified layout)
 * render941Pdf  — Employer's Quarterly Federal Tax Return (Form 941 lines 1-16 + Schedule B)
 *
 * Uses pdf-lib with standard Helvetica fonts (no external font files required).
 * Returns a Uint8Array of the PDF bytes.
 *
 * DISCLAIMER: These are simplified approximations for record-keeping purposes
 * and are NOT substitutes for the official IRS printed forms. Always file using
 * forms published by the IRS at irs.gov.
 */

import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import type { Form941Lines } from '@/lib/services/payrollReports';
import { stampSandbox } from './sandboxStamp';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Format a decimal string / number as USD currency. */
function fmt(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    isNaN(n) ? 0 : n,
  );
}

const PAGE_W = PageSizes.Letter[0]; // 612 pt
const PAGE_H = PageSizes.Letter[1]; // 792 pt

const ML = 48;
const MR = PAGE_W - 48;

const C_NAVY  = rgb(0.09, 0.13, 0.27);
const C_GRAY  = rgb(0.45, 0.45, 0.50);
const C_LIGHT = rgb(0.88, 0.90, 0.93);
const C_BLACK = rgb(0, 0, 0);
const C_ACCENT = rgb(0.20, 0.47, 0.96);

// ---------------------------------------------------------------------------
// W-2 types + renderer
// ---------------------------------------------------------------------------

export interface W2PdfInput {
  company: { name: string; address?: string | null; ein?: string | null };
  employee: { firstName: string; lastName: string; ssn?: string | null };
  year: number;
  /** Box 1: Wages, tips, other compensation. */
  wages: string | number;
  /** Box 2: Federal income tax withheld. */
  federalWithheld: string | number;
  /** Box 3: Social security wages (Box 1 capped at the SS wage base). Optional for
   * backward compatibility — omitted boxes are rendered as Box 1 wages. */
  ssWages?: string | number;
  /** Box 4: Social security tax withheld. */
  socialSecurity: string | number;
  /** Box 5: Medicare wages and tips (no cap). Defaults to Box 1 wages. */
  medicareWages?: string | number;
  /** Box 6: Medicare tax withheld. */
  medicare: string | number;
  /** Box 10: dependent care benefits. */
  dependentCare?: string | number | null;
  /** Box 12: coded amounts (D 401(k), E 403(b), G 457(b), S SIMPLE, W HSA, DD employer health). */
  box12?: Array<{ code: string; amount: string | number }> | null;
  /** Box 14: other (informational). */
  box14?: Array<{ label: string; amount: string | number }> | null;
  /** Boxes 15-17: state code, state wages, state income tax withheld. */
  state?: { code: string | null; wages: string | number; withheld: string | number } | null;
}

/**
 * Render a simplified W-2 statement as a PDF.
 * Returns the PDF bytes as Uint8Array.
 */
export async function renderW2Pdf(input: W2PdfInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // Convenience helpers
  function hRule(y: number, x1 = ML, x2 = MR, thickness = 0.5, color = C_LIGHT) {
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  function txt(
    s: string,
    x: number,
    y: number,
    opts: { size?: number; font?: typeof regular; color?: typeof C_BLACK; rightAlign?: boolean } = {},
  ) {
    const { size = 10, font = regular, color = C_BLACK, rightAlign = false } = opts;
    const drawX = rightAlign ? x - font.widthOfTextAtSize(s, size) : x;
    page.drawText(s, { x: drawX, y, font, size, color });
  }

  let cursor = PAGE_H - 48;

  // ----- Header -----
  txt('W-2 Wage and Tax Statement', ML, cursor, { font: bold, size: 18, color: C_NAVY });
  cursor -= 20;
  txt(`Tax Year ${input.year}`, ML, cursor, { size: 11, color: C_GRAY });

  // IRS disclaimer badge (right)
  const disc = 'INFORMATIONAL COPY — NOT OFFICIAL IRS FORM';
  txt(disc, MR, PAGE_H - 48, { size: 7, color: C_GRAY, rightAlign: true });

  cursor -= 10;
  hRule(cursor, ML, MR, 1.5, C_ACCENT);
  cursor -= 20;

  // ----- Employer section -----
  txt('a  Employer name, address, and ZIP code', ML, cursor, { size: 8, color: C_GRAY });
  // Box b: employer EIN (right side, from company settings).
  if (input.company.ein) {
    txt('b  Employer identification number (EIN)', MR - 180, cursor, { size: 8, color: C_GRAY });
    txt(input.company.ein, MR - 180, cursor - 14, { font: bold, size: 11, color: C_BLACK });
  }
  cursor -= 14;
  txt(input.company.name, ML, cursor, { font: bold, size: 11, color: C_BLACK });
  cursor -= 14;
  if (input.company.address) {
    txt(input.company.address, ML, cursor, { size: 10, color: C_BLACK });
    cursor -= 14;
  }

  cursor -= 8;
  hRule(cursor);
  cursor -= 16;

  // ----- Employee section -----
  txt('e  Employee name', ML, cursor, { size: 8, color: C_GRAY });
  const empName = `${input.employee.firstName} ${input.employee.lastName}`;
  cursor -= 14;
  txt(empName, ML, cursor, { font: bold, size: 11, color: C_BLACK });

  // SSN (right side)
  if (input.employee.ssn) {
    const maskedSsn = input.employee.ssn.replace(/\d(?=\d{4})/g, '*');
    txt('d  Employee SSN', MR - 180, cursor + 14, { size: 8, color: C_GRAY });
    txt(maskedSsn, MR - 180, cursor, { size: 11, color: C_BLACK });
  }

  cursor -= 24;
  hRule(cursor);
  cursor -= 20;

  // ----- Box layout -----
  // Draw a box-style layout: label (small gray) + value (bold black)
  function drawBox(
    label: string,
    boxLabel: string,
    value: string | number,
    x: number,
    y: number,
    w: number,
  ) {
    // Border rectangle
    page.drawRectangle({
      x,
      y: y - 34,
      width: w,
      height: 42,
      borderColor: C_LIGHT,
      borderWidth: 0.75,
    });
    // Box number
    txt(boxLabel, x + 4, y + 4, { size: 7, color: C_GRAY });
    // Label
    txt(label, x + 4, y - 6, { size: 8, color: C_GRAY });
    // Value
    txt(fmt(value), x + w - 4, y - 20, { font: bold, size: 11, color: C_BLACK, rightAlign: true });
  }

  // Box 15 holds a state code, not a dollar amount — same frame, raw text value.
  function drawTextBox(
    label: string,
    boxLabel: string,
    value: string,
    x: number,
    y: number,
    w: number,
  ) {
    page.drawRectangle({
      x,
      y: y - 34,
      width: w,
      height: 42,
      borderColor: C_LIGHT,
      borderWidth: 0.75,
    });
    txt(boxLabel, x + 4, y + 4, { size: 7, color: C_GRAY });
    txt(label, x + 4, y - 6, { size: 8, color: C_GRAY });
    txt(value, x + w - 4, y - 20, { font: bold, size: 11, color: C_BLACK, rightAlign: true });
  }

  const COL1 = ML;
  const COL2 = ML + (MR - ML) / 2 + 4;
  const BOXW = (MR - ML) / 2 - 4;

  const ssWages       = input.ssWages       ?? input.wages;
  const medicareWages = input.medicareWages ?? input.wages;

  drawBox('Wages, tips, other compensation', '1', input.wages,          COL1, cursor, BOXW);
  drawBox('Federal income tax withheld',      '2', input.federalWithheld, COL2, cursor, BOXW);
  cursor -= 50;

  drawBox('Social security wages',         '3', ssWages,              COL1, cursor, BOXW);
  drawBox('Social security tax withheld',  '4', input.socialSecurity, COL2, cursor, BOXW);
  cursor -= 50;

  drawBox('Medicare wages and tips',  '5', medicareWages, COL1, cursor, BOXW);
  drawBox('Medicare tax withheld',    '6', input.medicare, COL2, cursor, BOXW);
  cursor -= 50;

  // Box 10 (dependent care) and Box 12 (coded amounts: 401(k) D, 403(b) E, 457(b) G, HSA W, DD).
  const box12 = (input.box12 ?? []).filter((b) => parseFloat(String(b.amount)) > 0);
  const hasBox10 = parseFloat(String(input.dependentCare ?? 0)) > 0;
  if (hasBox10 || box12.length > 0) {
    if (hasBox10) {
      drawBox('Dependent care benefits', '10', input.dependentCare ?? 0, COL1, cursor, BOXW);
    }
    box12.slice(0, 4).forEach((b, i) => {
      const letter = String.fromCharCode(97 + i); // 12a..12d
      const col = (hasBox10 ? i + 1 : i) % 2 === 0 ? COL1 : COL2;
      drawBox(`Code ${b.code}`, `12${letter}`, b.amount, col, cursor, BOXW);
      if (col === COL2) cursor -= 50;
    });
    if (((hasBox10 ? 1 : 0) + Math.min(box12.length, 4)) % 2 === 1) cursor -= 50;
  }

  // Boxes 15-17: state code / state wages / state income tax (third-width boxes).
  if (input.state) {
    const BOX3W = (MR - ML) / 3 - 4;
    const COL3B = ML + (MR - ML) / 3 + 2;
    const COL3C = ML + (2 * (MR - ML)) / 3 + 4;
    drawTextBox('State',                 '15', input.state.code ?? '—', COL1,  cursor, BOX3W);
    drawBox('State wages, tips, etc.',   '16', input.state.wages,        COL3B, cursor, BOX3W);
    drawBox('State income tax',          '17', input.state.withheld,     COL3C, cursor, BOX3W);
    cursor -= 50;
  }

  // ----- Totals summary -----
  cursor -= 8;
  hRule(cursor);
  cursor -= 18;

  txt('Summary', ML, cursor, { font: bold, size: 10, color: C_NAVY });
  cursor -= 16;

  const totalWithheld =
    parseFloat(String(input.federalWithheld)) +
    parseFloat(String(input.socialSecurity)) +
    parseFloat(String(input.medicare));

  const rows: Array<[string, string | number]> = [
    ['Box 1 — Wages, tips, other compensation',   input.wages],
    ['Box 2 — Federal income tax withheld',        input.federalWithheld],
    ['Box 3 — Social security wages',              ssWages],
    ['Box 4 — Social security tax withheld',       input.socialSecurity],
    ['Box 5 — Medicare wages and tips',            medicareWages],
    ['Box 6 — Medicare tax withheld',              input.medicare],
    ...(hasBox10 ? ([['Box 10 — Dependent care benefits', input.dependentCare ?? 0]] as Array<[string, string | number]>) : []),
    ...box12.map((b) => [`Box 12 — Code ${b.code}`, b.amount] as [string, string | number]),
    ...(input.box14 ?? [])
      .filter((b) => parseFloat(String(b.amount)) > 0)
      .map((b) => [`Box 14 — ${b.label}`, b.amount] as [string, string | number]),
    ...(input.state
      ? ([
          [`Box 16 — State wages (${input.state.code ?? 'state'})`, input.state.wages],
          ['Box 17 — State income tax withheld',                    input.state.withheld],
        ] as Array<[string, string | number]>)
      : []),
    ['Total taxes withheld (Boxes 2 + 4 + 6)',     totalWithheld],
  ];

  for (const [label, value] of rows) {
    txt(label, ML, cursor, { size: 10, color: C_GRAY });
    txt(fmt(value), MR, cursor, { font: bold, size: 10, color: C_BLACK, rightAlign: true });
    cursor -= 16;
  }

  // ----- Footer -----
  cursor -= 16;
  hRule(cursor, ML, MR, 0.5, C_LIGHT);
  cursor -= 14;
  txt(
    `${input.company.name}  —  W-2 for ${empName}  —  Tax Year ${input.year}`,
    PAGE_W / 2,
    cursor,
    { size: 7, color: C_GRAY, rightAlign: false },
  );
  // center the footer
  const footerStr = `${input.company.name}  —  W-2 for ${empName}  —  Tax Year ${input.year}`;
  const ftW = regular.widthOfTextAtSize(footerStr, 7);
  page.drawText(footerStr, { x: (PAGE_W - ftW) / 2, y: cursor, font: regular, size: 7, color: C_GRAY });

  await stampSandbox(pdfDoc); // printed from a sandbox copy: stamped SANDBOX
  return pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Form 941 types + renderer
// ---------------------------------------------------------------------------

export interface Form941PdfInput {
  company: { name: string; tradeName?: string | null; address?: string | null; ein?: string | null };
  /** Calendar quarter: 1, 2, 3, or 4. */
  quarter: 1 | 2 | 3 | 4;
  year: number;
  /** Every Form 941 line (payrollReports.form941Data). */
  lines: Form941Lines;
  schedule: {
    kind: 'under2500' | 'monthly' | 'semiweekly';
    months: [string, string, string];
    total: string;
    scheduleB: Array<{ month: number; days: Array<{ day: number; amount: string }>; total: string }> | null;
  };
  notes?: string[];
}

const QUARTER_LABELS: Record<number, string> = {
  1: 'January, February, March',
  2: 'April, May, June',
  3: 'July, August, September',
  4: 'October, November, December',
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Render Form 941 (Employer's Quarterly Federal Tax Return): employer block (EIN, name, trade
 * name, address), Part 1 lines 1-15 with the line 5 two-column table, Part 2 line 16 (deposit
 * schedule and monthly liabilities), and Schedule B (daily liabilities) for semiweekly depositors.
 * Returns the PDF bytes as Uint8Array.
 */
export async function render941Pdf(input: Form941PdfInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const L = input.lines;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let cursor = PAGE_H - 48;

  function hRule(y: number, x1 = ML, x2 = MR, thickness = 0.5, color = C_LIGHT) {
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }
  function txt(
    s: string,
    x: number,
    y: number,
    opts: { size?: number; font?: typeof regular; color?: typeof C_BLACK; rightAlign?: boolean } = {},
  ) {
    const { size = 10, font = regular, color = C_BLACK, rightAlign = false } = opts;
    const drawX = rightAlign ? x - font.widthOfTextAtSize(s, size) : x;
    page.drawText(s, { x: drawX, y, font, size, color });
  }
  function ensure(space: number) {
    if (cursor - space < 56) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      cursor = PAGE_H - 48;
    }
  }
  const COL1 = MR - 130;
  /** A numbered line. Money values are formatted; `text` values print as-is. */
  function line(
    num: string,
    description: string,
    value: { money: string } | { text: string } | null,
    col1?: string | null,
    boldValue = false,
  ) {
    ensure(22);
    txt(num, ML, cursor, { size: 9, color: C_GRAY });
    txt(description, ML + 28, cursor, { size: 9, color: C_BLACK });
    if (col1 != null) txt(fmt(col1), COL1, cursor, { size: 9, color: C_BLACK, rightAlign: true });
    if (value) {
      const shown = 'money' in value ? fmt(value.money) : value.text;
      txt(shown, MR, cursor, { font: boldValue ? bold : regular, size: 9, color: C_BLACK, rightAlign: true });
    }
    cursor -= 5;
    hRule(cursor, ML + 28, MR, 0.3, C_LIGHT);
    cursor -= 12;
  }
  const $ = (money: string) => ({ money });
  function heading(s: string) {
    ensure(30);
    cursor -= 4;
    txt(s, ML, cursor, { font: bold, size: 10, color: C_NAVY });
    cursor -= 16;
  }

  // ----- Header -----
  txt(`Form 941 for ${input.year}`, ML, cursor, { font: bold, size: 18, color: C_NAVY });
  txt('INFORMATIONAL COPY - FILE ON THE OFFICIAL IRS FORM', MR, cursor, { size: 7, color: C_GRAY, rightAlign: true });
  cursor -= 16;
  txt("Employer's QUARTERLY Federal Tax Return", ML, cursor, { font: bold, size: 11, color: C_NAVY });
  cursor -= 10;
  hRule(cursor, ML, MR, 1.5, C_ACCENT);
  cursor -= 16;

  // ----- Employer block -----
  const field = (label: string, value: string, x: number, y: number) => {
    txt(label, x, y, { size: 7, color: C_GRAY });
    txt(value || '-', x, y - 12, { font: bold, size: 10 });
  };
  field('Employer identification number (EIN)', input.company.ein ?? '', ML, cursor);
  field('Report for this quarter', `Q${input.quarter}: ${QUARTER_LABELS[input.quarter]}`, ML + 300, cursor);
  cursor -= 30;
  field('Name (not your trade name)', input.company.name, ML, cursor);
  field('Trade name (if any)', input.company.tradeName ?? '', ML + 300, cursor);
  cursor -= 30;
  field('Address', input.company.address ?? '', ML, cursor);
  cursor -= 30;
  hRule(cursor);
  cursor -= 16;

  // ----- Part 1 -----
  heading('Part 1: Answer these questions for this quarter.');
  ensure(20);
  txt('Column 1', COL1, cursor, { size: 7, color: C_GRAY, rightAlign: true });
  txt('Column 2', MR, cursor, { size: 7, color: C_GRAY, rightAlign: true });
  cursor -= 12;
  line('1', 'Number of employees who received pay for the pay period including the 12th', { text: String(L.line1) });
  line('2', 'Wages, tips, and other compensation', $(L.line2));
  line('3', 'Federal income tax withheld from wages, tips, and other compensation', $(L.line3));
  line('4', 'No wages, tips, and other compensation are subject to social security or Medicare tax', { text: L.line4 ? 'Checked' : '-' });
  line('5a', 'Taxable social security wages  (x 0.124)', $(L.line5aTax), L.line5aWages);
  line('5b', 'Taxable social security tips  (x 0.124)', $(L.line5bTax), L.line5bWages);
  line('5c', 'Taxable Medicare wages & tips  (x 0.029)', $(L.line5cTax), L.line5cWages);
  line('5d', 'Wages & tips subject to Additional Medicare Tax withholding  (x 0.009)', $(L.line5dTax), L.line5dWages);
  line('5e', 'Total social security and Medicare taxes (5a + 5b + 5c + 5d)', $(L.line5e));
  line('5f', 'Section 3121(q) Notice and Demand - tax due on unreported tips', $(L.line5f));
  line('6', 'Total taxes before adjustments (3 + 5e + 5f)', $(L.line6), null, true);
  line('7', "Current quarter's adjustment for fractions of cents", $(L.line7));
  line('8', "Current quarter's adjustment for sick pay", $(L.line8));
  line('9', "Current quarter's adjustments for tips and group-term life insurance", $(L.line9));
  line('10', 'Total taxes after adjustments (6 through 9)', $(L.line10), null, true);
  line('11', 'Total nonrefundable credits', $(L.line11));
  line('12', 'Total taxes after adjustments and nonrefundable credits (10 - 11)', $(L.line12), null, true);
  line('13', 'Total deposits for this quarter', $(L.line13));
  line('14', 'Balance due (12 - 13 when 12 is more)', $(L.line14), null, true);
  line('15', 'Overpayment (13 - 12 when 13 is more)', $(L.line15));

  // ----- Part 2: line 16 -----
  heading('Part 2: Tell us about your deposit schedule and tax liability for this quarter.');
  const s = input.schedule;
  const kindText =
    s.kind === 'under2500'
      ? 'Line 12 is less than $2,500 - no monthly or daily liability record is required.'
      : s.kind === 'monthly'
        ? 'Monthly schedule depositor for the entire quarter - tax liability by month:'
        : 'Semiweekly schedule depositor - see Schedule B (Form 941) on the next page.';
  ensure(16);
  txt('16', ML, cursor, { size: 9, color: C_GRAY });
  txt(kindText, ML + 28, cursor, { size: 9 });
  cursor -= 16;
  const firstMonth = (input.quarter - 1) * 3;
  if (s.kind === 'monthly') {
    s.months.forEach((m, i) => line('', `Month ${i + 1} (${MONTH_NAMES[firstMonth + i]})`, $(m)));
    line('', 'Total liability for quarter (must equal line 12)', $(s.total), null, true);
  }

  if (input.notes?.length) {
    cursor -= 6;
    for (const n of input.notes) {
      ensure(12);
      txt(n, ML, cursor, { size: 7.5, color: C_GRAY });
      cursor -= 11;
    }
  }

  // ----- Schedule B -----
  if (s.kind === 'semiweekly' && s.scheduleB) {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    cursor = PAGE_H - 48;
    txt(`Schedule B (Form 941) for ${input.year}`, ML, cursor, { font: bold, size: 16, color: C_NAVY });
    cursor -= 14;
    txt('Report of Tax Liability for Semiweekly Schedule Depositors', ML, cursor, { font: bold, size: 10, color: C_NAVY });
    cursor -= 12;
    txt(`EIN ${input.company.ein ?? '-'}   ${input.company.name}   Quarter ${input.quarter}`, ML, cursor, { size: 9, color: C_GRAY });
    cursor -= 10;
    hRule(cursor, ML, MR, 1.5, C_ACCENT);
    cursor -= 16;
    for (const m of s.scheduleB) {
      heading(`Month ${m.month} - ${MONTH_NAMES[firstMonth + m.month - 1]}`);
      if (!m.days.length) {
        ensure(14);
        txt('No tax liability this month.', ML + 28, cursor, { size: 9, color: C_GRAY });
        cursor -= 14;
      }
      for (const d of m.days) line(String(d.day), `Day ${d.day}`, $(d.amount));
      line('', `Tax liability for month ${m.month}`, $(m.total), null, true);
    }
    line('', 'Total liability for the quarter (must equal line 12 of Form 941)', $(s.total), null, true);
  }

  // ----- Footer on every page -----
  for (const p of pdfDoc.getPages()) {
    const footer = `${input.company.name}  -  Form 941 Q${input.quarter} ${input.year}`;
    const w = regular.widthOfTextAtSize(footer, 7);
    p.drawText(footer, { x: (PAGE_W - w) / 2, y: 32, font: regular, size: 7, color: C_GRAY });
  }

  await stampSandbox(pdfDoc); // printed from a sandbox copy: stamped SANDBOX
  return pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Form 940 (FUTA) types + renderer
// ---------------------------------------------------------------------------

export interface Form940PdfInput {
  company: { name: string; address?: string | null; ein?: string | null };
  year: number;
  employeeCount: number;
  /** Line 3: total payments to all employees. */
  totalPayments: string | number;
  /** Line 4: payments exempt from FUTA tax. */
  exemptPayments: string | number;
  /** Line 5: total of payments over $7,000 per employee. */
  excessOver7000: string | number;
  /** Line 6: subtotal (line 4 + line 5). */
  subtotal: string | number;
  /** Line 7: total taxable FUTA wages. */
  taxableFutaWages: string | number;
  /** Line 8: FUTA tax (taxable wages × 0.6%). */
  futaTaxCalculated: string | number;
  /** FUTA tax accrued on paychecks (GL figure). */
  futaTaxAccrued: string | number;
  /** Part 5: FUTA liability by quarter. */
  quarters: Array<{ quarter: 1 | 2 | 3 | 4; futaLiability: string | number }>;
  totalQuarterlyLiability: string | number;
  /** Line 4 boxes (4a fringe benefits, 4d dependent care, ...). */
  exemptBreakdown?: { fringeBenefits: string; groupTermLife: string; retirement: string; dependentCare: string; other: string };
  line9?: string;
  line10?: string;
  /** Line 11 / Schedule A. */
  creditReduction?: { rows: Array<{ state: string; wages: string; rate: string; amount: string }>; total: string; known: boolean; source: string };
  line12?: string;
  line13?: string;
  line14?: string;
  line15?: string;
  warnings?: string[];
}

/**
 * Render a simplified Form 940 (Employer's Annual Federal Unemployment Tax Return)
 * worksheet as a PDF. Returns the PDF bytes as Uint8Array.
 */
export async function render940Pdf(input: Form940PdfInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  function hRule(y: number, x1 = ML, x2 = MR, thickness = 0.5, color = C_LIGHT) {
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  function txt(
    s: string,
    x: number,
    y: number,
    opts: { size?: number; font?: typeof regular; color?: typeof C_BLACK; rightAlign?: boolean } = {},
  ) {
    const { size = 10, font = regular, color = C_BLACK, rightAlign = false } = opts;
    const drawX = rightAlign ? x - font.widthOfTextAtSize(s, size) : x;
    page.drawText(s, { x: drawX, y, font, size, color });
  }

  let cursor = PAGE_H - 48;

  // ----- Header -----
  txt('Form 940', ML, cursor, { font: bold, size: 20, color: C_NAVY });
  cursor -= 18;
  txt("Employer's Annual Federal Unemployment (FUTA) Tax Return", ML, cursor, {
    font: bold, size: 12, color: C_NAVY,
  });
  cursor -= 14;
  txt(`Calendar Year ${input.year}  —  ${input.employeeCount} employee${input.employeeCount === 1 ? '' : 's'} paid`, ML, cursor, {
    size: 10, color: C_GRAY,
  });

  txt('INFORMATIONAL COPY — NOT OFFICIAL IRS FORM', MR, PAGE_H - 48, {
    size: 7, color: C_GRAY, rightAlign: true,
  });

  cursor -= 10;
  hRule(cursor, ML, MR, 1.5, C_ACCENT);
  cursor -= 20;

  // ----- Employer info -----
  txt('Name', ML, cursor, { size: 8, color: C_GRAY });
  if (input.company.ein) {
    txt('Employer identification number (EIN)', MR - 200, cursor, { size: 8, color: C_GRAY });
    txt(input.company.ein, MR - 200, cursor - 14, { font: bold, size: 11, color: C_BLACK });
  }
  cursor -= 14;
  txt(input.company.name, ML, cursor, { font: bold, size: 11, color: C_BLACK });
  if (input.company.address) {
    cursor -= 14;
    txt(input.company.address, ML, cursor, { size: 10, color: C_BLACK });
  }

  cursor -= 24;
  hRule(cursor);
  cursor -= 20;

  // ----- Part 2: FUTA tax before adjustments -----
  txt('Part 2: Determine your FUTA tax before adjustments', ML, cursor, {
    font: bold, size: 10, color: C_NAVY,
  });
  cursor -= 20;

  function drawLine940(lineNum: string, description: string, value: string | number) {
    txt(`${lineNum}.`, ML, cursor, { size: 10, color: C_GRAY });
    txt(description, ML + 24, cursor, { size: 10, color: C_BLACK });
    txt(fmt(value), MR, cursor, { font: bold, size: 10, color: C_BLACK, rightAlign: true });
    cursor -= 6;
    hRule(cursor, ML + 24, MR, 0.3, C_LIGHT);
    cursor -= 14;
  }

  drawLine940('3', 'Total payments to all employees',                          input.totalPayments);
  drawLine940('4', 'Payments exempt from FUTA tax',                            input.exemptPayments);
  if (input.exemptBreakdown) {
    const eb = input.exemptBreakdown;
    const boxes = [
      ['4a', 'Fringe benefits (Section 125, HSA)', eb.fringeBenefits],
      ['4b', 'Group-term life insurance', eb.groupTermLife],
      ['4c', 'Retirement/Pension', eb.retirement],
      ['4d', 'Dependent care', eb.dependentCare],
      ['4e', 'Other', eb.other],
    ];
    for (const [box, label, amt] of boxes) {
      if (Number(amt) === 0) continue;
      txt(`${box}  ${label}`, ML + 40, cursor, { size: 8, color: C_GRAY });
      txt(fmt(amt), MR - 90, cursor, { size: 8, color: C_GRAY, rightAlign: true });
      cursor -= 12;
    }
  }
  drawLine940('5', 'Total of payments made to each employee in excess of $7,000', input.excessOver7000);
  drawLine940('6', 'Subtotal (line 4 + line 5)',                               input.subtotal);
  drawLine940('7', 'Total taxable FUTA wages (line 3 minus line 6)',           input.taxableFutaWages);
  drawLine940('8', 'FUTA tax before adjustments (line 7 × 0.006)',             input.futaTaxCalculated);
  if (input.line12 != null) {
    cursor -= 4;
    txt('Part 3: Determine your adjustments', ML, cursor, { font: bold, size: 10, color: C_NAVY });
    cursor -= 18;
    drawLine940('9', 'All FUTA wages excluded from state unemployment tax (line 7 × 0.054)', input.line9 ?? '0');
    drawLine940('10', 'Some FUTA wages excluded from state unemployment tax / late state payments', input.line10 ?? '0');
    drawLine940('11', 'Credit reduction (Schedule A)', input.creditReduction?.total ?? '0');
    for (const r of input.creditReduction?.rows ?? []) {
      txt(`${r.state}: ${fmt(r.wages)} × ${(Number(r.rate) * 100).toFixed(1)}%`, ML + 40, cursor, { size: 8, color: C_GRAY });
      txt(fmt(r.amount), MR - 90, cursor, { size: 8, color: C_GRAY, rightAlign: true });
      cursor -= 12;
    }
    txt('Part 4: Determine your FUTA tax and balance due or overpayment', ML, cursor, { font: bold, size: 10, color: C_NAVY });
    cursor -= 18;
    drawLine940('12', 'Total FUTA tax after adjustments (lines 8 + 9 + 10 + 11)', input.line12);
    drawLine940('13', 'FUTA tax deposited for the year', input.line13 ?? '0');
    drawLine940('14', 'Balance due (line 12 - line 13 when 12 is more)', input.line14 ?? '0');
    drawLine940('15', 'Overpayment (line 13 - line 12 when 13 is more)', input.line15 ?? '0');
  }

  cursor -= 4;
  hRule(cursor, ML, MR, 1, C_NAVY);
  cursor -= 18;

  txt('FUTA tax accrued on paychecks (per-check employer accrual)', ML, cursor, {
    font: bold, size: 10, color: C_NAVY,
  });
  txt(fmt(input.futaTaxAccrued), MR, cursor, {
    font: bold, size: 11, color: C_NAVY, rightAlign: true,
  });
  cursor -= 14;
  txt(
    '(Differences between line 8 and the accrued figure usually mean manual employer-tax overrides.)',
    ML, cursor, { size: 8, color: C_GRAY },
  );
  cursor -= 28;

  // ----- Part 5: quarterly liability -----
  txt('Part 5: FUTA tax liability by quarter', ML, cursor, { font: bold, size: 10, color: C_NAVY });
  cursor -= 18;

  const Q_LABELS: Record<number, string> = {
    1: '16a  1st quarter (January 1 – March 31)',
    2: '16b  2nd quarter (April 1 – June 30)',
    3: '16c  3rd quarter (July 1 – September 30)',
    4: '16d  4th quarter (October 1 – December 31)',
  };
  for (const q of input.quarters) {
    txt(Q_LABELS[q.quarter], ML, cursor, { size: 10, color: C_GRAY });
    txt(fmt(q.futaLiability), MR, cursor, { font: bold, size: 10, color: C_BLACK, rightAlign: true });
    cursor -= 6;
    hRule(cursor, ML, MR, 0.3, C_LIGHT);
    cursor -= 14;
  }

  txt('17   Total tax liability for the year', ML, cursor, { font: bold, size: 10, color: C_NAVY });
  txt(fmt(input.totalQuarterlyLiability), MR, cursor, {
    font: bold, size: 11, color: C_NAVY, rightAlign: true,
  });
  cursor -= 24;

  for (const w of input.warnings ?? []) {
    txt(w.length > 150 ? `${w.slice(0, 147)}...` : w, ML, cursor, { size: 7, color: C_GRAY });
    cursor -= 10;
  }
  if (input.creditReduction?.rows.length) {
    txt(`Credit reduction rates: ${input.creditReduction.source}`.slice(0, 160), ML, cursor, { size: 6.5, color: C_GRAY });
    cursor -= 10;
  }

  // ----- Footer -----
  cursor -= 24;
  hRule(cursor, ML, MR, 0.5, C_LIGHT);
  cursor -= 14;
  const footerStr940 = `${input.company.name}  —  Form 940 ${input.year}`;
  const ftW940 = regular.widthOfTextAtSize(footerStr940, 7);
  page.drawText(footerStr940, { x: (PAGE_W - ftW940) / 2, y: cursor, font: regular, size: 7, color: C_GRAY });

  await stampSandbox(pdfDoc); // printed from a sandbox copy: stamped SANDBOX
  return pdfDoc.save();
}

// ---------------------------------------------------------------------------
// W-3 transmittal types + renderer
// ---------------------------------------------------------------------------

export interface W3PdfInput {
  company: { name: string; address?: string | null; ein?: string | null };
  year: number;
  /** Box c: total number of Forms W-2. */
  w2Count: number;
  wages: string | number;            // Box 1
  federalWithheld: string | number;  // Box 2
  ssWages: string | number;          // Box 3
  socialSecurity: string | number;   // Box 4
  medicareWages: string | number;    // Box 5
  medicare: string | number;         // Box 6
  dependentCare?: string | number;   // Box 10
  deferredCompensation?: string | number; // Box 12a (codes D, E, F, G, H, S)
  stateWages: string | number;       // Box 16
  stateWithheld: string | number;    // Box 17
}

/**
 * Render a simplified W-3 (Transmittal of Wage and Tax Statements) worksheet as
 * a PDF — totals across all employee W-2s for the year. Returns PDF bytes.
 */
export async function renderW3Pdf(input: W3PdfInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  function hRule(y: number, x1 = ML, x2 = MR, thickness = 0.5, color = C_LIGHT) {
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  function txt(
    s: string,
    x: number,
    y: number,
    opts: { size?: number; font?: typeof regular; color?: typeof C_BLACK; rightAlign?: boolean } = {},
  ) {
    const { size = 10, font = regular, color = C_BLACK, rightAlign = false } = opts;
    const drawX = rightAlign ? x - font.widthOfTextAtSize(s, size) : x;
    page.drawText(s, { x: drawX, y, font, size, color });
  }

  let cursor = PAGE_H - 48;

  // ----- Header -----
  txt('Form W-3', ML, cursor, { font: bold, size: 20, color: C_NAVY });
  cursor -= 18;
  txt('Transmittal of Wage and Tax Statements', ML, cursor, { font: bold, size: 12, color: C_NAVY });
  cursor -= 14;
  txt(`Tax Year ${input.year}`, ML, cursor, { size: 10, color: C_GRAY });

  txt('INFORMATIONAL COPY — NOT OFFICIAL SSA/IRS FORM', MR, PAGE_H - 48, {
    size: 7, color: C_GRAY, rightAlign: true,
  });

  cursor -= 10;
  hRule(cursor, ML, MR, 1.5, C_ACCENT);
  cursor -= 20;

  // ----- Employer info -----
  txt('e  Employer name, address, and ZIP code', ML, cursor, { size: 8, color: C_GRAY });
  txt('b  Employer identification number (EIN)', MR - 200, cursor, { size: 8, color: C_GRAY });
  txt(input.company.ein ?? '—', MR - 200, cursor - 14, { font: bold, size: 11, color: C_BLACK });
  cursor -= 14;
  txt(input.company.name, ML, cursor, { font: bold, size: 11, color: C_BLACK });
  if (input.company.address) {
    cursor -= 14;
    txt(input.company.address, ML, cursor, { size: 10, color: C_BLACK });
  }
  cursor -= 14;
  txt(`c  Total number of Forms W-2:  ${input.w2Count}`, ML, cursor, { size: 10, color: C_BLACK });

  cursor -= 18;
  hRule(cursor);
  cursor -= 20;

  // ----- Totals -----
  txt('Totals across all W-2s', ML, cursor, { font: bold, size: 10, color: C_NAVY });
  cursor -= 20;

  function drawLineW3(boxNum: string, description: string, value: string | number) {
    txt(boxNum, ML, cursor, { size: 10, color: C_GRAY });
    txt(description, ML + 28, cursor, { size: 10, color: C_BLACK });
    txt(fmt(value), MR, cursor, { font: bold, size: 10, color: C_BLACK, rightAlign: true });
    cursor -= 6;
    hRule(cursor, ML + 28, MR, 0.3, C_LIGHT);
    cursor -= 14;
  }

  drawLineW3('1',  'Wages, tips, other compensation',  input.wages);
  drawLineW3('2',  'Federal income tax withheld',      input.federalWithheld);
  drawLineW3('3',  'Social security wages',            input.ssWages);
  drawLineW3('4',  'Social security tax withheld',     input.socialSecurity);
  drawLineW3('5',  'Medicare wages and tips',          input.medicareWages);
  drawLineW3('6',  'Medicare tax withheld',            input.medicare);
  if (input.dependentCare != null && parseFloat(String(input.dependentCare)) > 0) {
    drawLineW3('10', 'Dependent care benefits',        input.dependentCare);
  }
  if (input.deferredCompensation != null && parseFloat(String(input.deferredCompensation)) > 0) {
    drawLineW3('12a', 'Deferred compensation',         input.deferredCompensation);
  }
  drawLineW3('16', 'State wages, tips, etc.',          input.stateWages);
  drawLineW3('17', 'State income tax',                 input.stateWithheld);

  cursor -= 4;
  hRule(cursor, ML, MR, 1, C_NAVY);
  cursor -= 18;

  const totalWithheld =
    parseFloat(String(input.federalWithheld)) +
    parseFloat(String(input.socialSecurity)) +
    parseFloat(String(input.medicare));

  txt('Total federal taxes withheld (Boxes 2 + 4 + 6)', ML, cursor, {
    font: bold, size: 10, color: C_NAVY,
  });
  txt(fmt(totalWithheld), MR, cursor, { font: bold, size: 11, color: C_NAVY, rightAlign: true });
  cursor -= 24;

  txt(
    'File this transmittal with Copy A of all Forms W-2. Verify totals match the sum of the individual W-2s.',
    ML, cursor, { size: 8, color: C_GRAY },
  );

  // ----- Footer -----
  cursor -= 24;
  hRule(cursor, ML, MR, 0.5, C_LIGHT);
  cursor -= 14;
  const footerStrW3 = `${input.company.name}  —  Form W-3 ${input.year}`;
  const ftWW3 = regular.widthOfTextAtSize(footerStrW3, 7);
  page.drawText(footerStrW3, { x: (PAGE_W - ftWW3) / 2, y: cursor, font: regular, size: 7, color: C_GRAY });

  await stampSandbox(pdfDoc); // printed from a sandbox copy: stamped SANDBOX
  return pdfDoc.save();
}
