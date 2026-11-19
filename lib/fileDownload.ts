/**
 * Server helper: a binary file response with a download name that survives spaces, quotes and
 * accents (RFC 5987 filename*), as used by the portable company file routes.
 */
import { NextResponse } from 'next/server';

/** Half of a surrogate pair without its other half (a name cut in the middle of an emoji). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Header value for any name: never throws, and the result is always one well-formed header. */
export function contentDisposition(filename: string): string {
  // encodeURIComponent throws on a lone surrogate (a name from a file or a database row can hold
  // one): it becomes U+FFFD first.
  const name = String(filename ?? '').replace(LONE_SURROGATE, '\uFFFD');
  // The plain fallback is a quoted string: printable ASCII only, and neither '"' (which would end
  // it) nor '\' (which would escape the next character).
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'").replace(/\\/g, '_');
  // RFC 5987: everything but its attr-char is percent-encoded (encodeURIComponent leaves ' ( ) *).
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function fileResponse(
  buffer: Buffer,
  filename: string,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(buffer.byteLength),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
