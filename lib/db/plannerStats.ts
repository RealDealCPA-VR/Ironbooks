/**
 * Planner statistics for the embedded database.
 *
 * Postgres plans every query from per-table statistics (row counts, value distributions) that a
 * server refreshes in the background (autovacuum). PGlite runs as one embedded session with no
 * background workers, so a company file never gets any unless the app runs ANALYZE itself, and
 * a large file then gets quadratic nested-loop plans (the inventory valuation line scan: ~90 s
 * on 66,000 entries, well under a second once analyzed).
 *
 *  - When a company file is opened (lib/db/index.ts), tables that were never analyzed or grew a
 *    lot since are analyzed (`staleOnly`). A fresh file costs a fraction of a second.
 *  - After bulk operations that change table sizes a lot (imports, condense, company restore,
 *    Period Copy) every table of a meaningful size is analyzed.
 *
 * Tables below MIN_PAGES are left alone on purpose. A never-analyzed table is planned as if it
 * had at least 10 pages, which keeps index plans; statistics taken while a table is almost empty
 * would make the planner (and the plans the ledger triggers cache for the session) choose
 * sequential scans that turn quadratic when a bulk load then grows the table.
 *
 * ANALYZE samples (at most 30,000 rows per table), so it is cheap. It is best-effort: an error
 * is logged and swallowed, never thrown, and it runs in a savepoint when the caller is inside a
 * transaction, so a failure cannot abort the caller's work.
 */
import { sql, type SQL } from 'drizzle-orm';

interface StatsDb {
  execute(query: SQL): Promise<unknown>;
  transaction<T>(fn: (tx: { execute(query: SQL): Promise<unknown> }) => Promise<T>): Promise<T>;
}

/** Tables smaller than this (in 8 kB pages) are never analyzed (see the module notes). */
const MIN_PAGES = 16;

/**
 * Tables of at least MIN_PAGES pages — with `staleOnly`, only those never analyzed or grown a lot
 * since (PGlite keeps no modification counters, so growth is measured against the page count the
 * last ANALYZE recorded).
 */
async function tablesToAnalyze(db: StatsDb, staleOnly: boolean): Promise<string[]> {
  const res = (await db.execute(sql`
    SELECT format('%I.%I', n.nspname, c.relname) AS t
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND pg_relation_size(c.oid) / current_setting('block_size')::bigint >= ${MIN_PAGES}
      AND (
        ${staleOnly ? sql`FALSE` : sql`TRUE`}
        OR c.reltuples < 0
        OR pg_relation_size(c.oid) / current_setting('block_size')::bigint > 2 * c.relpages + 8
      )
  `)) as { rows?: Array<{ t: string }> };
  return (res.rows ?? []).map((r) => r.t);
}

/**
 * Refresh the planner statistics (best-effort; see the module notes). `reason` names the
 * operation in the log line if ANALYZE fails.
 */
export async function refreshPlannerStats(
  db: StatsDb,
  reason: string,
  opts: { staleOnly?: boolean } = {},
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const tables = await tablesToAnalyze(tx as StatsDb, opts.staleOnly ?? false);
      if (tables.length) await tx.execute(sql.raw(`ANALYZE ${tables.join(', ')}`));
    });
  } catch (err) {
    console.warn(`[db] ANALYZE (${reason}) failed — continuing without fresh planner statistics:`, err instanceof Error ? err.message : err);
  }
}

/** Run a bulk operation, then refresh the planner statistics (only when it succeeded). */
export async function withPlannerStats<T>(db: StatsDb, reason: string, fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  await refreshPlannerStats(db, reason);
  return result;
}
