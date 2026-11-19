/**
 * Security 1.4 — a PDF with one enormous image (lib/receipts/pdfText.ts, lib/receipts/png.ts).
 *
 * The page image of a "scanned" receipt or statement is decoded and copied at the size the PDF
 * declares: an 18 KB PDF with a 12,000 x 12,000 1-bit image used 550 MB on the server that also
 * hosts the database. Images above 40 million pixels (a 600-dpi Letter or A4 scan is ~34 million)
 * are now dropped by pdf.js before decoding (maxImageSize) and skipped by our own code too; the
 * page then falls through to the normal "no scan on this page" path.
 */
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { MAX_IMAGE_PIXELS, encodePng, expand1bpp, imageSizeOk } from './png';
import { imageToPng, pageImages, readPdfDocument, type PdfImage } from './pdfText';

/** A one-page PDF whose only content is a DeviceGray 1-bit image of w x h pixels. */
function pdfWithImage(w: number, h: number): Buffer {
  const pixels = zlib.deflateSync(Buffer.alloc(Math.ceil(w / 8) * h, 0xff));
  const content = Buffer.from(`q 612 0 0 792 0 0 cm /Im1 Do Q`);
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    parts.push(buf);
    length += buf.length;
  };
  const obj = (n: number, body: string, stream?: Buffer) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>');
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${pixels.length} >>`, pixels);
  obj(5, `<< /Length ${content.length} >>`, content);
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

describe('oversized PDF images are skipped, never allocated', () => {
  it('the cap still reads a 600-dpi Letter or A4 page scan', () => {
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
    expect(imageSizeOk(5100, 6600)).toBe(true); // Letter at 600 dpi
    expect(imageSizeOk(4961, 7016)).toBe(true); // A4 at 600 dpi
    expect(imageSizeOk(12_000, 12_000)).toBe(false);
    expect(imageSizeOk(0, 10)).toBe(false);
    expect(imageSizeOk(Number.NaN, 10)).toBe(false);
  });

  it('imageToPng / expand1bpp / encodePng refuse a huge declared size before allocating', () => {
    const huge: PdfImage = { width: 8000, height: 6000, kind: 1, data: new Uint8Array(16) };
    expect(imageToPng(huge)).toBeNull();
    expect(imageToPng({ ...huge, kind: 2 })).toBeNull();
    expect(() => expand1bpp(100_000, 100_000, new Uint8Array(16))).toThrow(/too large/);
    expect(() => encodePng(100_000, 100_000, new Uint8Array(16), 1)).toThrow(/too large/);
    // A normal image still converts.
    const png = imageToPng({ width: 16, height: 2, kind: 1, data: new Uint8Array(4).fill(0xaa) });
    expect(png?.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('pageImages leaves out an oversize image, so it neither allocates nor hides the real page image', async () => {
    const OPS = { paintImageXObject: 85, paintInlineImageXObject: 86 };
    const normal: PdfImage = { width: 200, height: 100, kind: 1, data: new Uint8Array(25 * 100).fill(0xff) };
    const huge: PdfImage = { width: 20_000, height: 20_000, kind: 1, data: new Uint8Array(16) };
    const page = {
      getOperatorList: async () => ({ fnArray: [OPS.paintInlineImageXObject, OPS.paintInlineImageXObject], argsArray: [[huge], [normal]] }),
      objs: { get: () => undefined },
    };
    const out = await pageImages({ OPS }, page);
    expect(out.map((o) => o.area)).toEqual([200 * 100]);
    // A page whose only image is too large has no scan images.
    const onlyHuge = { ...page, getOperatorList: async () => ({ fnArray: [OPS.paintInlineImageXObject], argsArray: [[huge]] }) };
    expect(await pageImages({ OPS }, onlyHuge)).toEqual([]);
  });

  it('a real 18 KB PDF with a 12,000 x 12,000 image reads as a page with no scan (and a normal scan still reads)', async () => {
    const bomb = pdfWithImage(12_000, 12_000);
    expect(bomb.length).toBeLessThan(40_000);
    const before = process.memoryUsage().arrayBuffers;
    const doc = await readPdfDocument(bomb, { maxPages: 1, maxScannedPages: 1 });
    expect(doc.pages).toBe(1);
    expect(doc.pageList[0].scan).toBeNull();
    expect(doc.scans).toEqual([]);
    // Nothing near the 144 MB the expanded image would take was kept.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);

    const ok = await readPdfDocument(pdfWithImage(1700, 2200), { maxPages: 1, maxScannedPages: 1 });
    expect(ok.pageList[0].scan?.length).toBe(1);
    expect(ok.scans.length).toBe(1);
  }, 60_000);
});
