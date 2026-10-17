/**
 * Local-first database client.
 *
 * Ironbooks is a DESKTOP app: data lives on the user's machine, not in a cloud Postgres.
 * We use PGlite (embedded Postgres compiled to WASM) so the existing `pg-core` Drizzle schema
 * runs verbatim, fully offline, persisted to a local directory.
 *
 * Multi-company model: each "company file" is its own PGlite data directory. The Electron main
 * process sets BKA_DATA_DIR to the active company's directory before launching the server; in
 * dev we fall back to a local `.bookkeeper-data/default` folder.
 */
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';
import * as schema from './schema';
import { instrumentDb } from './txHooks';
import { translatePgErrors } from './pgErrors';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceError } from '@/lib/services/errors';
import { OPEN_BLOCKING, checkLedgerHealth, ensureLedgerGuards, type LedgerProblem } from './ledgerGuards';
import { acquireDirLock, releaseDirLock } from './dirLock';

export { CompanyFileInUseError, LOCK_FILE } from './dirLock';

export type DB = PgliteDatabase<typeof schema>;

interface DbHandle {
  client: PGlite;
  db: DB;
  migrated: Promise<void>;
  /** Set when the file's ledger is damaged (see ledgerGuards.ts); getDb then refuses it. */
  damage: LedgerProblem[] | null;
}

/**
 * A company file whose ledger is damaged (unbalanced or malformed posted entries, lines on
 * another company's account, …). QuickBooks refuses to open a damaged company file; so do we,
 * so nothing can be posted or reported on top of books that do not balance.
 */
export class LedgerDamagedError extends ServiceError {
  constructor(public problems: LedgerProblem[]) {
    super(
      'CONFLICT',
      `This company file is damaged, so Ironbooks will not open it: ${problems
        .map((p) => p.detail)
        .join(' ')} Restore your most recent backup (File > Back Up and Restore) or open a different company file.`,
      { problems },
    );
    this.name = 'LedgerDamagedError';
  }
}

/**
 * Scope in which a damaged company file may still be opened: only the backup routes use it, so
 * a damaged file can be backed up for support and replaced by restoring a good backup.
 */
const damagedFileAccess = new AsyncLocalStorage<true>();

export function withDamagedFileAccess<T>(fn: () => Promise<T>): Promise<T> {
  return damagedFileAccess.run(true, fn);
}

const handles = new Map<string, DbHandle>();

/**
 * Company files that must not be (re)opened right now: the sandbox switch (lib/services/sandbox.ts)
 * holds the REAL file from just before it closes its handle until the server points at the copy,
 * so no request that slips in between can open a fresh handle to the real file and keep writing
 * to it while the server is in the sandbox. getDb() waits for the hold to end and then opens
 * whichever file is active by then; the synchronous openDb() refuses instead.
 */
const openHolds = new Map<string, Promise<void>>();

/** Keep `dataDir` from being opened until the returned release function is called. */
export function holdDbOpen(dataDir: string): () => void {
  const dir = resolveDataDir(dataDir);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  openHolds.set(dir, gate);
  return () => {
    if (openHolds.get(dir) === gate) openHolds.delete(dir);
    release();
  };
}

/** The hold that would block opening the file a call resolves to right now (none: open it). */
function openHoldFor(dataDir?: string): Promise<void> | undefined {
  const dir = resolveDataDir(dataDir);
  return handles.has(dir) ? undefined : openHolds.get(dir);
}

/** Wait while the company file a call would open is held by holdDbOpen(). */
async function waitForOpenHold(dataDir?: string): Promise<void> {
  // Re-resolve after each wait: without an explicit dataDir the active file has usually changed.
  for (let gate = openHoldFor(dataDir); gate; gate = openHoldFor(dataDir)) await gate;
}

/** Whether a handle for `dataDir` is open in this process. */
export function isDbOpen(dataDir?: string): boolean {
  return handles.has(resolveDataDir(dataDir));
}

/** Resolve the data directory for the active (or a named) company file. */
export function resolveDataDir(dataDir?: string): string {
  if (dataDir) return path.resolve(dataDir);
  if (process.env.BKA_DATA_DIR) return path.resolve(process.env.BKA_DATA_DIR);
  return path.resolve(process.cwd(), '.bookkeeper-data', 'default');
}

