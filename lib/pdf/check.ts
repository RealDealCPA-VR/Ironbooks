/**
 * PDF renderer for printable US personal-format checks.
 *
 * Uses pdf-lib with standard Helvetica fonts (no external files needed).
 *
 * Layout (US Letter, portrait) — standard personal-check proportions
 * in the upper portion of the page, leaving the lower portion for the
 * MICR area stub (decorative rules only — actual MICR encoding requires
 * a specialised font we do not ship):
 *
 *   - Company name (payer / drawer) — top-left
 *   - Check number — top-right
 *   - Date — right side, below check number
 *   - "Pay to the Order of" line with payee name
 *   - Numeric amount box — right side of payee line
 *   - Amount-in-words line with trailing fill rule
 *   - Memo line — bottom-left
 *   - Signature line — bottom-right
 *   - Decorative MICR-area rule near the bottom
 *
 * wave2 purchases (D4) — QB Printer Setup parity:
 *   - `style`: 'voucher' (check on top + voucher stub with the bill/expense detail, the default),
 *     'standard' (check only, no stub) or 'wallet' (narrower check with a left-hand stub that
 *     repeats date / payee / amount / memo for the checkbook register).
 *   - `offset`: per-company alignment nudge in inches ({ x: right+, y: up+ }) applied to the
 *     whole page, so pre-printed check stock lines up with the printer.
 */

import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { Money } from '@/lib/money';

