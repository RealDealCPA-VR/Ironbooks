/**
 * Shared ServiceError -> HTTP translation for the advanced-pricing, fulfillment and receiving
 * API routes (same mapping as the neighbouring routes, e.g. app/api/sales-orders/route.ts).
 */
import { NextResponse } from 'next/server';
import { ServiceError } from '@/lib/services/_base';

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  UNBALANCED: 400,
  PERIOD_CLOSED: 400,
  FORBIDDEN: 403,
  CONFLICT: 409,
};

export function routeError(err: unknown, tag: string): NextResponse {
  if (err instanceof ServiceError) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status: STATUS[err.code] ?? 500 },
    );
  }
  console.error(`[${tag}]`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Wrap PDF bytes in an inline application/pdf response. */
export function pdfResponse(bytes: Uint8Array, filename: string): NextResponse {
  const buf: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      // Alphanumeric document numbers (wave2 foundation) may carry quotes, slashes or non-ASCII
      // characters that are not valid in a header value — keep the filename header-safe.
      'Content-Disposition': `inline; filename="${filename.replace(/[^A-Za-z0-9._-]+/g, '_')}"`,
      'Content-Length': String(buf.byteLength),
    },
  });
}
