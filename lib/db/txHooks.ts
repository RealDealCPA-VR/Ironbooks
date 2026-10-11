/**
 * After-commit hooks for Drizzle/PGlite database handles.
 *
 * The running transaction log (lib/services/transactionLog.ts) must record a business change
 * only once its database transaction has COMMITTED — never for rolled-back work. Drizzle has no
 * public commit hook, so `instrumentDb` wraps the `transaction` method of a root handle (and,
 * recursively, of every transaction / savepoint object it hands out):
 *
 *  - each transaction gets its own queue of callbacks;
 *  - when a nested transaction (savepoint) is released, its queue is merged into the parent's
 *    (the outer transaction can still roll back, so nothing runs yet);
 *  - when the OUTERMOST transaction commits, the queue runs in order;
 *  - a rollback (thrown error / tx.rollback()) discards the queue.
 *
 * `afterCommit(dbOrTx, fn)` queues on a transaction, or runs immediately on a root handle
 * (autocommit — the statement that preceded it has already committed). Hooks may be async; the
 * outermost `transaction()` call resolves only after its hooks have finished, so callers see the
 * transaction log (and its database anchor) up to date when their write returns.
 *
 * The handle → data-directory association is kept here too, so services that receive only a
 * `ServiceContext` can locate per-company-file side files (e.g. transactions.bktlg).
 */

interface HookState {
  /** Company data directory the handle belongs to. */
  dir: string;
  /** Root (autocommit) handle the transaction belongs to. */
  root: object;
  /** Pending callbacks; null for a root (autocommit) handle. */
  queue: Array<Hook> | null;
}

type Hook = () => void | Promise<void>;

const states = new WeakMap<object, HookState>();

type TxFn = (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>;

async function runSafely(fn: Hook): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // A failing hook must never surface as a failure of work that already committed.
    console.error('[txHooks] after-commit hook failed:', err);
  }
}

function wrapTransaction(target: { transaction: TxFn }, dir: string, root: object): void {
  const original = target.transaction.bind(target) as TxFn;
  target.transaction = async (fn, config) => {
    const queue: Hook[] = [];
    const result = await original(async (tx) => {
      const txObj = tx as { transaction: TxFn };
      states.set(txObj, { dir, root, queue });
      wrapTransaction(txObj, dir, root);
      return fn(tx);
    }, config);
    // Reached only when the transaction (or savepoint) completed without error.
    const parent = states.get(target);
    if (parent?.queue) parent.queue.push(...queue);
    else for (const hook of queue) await runSafely(hook);
    return result;
  };
}

/** Attach commit tracking + data-dir association to a root database handle (idempotent). */
export function instrumentDb(db: object, dir: string): void {
  if (states.has(db)) return;
  states.set(db, { dir, root: db, queue: null });
  wrapTransaction(db as { transaction: TxFn }, dir, db);
}

/**
 * Run `fn` once the work done so far on `dbOrTx` is durable: immediately (awaited) for a root
 * handle, or after the outermost enclosing transaction commits. Resolves false (nothing done) when
 * the handle was not instrumented (e.g. a hand-built drizzle instance in a unit test).
 */
export async function afterCommit(dbOrTx: object, fn: Hook): Promise<boolean> {
  const state = states.get(dbOrTx);
  if (!state) return false;
  if (state.queue) state.queue.push(fn);
  else await runSafely(fn);
  return true;
}

/** Root (autocommit) handle of an instrumented handle or transaction, or null. */
export function rootDbOf(dbOrTx: object): object | null {
  return states.get(dbOrTx)?.root ?? null;
}

/** Data directory of an instrumented handle or transaction, or null. */
export function dataDirOf(dbOrTx: object): string | null {
  return states.get(dbOrTx)?.dir ?? null;
}
