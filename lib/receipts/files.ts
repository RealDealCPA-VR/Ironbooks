/**
 * Receipt upload checks (receipt capture): which files are accepted, how big they may be, and
 * what they really are. Pure (no I/O) so the desktop drop zone, the Receipts page and the phone
 * upload page share one rulebook, and it is unit-tested.
 *
 * The declared type (browser / phone) is never trusted: the first bytes decide. A file whose
 * bytes are not a JPEG, PNG, WebP, HEIC/HEIF photo or a PDF is refused, whatever its name says.
 */

export type ReceiptFileKind = 'pdf' | 'jpeg' | 'png' | 'webp' | 'heic';

export const RECEIPT_MIME: Record<ReceiptFileKind, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
};

const EXT: Record<ReceiptFileKind, string> = { pdf: 'pdf', jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic' };

/** What the file picker / drop zone offers (the server still checks the bytes). */
export const RECEIPT_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf';

/** Largest receipt from this computer (same as the Doc Center limit). */
export const RECEIPT_MAX_BYTES = 25 * 1024 * 1024;
/** Largest receipt from a phone link. */
export const MOBILE_MAX_BYTES = 15 * 1024 * 1024;

/** Kinds the offline reader can read text from (HEIC photos are stored but can't be read). */
export function isReadableKind(kind: ReceiptFileKind): boolean {
  return kind !== 'heic';
}

const ascii = (b: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...Array.from(b.subarray(start, start + len)));

/** Identify a receipt file from its first bytes; null when it is not an accepted kind. */
export function sniffReceiptKind(bytes: Uint8Array): ReceiptFileKind | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  // PDF: "%PDF-" within the first 1 KB (some generators prepend a few bytes).
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024));
  if (head.indexOf('%PDF-') !== -1 && head.indexOf('%PDF-') < 1024) return 'pdf';
  // HEIC / HEIF (ISO-BMFF): size + "ftyp" + brand.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

export class ReceiptFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptFileError';
  }
}

export interface CheckedReceiptFile {
  kind: ReceiptFileKind;
  mimeType: string;
  /** Safe display name, with an extension that matches the real type. */
  filename: string;
}

/**
 * Check one uploaded file: not empty, not too big, really a photo or PDF. Returns the detected
 * type and a cleaned-up filename; throws ReceiptFileError with a plain-language reason otherwise.
 */
export function checkReceiptFile(
  input: { filename?: string | null; bytes: Uint8Array },
  opts: { maxBytes?: number } = {},
): CheckedReceiptFile {
  const max = opts.maxBytes ?? RECEIPT_MAX_BYTES;
  if (!input.bytes || input.bytes.length === 0) throw new ReceiptFileError('The file is empty.');
  if (input.bytes.length > max) {
    throw new ReceiptFileError(`That file is too big. Receipts can be up to ${Math.floor(max / (1024 * 1024))} MB.`);
  }
  const kind = sniffReceiptKind(input.bytes);
  if (!kind) {
    throw new ReceiptFileError('Only photos (JPG, PNG, WebP, HEIC) and PDF files can be added as receipts.');
  }
  return { kind, mimeType: RECEIPT_MIME[kind], filename: safeReceiptName(input.filename, kind) };
}

/** A filename safe to store and show: no paths or control characters, real extension. */
export function safeReceiptName(name: string | null | undefined, kind: ReceiptFileKind): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 120).trim() || 'receipt';
  return `${stem}.${EXT[kind]}`;
}
