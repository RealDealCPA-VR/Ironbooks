/**
 * Bytes of an imported text file (IIF, CSV, report export) → text. Pure, no Node or DOM APIs
 * beyond TextDecoder, so the browser (file picker) and the server read a file the same way.
 *
 * QuickBooks Desktop writes IIF and CSV exports in the Windows code page ("ANSI", Windows-1252
 * in North America and Western Europe), not UTF-8 — the account-number separator "·" is byte
 * 0xB7 and "é" is 0xE9. Reading those bytes as UTF-8 turns every accented name into "�", which
 * cannot be undone, so: UTF-16 with a byte-order mark ("Unicode Text" exports), UTF-8 (with or
 * without BOM) when the bytes are valid UTF-8, otherwise Windows-1252.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}
