/**
 * Shared ServiceError -> HTTP translation and request-body parsing for every API route
 * (app/api/**). Routes must not hand-roll their own code → status maps: use routeError(), or
 * serviceErrorStatus() with overrides for a deliberate exception.
 */
import { NextResponse } from 'next/server';
import { ServiceError, type ServiceErrorCode } from '@/lib/services/_base';
import { MoneyParseError } from '@/lib/money';

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

/**
 * A JSON request body as handlers read it: an object whose fields the handler (or its zod schema
 * / service) still validates — the same typing `await req.json()` gave, minus null / arrays /
 * strings / malformed JSON, which requireJsonObject refuses.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonObjectBody = Record<string, any>;

/** The message for a body that is not a JSON object (also used by invalidJsonBody callers). */
export const INVALID_JSON_BODY_MESSAGE = 'The request body must be a JSON object.';

/**
 * Drop-in replacement for `await req.json()` in route handlers: returns the parsed JSON object, or
 * throws ServiceError VALIDATION (→ 400 via routeError / serviceErrorStatus) for malformed JSON
 * or a body that is not an object (`null`, an array, a string). Reading a field of a `null` body
 * or a SyntaxError used to surface as HTTP 500.
 *
 * `optional: true` treats an EMPTY body as `{}` — for handlers whose body is optional (they used
 * `req.json().catch(() => ({}))`); a malformed or non-object body is still refused.
 */
export async function requireJsonObject(req: Request, opts: { optional?: boolean } = {}): Promise<JsonObjectBody> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new ServiceError('VALIDATION', INVALID_JSON_BODY_MESSAGE);
  }
  if (!text.trim()) {
    if (opts.optional) return {};
    throw new ServiceError('VALIDATION', INVALID_JSON_BODY_MESSAGE);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ServiceError('VALIDATION', INVALID_JSON_BODY_MESSAGE);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('VALIDATION', INVALID_JSON_BODY_MESSAGE);
  }
  return value as JsonObjectBody;
}

/**
 * Refuse (ServiceError VALIDATION) a body whose listed fields are present but not strings, for
 * handlers without a zod schema whose services call string methods (`name.trim()`) on them.
 * `null` / absent fields pass (the service decides whether they are required).
 */
export function assertStringFields(body: Record<string, unknown>, fields: readonly string[]): void {
  for (const f of fields) {
    const v = body[f];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new ServiceError('VALIDATION', `${f} must be text.`, { field: f });
    }
  }
}

/**
 * The one ServiceError code → HTTP status map for every API route. Typed against
 * ServiceErrorCode (lib/services/errors.ts), so adding a code fails to compile until it is mapped
 * here — no route can silently answer 500 for a caller error (e.g. PERIOD_CLOSED).
 */
const STATUS: Record<ServiceErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  UNBALANCED: 400,
  PERIOD_CLOSED: 400,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INTERNAL: 500,
};

/** Per-route exceptions to the shared map (e.g. a route that answers PERIOD_CLOSED with 409). */
export type ServiceErrorStatusOverrides = Partial<Record<ServiceErrorCode, number>>;

/**
 * HTTP status for a ServiceError code. `overrides` keeps a route's deliberate choices (e.g.
 * `{ PERIOD_CLOSED: 422 }` on the payment routes); unknown codes answer 500.
 */
export function serviceErrorStatus(code: string, overrides?: ServiceErrorStatusOverrides): number {
  const own = (o: object | undefined, k: string) => (o !== undefined && Object.hasOwn(o, k) ? (o as Record<string, number>)[k] : undefined);
  return own(overrides, code) ?? own(STATUS, code) ?? 500;
}

/**
 * JSON body for a ServiceError: `{ error, code, details, fixes? }`. `fixes` (lib/errorFixes.ts)
 * is only present when the service suggested any, so existing clients see the same shape.
 * `code` may be overridden for soft warnings (lib/salesRouteErrors.ts).
 */
export function serviceErrorBody(
  err: ServiceError,
  code: string = err.code,
): { error: string; code: string; details: unknown; fixes?: ServiceError['fixes'] } {
  return {
    error: err.message,
    code,
    details: err.details,
    ...(err.fixes && err.fixes.length ? { fixes: err.fixes } : {}),
  };
}

export function routeError(err: unknown, tag: string): NextResponse {
  if (err instanceof ServiceError) {
    return NextResponse.json(serviceErrorBody(err), { status: serviceErrorStatus(err.code) });
  }
  // A malformed request body (`await req.json()` on invalid JSON) is the caller's fault, not ours.
  if (err instanceof SyntaxError) {
    return invalidJsonBody();
  }
  // An amount that is not a number ("abc", "3.4%") reaching Money.of in a service: a 400 with the
  // plain message, not a 500 (review round 5).
  if (err instanceof MoneyParseError) {
    return NextResponse.json({ error: err.message, code: 'VALIDATION' }, { status: 400 });
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
