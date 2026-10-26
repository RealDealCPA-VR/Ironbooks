/**
 * Generic tabular PDF renderer for financial reports, built on pdf-lib
 * (already a dependency — also used by the statement PDFs).
 *
 * Renders: company name, report title, subtitle/date range, a column header
 * band repeated on every page, data rows (numeric columns right-aligned),
 * optional emphasized totals rows, page numbers, and a generated-at footer.
 * Supports portrait and landscape US Letter.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { stampSandbox } from '@/lib/pdf/sandboxStamp';

export interface PdfColumn {
  header: string;
  /** Right-align (money/qty) columns. */
  numeric?: boolean;
}

export type PdfCell = string | number | null | undefined;

export interface ReportPdfInput {
  title: string;
  /** Company name shown above the title. */
  company?: string;
  /** Subtitle / date-range line under the title. */
  subtitle?: string;
  columns: PdfColumn[];
  rows: PdfCell[][];
  /** Totals/footer rows rendered bold under a rule. */
  totals?: PdfCell[][];
  /** Landscape US Letter (792x612) instead of portrait (612x792). */
  landscape?: boolean;
}

const LETTER: [number, number] = [612, 792];
const MARGIN = 40;
const HEADER_FONT_SIZE = 8.5;
const BODY_FONT_SIZE = 8.5;
const ROW_HEIGHT = 14;
const NAVY = rgb(0.1, 0.15, 0.3);
const GRAY = rgb(0.45, 0.48, 0.55);
const RULE = rgb(0.75, 0.78, 0.84);

function cellText(value: PdfCell): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Look-alikes for characters the standard (WinAnsi) fonts cannot draw. */
const PDF_STAND_INS: Record<string, string> = { '✓': 'X', '✔': 'X', '✗': 'x', '✘': 'x', '−': '-', '\u2009': ' ', '\u202F': ' ' };

const charsets = new WeakMap<PDFFont, Set<number>>();

/**
 * Text the font can draw: every character of its character set is kept (for Helvetica that is
 * WinAnsi: accented letters, en / em dashes, curly quotes, the euro sign, …), line breaks and
 * tabs become spaces, a check mark becomes X, anything else '?'. pdf-lib throws on a character
 * outside the font's encoding; keeping only Latin-1 instead turned every report's
 * "01/01/2026 – 03/31/2026" subtitle into "01/01/2026 ? 03/31/2026".
 */
export function pdfSafeText(text: string, font: PDFFont): string {
  let set = charsets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charsets.set(font, set);
  }
  let out = '';
  for (const ch of text) {
    if (ch === '\n' || ch === '\r' || ch === '\t') out += ' ';
    else if (set.has(ch.codePointAt(0)!)) out += ch;
    else out += PDF_STAND_INS[ch] ?? '?';
  }
  return out;
}

