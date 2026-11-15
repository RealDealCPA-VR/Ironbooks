/**
 * Text encoders for files other programs read in a legacy code page (lib/textDecode.ts decodes).
 */

/** Windows-1252 bytes for 0x80–0x9F (the rest of 0x00–0xFF is Latin-1). */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * `text` as Windows-1252 bytes. A character the code page can't hold becomes "?" (QuickBooks
 * Desktop can't store it either).
 */
export function encodeWindows1252(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else if (CP1252_HIGH[cp] !== undefined) out.push(CP1252_HIGH[cp]);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

/** True when every character of `text` exists in Windows-1252 (what the PDF standard fonts draw). */
export function isWindows1252(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) continue;
    if (CP1252_HIGH[cp] === undefined) return false;
  }
  return true;
}
