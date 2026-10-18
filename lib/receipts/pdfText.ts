/**
 * PDF receipts (receipt capture): the text layer via pdfjs-dist, fully in-process (no worker
 * thread, no network). A PDF with no text — a phone "scan to PDF" or a scanner output — has its
 * page images pulled out and encoded as PNG so the offline OCR engine can read them.
 */
import { encodePng, expand1bpp } from './png';

/** Pages read from one receipt PDF (receipts are short). Bank statements pass their own limits. */
const MAX_PAGES = 5;
/** Scanned receipt pages handed to OCR. */
const MAX_SCANNED_PAGES = 3;
/** pdf.js ImageKind */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

async function loadPdfjs() {
  // Same loading as lib/services/qbGlFiles.ts: legacy (Node) build, in-process "fake worker",
  // static specifiers so Next's standalone tracing ships both files.
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

export interface PdfReceiptContent {
  /** Text in reading order, one line per visual line. */
  text: string;
  pages: number;
  /** PNG images of scanned pages (only when the PDF has (almost) no text). */
  scans: Buffer[];
}

interface Item {
  x: number;
  y: number;
  str: string;
  size: number;
}

/** One visual line of a page: its text and the pieces it was built from, left to right. */
export interface PdfLine {
  text: string;
  cells: Array<{ x: number; str: string }>;
}

function pdfLinesFromItems(items: Item[]): PdfLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; items: Item[] }[] = [];
  for (const it of sorted) {
    const tol = Math.max(1.5, it.size * 0.3);
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((l) => {
      const cells = l.items.sort((a, b) => a.x - b.x).map((i) => ({ x: i.x, str: i.str }));
      return { text: cells.map((c) => c.str).join('  ').trim(), cells };
    })
    .filter((l) => l.text);
}

type PdfImage = { width: number; height: number; data?: Uint8Array | Uint8ClampedArray; kind?: number };

function imageToPng(img: PdfImage): Buffer | null {
  if (!img?.data || !img.width || !img.height) return null;
  const data = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  if (img.kind === GRAYSCALE_1BPP) return encodePng(img.width, img.height, expand1bpp(img.width, img.height, data), 1);
  if (img.kind === RGB_24BPP) return encodePng(img.width, img.height, data, 3);
  if (img.kind === RGBA_32BPP) return encodePng(img.width, img.height, data, 4);
  return null;
}

/** Read a PDF receipt. Throws Error('unreadable') when the file can't be opened. */
export async function readPdfReceipt(bytes: Uint8Array): Promise<PdfReceiptContent> {
  const doc = await readPdfDocument(bytes, { maxPages: MAX_PAGES, maxScannedPages: MAX_SCANNED_PAGES });
  return { text: doc.lines.map((l) => l.text).join('\n'), pages: doc.pages, scans: doc.scans };
}

export interface PdfDocumentContent {
  /** Every visual line of the pages read, in reading order, with x positions. */
  lines: PdfLine[];
  pages: number;
  /** PNG images of scanned pages (pages with (almost) no text layer). */
  scans: Buffer[];
}

/**
 * Read a PDF's text layer (and the images of scanned pages) — receipts and bank statements.
 * Throws Error('unreadable') when the file can't be opened.
 */
export async function readPdfDocument(
  bytes: Uint8Array,
  limits: { maxPages: number; maxScannedPages: number },
): Promise<PdfDocumentContent> {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
      verbosity: 0,
    }).promise;
  } catch {
    throw new Error('unreadable');
  }
  const out: PdfLine[] = [];
  const scans: Buffer[] = [];
  try {
    const pages = Math.min(doc.numPages, limits.maxPages);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const raw of content.items as Array<Record<string, unknown>>) {
        const str = typeof raw.str === 'string' ? raw.str : '';
        if (!str.trim()) continue;
        const tr = raw.transform as number[];
        items.push({ x: tr[4], y: tr[5], str, size: Math.abs(tr[3]) || Number(raw.height ?? 8) || 8 });
      }
      const lines = pdfLinesFromItems(items);
      out.push(...lines);
      // A page without a text layer is a scan: hand its largest image to OCR.
      if (lines.map((l) => l.text).join('').replace(/\s/g, '').length < 20 && scans.length < limits.maxScannedPages) {
        const png = await largestImage(pdfjs, page);
        if (png) scans.push(png);
      }
      page.cleanup();
    }
    return { lines: out, pages: doc.numPages, scans };
  } finally {
    await doc.destroy();
  }
}

async function largestImage(
  pdfjs: { OPS: Record<string, number> },
  page: { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>; objs: { get(id: string, cb?: (v: unknown) => void): unknown } },
): Promise<Buffer | null> {
  try {
    const ops = await page.getOperatorList();
    let best: PdfImage | null = null;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintInlineImageXObject) continue;
      const arg = ops.argsArray[i]?.[0];
      let img: PdfImage | null = null;
      if (arg && typeof arg === 'object') img = arg as PdfImage; // inline image
      else if (typeof arg === 'string') {
        img = await new Promise<PdfImage | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 5000);
          try {
            page.objs.get(arg, (v) => {
              clearTimeout(timer);
              resolve((v as PdfImage) ?? null);
            });
          } catch {
            clearTimeout(timer);
            resolve(null);
          }
        });
      }
      if (img?.data && (!best || img.width * img.height > best.width * best.height)) best = img;
    }
    return best ? imageToPng(best) : null;
  } catch {
    return null;
  }
}
