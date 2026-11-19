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
import { installDriverErrors } from './driverErrors';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceError } from '@/lib/services/errors';
import { OPEN_BLOCKING, checkLedgerHealth, ensureLedgerGuards, type LedgerProblem } from './ledgerGuards';
import { CompanyFileInUseError, acquireDirLock, assertDirLockHeld, releaseDirLock } from './dirLock';
import { refreshPlannerStats } from './plannerStats';
import { assertNotSealed } from './sealed';
import format from '@/electron/companyFileFormat';

export { CompanyFileInUseError, LOCK_FILE } from './dirLock';
export { isSealedDir, sealedMode, withSealedAccess } from './sealed';

export type DB = PgliteDatabase<typeof schema>;

// Query errors reach the app as Postgres raised them (ServiceErrors from translatePgErrors, the
// ledger guards' codes), never wrapped by drizzle (lib/db/driverErrors.ts).
installDriverErrors();

interface DbHandle {
  client: PGlite;
  db: DB;
  migrated: Promise<void>;
  /** Set when the file's ledger is damaged (see ledgerGuards.ts); getDb then refuses it. */
  damage: LedgerProblem[] | null;
  /** Set when another process took the company file lock over (dirLock.ts); the handle is dead. */
  lost: CompanyFileInUseError | null;
}

/**
 * Make every statement on `client` refuse once `lostOf()` reports the file lost, and re-check the
 * lock just before each transaction commits (assertDirLockHeld), so a write that is in flight when
 * another process takes the file over is rolled back instead of landing in a folder the other
 * process now owns. Statements PGlite runs for itself (BEGIN / COMMIT / ROLLBACK) are not routed
 * through these methods, so a refused transaction still rolls back cleanly.
 */
function refuseWhenLost(client: PGlite, dir: string, lostOf: () => CompanyFileInUseError | null): void {
  const check = () => {
    const lost = lostOf();
    if (lost) throw lost;
  };
  const guard = (target: Record<string, unknown>) => {
    for (const name of ['query', 'exec'] as const) {
      const fn = target[name];
      if (typeof fn !== 'function') continue;
      const bound = (fn as (...a: unknown[]) => Promise<unknown>).bind(target);
      target[name] = async (...args: unknown[]) => {
        check();
        return bound(...args);
      };
    }
  };
  const c = client as unknown as Record<string, unknown>;
  guard(c);
  const transaction = (c.transaction as (fn: (t: object) => Promise<unknown>) => Promise<unknown>).bind(c);
  c.transaction = async (fn: (t: object) => Promise<unknown>) => {
    check();
    return transaction(async (t) => {
      guard(t as Record<string, unknown>);
      const result = await fn(t);
      // Last moment before COMMIT: a takeover found now (or by the heartbeat meanwhile) throws,
      // and PGlite rolls the transaction back.
      assertDirLockHeld(dir);
      check();
      return result;
    });
  };
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
 * A company file a NEWER Ironbooks has upgraded (its database has migrations this app does not
 * ship). QuickBooks refuses a file upgraded by a newer version; so do we, before touching it:
 * opening it here would skip the unknown migrations, re-install this app's older ledger guards
 * and drop the newer version's ledger triggers, and this code would then write into a database
 * layout it does not know — which, for a shared company file, is saved back for everyone.
 */
export class NewerCompanyFileError extends ServiceError {
  constructor() {
    super(
      'CONFLICT',
      'This company file was last used with a newer version of Ironbooks, so this version cannot open it safely. Update Ironbooks (Help > Check for Updates), then open the file again.',
      { newerVersion: true },
    );
    this.name = 'NewerCompanyFileError';
  }
}

/**
 * Upgrading the company file to this version's layout failed (a step that rewrites data met rows
 * it could not handle). Drizzle runs every pending step in one transaction, so nothing was changed
 * — said plainly, instead of a 500 on every request (or a 400 "too long" that looked like input).
 */
export class CompanyFileUpgradeError extends ServiceError {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      'CONFLICT',
      `Ironbooks could not upgrade this company file to the new version, so it was left exactly as it was (the upgrade was rolled back). Open it with the version you used before, or contact support with this message: ${detail}`,
      { upgradeFailed: true },
    );
    this.name = 'CompanyFileUpgradeError';
  }
}

