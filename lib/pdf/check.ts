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
 *
 * p1 purchases — check paper (`stock`):
 *   - 'preprinted' (default, QB behaviour): the bank's check paper already carries the borders,
 *     labels ("Pay to the Order of", "Dollars", "Memo"), the signature line, the check number and
 *     the MICR line. Only the variable fields are printed — date, payee, numeric amount, amount in
 *     words, memo — at the QB voucher / standard / wallet field positions (PREPRINTED_FIELDS),
 *     shifted by the saved alignment offsets; voucher stubs get the detail lines.
 *   - 'blank': the full check layout above (border, labels, amount box) on plain paper. No MICR
 *     line is printed: real MICR needs the bank routing/account numbers and a MICR E-13B font,
 *     which are not available, and a fake one would be rejected by the bank.
 *
 * Any check stock (Deluxe, Intuit, Costco, Harland, VersaCheck-style blank stock…):
 *   - `position` ('top' | 'middle' | 'bottom'): which third of the sheet holds the check on
 *     voucher / wallet stock; voucher stubs fill the other two. Standard checks pack three per
 *     sheet; `firstSheetRemaining` (1-3) skips the used checks at the top of a partly used sheet.
 *   - `layout`: per-company field positions (see ./checkLayout) — defaults = PREPRINTED_FIELDS,
 *     plus optional payee address (window envelopes), check number and company name/address.
 *   - `checkHeight` (2.75-3.67", default 3.5") and `pageSize` ('letter' | 'legal').
 *   - renderChecksPdf renders a whole batch into one PDF.
 */

import { PDFDocument, StandardFonts, rgb, PageSizes, type PDFFont, type PDFPage } from 'pdf-lib';
import { stampSandbox } from './sandboxStamp';
import { pdfSafe } from './template';
import { Money } from '@/lib/money';
import {
  CHECKS_PER_STANDARD_SHEET,
  PAGE_SIZE_IN,
  WALLET_STUB_WIDTH_IN,
  checkWidthIn,
  normalizeCheckHeight,
  planCheckSheets,
  resolveCheckLayout,
  slotTopIn,
  type CheckLayout,
  type CheckLayoutOverrides,
  type CheckPageSize,
  type CheckPosition,
} from './checkLayout';

/** Letters with no WinAnsi form and no accent to strip (NFD leaves them whole). */
const FOLD: Record<string, string> = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŧ: 'T', ŧ: 't', Ŀ: 'L', ŀ: 'l' };

/**
 * Text the standard PDF fonts (WinAnsi) can draw. pdf-lib throws "WinAnsi cannot encode" for
 * anything else, which failed the whole check / 1099 print (HTTP 500) for a payee such as
 * "Łódź Supplies" or "Nguyễn Văn Ánh". Accented letters fold to their base letter (ễ → e, Ł → L);
 * what has no Latin form (CJK, emoji) becomes "?".
 */
export function pdfText(s: string | null | undefined): string {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    if (pdfSafe(ch) === ch) {
      out += ch;
      continue;
    }
    const folded = FOLD[ch] ?? ch.normalize('NFD').replace(/\p{M}+/gu, '');
    out += folded && pdfSafe(folded) === folded ? folded : '?';
  }
  return out;
}

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

export interface CheckPdfData extends CheckRenderSettings {
  /** Payer / company name — printed top-left as the drawer. */
  company: { name: string; addressLines?: string[] };
  /** Name of the payee (individual or vendor). */
  payee: string;
  /** Payee mailing address lines (printed only when the layout shows the address block). */
  payeeAddress?: string[] | null;
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
}

/** Printer setup applied to a whole PDF (one batch). */
export interface CheckRenderSettings {
  /** Check style (default 'voucher'). */
  style?: CheckStyle;
  /** Check paper (default 'preprinted' — print only the variable fields). */
  stock?: CheckStock;
  /** Printer alignment nudge in inches (positive x = right, positive y = up). */
  offset?: { x?: number | string | null; y?: number | string | null };
  /** Voucher / wallet: which third of the sheet holds the check (default 'top'). */
  position?: CheckPosition | null;
  /** Field-position overrides (inches from the check's top-left); null = QB defaults. */
  layout?: CheckLayoutOverrides | null;
  /** Sheet size (default 'letter'). */
  pageSize?: CheckPageSize | null;
  /** Height of one check in inches (default 3.5). */
  checkHeight?: number | string | null;
  /** Standard checks: how many unused checks are left on the first sheet (1-3, default 3). */
  firstSheetRemaining?: number | null;
}

