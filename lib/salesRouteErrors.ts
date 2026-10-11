/**
 * wave2 sales — route error helper for A/R documents. Same mapping as lib/routeErrors.ts, plus
 * soft WARNINGS: a ServiceError whose details carry `{ warning: 'CREDIT_LIMIT' }` is answered
 * with code 'CREDIT_LIMIT' (HTTP 409) so the UI can show a confirm dialog and retry the same
 * request with `overrideCreditLimit: true`.
 */
import { NextResponse } from 'next/server';
import { ServiceError } from '@/lib/services/_base';
import { routeError } from '@/lib/routeErrors';

export const CREDIT_LIMIT_WARNING = 'CREDIT_LIMIT';

export function routeErrorWithWarnings(err: unknown, tag: string): NextResponse {
  if (
    err instanceof ServiceError &&
    (err.details as { warning?: unknown } | undefined)?.warning === CREDIT_LIMIT_WARNING
  ) {
    return NextResponse.json(
      { error: err.message, code: CREDIT_LIMIT_WARNING, details: err.details },
      { status: 409 },
    );
  }
  return routeError(err, tag);
}