/** Folders given their pre-upgrade safety copy in this process. */
const upgradeCopied = new Set<string>();

/**
 * The newest migration applied to the database (`created_at` of drizzle's journal table, the
 * migration's `when`): the layout its books are in. Null for a database never migrated.
 */
async function appliedSchemaAt(client: PGlite): Promise<number | null> {
  try {
    const res = await client.query<{ last: string | number | null }>('SELECT MAX(created_at) AS last FROM drizzle.__drizzle_migrations');
    const newest = res.rows[0]?.last == null ? null : Number(res.rows[0].last);
    return newest !== null && Number.isFinite(newest) ? newest : null;
  } catch {
    return null;
  }
}

/** Steps of this version not yet applied to the file (0 for a brand-new database). */
async function pendingMigrationCount(client: PGlite, migrationsFolder: string): Promise<number> {
  // Never migrated: a brand-new database, nothing to protect.
  const newest = await appliedSchemaAt(client);
  if (newest === null) return 0;
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries?: Array<{ when?: unknown }>;
    };
    return (journal.entries ?? []).filter((e) => Number(e.when) > newest!).length;
  } catch {
    return 0;
  }
}

/**
 * The database in a company folder would not START (PGlite aborted while Postgres was starting:
 * typically "could not locate a valid checkpoint record"), as opposed to a statement or migration
 * that failed once it was running. getDb hands it to lib/services/workingCopyRecovery.ts.
 */
