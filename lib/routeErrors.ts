/**
 * Shared ServiceError -> HTTP translation for the advanced-pricing, fulfillment and receiving
 * API routes (same mapping as the neighbouring routes, e.g. app/api/sales-orders/route.ts).
 */
import { NextResponse } from 'next/server';
import { ServiceError } from '@/lib/services/_base';

/** 400 response for a request body that is not valid JSON (or not a JSON object). */
export function invalidJsonBody(): NextResponse {
  return NextResponse.json({ error: 'Invalid JSON body', code: 'VALIDATION' }, { status: 400 });
}

/**
 * Parse a JSON object request body; returns null when the body is malformed or not an object,
 * so handlers can answer 400 (see invalidJsonBody) instead of throwing a SyntaxError -> 500.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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
  // A malformed request body (`await req.json()` on invalid JSON) is the caller's fault, not ours.
  if (err instanceof SyntaxError) {
    return invalidJsonBody();
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
