/**
 * A database handle that can only read.
 *
 * A context that must not change the books (an agent that may only read, lib/agentContext.ts) gets
 * this instead of the real handle. It is the last of three barriers, after the route list and the
 * view-only role, and the only one that does not depend on a service remembering to check:
 *
 *  - reads pass through (`select`, the relational `query` API, `$count`, `with(...).select`);
 *  - every transaction opens as READ ONLY, so the database itself refuses a write inside it,
 *    whatever statement tries;
 *  - a raw statement (`execute`) runs inside such a transaction;
 *  - `insert`, `update`, `delete` and every method this wrapper does not know are refused. A new
 *    drizzle method is therefore closed until someone adds it here on purpose.
 *
 * Spreading a context (`{ ...ctx }`) keeps the wrapper, and a transaction handed out by it is
 * wrapped the same way.
 */
import { sql } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { ServiceError } from '@/lib/services/errors';
import { associateWrapper } from './txHooks';

export const READ_ONLY_MESSAGE = 'This connection can only read the books. Nothing was changed.';

const READ_BUILDERS = new Set(['select', 'selectDistinct', 'selectDistinctOn', '$count']);
const marked = new WeakSet<object>();

/** True for a handle made by readOnlyDb (or a transaction it handed out). */
export function isReadOnlyDb(db: unknown): boolean {
  return typeof db === 'object' && db !== null && marked.has(db);
}

function refuse(): never {
  throw new ServiceError('FORBIDDEN', READ_ONLY_MESSAGE, { readOnly: true });
}

type AnyFn = (...args: unknown[]) => unknown;
type Target = Record<string | symbol, unknown> & {
  transaction: (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>;
  execute: (query: unknown) => Promise<unknown>;
};

function wrap(target: Target, insideTransaction: boolean): object {
  const readTransaction = (fn: (tx: unknown) => Promise<unknown>, config?: unknown) =>
    target.transaction(async (tx) => {
      // The outermost transaction is made read-only; a nested one (savepoint) already is.
      if (!insideTransaction) await (tx as Target).execute(sql`SET TRANSACTION READ ONLY`);
      return fn(wrap(tx as Target, true));
    }, config);

  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      if (READ_BUILDERS.has(prop)) return (...args: unknown[]) => (t[prop] as AnyFn).apply(t, args);
      // The relational query API only reads (findMany / findFirst); `_` is drizzle's own metadata.
      if (prop === 'query' || prop === '_') return t[prop];
      if (prop === 'with') {
        // WITH ... SELECT only: the same builder also offers insert / update / delete.
        return (...ctes: unknown[]) => {
          const b = (t.with as AnyFn).apply(t, ctes) as Record<string, AnyFn>;
          return {
            select: (...a: unknown[]) => b.select(...a),
            selectDistinct: (...a: unknown[]) => b.selectDistinct(...a),
            selectDistinctOn: (...a: unknown[]) => b.selectDistinctOn(...a),
          };
        };
      }
      if (prop === '$with') return (...args: unknown[]) => (t.$with as AnyFn).apply(t, args);
      if (prop === 'transaction') return readTransaction;
      if (prop === 'execute') {
        return insideTransaction
          ? (query: unknown) => t.execute(query)
          : (query: unknown) => readTransaction((tx) => (tx as Target).execute(query));
      }
      // `then` must read as absent, or awaiting the handle would treat it as a promise.
      if (prop === 'then') return undefined;
      return refuse;
    },
    set() {
      return refuse();
    },
    deleteProperty() {
      return refuse();
    },
    defineProperty() {
      return refuse();
    },
  });
  marked.add(proxy);
  associateWrapper(proxy, target);
  return proxy;
}

/** Wrap a database handle so nothing reached through it can change the books. */
export function readOnlyDb(db: DB): DB {
  if (isReadOnlyDb(db)) return db;
  return wrap(db as unknown as Target, false) as unknown as DB;
}
