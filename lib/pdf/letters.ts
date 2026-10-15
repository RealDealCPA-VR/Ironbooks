/**
 * Letters, mailing labels and envelopes (QB "Prepare Letters with Envelopes" + "Print Labels").
 *
 *  - renderLettersPdf: one merged letter per page on a simple letterhead (wraps + continues).
 *  - renderLabelsPdf: Avery 5160 / 8160 sheets (30 labels: 3 x 10, 2-5/8" x 1"), with an optional
 *    starting position so a partly used sheet can be reused.
 *  - renderEnvelopesPdf: #10 business envelopes (9.5" x 4.125") with the return address top-left.
 *
 * Standard pdf-lib fonts only; nothing is fetched.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfSafe, wrapText } from './template';
import { stampSandbox } from './sandboxStamp';

const LETTER_W = 612;
const LETTER_H = 792;

export interface LetterLetterhead {
  name: string;
  addressLines: string[];
  phone?: string | null;
  email?: string | null;
}

export async function renderLettersPdf(letters: Array<{ body: string }>, letterhead: LetterLetterhead): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const margin = 72;
  const size = 11.5;
  const lead = 15;
  const gray = rgb(0.35, 0.35, 0.4);
  for (const letter of letters) {
    let page = pdf.addPage([LETTER_W, LETTER_H]);
    let y = LETTER_H - margin + 18;
    page.drawText(pdfSafe(letterhead.name), { x: margin, y, font: bold, size: 16, color: rgb(0.09, 0.13, 0.27) });
    const contact = [...letterhead.addressLines, letterhead.phone, letterhead.email].filter(Boolean).join('  |  ');
    if (contact) {
      y -= 15;
      page.drawText(pdfSafe(contact).slice(0, 110), { x: margin, y, font: regular, size: 9, color: gray });
    }
    y -= 10;
    page.drawLine({ start: { x: margin, y }, end: { x: LETTER_W - margin, y }, thickness: 0.75, color: rgb(0.8, 0.82, 0.86) });
    y -= 36;
    for (const line of wrapText(letter.body, regular, size, LETTER_W - margin * 2)) {
      if (y < margin) {
        page = pdf.addPage([LETTER_W, LETTER_H]);
        y = LETTER_H - margin;
      }
      page.drawText(line, { x: margin, y, font: regular, size });
      y -= lead;
    }
  }
  if (letters.length === 0) pdf.addPage([LETTER_W, LETTER_H]);
  await stampSandbox(pdf); // printed from a sandbox copy: stamped SANDBOX
  return pdf.save();
}

/** Avery 5160 geometry (points). */
const LABEL = {
  cols: 3,
  rows: 10,
  width: 189, // 2.625"
  height: 72, // 1"
  left: 13.5, // 0.1875"
  top: 36, // 0.5"
  hPitch: 198, // 2.75"
  vPitch: 72,
};

export async function renderLabelsPdf(addresses: string[][], opts: { startPosition?: number } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const perSheet = LABEL.cols * LABEL.rows;
  const start = Math.min(Math.max((opts.startPosition ?? 1) - 1, 0), perSheet - 1);
  let page = pdf.addPage([LETTER_W, LETTER_H]);
  let slot = start;
  for (const addr of addresses) {
    if (slot >= perSheet) {
      page = pdf.addPage([LETTER_W, LETTER_H]);
      slot = 0;
    }
    const col = slot % LABEL.cols;
    const row = Math.floor(slot / LABEL.cols);
    const x = LABEL.left + col * LABEL.hPitch + 10;
    let y = LETTER_H - LABEL.top - row * LABEL.vPitch - 18;
    addr.filter(Boolean).slice(0, 5).forEach((line, i) => {
      const f = i === 0 ? bold : font;
      let text = pdfSafe(line);
      while (text.length > 1 && f.widthOfTextAtSize(text, 9) > LABEL.width - 20) text = text.slice(0, -1);
      page.drawText(text, { x, y, font: f, size: 9 });
      y -= 11;
    });
    slot++;
  }
  await stampSandbox(pdf); // printed from a sandbox copy: stamped SANDBOX
  return pdf.save();
}

/** #10 envelope, landscape. */
const ENV_W = 684; // 9.5"
const ENV_H = 297; // 4.125"

export async function renderEnvelopesPdf(addresses: string[][], returnAddress: string[] | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const addr of addresses) {
    const page = pdf.addPage([ENV_W, ENV_H]);
    if (returnAddress) {
      let y = ENV_H - 30;
      returnAddress.filter(Boolean).slice(0, 4).forEach((line, i) => {
        page.drawText(pdfSafe(line).slice(0, 45), { x: 24, y, font: i === 0 ? bold : font, size: 9 });
        y -= 11;
      });
    }
    let y = ENV_H / 2 + 6;
    addr.filter(Boolean).slice(0, 5).forEach((line, i) => {
      page.drawText(pdfSafe(line).slice(0, 50), { x: ENV_W / 2 - 60, y, font: i === 0 ? bold : font, size: 12 });
      y -= 15;
    });
  }
  if (addresses.length === 0) pdf.addPage([ENV_W, ENV_H]);
  await stampSandbox(pdf); // printed from a sandbox copy: stamped SANDBOX
  return pdf.save();
}