/** "1234.5" -> "1,234.50" using Decimal (no float drift); null when not a number. */
function fmtAmount(v: string): string | null {
  let d;
  try {
    d = Money.of(v);
  } catch {
    return null;
  }
  if (!d.isFinite()) return null;
  const [int, frac] = Money.round2(d).abs().toFixed(2).split('.');
  return `${d.isNegative() ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

// ---------------------------------------------------------------------------
// numberToWords — converts a decimal amount string/number to check-style words
// ---------------------------------------------------------------------------

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];

const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
];

/** Convert a non-negative integer < 1,000 to English words. */
function threeDigitsToWords(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) {
    const remainder = n % 10;
    return TENS[Math.floor(n / 10)] + (remainder ? '-' + ONES[remainder] : '');
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return ONES[hundreds] + ' Hundred' + (rest ? ' ' + threeDigitsToWords(rest) : '');
}

const MAGNITUDES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

/** Convert a non-negative integer to English words. Returns 'Zero' for 0. */
function integerToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'Zero';
  n = Math.floor(n);
  if (n === 0) return 'Zero';

  const parts: string[] = [];
  let magnitude = 0;

  while (n > 0) {
    const chunk = n % 1000;
    if (chunk !== 0) {
      const chunkWords = threeDigitsToWords(chunk);
      parts.unshift(
        magnitude > 0 ? chunkWords + ' ' + MAGNITUDES[magnitude] : chunkWords,
      );
    }
    n = Math.floor(n / 1000);
    magnitude++;
  }

  return parts.join(' ');
}

/**
 * Convert a decimal amount (string or number) to the check-style
 * "One Hundred Twenty-Three and 45/100" format.
 *
 * Exported so it can be tested and reused by the UI for live preview.
 */
export function numberToWords(amount: string | number): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!Number.isFinite(n) || n < 0) return 'Zero and 00/100';

  const dollars = Math.floor(n);
  const cents = Math.round((n - dollars) * 100);
  const centsStr = String(cents).padStart(2, '0');

  const dollarWords = integerToWords(dollars);
  return `${dollarWords} and ${centsStr}/100`;
}

// ---------------------------------------------------------------------------
// Check PDF data types
// ---------------------------------------------------------------------------

export interface VoucherLine {
  /** GL account label, e.g. "5000 – Office Supplies". */
  account: string;
  description?: string | null;
  /** Decimal string, e.g. "120.50". */
  amount: string;
}

export interface CheckPdfData {
  /** Payer / company name — printed top-left as the drawer. */
  company: { name: string };
  /** Name of the payee (individual or vendor). */
  payee: string;
  /** Dollar amount as a decimal string, e.g. "1234.56". */
  amountNumeric: string;
  /** Pre-computed words; if omitted, derived from amountNumeric. */
  amountWords?: string;
  /** ISO date string YYYY-MM-DD or any human-readable date. */
  date: string;
  /** Optional memo / note line. */
  memo?: string | null;
  /** Optional check number — printed top-right. */
  checkNumber?: string | number | null;
  /**
   * Optional voucher stub lines (QB voucher-check style) — the expense/bill
   * detail behind the check, printed in the lower portion of the page.
   */
  voucher?: VoucherLine[];
  /** Check style (default 'voucher'). */
  style?: CheckStyle;
  /** Printer alignment nudge in inches (positive x = right, positive y = up). */
  offset?: { x?: number | string | null; y?: number | string | null };
}

export type CheckStyle = 'voucher' | 'standard' | 'wallet';
export const CHECK_STYLES: CheckStyle[] = ['voucher', 'standard', 'wallet'];
/** Largest alignment nudge accepted (inches). */
export const MAX_CHECK_OFFSET_IN = 1;

/** Clamp an inch offset to +/- MAX_CHECK_OFFSET_IN and convert to PDF points. */
export function offsetToPoints(v: number | string | null | undefined): number {
  let n: number;
  try {
    n = typeof v === 'string' ? Money.of(v.trim() || '0').toNumber() : (v ?? 0);
  } catch {
    return 0;
  }
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.max(-MAX_CHECK_OFFSET_IN, Math.min(MAX_CHECK_OFFSET_IN, n));
  return Math.round(clamped * 72 * 100) / 100;
}

// ---------------------------------------------------------------------------
// Layout constants (US Letter)
// ---------------------------------------------------------------------------

const PAGE_W = PageSizes.Letter[0]; // 612 pt
const PAGE_H = PageSizes.Letter[1]; // 792 pt

// The check body occupies the top ~3.5 inches (252 pt) of the page.
// A real personal check is ~2.75" tall in a continuous form; we give it
// generous breathing room on Letter paper.
const CHECK_TOP = PAGE_H - 48;      // 744 pt from bottom
const CHECK_BOTTOM = PAGE_H - 300;  // 492 pt from bottom

const PAGE_ML = 48;                 // page left margin
const PAGE_MR = PAGE_W - 48;        // page right margin
const WALLET_STUB_W = 162;          // 2.25" register stub on wallet checks

// Colors
const C_NAVY  = rgb(0.09, 0.13, 0.27);
const C_GRAY  = rgb(0.45, 0.45, 0.50);
const C_LIGHT = rgb(0.82, 0.86, 0.90);
const C_BLACK = rgb(0, 0, 0);

// ---------------------------------------------------------------------------
// renderCheckPdf
// ---------------------------------------------------------------------------

export async function renderCheckPdf(data: CheckPdfData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  const style: CheckStyle = data.style && CHECK_STYLES.includes(data.style) ? data.style : 'voucher';
  // Printer alignment: shift everything drawn on the page.
  const dx = offsetToPoints(data.offset?.x);
  const dy = offsetToPoints(data.offset?.y);
  if (dx !== 0 || dy !== 0) page.translateContent(dx, dy);

  // Wallet checks leave a register stub on the left; the check body moves right.
  const ML = style === 'wallet' ? PAGE_ML + WALLET_STUB_W : PAGE_ML;
  const MR = PAGE_MR;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function hRule(y: number, x1 = ML, x2 = MR, thickness = 0.5, color = C_LIGHT) {
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  function text(
    s: string,
    x: number,
    y: number,
    opts: { size?: number; font?: typeof regular; color?: typeof C_BLACK; rightAlign?: boolean } = {},
  ) {
    const { size = 10, font = regular, color = C_BLACK, rightAlign = false } = opts;
    const drawX = rightAlign ? x - font.widthOfTextAtSize(s, size) : x;
    page.drawText(s, { x: drawX, y, font, size, color });
  }

  // -------------------------------------------------------------------------
  // Outer check border
  // -------------------------------------------------------------------------

  page.drawRectangle({
    x: ML - 4,
    y: CHECK_BOTTOM - 4,
    width: MR - ML + 8,
    height: CHECK_TOP - CHECK_BOTTOM + 8,
    borderColor: C_LIGHT,
    borderWidth: 1,
    color: rgb(1, 1, 1), // white fill
    opacity: 0,
  });

  // -------------------------------------------------------------------------
  // ROW 1 — Company name (top-left) + Check number (top-right)
  // -------------------------------------------------------------------------

  let cursor = CHECK_TOP - 2;

  text(data.company.name, ML, cursor, { font: bold, size: 13, color: C_NAVY });

  if (data.checkNumber != null && String(data.checkNumber).trim() !== '') {
    const checkNumStr = `Check #${data.checkNumber}`;
    text(checkNumStr, MR, cursor, { font: bold, size: 10, color: C_NAVY, rightAlign: true });
  }

  cursor -= 16;

  // Company subtitle label
  text('Payer', ML, cursor, { size: 8, color: C_GRAY });

  cursor -= 20;
  hRule(cursor, ML, MR, 0.75, C_LIGHT);
  cursor -= 18;

  // -------------------------------------------------------------------------
  // ROW 2 — Date (right-aligned)
  // -------------------------------------------------------------------------

  const DATE_LABEL_X = MR - 160;

  text('Date', DATE_LABEL_X, cursor, { size: 8, color: C_GRAY });

  const dateLineY = cursor;
  hRule(dateLineY - 14, DATE_LABEL_X + 28, MR, 0.75, C_NAVY);

  text(data.date, MR, dateLineY - 12, { size: 10, color: C_BLACK, rightAlign: true });

  cursor -= 38;

  // -------------------------------------------------------------------------
  // ROW 3 — "Pay to the Order of" + payee + amount box
  // -------------------------------------------------------------------------

  const AMOUNT_BOX_W = 110;
  const AMOUNT_BOX_X = MR - AMOUNT_BOX_W;
  const PAYEE_LINE_END = AMOUNT_BOX_X - 10;

  // Label
  text('Pay to the Order of', ML, cursor, { size: 8, color: C_GRAY });
  cursor -= 14;

  // Payee name
  const payeeY = cursor;
  text(data.payee, ML, payeeY, { font: bold, size: 12, color: C_BLACK });

  // Payee underline (fill up to the amount box)
  hRule(payeeY - 3, ML, PAYEE_LINE_END, 0.75, C_NAVY);

  // Amount box (border rectangle)
  const BOX_H = 22;
  page.drawRectangle({
    x: AMOUNT_BOX_X,
    y: payeeY - BOX_H + 12,
    width: AMOUNT_BOX_W,
    height: BOX_H,
    borderColor: C_NAVY,
    borderWidth: 1,
  });

  // Dollar sign inside box
  text('$', AMOUNT_BOX_X + 6, payeeY, { size: 11, color: C_NAVY });

  // Numeric amount right-aligned inside box
  const numDisplay = fmtAmount(data.amountNumeric) ?? data.amountNumeric;

  text(numDisplay, MR - 6, payeeY, {
    font: bold,
    size: 11,
    color: C_BLACK,
    rightAlign: true,
  });

  cursor -= 34;

  // -------------------------------------------------------------------------
  // ROW 4 — Amount in words
  // -------------------------------------------------------------------------

  const words = data.amountWords ?? numberToWords(data.amountNumeric);

  text('Amount', ML, cursor, { size: 8, color: C_GRAY });
  cursor -= 14;

  const wordsY = cursor;
  text(words, ML, wordsY, { font: oblique, size: 10, color: C_BLACK });

  // Trailing fill rule after the words
  const wordsW = oblique.widthOfTextAtSize(words, 10);
  const fillStart = ML + wordsW + 6;
  if (fillStart < MR - 20) {
    hRule(wordsY - 2, fillStart, MR - 6, 0.5, C_GRAY);
  }

  // "DOLLARS" suffix right-aligned on the same baseline
  text('DOLLARS', MR, wordsY, { size: 8, color: C_GRAY, rightAlign: true });

  hRule(wordsY - 14, ML, MR, 0.75, C_NAVY);

  cursor -= 40;

  // -------------------------------------------------------------------------
  // ROW 5 — Memo (left) + Signature line (right)
  // -------------------------------------------------------------------------

  const SIG_LINE_X = ML + (MR - ML) * 0.55;

  // Memo
  text('Memo', ML, cursor, { size: 8, color: C_GRAY });
  hRule(cursor - 14, ML, SIG_LINE_X - 20, 0.75, C_NAVY);
  if (data.memo) {
    text(data.memo, ML, cursor - 12, { size: 9, color: C_BLACK });
  }

  // Signature
  text('Authorized Signature', SIG_LINE_X, cursor, { size: 8, color: C_GRAY });
  hRule(cursor - 14, SIG_LINE_X, MR, 0.75, C_NAVY);

  cursor -= 30;

  // -------------------------------------------------------------------------
  // MICR area (decorative — shows the routing/account number zone)
  // -------------------------------------------------------------------------

  const MICR_Y = CHECK_BOTTOM + 10;
  hRule(MICR_Y + 18, ML, MR, 0.5, C_LIGHT);
  hRule(MICR_Y, ML, MR, 0.5, C_LIGHT);

  // Plain ASCII: the standard Helvetica (WinAnsi) font cannot encode the MICR symbols.
  text('|: ROUTING |:  ACCOUNT  |:  CHECK#', ML + 4, MICR_Y + 5, {
    size: 7,
    color: C_LIGHT,
  });

  // -------------------------------------------------------------------------
  // Footer stub — "NOT NEGOTIABLE / VOID IF NOT USED WITHIN 90 DAYS"
  // -------------------------------------------------------------------------

  const STUB_Y = CHECK_BOTTOM - 30;
  const disclaimer = 'VOID AFTER 90 DAYS  —  NOT NEGOTIABLE WITHOUT AUTHORIZED SIGNATURE';
  const dW = regular.widthOfTextAtSize(disclaimer, 7);
  page.drawText(disclaimer, {
    x: (PAGE_W - dW) / 2,
    y: STUB_Y,
    font: regular,
    size: 7,
    color: C_GRAY,
  });

  // -------------------------------------------------------------------------
  // Voucher stub — expense/bill detail behind the check (QB voucher checks)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Wallet stub — date / payee / amount / memo for the checkbook register
  // -------------------------------------------------------------------------

  if (style === 'wallet') {
    const sx = PAGE_ML;
    const sw = WALLET_STUB_W - 16;
    page.drawLine({
      start: { x: ML - 10, y: CHECK_TOP + 4 },
      end: { x: ML - 10, y: CHECK_BOTTOM - 4 },
      thickness: 0.5,
      color: C_GRAY,
      dashArray: [3, 3],
    });
    let sy = CHECK_TOP - 2;
    const stub = (label: string, value: string) => {
      page.drawText(label, { x: sx, y: sy, font: regular, size: 7, color: C_GRAY });
      sy -= 11;
      let v = value;
      while (v.length > 0 && regular.widthOfTextAtSize(v, 9) > sw) v = v.slice(0, -1);
      page.drawText(v, { x: sx, y: sy, font: bold, size: 9, color: C_BLACK });
      sy -= 18;
    };
    if (data.checkNumber != null && String(data.checkNumber).trim() !== '') stub('Check #', String(data.checkNumber));
    stub('Date', data.date);
    stub('To', data.payee);
    stub('Amount', fmtAmount(data.amountNumeric) ?? data.amountNumeric);
    if (data.memo) stub('Memo', data.memo);
  }

  if (style === 'voucher' && data.voucher && data.voucher.length > 0) {
    let vy = STUB_Y - 36;

    text('VOUCHER', ML, vy, { font: bold, size: 10, color: C_NAVY });
    const headRight =
      `${data.payee}` +
      (data.checkNumber != null && String(data.checkNumber).trim() !== ''
        ? `  —  Check #${data.checkNumber}`
        : '') +
      `  —  ${data.date}`;
    text(headRight, MR, vy, { size: 8, color: C_GRAY, rightAlign: true });
    vy -= 8;
    hRule(vy, ML, MR, 0.75, C_NAVY);
    vy -= 14;

    // Column headers
    const AMT_X = MR;
    const DESC_X = ML + (MR - ML) * 0.45;
    text('Account', ML, vy, { font: bold, size: 8, color: C_GRAY });
    text('Description', DESC_X, vy, { font: bold, size: 8, color: C_GRAY });
    text('Amount', AMT_X, vy, { font: bold, size: 8, color: C_GRAY, rightAlign: true });
    vy -= 6;
    hRule(vy, ML, MR, 0.5, C_LIGHT);
    vy -= 12;

    let voucherTotal = Money.zero();
    for (const line of data.voucher) {
      if (vy < 48) break; // never run off the page
      text(line.account.slice(0, 48), ML, vy, { size: 9, color: C_BLACK });
      if (line.description) {
        text(line.description.slice(0, 40), DESC_X, vy, { size: 9, color: C_GRAY });
      }
      const amtDisplay = fmtAmount(line.amount);
      if (amtDisplay !== null) voucherTotal = voucherTotal.plus(Money.of(line.amount));
      const amtDisplayOrRaw = amtDisplay ?? line.amount;
      text(amtDisplayOrRaw, AMT_X, vy, { size: 9, color: C_BLACK, rightAlign: true });
      vy -= 14;
    }

    hRule(vy + 6, DESC_X, MR, 0.5, C_LIGHT);
    text('Total', DESC_X, vy - 4, { font: bold, size: 9, color: C_NAVY });
    text(
      fmtAmount(voucherTotal.toFixed(2)) ?? '0.00',
      AMT_X,
      vy - 4,
      { font: bold, size: 9, color: C_NAVY, rightAlign: true },
    );
  }

  // -------------------------------------------------------------------------
  // Finalize
  // -------------------------------------------------------------------------

  return pdfDoc.save();
}
