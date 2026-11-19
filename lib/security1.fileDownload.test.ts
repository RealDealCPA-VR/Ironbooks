/**
 * Security (small) — contentDisposition (lib/fileDownload.ts) for any file name.
 *
 * A lone surrogate (half an emoji, from a crafted file or row) made encodeURIComponent throw, so
 * the download answered 500; a '\' in the quoted fallback escaped the character after it (a name
 * ending in '\' left the quoted string open). Now every name gives one well-formed header.
 */
import { describe, it, expect } from 'vitest';
import { contentDisposition } from './fileDownload';

/** The parts of the header, parsed the strict way (quoted-string with escapes, RFC 5987 value). */
function parse(header: string) {
  const m = /^attachment; filename="((?:[^"\\]|\\.)*)"; filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]*)$/.exec(header);
  expect(m, header).not.toBeNull();
  return { ascii: m![1], decoded: decodeURIComponent(m![2]) };
}

describe('contentDisposition', () => {
  it('never throws, and always gives one well-formed header', () => {
    for (const name of ['a\uD83D.pdf', '\uDE00start', 'end\uD83D', 'back\\slash\\', 'q"uote".csv', "O'Brien (copy)*.pdf", 'line\r\nbreak.txt', '', '利润表 — Q1 🚀.xlsx']) {
      const header = contentDisposition(name);
      expect(header).not.toMatch(/[\r\n]/);
      const { ascii, decoded } = parse(header);
      expect(ascii).not.toMatch(/[\\"]/);
      expect(decoded).toBe(name.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�'));
    }
  });

  it('ordinary names are unchanged', () => {
    expect(contentDisposition('Acme Books 2026-01-31.ironbooks')).toBe(
      `attachment; filename="Acme Books 2026-01-31.ironbooks"; filename*=UTF-8''Acme%20Books%202026-01-31.ironbooks`,
    );
  });
});
