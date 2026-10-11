/**
 * Shared helpers for the accountant-tool API routes (not a route — underscore-prefixed).
 * Errors go through the shared routeError helper (lib/routeErrors.ts).
 */
import { ServiceError } from '@/lib/services/_base';

/**
 * Parse a 'YYYY-MM-DD' (or ISO) query param. Day-only values become UTC midnight, or the last
 * millisecond of that UTC day when `endOfDay` (so a `to` date includes the whole day, matching
 * how document dates are stored).
 */
export function dayParam(value: string | null, name: string, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(v);
  if (Number.isNaN(d.getTime())) throw new ServiceError('VALIDATION', `Invalid ${name} date.`);
  return d;
}
