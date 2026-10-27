/**
 * Import robustness: a value in an imported file that the database cannot store (a name longer
 * than its column, an amount past decimal(15,2), …) must come back as a plain row problem, never
 * as a raw database error (HTTP 500) that stops an import halfway.
 *
 * The importers already turn ServiceError VALIDATION into a per-row issue; `importRowError` lets
 * them treat Postgres "data exception" errors (SQLSTATE class 22) the same way.
 */
import { ServiceError, validation } from './_base';

/** The Postgres data-exception error behind `err` (PGlite / drizzle may wrap it), or null. */
function dataException(err: unknown): { code: string; message: string } | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code)) {
      return { code, message: String((e as { message?: unknown }).message ?? '') };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** True for a Postgres data exception (value too long, numeric overflow, bad date, …). */
export function isDataException(err: unknown): boolean {
  return dataException(err) !== null;
}

/** Plain-language explanation of a data exception. */
export function dataExceptionMessage(err: unknown): string {
  const d = dataException(err);
  if (!d) return 'A value could not be stored.';
  if (d.code === '22001') {
    const limit = /varying\((\d+)\)/.exec(d.message)?.[1];
    return limit ? `a value is longer than ${limit} characters, the most Ironbooks can store there.` : 'a value is too long.';
  }
  if (d.code === '22003') return 'an amount or number is too large.';
  if (d.code === '22007' || d.code === '22008') return 'a date is not valid.';
  return 'a value is not valid.';
}

/**
 * The ServiceError an importer should report for `err` as a row problem: the error itself when it
 * is a ServiceError, a VALIDATION error for a database data exception, else null (a real failure
 * the caller rethrows).
 */
export function importRowError(err: unknown): ServiceError | null {
  if (err instanceof ServiceError) return err;
  if (isDataException(err)) {
    const msg = dataExceptionMessage(err);
    return validation(msg.charAt(0).toUpperCase() + msg.slice(1));
  }
  return null;
}
