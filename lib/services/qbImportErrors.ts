/**
 * Import robustness: a value in an imported file that the database cannot store (a name longer
 * than its column, an amount past decimal(15,2), …) must come back as a plain row problem, never
 * as a raw database error (HTTP 500) that stops an import halfway.
 *
 * The importers already turn ServiceError VALIDATION into a per-row issue; `importRowError` lets
 * them treat Postgres "data exception" errors (SQLSTATE class 22) the same way. The wording is the
 * one shared translation (lib/db/pgErrors.ts translatePgError), which the company database client
 * normally applies already; this also covers a raw error (possibly wrapped) that reaches an importer.
 */
import { translatePgError } from '@/lib/db/pgErrors';
import { ServiceError, validation } from './_base';

const DATA_EXCEPTION = /^22[0-9A-Z]{3}$/;

/**
 * The data exception behind `err`, or null: a raw Postgres error (PGlite / drizzle may wrap it in
 * `cause`), or a ServiceError the database client already translated from one (details.sqlstate).
 */
function dataException(err: unknown): { translated: ServiceError | null } | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    if (e instanceof ServiceError) {
      const sqlstate = (e.details as { sqlstate?: unknown } | undefined)?.sqlstate;
      return typeof sqlstate === 'string' && DATA_EXCEPTION.test(sqlstate) ? { translated: e } : null;
    }
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && DATA_EXCEPTION.test(code)) {
      const t = translatePgError(e);
      return { translated: t instanceof ServiceError ? t : null };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** True for a Postgres data exception (value too long, numeric overflow, bad date, …). */
export function isDataException(err: unknown): boolean {
  return dataException(err) !== null;
}

/** Plain-language explanation of a data exception (the shared pgErrors wording when it has one). */
export function dataExceptionMessage(err: unknown): string {
  const d = dataException(err);
  if (!d) return 'A value could not be stored.';
  return d.translated?.message ?? 'A value is not valid for the field it was entered in.';
}

/**
 * The ServiceError an importer should report for `err` as a row problem: the error itself when it
 * is a ServiceError, a VALIDATION error for a database data exception, else null (a real failure
 * the caller rethrows).
 */
export function importRowError(err: unknown): ServiceError | null {
  if (err instanceof ServiceError) return err;
  const d = dataException(err);
  if (!d) return null;
  return d.translated ?? validation(dataExceptionMessage(err));
}
