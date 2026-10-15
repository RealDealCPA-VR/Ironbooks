/**
 * Server helper: a binary file response with a download name that survives spaces, quotes and
 * accents (RFC 5987 filename*), as used by the portable company file routes.
 */
import { NextResponse } from 'next/server';

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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
