/**
 * Errors from a query reach the app as the database raised them, not wrapped by drizzle.
 *
 * Since 0.44, drizzle-orm wraps every error a query raises in a DrizzleQueryError ("Failed query:
 * <statement> params: <values>", with the driver's error as `cause`). The app was built on the
 * earlier contract and relies on it everywhere:
 *  - the PGlite client turns Postgres data errors into ServiceErrors (lib/db/pgErrors.ts), which
 *    routes answer with their own status (a malformed id is 404, text too long is 400);
 *  - the ledger guards' SQLSTATEs (BK001-BK003, lib/services/_base.ts translateLedgerDbError) and
 *    foreign-key codes are read from the error itself;
 *  - a few messages are shown to the person ("The portable file could not be restored: …").
 * Wrapped, every one of those became an "Internal server error", and the message carried the
 * statement and its parameter values (names, amounts) into logs and onto the screen.
 *
 * So each query on a PGlite database rethrows the driver's own error, exactly as drizzle 0.36 did.
 * Installed once per process by lib/db/index.ts; it covers every drizzle instance on PGlite (the
 * company database, the scratch database of a portable-file restore, hand-built test instances).
 * lib/db/driverErrors.test.ts and lib/db/pgErrors.test.ts fail if a drizzle update changes this.
 */
import { DrizzleQueryError } from 'drizzle-orm';
import { PgPreparedQuery } from 'drizzle-orm/pg-core';
import { PglitePreparedQuery } from 'drizzle-orm/pglite';

const INSTALLED = Symbol.for('ironbooks.drizzle-driver-errors');

type QueryFn = (this: unknown, ...args: unknown[]) => Promise<unknown>;

/** The database's own error behind a drizzle query error; anything else unchanged. */
export function driverError(err: unknown): unknown {
  return err instanceof DrizzleQueryError && err.cause !== undefined ? err.cause : err;
}

/**
 * Make every PGlite query rethrow the driver's error (idempotent). `queryWithCache` is where
 * drizzle runs a prepared query and wraps what it throws; it is internal to drizzle, hence the
 * casts. Without it (a drizzle that no longer wraps errors there) nothing is changed.
 */
export function installDriverErrors(): void {
  const proto = PglitePreparedQuery.prototype as unknown as Record<PropertyKey, unknown>;
  if (proto[INSTALLED]) return;
  const run = (PgPreparedQuery.prototype as unknown as { queryWithCache?: QueryFn }).queryWithCache;
  if (typeof run !== 'function') return;
  proto.queryWithCache = async function queryWithCache(this: unknown, ...args: unknown[]) {
    try {
      return await run.apply(this, args);
    } catch (err) {
      throw driverError(err);
    }
  } as QueryFn;
  proto[INSTALLED] = true;
}

/** True once installDriverErrors has run in this process (tests). */
export function driverErrorsInstalled(): boolean {
  return Boolean((PglitePreparedQuery.prototype as unknown as Record<PropertyKey, unknown>)[INSTALLED]);
}