// In dev this is <project>/drizzle. In a packaged Electron build the standalone server's cwd
// differs, so the main process sets BKA_MIGRATIONS_DIR to the bundled migrations location.
export const MIGRATIONS_FOLDER = process.env.BKA_MIGRATIONS_DIR
  ? path.resolve(process.env.BKA_MIGRATIONS_DIR)
  : path.resolve(process.cwd(), 'drizzle');

/** Open (or reuse) a database handle for a given company data directory. */
export function openDb(dataDir?: string): DbHandle {
  const dir = resolveDataDir(dataDir);
  const existing = handles.get(dir);
  if (existing) return existing;
  if (openHolds.has(dir)) {
    throw new ServiceError('CONFLICT', 'The company file is being switched. Try again in a moment.');
  }

  fs.mkdirSync(dir, { recursive: true });
  // Refuse a company file another process has open (PGlite has no lock of its own, so two
  // writers on one folder silently lose each other's transactions) — lib/db/dirLock.ts.
  acquireDirLock(dir);
  // Postgres data errors (malformed uuid 22P02, numeric overflow 22003) become ServiceErrors for
  // every query, so bad input answers 4xx instead of 500 (lib/db/pgErrors.ts).
  let client: PGlite;
  try {
    client = translatePgErrors(new PGlite(dir));
  } catch (err) {
    releaseDirLock(dir);
    throw err;
  }
  const db = drizzle(client, { schema });
  // Commit tracking for the running transaction log (appends only after COMMIT).
  instrumentDb(db, dir);

  const handle: DbHandle = { client, db, migrated: Promise.resolve(), damage: null };
  handle.migrated = (async () => {
    // PGlite's session time zone follows the host (e.g. Etc/GMT+5), so now() / defaultNow()
    // wrote local wall-clock time into `timestamp` columns, which drizzle reads back as UTC —
    // every DB-stamped time came back hours early (and a day early just after midnight).
    // PGlite is a single session, so this holds for every query on the handle.
    await client.exec("SET TIME ZONE 'UTC'");
    // Only migrate if a migrations folder has been generated. In early dev before
    // `db:generate`, callers can use db:push instead.
    if (fs.existsSync(MIGRATIONS_FOLDER)) {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      // Migrations already recorded are never re-run, so a file whose ledger guards were turned
      // off or replaced outside the app would stay unguarded. Re-install them on every open,
      // then refuse a file whose ledger is already damaged.
      await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
      const health = await checkLedgerHealth(client, MIGRATIONS_FOLDER, { includeCachedBalances: false });
      const blocking = health.problems.filter((p) => OPEN_BLOCKING.has(p.kind));
      if (blocking.length) {
        handle.damage = blocking;
        console.error('[db] company file ledger is damaged:', dir, blocking.map((p) => p.detail).join(' '));
      }
    }
  })();

  handles.set(dir, handle);
  return handle;
}

/** Ledger problems found when the company file was opened (null = healthy). */
export async function getLedgerDamage(dataDir?: string): Promise<LedgerProblem[] | null> {
  // Only a held file costs an extra tick: otherwise the file is resolved at call time, as before.
  if (openHoldFor(dataDir)) await waitForOpenHold(dataDir);
  const handle = openDb(dataDir);
  await handle.migrated;
  return handle.damage;
}

/**
 * The active company database (after migrations have completed). Refuses a company file whose
 * ledger is damaged (LedgerDamagedError) except inside withDamagedFileAccess().
 */
export async function getDb(dataDir?: string): Promise<DB> {
  // Only a held file costs an extra tick: otherwise the file is resolved at call time, as before.
  if (openHoldFor(dataDir)) await waitForOpenHold(dataDir);
  const handle = openDb(dataDir);
  await handle.migrated;
  if (handle.damage && !damagedFileAccess.getStore()) throw new LedgerDamagedError(handle.damage);
  return handle.db;
}

/** Synchronous accessor for code paths that manage readiness themselves. */
export function getDbSync(dataDir?: string): DB {
  return openDb(dataDir).db;
}

/** Close a company file (e.g. when switching companies). */
export async function closeDb(dataDir?: string): Promise<void> {
  const dir = resolveDataDir(dataDir);
  const handle = handles.get(dir);
  if (handle) {
    // Forget the handle even if closing fails (e.g. a file that never finished opening), so the
    // next open starts fresh instead of reusing a broken instance.
    try {
      await handle.client.close();
    } finally {
      handles.delete(dir);
      releaseDirLock(dir);
    }
  }
}

export { schema };
