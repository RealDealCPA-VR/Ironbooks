/**
 * Central translation of Postgres data errors into ServiceErrors, applied to EVERY query of a
 * company database (lib/db/index.ts wraps the PGlite client and each transaction it hands out).
 *
 * Without it, bad input that only Postgres notices surfaced as a raw error → HTTP 500 from
 * whichever route happened to run the query:
 *  - 22P02 invalid_text_representation — e.g. a malformed id ("garbage") compared with a uuid
 *    column. For uuid input no row can match, so it is NOT_FOUND (404); any other malformed
 *    value is VALIDATION (400).
 *  - 22003 numeric_value_out_of_range — e.g. a posting that would push a cached account
 *    balance past numeric(15,2). VALIDATION with a friendly "too large" message. The statement
 *    failed, so the transaction rolls back as before.
 * Every other error passes through unchanged (ledger BK00x codes are translated in
 * lib/services/_base.ts inTransaction, where deferred checks surface at COMMIT).
 */
import { ServiceError } from '@/lib/services/errors';

export function translatePgError(err: unknown): unknown {
  if (!err || typeof err !== 'object' || err instanceof ServiceError) return err;
  const code = (err as { code?: unknown }).code;
  const message = String((err as { message?: unknown }).message ?? '');
  if (code === '22P02') {
    if (/\buuid\b/i.test(message)) {
      return new ServiceError('NOT_FOUND', 'No record matches that id.', { sqlstate: code });
    }
    return new ServiceError('VALIDATION', `Invalid value: ${message}`, { sqlstate: code });
  }
  if (code === '22003') {
    return new ServiceError(
      'VALIDATION',
      'That amount is too large: the result would exceed the largest amount the ledger can hold (9,999,999,999,999.99).',
      { sqlstate: code },
    );
  }
  return err;
}

type Queryish = {
  query?: (...args: never[]) => Promise<unknown>;
  exec?: (...args: never[]) => Promise<unknown>;
  transaction?: (fn: (tx: never) => Promise<unknown>) => Promise<unknown>;
};

const wrapped = new WeakSet<object>();

/** Wrap query/exec (and, recursively, transactions) of a PGlite client so errors are translated. */
export function translatePgErrors<T extends object>(client: T): T {
  const c = client as unknown as Queryish & Record<string, unknown>;
  if (wrapped.has(c)) return client;
  wrapped.add(c);
  for (const name of ['query', 'exec'] as const) {
    const fn = c[name];
    if (typeof fn !== 'function') continue;
    const bound = (fn as (...a: unknown[]) => Promise<unknown>).bind(c);
    c[name] = async (...args: unknown[]) => {
      try {
        return await bound(...args);
      } catch (err) {
        throw translatePgError(err);
      }
    };
  }
  if (typeof c.transaction === 'function') {
    const tx = (c.transaction as (fn: (t: object) => Promise<unknown>) => Promise<unknown>).bind(c);
    c.transaction = (async (fn: (t: object) => Promise<unknown>) => {
      try {
        return await tx((t: object) => fn(translatePgErrors(t)));
      } catch (err) {
        throw translatePgError(err);
      }
    }) as never;
  }
  return client;
}