export type CheckStyle = 'voucher' | 'standard' | 'wallet';
export const CHECK_STYLES: CheckStyle[] = ['voucher', 'standard', 'wallet'];
export type CheckStock = 'preprinted' | 'blank';
export const CHECK_STOCKS: CheckStock[] = ['preprinted', 'blank'];

/**
 * Where QB prints each variable field on pre-printed check paper, in inches from the top-left
 * corner of the check itself (one check = the top 3.5" of a Letter sheet; wallet checks sit
 * right of a 2.25" register stub and are 6.25" wide). `amountRight` / `dateX` are measured from
 * the check's right edge so the same table serves the narrower wallet check.
 * These are the DEFAULT positions: ./checkLayout (defaultCheckLayout) converts them to left-edge
 * inches per style, and a company can override every field in Printer setup.
 */
export const PREPRINTED_FIELDS = {
  /** Date: left edge, measured from the check's RIGHT edge. */
  dateFromRight: 1.85,
  dateTop: 0.82,
  payeeX: 0.95,
  payeeTop: 1.32,
  /** Numeric amount: right edge, measured from the check's RIGHT edge. */
  amountFromRight: 0.45,
  amountTop: 1.32,
  wordsX: 0.35,
  wordsTop: 1.68,
  memoX: 0.55,
  memoTop: 2.72,
  /** Voucher stubs start 3.5" and 7" from the top of the sheet. */
  stubTops: [3.5, 7.0],
  walletStubWidth: 2.25,
} as const;
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
// Layout constants
// ---------------------------------------------------------------------------

const IN = 72;                      // points per inch
const PAGE_ML = 48;                 // voucher stub left margin
const PAGE_MR = PageSizes.Letter[0] - 48; // voucher stub right margin

// Colors
const C_NAVY  = rgb(0.09, 0.13, 0.27);
const C_GRAY  = rgb(0.45, 0.45, 0.50);
const C_LIGHT = rgb(0.82, 0.86, 0.90);
const C_BLACK = rgb(0, 0, 0);

const hasNumber = (n: CheckPdfData['checkNumber']) => n != null && String(n).trim() !== '';

// ---------------------------------------------------------------------------
// renderCheckPdf / renderChecksPdf
// ---------------------------------------------------------------------------

/** One check (with its own printer settings) as a PDF. */
export async function renderCheckPdf(data: CheckPdfData): Promise<Uint8Array> {
  return renderChecksPdf([data], data);
}

/**
 * A batch of checks in ONE PDF. Standard checks are packed three per sheet (honouring
 * `firstSheetRemaining`); voucher and wallet checks print one per sheet at `position`.
 */
export async function renderChecksPdf(checks: CheckPdfData[], settings: CheckRenderSettings = checks[0] ?? {}): Promise<Uint8Array> {
  if (checks.length === 0) throw new Error('renderChecksPdf: no checks to print');
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    oblique: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
  };

  const style: CheckStyle = settings.style && CHECK_STYLES.includes(settings.style) ? settings.style : 'voucher';
  const stock: CheckStock = settings.stock === 'blank' ? 'blank' : 'preprinted';
  const sheet = PAGE_SIZE_IN[settings.pageSize === 'legal' ? 'legal' : 'letter'];
  const pageW = sheet.w * IN;
  const pageH = sheet.h * IN;
  const checkH = normalizeCheckHeight(settings.checkHeight ?? undefined);
  const layout = resolveCheckLayout(style, settings.layout);
  const dx = offsetToPoints(settings.offset?.x);
  const dy = offsetToPoints(settings.offset?.y);

  const plan = planCheckSheets(checks.length, {
    style,
    position: settings.position,
    firstSheetRemaining: settings.firstSheetRemaining,
  });
  const pages: ReturnType<typeof pdfDoc.addPage>[] = [];
  for (let i = 0; i < checks.length; i++) {
    const { sheet: s, slot } = plan[i];
    while (pages.length <= s) {
      const page = pdfDoc.addPage([pageW, pageH]);
      // Printer alignment: shift everything drawn on the page.
      if (dx !== 0 || dy !== 0) page.translateContent(dx, dy);
      pages.push(page);
    }
    drawCheck({
      page: pages[s],
      fonts,
      data: checks[i],
      style,
      stock,
      layout,
      pageH,
      checkH,
      // A 3.67" check three times over can overhang Letter by a hair: keep the slot on the sheet.
      slotTop: Math.min(slotTopIn(slot, checkH), sheet.h - checkH),
      slot,
    });
  }
  await stampSandbox(pdfDoc); // printed from a sandbox copy: stamped SANDBOX
  return pdfDoc.save();
}

