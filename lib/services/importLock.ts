/**
 * One import at a time per company.
 *
 * The QuickBooks imports (IIF lists + transactions, CSV / Excel lists, open invoices and bills,
 * the General Ledger) are idempotent: each checks what the books already hold (source refs,
 * document tags, names) and only adds what is missing. That check and the writes are separate
 * steps — the IIF and list imports deliberately are not one big transaction, so a bad row stays
 * a row problem — and two runs of the same file at once (a double click on "Run Import", two
 * windows, a retry while the first is still posting) both passed the check before either wrote:
 * every open bill and IIF transaction came in twice.
 *
 * Running them one after the other restores the guarantee: the second run sees the first one's
 * work and adds nothing. The company file lives in one server process (embedded PGlite; in
 * multi-user mode every workstation talks to the host's server), so an in-process queue per
 * company is enough. It is kept on globalThis so every route bundle shares the same queue.
 */
import type { ServiceContext } from './_base';

const KEY = Symbol.for('ironbooks.importLock');
type Queues = Map<string, Promise<void>>;
const queues: Queues = ((globalThis as Record<symbol, unknown>)[KEY] as Queues | undefined) ??
  ((globalThis as Record<symbol, unknown>)[KEY] = new Map<string, Promise<void>>() as Queues);

/**
 * Run `fn` after every import already queued for this company has finished. Not re-entrant: the
 * public import entry points take it, and none of them calls another.
 */
export async function withImportLock<T>(ctx: ServiceContext, fn: () => Promise<T>): Promise<T> {
  const key = ctx.companyId;
  const before = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const tail = before.then(() => done);
  queues.set(key, tail);
  try {
    await before;
    return await fn();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