/** Truncate text (with ellipsis) so it fits in maxWidth at the given size. */
function fitText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  // pdf-lib's WinAnsi encoder throws on characters outside the codepage — replace them rather
  // than fail the whole export.
  let t = pdfSafeText(text, font);
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}…`;
}

/**
 * Distribute the available width across columns, weighted by the wider of the
 * header and the longest sampled cell, with a sane minimum per column.
 */
function computeColumnWidths(
  columns: PdfColumn[],
  rows: PdfCell[][],
  font: PDFFont,
  available: number,
): number[] {
  const sample = rows.slice(0, 200);
  const weights = columns.map((col, i) => {
    let max = font.widthOfTextAtSize(pdfSafeText(col.header, font), HEADER_FONT_SIZE);
    for (const row of sample) {
      const text = cellText(row[i]);
      if (!text) continue;
      const w = font.widthOfTextAtSize(pdfSafeText(text, font), BODY_FONT_SIZE);
      if (w > max) max = w;
    }
    return Math.min(max + 10, available); // padding; cap runaway columns
  });
  const totalWeight = weights.reduce((s, w) => s + w, 0) || 1;
  const minWidth = Math.min(45, available / columns.length);
  let widths = weights.map((w) => Math.max(minWidth, (w / totalWeight) * available));
  // Re-normalize after the min-width clamp so the table still fits the page.
  const sum = widths.reduce((s, w) => s + w, 0);
  if (sum > available) widths = widths.map((w) => (w / sum) * available);
  return widths;
}

export async function buildReportPdf(input: ReportPdfInput): Promise<Uint8Array> {
  if (!input.columns?.length) throw new Error('buildReportPdf requires at least one column.');

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const [pw, ph] = input.landscape ? [LETTER[1], LETTER[0]] : LETTER;
  const available = pw - MARGIN * 2;
  const widths = computeColumnWidths(input.columns, input.rows, font, available);
  // X offset of each column's left edge.
  const xOffsets: number[] = [];
  let acc = MARGIN;
  for (const w of widths) {
    xOffsets.push(acc);
    acc += w;
  }

  let page: PDFPage = doc.addPage([pw, ph]);
  let y = ph - MARGIN;

  const drawColumnHeaders = () => {
    input.columns.forEach((col, i) => {
      const text = fitText(col.header, bold, HEADER_FONT_SIZE, widths[i] - 6);
      const tw = bold.widthOfTextAtSize(text, HEADER_FONT_SIZE);
      const x = col.numeric ? xOffsets[i] + widths[i] - 3 - tw : xOffsets[i];
      page.drawText(text, { x, y, size: HEADER_FONT_SIZE, font: bold, color: NAVY });
    });
    y -= 5;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: pw - MARGIN, y },
      thickness: 0.8,
      color: NAVY,
    });
    y -= ROW_HEIGHT - 4;
  };

  const newPage = () => {
    page = doc.addPage([pw, ph]);
    y = ph - MARGIN;
    drawColumnHeaders();
  };

  // --- First-page report header -------------------------------------------
  if (input.company) {
    page.drawText(fitText(input.company, bold, 10, available), {
      x: MARGIN, y, size: 10, font: bold, color: GRAY,
    });
    y -= 16;
  }
  page.drawText(fitText(input.title, bold, 16, available), {
    x: MARGIN, y, size: 16, font: bold, color: NAVY,
  });
  y -= 16;
  if (input.subtitle) {
    page.drawText(fitText(input.subtitle, font, 9.5, available), {
      x: MARGIN, y, size: 9.5, font, color: GRAY,
    });
    y -= 14;
  }
  y -= 8;
  drawColumnHeaders();

  // --- Rows -----------------------------------------------------------------
  const drawRow = (cells: PdfCell[], emphasized: boolean) => {
    if (y < MARGIN + ROW_HEIGHT) newPage();
    const f = emphasized ? bold : font;
    input.columns.forEach((col, i) => {
      const raw = cellText(cells[i]);
      if (!raw) return;
      const text = fitText(raw, f, BODY_FONT_SIZE, widths[i] - 6);
      const tw = f.widthOfTextAtSize(text, BODY_FONT_SIZE);
      const x = col.numeric ? xOffsets[i] + widths[i] - 3 - tw : xOffsets[i];
      page.drawText(text, { x, y, size: BODY_FONT_SIZE, font: f, color: NAVY });
    });
    y -= ROW_HEIGHT;
  };

  for (const row of input.rows) drawRow(row, false);

  if (input.totals?.length) {
    if (y < MARGIN + ROW_HEIGHT * (input.totals.length + 1)) newPage();
    page.drawLine({
      start: { x: MARGIN, y: y + ROW_HEIGHT - 4 },
      end: { x: pw - MARGIN, y: y + ROW_HEIGHT - 4 },
      thickness: 0.8,
      color: RULE,
    });
    for (const row of input.totals) drawRow(row, true);
  }

  // --- Page numbers + footer (second pass, page count is now known) --------
  const pages = doc.getPages();
  const generated = `Generated ${new Date().toLocaleDateString('en-US')}`;
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, {
      x: pw - MARGIN - font.widthOfTextAtSize(label, 8),
      y: MARGIN / 2,
      size: 8,
      font,
      color: GRAY,
    });
    p.drawText(generated, { x: MARGIN, y: MARGIN / 2, size: 8, font, color: GRAY });
  });

  await stampSandbox(doc); // printed from a sandbox copy: stamped SANDBOX
  return doc.save();
}