type Fonts = { regular: PDFFont; bold: PDFFont; oblique: PDFFont };

interface DrawArgs {
  page: PDFPage;
  fonts: Fonts;
  data: CheckPdfData;
  style: CheckStyle;
  stock: CheckStock;
  layout: CheckLayout;
  /** Sheet height in points. */
  pageH: number;
  /** Check height in inches. */
  checkH: number;
  /** Inches from the top of the sheet to the top of this check. */
  slotTop: number;
  slot: number;
}

function drawCheck(a: DrawArgs) {
  const { page, fonts, data, style, stock, layout: L, pageH, checkH, slotTop } = a;
  const { regular, bold, oblique } = fonts;
  const checkLeft = style === 'wallet' ? WALLET_STUB_WIDTH_IN : 0;
  const checkW = checkWidthIn(style);
  /** Check-relative inches → page points. */
  const px = (xIn: number) => (checkLeft + xIn) * IN;
  const py = (yIn: number) => pageH - (slotTop + yIn) * IN;
  /** Sheet-relative inches from the top → page points. */
  const sy = (inchesFromSheetTop: number) => pageH - inchesFromSheetTop * IN;

  function text(
    s: string,
    x: number,
    y: number,
    opts: { size?: number; font?: PDFFont; color?: typeof C_BLACK; rightAlign?: boolean } = {},
  ) {
    const { size = 10, font = regular, color = C_BLACK, rightAlign = false } = opts;
    s = pdfText(s);
    if (!s) return;
    const drawX = rightAlign ? x - font.widthOfTextAtSize(s, size) : x;
    page.drawText(s, { x: drawX, y, font, size, color });
  }
  function hRule(y: number, x1: number, x2: number, thickness = 0.5, color = C_LIGHT) {
    if (x2 <= x1) return;
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }
  function fit(s: string, font: PDFFont, size: number, maxW: number) {
    let v = pdfText(s);
    while (v.length > 0 && font.widthOfTextAtSize(v, size) > maxW) v = v.slice(0, -1);
    return v;
  }

  /** Voucher detail (payee / number / date header, lines, total) from `top` down to `bottom`. */
  function drawVoucher(top: number, bottom: number) {
    if (!data.voucher || data.voucher.length === 0) return;
    const VL = PAGE_ML;
    const MR = PAGE_MR;
    let vy = top;
    text('VOUCHER', VL, vy, { font: bold, size: 10, color: C_NAVY });
    const headRight =
      `${data.payee}` + (hasNumber(data.checkNumber) ? `  —  Check #${data.checkNumber}` : '') + `  —  ${data.date}`;
    text(headRight, MR, vy, { size: 8, color: C_GRAY, rightAlign: true });
    vy -= 8;
    hRule(vy, VL, MR, 0.75, C_NAVY);
    vy -= 14;

    const AMT_X = MR;
    const DESC_X = VL + (MR - VL) * 0.45;
    text('Account', VL, vy, { font: bold, size: 8, color: C_GRAY });
    text('Description', DESC_X, vy, { font: bold, size: 8, color: C_GRAY });
    text('Amount', AMT_X, vy, { font: bold, size: 8, color: C_GRAY, rightAlign: true });
    vy -= 6;
    hRule(vy, VL, MR, 0.5, C_LIGHT);
    vy -= 12;

    let voucherTotal = Money.zero();
    for (const line of data.voucher) {
      if (vy < bottom + 18) break; // never run off the stub
      text(line.account.slice(0, 48), VL, vy, { size: 9, color: C_BLACK });
      if (line.description) {
        text(line.description.slice(0, 40), DESC_X, vy, { size: 9, color: C_GRAY });
      }
      const amtDisplay = fmtAmount(line.amount);
      if (amtDisplay !== null) voucherTotal = voucherTotal.plus(Money.of(line.amount));
      text(amtDisplay ?? line.amount, AMT_X, vy, { size: 9, color: C_BLACK, rightAlign: true });
      vy -= 14;
    }

    hRule(vy + 6, DESC_X, MR, 0.5, C_LIGHT);
    text('Total', DESC_X, vy - 4, { font: bold, size: 9, color: C_NAVY });
    text(fmtAmount(voucherTotal.toFixed(2)) ?? '0.00', AMT_X, vy - 4, {
      font: bold,
      size: 9,
      color: C_NAVY,
      rightAlign: true,
    });
  }

  /** Voucher checks: the detail stub in every other slot of the sheet. */
  function drawVoucherStubs() {
    if (style !== 'voucher') return;
    for (let s = 0; s < CHECKS_PER_STANDARD_SHEET; s++) {
      const top = s * checkH;
      if (Math.abs(top - slotTop) < 1e-6 || top + 0.5 > pageH / IN) continue;
      // Stubs never overlap the check itself.
      const bottom = top < slotTop ? Math.min(top + checkH, slotTop) : top + checkH;
      drawVoucher(sy(top) - 24, sy(bottom) + 12);
    }
  }

  const words = pdfText(data.amountWords ?? numberToWords(data.amountNumeric));
  const amount = fmtAmount(data.amountNumeric) ?? data.amountNumeric;
  const payeeAddress = (data.payeeAddress ?? []).filter((l) => l && l.trim());
  const companyAddress = (data.company.addressLines ?? []).filter((l) => l && l.trim());

  /** Multi-line block starting at a field's baseline. */
  function block(lines: string[], f: { x: number; y: number; size: number }, first?: { font: PDFFont; size: number }) {
    let y = py(f.y);
    lines.forEach((l, i) => {
      const font = i === 0 && first ? first.font : regular;
      const size = i === 0 && first ? first.size : f.size;
      text(fit(l, font, size, Math.max(36, (checkW - f.x - 0.2) * IN)), px(f.x), y, { size, font });
      y -= size * 1.2;
    });
  }

  // -------------------------------------------------------------------------
  // Pre-printed check paper: only the variable fields (QB default)
  // -------------------------------------------------------------------------

  if (stock === 'preprinted') {
    text(data.date, px(L.date.x), py(L.date.y), { size: L.date.size });
    text(data.payee, px(L.payee.x), py(L.payee.y), { size: L.payee.size });
    // QB fills the amount field with asterisks so nothing can be added in front of it.
    text(`**${amount}`, px(L.amount.x), py(L.amount.y), { size: L.amount.size, rightAlign: true });
    const maxWordsW = px(L.amount.x) - px(L.words.x);
    let wordsLine = `${words}*****`;
    while (wordsLine.length < 160 && regular.widthOfTextAtSize(`${wordsLine}*`, L.words.size) < maxWordsW) wordsLine += '*';
    text(wordsLine, px(L.words.x), py(L.words.y), { size: L.words.size });
    if (data.memo) text(data.memo.slice(0, 60), px(L.memo.x), py(L.memo.y), { size: L.memo.size });
    if (L.address.show && payeeAddress.length > 0) block([data.payee, ...payeeAddress], L.address);
    if (L.checkNumber.show && hasNumber(data.checkNumber)) {
      text(String(data.checkNumber), px(L.checkNumber.x), py(L.checkNumber.y), { size: L.checkNumber.size });
    }
    if (L.company.show) {
      block([data.company.name, ...companyAddress], L.company, { font: bold, size: L.company.size });
    }

    if (style === 'wallet') {
      // Register stub values (labels are printed on the stub already).
      const sx = 0.3 * IN;
      let y = py(0.82);
      for (const v of [data.date, data.payee, amount, data.memo ?? '']) {
        const s = fit(v, regular, 9, (WALLET_STUB_WIDTH_IN - 0.5) * IN);
        if (s) text(s, sx, y, { size: 9 });
        y -= 0.4 * IN;
      }
    }
    drawVoucherStubs();
    return;
  }

  // -------------------------------------------------------------------------
  // Blank check stock: the full check, drawn inside this check's slot around the field positions
  // -------------------------------------------------------------------------

  const left = px(0);
  const right = px(checkW);
  page.drawRectangle({
    x: left + 0.12 * IN,
    y: py(checkH - 0.1),
    width: (checkW - 0.24) * IN,
    height: (checkH - 0.2) * IN,
    borderColor: C_LIGHT,
    borderWidth: 1,
    opacity: 0,
  });

  // Company (drawer) — always on blank stock, nothing is pre-printed.
  block([data.company.name, ...companyAddress], { ...L.company, size: Math.max(6, L.company.size - 2) }, {
    font: bold,
    size: L.company.size + 2,
  });
  if (hasNumber(data.checkNumber)) {
    const s = pdfText(`Check #${data.checkNumber}`);
    const x = Math.min(px(L.checkNumber.x), right - 0.2 * IN - bold.widthOfTextAtSize(s, L.checkNumber.size));
    text(s, x, py(L.checkNumber.y), { font: bold, size: L.checkNumber.size, color: C_NAVY });
  }

  // Date
  const dateX = px(L.date.x);
  text('Date', dateX - 0.4 * IN, py(L.date.y), { size: 8, color: C_GRAY });
  text(data.date, dateX, py(L.date.y), { size: L.date.size });
  hRule(py(L.date.y) - 3, dateX - 0.05 * IN, Math.min(dateX + 1.4 * IN, right - 0.2 * IN), 0.75, C_NAVY);

  // Amount box + payee line
  const amtRight = px(L.amount.x);
  const boxW = 1.5 * IN;
  const boxLeft = amtRight + 0.1 * IN - boxW;
  page.drawRectangle({
    x: boxLeft,
    y: py(L.amount.y) - 0.1 * IN,
    width: boxW,
    height: 0.32 * IN,
    borderColor: C_NAVY,
    borderWidth: 1,
  });
  text('$', boxLeft + 0.06 * IN, py(L.amount.y), { size: L.amount.size + 1, color: C_NAVY });
  text(`**${amount}`, amtRight, py(L.amount.y), { font: bold, size: L.amount.size, rightAlign: true });

  const labelX = Math.min(px(0.35), px(L.payee.x));
  text('Pay to the Order of', labelX, py(L.payee.y) + 0.2 * IN, { size: 7, color: C_GRAY });
  text(data.payee, px(L.payee.x), py(L.payee.y), { font: bold, size: L.payee.size + 1 });
  hRule(py(L.payee.y) - 3, labelX, boxLeft - 0.1 * IN, 0.75, C_NAVY);

  // Amount in words
  text(words, px(L.words.x), py(L.words.y), { font: oblique, size: L.words.size });
  const dollarsX = amtRight + 0.1 * IN;
  const fillStart = px(L.words.x) + oblique.widthOfTextAtSize(words, L.words.size) + 6;
  hRule(py(L.words.y) + 2, fillStart, dollarsX - 0.6 * IN, 0.5, C_GRAY);
  text('DOLLARS', dollarsX, py(L.words.y), { size: 8, color: C_GRAY, rightAlign: true });
  hRule(py(L.words.y) - 3, px(L.words.x), dollarsX, 0.75, C_NAVY);

  if (L.address.show && payeeAddress.length > 0) block([data.payee, ...payeeAddress], L.address);

  // Memo (left) + signature (right)
  const sigX = left + checkW * IN * 0.55;
  const memoLabelX = Math.max(left + 0.2 * IN, px(L.memo.x) - 0.35 * IN);
  text('Memo', memoLabelX, py(L.memo.y), { size: 7, color: C_GRAY });
  if (data.memo) text(fit(data.memo, regular, L.memo.size, sigX - 0.3 * IN - px(L.memo.x)), px(L.memo.x), py(L.memo.y), { size: L.memo.size });
  hRule(py(L.memo.y) - 3, memoLabelX, sigX - 0.2 * IN, 0.75, C_NAVY);
  hRule(py(L.memo.y) - 3, sigX, right - 0.3 * IN, 0.75, C_NAVY);
  text('Authorized Signature', sigX, py(L.memo.y) - 13, { size: 7, color: C_GRAY });

  // No MICR line: real MICR needs the bank routing / account numbers and a MICR E-13B font
  // (neither is available), and a fake one only gets the check rejected.
  const disclaimer = 'VOID AFTER 90 DAYS  —  NOT NEGOTIABLE WITHOUT AUTHORIZED SIGNATURE';
  if (checkH - 0.2 > L.memo.y + 0.3) {
    const w = regular.widthOfTextAtSize(disclaimer, 6);
    text(disclaimer, left + (checkW * IN - w) / 2, py(checkH - 0.2), { size: 6, color: C_GRAY });
  }

  // Wallet stub — date / payee / amount / memo for the checkbook register
  if (style === 'wallet') {
    const stubX = 0.3 * IN;
    const stubW = (WALLET_STUB_WIDTH_IN - 0.5) * IN;
    page.drawLine({
      start: { x: left - 0.05 * IN, y: py(0.1) },
      end: { x: left - 0.05 * IN, y: py(checkH - 0.1) },
      thickness: 0.5,
      color: C_GRAY,
      dashArray: [3, 3],
    });
    let y = py(0.35);
    const stub = (label: string, value: string) => {
      text(label, stubX, y, { size: 7, color: C_GRAY });
      y -= 11;
      text(fit(value, bold, 9, stubW), stubX, y, { font: bold, size: 9 });
      y -= 18;
    };
    if (hasNumber(data.checkNumber)) stub('Check #', String(data.checkNumber));
    stub('Date', data.date);
    stub('To', data.payee);
    stub('Amount', amount);
    if (data.memo) stub('Memo', data.memo);
  }

  drawVoucherStubs();
}
