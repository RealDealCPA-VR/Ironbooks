/**
 * Shared helpers for the report API routes: ServiceError -> HTTP status mapping
 * and tolerant query-string date parsing. Not a route (underscore-prefixed).
 */
import { NextResponse } from 'next/server';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { parseDateInput } from '@/lib/validation/helpers';

export function reportError(err: unknown, tag: string) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error(`[reports/${tag}] unexpected error:`, err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}

/**
 * Parse an optional date query param. Returns undefined when absent; throws VALIDATION (400) on
 * garbage AND on days that do not exist: `new Date('2026-02-30')` silently rolled over to
 * March 2, so the report ran for a different day than asked (parseDateInput is the same check
 * every other route uses).
 */
export function parseDateParam(value: string | null, name: string): Date | undefined {
  if (!value || !value.trim()) return undefined;
  const d = parseDateInput(value);
  if (!d) {
    throw new ServiceError('VALIDATION', `Invalid ${name} date: use a real calendar day (YYYY-MM-DD) in years 1900-9999.`);
  }
  return d;
}

/** Build an optional {from,to} range from query params (undefined when neither set). */
export function parseRange(params: URLSearchParams): { from?: Date; to?: Date } | undefined {
  const from = parseDateParam(params.get('from'), 'from');
  const to = parseDateParam(params.get('to'), 'to');
  return from || to ? { from, to } : undefined;
}