export class DatabaseWouldNotStartError extends Error {
  constructor(public dir: string, public cause: unknown) {
    super(`The database in ${dir} would not start: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'DatabaseWouldNotStartError';
  }
}

/**
 * The database layout this app writes ({ migrations, lastMigrationAt } of its drizzle journal), for
 * a company file written out without measuring a database (electron/companySession.js
 * writeWorkingCopyAs); null without a journal.
 */
export function shippedSchemaStamp(migrationsFolder: string = MIGRATIONS_FOLDER): { migrations: number; lastMigrationAt: number } | null {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries?: unknown[] };
    const at = latestShippedMigrationAt(migrationsFolder);
    return at === null ? null : { migrations: (journal.entries ?? []).length, lastMigrationAt: at };
  } catch {
    return null;
  }
}

/** The newest migration this app ships (`when` in the drizzle journal); null without a journal. */
export function latestShippedMigrationAt(migrationsFolder: string = MIGRATIONS_FOLDER): number | null {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries?: Array<{ when?: unknown }>;
    };
    const whens = (journal.entries ?? []).map((e) => Number(e.when)).filter((n) => Number.isFinite(n));
    return whens.length ? Math.max(...whens) : null;
  } catch {
    return null;
  }
}

async function refuseNewerFile(client: PGlite, migrationsFolder: string): Promise<void> {
  const shipped = latestShippedMigrationAt(migrationsFolder);
  if (shipped === null) return;
  let newest: number | null = null;
  try {
    const res = await client.query<{ last: string | number | null }>('SELECT MAX(created_at) AS last FROM drizzle.__drizzle_migrations');
    newest = res.rows[0]?.last == null ? null : Number(res.rows[0].last);
  } catch {
    return; // never migrated: a brand-new database
  }
  if (newest !== null && Number.isFinite(newest) && newest > shipped) throw new NewerCompanyFileError();
}

/**
 * Scope in which a damaged company file may still be opened: only the backup routes use it, so
 * a damaged file can be backed up for support and replaced by restoring a good backup.
 */
const damagedFileAccess = new AsyncLocalStorage<true>();

export function withDamagedFileAccess<T>(fn: () => Promise<T>): Promise<T> {
  return damagedFileAccess.run(true, fn);
}

/**
 * The open databases of this PROCESS, by data directory — kept on globalThis, not in this module.
 * Next.js can load this module more than once in one server process (`next dev` builds every route
 * on its own, and rebuilds them after an edit), and a second copy with its own map would start a
 * second Postgres on a folder that is already open. Two Postgres instances writing one folder
 * destroy it: one recycles the write-ahead log segment the other's next checkpoint is written
 * into, and after the process stops the folder no longer starts at all ("could not locate a valid
 * checkpoint record"). The folder lock (dirLock.ts) cannot tell the two apart: same process.
 */
const processState = globalThis as typeof globalThis & {
  __ironbooksDbHandles?: Map<string, DbHandle>;
  __ironbooksDbOpenHolds?: Map<string, Promise<void>>;
};
const handles: Map<string, DbHandle> = (processState.__ironbooksDbHandles ??= new Map());

/**
 * Company files that must not be (re)opened right now: the sandbox switch (lib/services/sandbox.ts)
 * holds the REAL file from just before it closes its handle until the server points at the copy,
 * so no request that slips in between can open a fresh handle to the real file and keep writing
 * to it while the server is in the sandbox. getDb() waits for the hold to end and then opens
 * whichever file is active by then; the synchronous openDb() refuses instead. Process-wide too.
 */
const openHolds: Map<string, Promise<void>> = (processState.__ironbooksDbOpenHolds ??= new Map());

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

/**
 * How the open of `dataDir` in this process ends: true when it opened, false when it failed (its
 * handle is gone by then), null when nothing is open (lib/services/workingCopyRecovery.ts waits
 * for a handle another request is still opening before it judges the folder).
 */
export async function openSettled(dataDir?: string): Promise<boolean | null> {
  const handle = handles.get(resolveDataDir(dataDir));
  if (!handle) return null;
  try {
    await handle.migrated;
    return !handle.lost;
  } catch {
    return false;
  }
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

/**
 * `dir` is the working copy of the open single company file (BKA_COMPANY_FILE), and that file
 * holds books (a protected file always does; a plain one has PG_VERSION in its listing or a
 * recorded layout — electron/companyFileFormat.js companyFileHoldsBooks): a missing database there
 * is a lost working copy, not a brand-new company.
 */
function savedBooksExpectedIn(dir: string): boolean {
  const file = process.env.BKA_COMPANY_FILE;
  if (!file) return false;
  const st = process.env.BKA_COMPANY_STATE;
  const work = st ? path.resolve(path.dirname(st), 'data') : resolveDataDir();
  const same = process.platform === 'win32' ? work.toLowerCase() === dir.toLowerCase() : work === dir;
  if (!same) return false;
  try {
    return Boolean(format.companyFileHoldsBooks(path.resolve(file)));
  } catch {
    return false;
  }
}

/** Open (or reuse) a database handle for a given company data directory. */
export function openDb(dataDir?: string): DbHandle {
  const dir = resolveDataDir(dataDir);
  // A company file protected with passwords is only used once someone has signed in (lib/db/sealed.ts).
  assertNotSealed(dir);
  const existing = handles.get(dir);
  if (existing) return existing;
  if (openHolds.has(dir)) {
    throw new ServiceError('CONFLICT', 'The company file is being switched. Try again in a moment.');
  }

  // The working copy of a company file whose saves hold books, with no database in it: never let
  // Postgres make a NEW, empty one there (it would be saved over the company file).
  if (!fs.existsSync(path.join(dir, 'PG_VERSION')) && savedBooksExpectedIn(dir)) {
    throw new ServiceError(
      'CONFLICT',
      'The copy of your books on this computer is missing. Close the company file and open it again; your company file itself was not changed.',
      { booksMissing: true },
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  // Refuse a company file another process has open (PGlite has no lock of its own, so two
  // writers on one folder silently lose each other's transactions) — lib/db/dirLock.ts.
  // If another process later takes the lock over (this one stopped renewing it: sleep, a long
  // pause), this handle dies: it is dropped, so getDb() re-checks the lock (CompanyFileInUseError
  // while the other process has it), and every statement still sent through it is refused.
  // It is deliberately NOT closed: closing PGlite checkpoints, which would write this process's
  // buffers into files the other process now owns.
  let handle: DbHandle | undefined;
  acquireDirLock(dir, (host) => {
    if (!handle || handle.lost) return;
    handle.lost = new CompanyFileInUseError(host);
    if (handles.get(dir) === handle) handles.delete(dir);
    console.error(`[db] company file ${dir} was taken over by ${host}; this process stopped using it.`);
  });
  // Postgres data errors (malformed uuid 22P02, numeric overflow 22003) become ServiceErrors for
  // every query, so bad input answers 4xx instead of 500 (lib/db/pgErrors.ts).
  let client: PGlite;
  try {
    client = translatePgErrors(new PGlite(dir));
  } catch (err) {
    releaseDirLock(dir);
    throw err;
  }
  refuseWhenLost(client, dir, () => handle?.lost ?? null);
  const db = drizzle(client, { schema });
  // Commit tracking for the running transaction log (appends only after COMMIT).
  instrumentDb(db, dir);

  const opened: DbHandle = { client, db, migrated: Promise.resolve(), damage: null, lost: null };
  handle = opened;
  opened.migrated = (async () => {
    // Postgres starts (and replays its write-ahead log after a crash) before the first statement.
    try {
      await client.waitReady;
    } catch (err) {
      throw new DatabaseWouldNotStartError(dir, err);
    }
    // PGlite's session time zone follows the host (e.g. Etc/GMT+5), so now() / defaultNow()
    // wrote local wall-clock time into `timestamp` columns, which drizzle reads back as UTC —
    // every DB-stamped time came back hours early (and a day early just after midnight).
    // PGlite is a single session, so this holds for every query on the handle.
    await client.exec("SET TIME ZONE 'UTC'");
    // Only migrate if a migrations folder has been generated. In early dev before
    // `db:generate`, callers can use db:push instead. An installed app (BKA_MIGRATIONS_DIR set)
    // without its migrations is broken: refuse, rather than run unmigrated / unguarded books.
    if (!fs.existsSync(MIGRATIONS_FOLDER) && process.env.BKA_MIGRATIONS_DIR) {
      throw new Error(`Ironbooks is missing its database upgrade files (${MIGRATIONS_FOLDER}). Reinstall Ironbooks.`);
    }
    if (fs.existsSync(MIGRATIONS_FOLDER)) {
      // Before anything writes to it: a file upgraded by a newer version is refused untouched.
      await refuseNewerFile(client, MIGRATIONS_FOLDER);
      // A file from an earlier version is about to be upgraded (some steps rewrite data in place,
      // and an older app refuses the upgraded file): keep a safety copy first, as QuickBooks backs
      // up before upgrading a company file. Best-effort — it never blocks the open.
      // Only the company file being opened (not a backup being restored or previewed — a restore
      // makes its own copy), once per folder per process (a failing upgrade retried on every
      // request rotated the older safety copies out), sealed like the file when it is protected.
      if (!upgradeCopied.has(dir) && path.resolve(dir) === path.resolve(resolveDataDir()) && (await pendingMigrationCount(client, MIGRATIONS_FOLDER)) > 0) {
        upgradeCopied.add(dir);
        try {
          await client.exec('CHECKPOINT');
          const { sealProtectionFor, isMarkedProtected } = await import('@/lib/services/fileProtection');
          // A file older than the protection tables (0077 / 0086) can't be read for its slots yet:
          // a plain file is copied as it is; a protected one is never copied unsealed.
          const protection = await sealProtectionFor(db as never, dir).catch((err) => {
            if (isMarkedProtected(dir)) throw err;
            return null;
          });
          const { ensurePreOpBackup } = await import('@/lib/services/backup');
          // Stamped with the layout the books are in NOW (before the upgrade), not the one this
          // app ships: the version used before must be able to restore its own safety copy (it
          // refuses a backup stamped newer than it knows).
          ensurePreOpBackup(null, 'upgrade', dir, protection, { dbSchemaAt: await appliedSchemaAt(client) });
        } catch (err) {
          console.warn('[db] could not make a safety copy before upgrading the company file:', (err as Error)?.message ?? err);
        }
      }
      try {
        await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      } catch (err) {
        console.error('[db] company file upgrade failed (rolled back):', err);
        throw new CompanyFileUpgradeError(err);
      }
      // Migrations already recorded are never re-run, so a file whose ledger guards were turned
      // off or replaced outside the app would stay unguarded. Re-install them on every open,
      // then refuse a file whose ledger is already damaged.
      await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
      // PGlite has no autovacuum: give tables that hold data but were never analyzed (or changed
      // a lot since) planner statistics, or large files get quadratic plans (plannerStats.ts).
      await refreshPlannerStats(db, 'open', { staleOnly: true });
      const health = await checkLedgerHealth(client, MIGRATIONS_FOLDER, { includeCachedBalances: false });
      const blocking = health.problems.filter((p) => OPEN_BLOCKING.has(p.kind));
      if (blocking.length) {
        opened.damage = blocking;
        console.error('[db] company file ledger is damaged:', dir, blocking.map((p) => p.detail).join(' '));
      }
    }
    await noteFirstOpenPosition(client, dir);
    // Saved keys of outside services (AI providers, ChatGPT, the mail password) belong to the
    // computer that entered them (lib/ai/keyVault.ts): the ones this computer can read are moved
    // to its own secret and the file's vault secret is deleted — or, with no such secret or for a
    // file protected with passwords, legacy keys move to the file's key as before. After the
    // first-open position on purpose, so the change is saved to the single company file like any
    // other. Never blocks the open (a failure leaves everything as it was: one transaction).
    if (fs.existsSync(MIGRATIONS_FOLDER) && !opened.damage) {
      try {
        const { MOVED_SECRET_TABLES, migrateStoredSecrets } = await import('@/lib/ai/keyVault');
        await migrateStoredSecrets(db, {
          dataDir: dir,
          // PGlite never vacuums, and the write-ahead log keeps whole copies of changed pages: without
          // this the old vault secret and blobs stay in the folder (and every copy of it). Rewrite
          // the tables, then start a new log segment and let the checkpoint delete the old one
          // (deleted, not recycled: a recycled segment keeps its old bytes). Separate statements:
          // VACUUM can't run inside the implicit transaction of a multi-statement exec.
          compact: async () => {
            await client.exec(`VACUUM FULL ${MOVED_SECRET_TABLES.join(', ')}`);
            await client.exec('SET wal_recycle = off');
            try {
              await client.query('SELECT pg_switch_wal()');
              await client.exec('CHECKPOINT');
            } finally {
              await client.exec('RESET wal_recycle');
            }
          },
        });
      } catch (err) {
        console.warn('[db] could not move saved keys to this computer:', (err as Error)?.message ?? err);
      }
    }
    // Internet services of a company file are held until this computer approves it
    // (lib/net/fileTrust.ts): a file this computer already knew before (named by the desktop shell)
    // or a brand-new one is approved here at its first open. After the first-open position, so the
    // stamp is saved to the single company file like any other change. Never blocks the open.
    if (fs.existsSync(MIGRATIONS_FOLDER)) {
      try {
        const { noteFileOpenedHere } = await import('@/lib/net/fileTrust');
        await noteFileOpenedHere(db, dir, { damaged: Boolean(opened.damage) });
      } catch (err) {
        console.warn('[db] could not record this computer’s approval of the company file:', (err as Error)?.message ?? err);
      }
    }
  })().catch(async (err) => {
    // A failed open (folder unreachable for a moment, damaged PG_VERSION, a migration that threw)
    // must not stay cached: every later request would answer this error until the app restarted,
    // and the lock — renewed by its heartbeat — would keep every other computer out. Close what
    // was opened first (callers meanwhile still get this handle and this error), then forget the
    // handle and release the lock so the next request opens the file afresh.
    try {
      await client.close();
    } catch {
      /* never finished opening */
    }
    if (handles.get(dir) === opened) handles.delete(dir);
    if (!opened.lost) releaseDirLock(dir);
    throw err;
  });

  handles.set(dir, opened);
  return opened;
}

/**
 * Where the database's write-ahead log stood once the company file had finished opening (after
 * migrations, ledger guards and planner statistics), for the FIRST open in this process only.
 * lib/services/companyFileSave.ts compares against it to know whether anything was written since
 * the single company file was opened — however late its own state is first created. A later
 * reopen (after a restore replaced the folder) never moves it, so restored books always count as
 * unsaved.
 */
const firstOpen = globalThis as typeof globalThis & { __ironbooksFirstOpenLsn?: { dir: string; lsn: string } };

async function noteFirstOpenPosition(client: PGlite, dir: string): Promise<void> {
  if (!process.env.BKA_COMPANY_FILE || firstOpen.__ironbooksFirstOpenLsn) return;
  try {
    const res = await client.query<{ lsn: string }>('select pg_current_wal_insert_lsn()::text as lsn');
    const lsn = res.rows[0]?.lsn;
    if (lsn && !firstOpen.__ironbooksFirstOpenLsn) firstOpen.__ironbooksFirstOpenLsn = { dir, lsn };
  } catch {
    /* unknown: the save logic then treats the database as changed */
  }
}

/** The write position recorded when `dataDir` was first opened in this process (see above). */
export function firstOpenWalPosition(dataDir?: string): string | null {
  const rec = firstOpen.__ironbooksFirstOpenLsn;
  return rec && rec.dir === resolveDataDir(dataDir) ? rec.lsn : null;
}

/** Ledger problems found when the company file was opened (null = healthy). */
export async function getLedgerDamage(dataDir?: string): Promise<LedgerProblem[] | null> {
  // Only a held file costs an extra tick: otherwise the file is resolved at call time, as before.
  if (openHoldFor(dataDir)) await waitForOpenHold(dataDir);
  const handle = openDb(dataDir);
  try {
    await handle.migrated;
  } catch (err) {
    if (!(err instanceof DatabaseWouldNotStartError)) throw err;
    // Would not start: getDb reopens the last save (or says why it can't), as for any request.
    await withDamagedFileAccess(() => getDb(dataDir));
    return openDb(dataDir).damage;
  }
  return handle.damage;
}

/**
 * The active company database (after migrations have completed). Refuses a company file whose
 * ledger is damaged (LedgerDamagedError) except inside withDamagedFileAccess().
 */
export async function getDb(dataDir?: string): Promise<DB> {
  // Only a held file costs an extra tick: otherwise the file is resolved at call time, as before.
  if (openHoldFor(dataDir)) await waitForOpenHold(dataDir);
  let handle = openDb(dataDir);
  try {
    await handle.migrated;
  } catch (err) {
    if (!(err instanceof DatabaseWouldNotStartError)) throw err;
    // The books on this computer would not start: reopen the company file's last save instead of
    // locking the person out (lib/services/workingCopyRecovery.ts), then try once more.
    const recovery = await import('@/lib/services/workingCopyRecovery');
    const outcome = await recovery.recoverUnstartableWorkingCopy(err.dir);
    if (outcome === 'resealed') {
      throw new ServiceError('FORBIDDEN', 'Authentication required.', { sealed: true, resealed: true });
    }
    if (outcome === 'needs-sign-in') {
      throw new ServiceError('FORBIDDEN', 'Authentication required.', { sealed: true, needsSignIn: true });
    }
    if (outcome === 'busy') throw new recovery.BooksBusyError();
    if (outcome !== 'replaced' && outcome !== 'retry') {
      throw new recovery.BooksWontOpenError(recovery.dataDirProblem(err.dir), Boolean(process.env.BKA_COMPANY_FILE));
    }
    // A request that came in during the recovery may have opened it already (it waited for it).
    if (openHoldFor(dataDir)) await waitForOpenHold(dataDir);
    handle = openDb(dataDir);
    try {
      await handle.migrated;
    } catch (again) {
      if (again instanceof DatabaseWouldNotStartError) throw new recovery.BooksWontOpenError(recovery.dataDirProblem(again.dir), true);
      throw again;
    }
  }
  // Taken over by another process while it was opening (dirLock.ts): never hand it out.
  if (handle.lost) throw handle.lost;
  if (handle.damage && !damagedFileAccess.getStore()) throw new LedgerDamagedError(handle.damage);
  return handle.db;
}

/**
 * Ledger problems found when the handle open in this process for `dataDir` opened (null: healthy,
 * or nothing open). Never opens anything: lib/services/companyFileSave.ts asks it so books found
 * damaged are never saved over the company file.
 */
export function openDbDamage(dataDir?: string): LedgerProblem[] | null {
  const damage = handles.get(resolveDataDir(dataDir))?.damage;
  return damage && damage.length ? damage : null;
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
