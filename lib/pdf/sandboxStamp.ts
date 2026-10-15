/**
 * "SANDBOX" stamp for PDFs printed from a sandbox / training file ("Try it on a copy",
 * lib/services/sandbox.ts). Every PDF the app renders calls stampSandbox() just before saving —
 * checks, invoices and the other sales / template forms, paystubs, W-2 / W-3 / 941 / 940,
 * 1099-NEC, collection letters, labels and envelopes, packing slips, pick lists, open-item
 * statements and report PDFs — so nothing printed from a practice copy can pass for a real one.
 * Documents merged from already-stamped parts (combined packing slips, batch statements, the
 * shareable ledger summary) call tagSandbox() instead, which marks the document without
 * drawing the stamp a second time.
 *
 * lib/pdf is shared with client bundles, so this module never touches the file system: the
 * server keeps process.env.BKA_SANDBOX in step with the active company file
 * (lib/services/sandboxState.ts syncSandboxEnv; the desktop shell also sets it when it launches
 * the server on a sandbox). In a browser the flag is always off.
 */
import { StandardFonts, degrees, rgb, type PDFDocument } from 'pdf-lib';

export const SANDBOX_STAMP = 'SANDBOX';
export const SANDBOX_STAMP_NOTE = 'SANDBOX COPY - not your real books. Do not send, deposit or file this document.';

/** True on the server while the active company file is a sandbox / training file. */
export function sandboxStampActive(): boolean {
  if (typeof window !== 'undefined') return false;
  return typeof process !== 'undefined' && process.env?.BKA_SANDBOX === '1';
}

/** Stamp every page with a large diagonal "SANDBOX" and a red notice along the top edge. */
export async function stampSandbox(pdf: PDFDocument, force: boolean = sandboxStampActive()): Promise<void> {
  if (!force) return;
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const red = rgb(0.86, 0.15, 0.1);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    // Diagonal watermark across the middle of the page.
    const size = Math.max(36, Math.min(width, height) / 5);
    const w = bold.widthOfTextAtSize(SANDBOX_STAMP, size);
    const angle = Math.atan2(height, width);
    const cx = width / 2;
    const cy = height / 2;
    page.drawText(SANDBOX_STAMP, {
      x: cx - (w / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
      y: cy - (w / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
      size,
      font: bold,
      color: red,
      opacity: 0.22,
      rotate: degrees((angle * 180) / Math.PI),
    });
    // Notice band along the top edge, readable even on pre-printed check stock.
    const noteSize = 8;
    page.drawRectangle({ x: 0, y: height - 14, width, height: 14, color: rgb(1, 0.93, 0.8), opacity: 0.9 });
    page.drawText(SANDBOX_STAMP_NOTE, { x: 12, y: height - 10.5, size: noteSize, font: bold, color: red });
  }
  tagSandbox(pdf, true);
}

/**
 * Mark a document as printed from a sandbox (the SANDBOX keyword) without drawing on it — for
 * documents merged from parts that stampSandbox() already stamped.
 */
export function tagSandbox(pdf: PDFDocument, force: boolean = sandboxStampActive()): void {
  if (!force) return;
  const keywords = pdf.getKeywords()?.split(/\s+/).filter(Boolean) ?? [];
  if (!keywords.includes(SANDBOX_STAMP)) pdf.setKeywords([...keywords, SANDBOX_STAMP]);
}
