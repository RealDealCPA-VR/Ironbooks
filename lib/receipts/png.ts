/**
 * Minimal PNG encoder (receipt capture): turns raw pixels pulled out of a scanned PDF into a PNG
 * the offline OCR engine can read. Node-only (zlib). 8-bit grayscale, RGB or RGBA, no filtering.
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** channels: 1 = gray, 3 = RGB, 4 = RGBA. `pixels` is row-major, `width * height * channels` bytes. */
export function encodePng(width: number, height: number, pixels: Uint8Array, channels: 1 | 3 | 4): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Invalid image size.');
  }
  const stride = width * channels;
  if (pixels.length < stride * height) throw new Error('Not enough pixel data.');
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6; // color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Expand pdf.js 1-bit-per-pixel grayscale (kind 1) to 8-bit gray. */
export function expand1bpp(width: number, height: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(width * height);
  const rowBytes = (width + 7) >> 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      out[y * width + x] = bit ? 255 : 0;
    }
  }
  return out;
}
