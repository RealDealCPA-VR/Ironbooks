/**
 * Local-first database client.
 *
 * BookKeeper AI is a DESKTOP app: data lives on the user's machine, not in a cloud Postgres.
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

export type DB = PgliteDatabase<typeof schema>;

interface DbHandle {
  client: PGlite;
  db: DB;
  migrated: Promise<void>;
}

const handles = new Map<string, DbHandle>();

/** Resolve the data directory for the active (or a named) company file. */
export function resolveDataDir(dataDir?: string): string {
  if (dataDir) return path.resolve(dataDir);
  if (process.env.BKA_DATA_DIR) return path.resolve(process.env.BKA_DATA_DIR);
  return path.resolve(process.cwd(), '.bookkeeper-data', 'default');
}

// In dev this is <project>/drizzle. In a packaged Electron build the standalone server's cwd
// differs, so the main process sets BKA_MIGRATIONS_DIR to the bundled migrations location.
const MIGRATIONS_FOLDER = process.env.BKA_MIGRATIONS_DIR
  ? path.resolve(process.env.BKA_MIGRATIONS_DIR)
  : path.resolve(process.cwd(), 'drizzle');

/** Open (or reuse) a database handle for a given company data directory. */
export function openDb(dataDir?: string): DbHandle {
  const dir = resolveDataDir(dataDir);
  const existing = handles.get(dir);
  if (existing) return existing;

  fs.mkdirSync(dir, { recursive: true });
  // Postgres data errors (malformed uuid 22P02, numeric overflow 22003) become ServiceErrors for
  // every query, so bad input answers 4xx instead of 500 (lib/db/pgErrors.ts).
  const client = translatePgErrors(new PGlite(dir));
  const db = drizzle(client, { schema });
  // Commit tracking for the running transaction log (appends only after COMMIT).
  instrumentDb(db, dir);

  const migrated = (async () => {
    // Only migrate if a migrations folder has been generated. In early dev before
    // `db:generate`, callers can use db:push instead.
    if (fs.existsSync(MIGRATIONS_FOLDER)) {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    }
  })();

  const handle: DbHandle = { client, db, migrated };
  handles.set(dir, handle);
  return handle;
}

/** The active company database (after migrations have completed). */
export async function getDb(dataDir?: string): Promise<DB> {
  const handle = openDb(dataDir);
  await handle.migrated;
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
    await handle.client.close();
    handles.delete(dir);
  }
}

export { schema };
