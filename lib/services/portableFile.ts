/**
 * Portable Company File (QuickBooks Desktop .QBM parity) — `<Company>.bkp`.
 *
 * A single, compressed file holding a complete LOGICAL export of a company file:
 *   bookkeeper-portable.json   manifest (schema + app version, created, company, row counts,
 *                              per-table SHA-256, ledger checksum = trial balance per account,
 *                              cached account balances, file + transaction-log checksums)
 *   checksums.sha256           "<sha256>  <entry>" for every other entry (incl. the manifest)
 *   data/<table>.jsonl         every row of every table (users incl. password hashes,
 *                              preferences, lists, documents, journal, audit trail, …)
 *   files/attachments/…        attachment files stored in the data dir
 *   files/transactions.bktlg   the running transaction log
 *
 * Rows are exported as the database's own text representation of each value (JSON/JSONB
 * columns as native JSON), read and written entirely inside Postgres (`row_to_json` out,
 * `json_populate_recordset` in) — values never pass through JavaScript numbers, so amounts,
 * timestamps and ids round-trip byte-for-byte.
 *
 * `restorePortableCompanyFile` recreates the company in a NEW, empty data directory and then
 * proves the copy is exact: every table's row count and content hash, every account's trial
 * balance and cached balance, the attachment files and the transaction log must match the
 * manifest, and every company's trial balance must balance. On any mismatch the new
 * directory is removed and the restore is refused — a partial or altered file never opens.
 *
 * The session-signing secret (.auth-secret) is deliberately NOT included.
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { asc, eq } from 'drizzle-orm';
import { closeDb, getDb, resolveDataDir, type DB } from '@/lib/db';
import { accounts, companies } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { trialBalance } from './reports';
import { TRANSACTION_LOG_FILE, transactionLogPath, readAllTransactionLog } from './transactionLog';
import pkg from '@/package.json';

export const PORTABLE_EXTENSION = 'bkp';
export const PORTABLE_MANIFEST_ENTRY = 'bookkeeper-portable.json';
export const PORTABLE_CHECKSUMS_ENTRY = 'checksums.sha256';
/** Bump when the portable layout changes incompatibly. */
export const PORTABLE_FORMAT_VERSION = 1;

/** Desktop company-file manifest (mirrors electron/companyFile.js). */
const COMPANY_FILE_MANIFEST = 'bookkeeper-company.json';
const COMPANY_FILE_SCHEMA = 'bookkeeper-company/v1';

/** Data-dir files carried in the portable file (relative paths; dirs are walked). */
const CARRIED_PATHS = ['attachments', TRANSACTION_LOG_FILE];

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export interface LedgerAccountChecksum {
  code: string;
  name: string;
  debit: string;
  credit: string;
}

export interface CompanyLedgerChecksum {
  companyName: string;
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
  /** Trial balance per account (accounts with activity). */
  trialBalance: LedgerAccountChecksum[];
  /** Cached accounts.balance per account code (every account). */
  accountBalances: Record<string, string>;
  sha256: string;
}

export interface PortableManifest {
  app: 'bookkeeper-ai';
  kind: 'portable';
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  companyName: string;
  companies: Array<{ id: string; name: string }>;
  schemaVersion: { migrations: number; lastMigrationAt: number | null };
  tables: Record<string, { rows: number; columns: string[]; sha256: string }>;
  rowCounts: Record<string, number>;
  ledger: Record<string, CompanyLedgerChecksum>;
  files: Record<string, { bytes: number; sha256: string }>;
  transactionLog: { records: number; headHash: string | null; sha256: string } | null;
}

// ---------------------------------------------------------------------------
// Low-level database access (raw PGlite client — values stay inside Postgres)
// ---------------------------------------------------------------------------

type Queryable = Pick<Transaction, 'query' | 'exec'>;

function rawClient(db: DB): PGlite {
  const client = (db as unknown as { $client?: PGlite }).$client;
  if (!client) throw new ServiceError('INTERNAL', 'Portable file: database client unavailable.');
  return client;
}

const qi = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

interface TableInfo {
  name: string;
  columns: Array<{ name: string; type: string; json: boolean }>;
}

async function listTables(q: Queryable): Promise<TableInfo[]> {
  const res = await q.query<{ table: string; column: string; type: string; generated: string }>(
    `SELECT c.relname AS "table", a.attname AS "column",
            format_type(a.atttypid, a.atttypmod) AS "type", a.attgenerated::text AS "generated"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
  );
  const byName = new Map<string, TableInfo>();
  for (const r of res.rows) {
    if (r.generated && r.generated.trim()) continue; // generated columns are recomputed
    let t = byName.get(r.table);
    if (!t) {
      t = { name: r.table, columns: [] };
      byName.set(r.table, t);
    }
    t.columns.push({ name: r.column, type: r.type, json: r.type === 'json' || r.type === 'jsonb' });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every row of a table as canonical JSON text, deterministically ordered. Non-JSON columns
 * are rendered with Postgres' own text output (exact for numeric/timestamp/uuid/enum/array).
 */
async function dumpTable(q: Queryable, table: TableInfo, columnNames?: string[]): Promise<string[]> {
  const cols = columnNames
    ? columnNames.map((n) => table.columns.find((c) => c.name === n) ?? { name: n, type: 'text', json: false })
    : table.columns;
  if (!cols.length) return [];
  const exprs = cols.map((c) => (c.json ? `${qi(c.name)} AS ${qi(c.name)}` : `${qi(c.name)}::text AS ${qi(c.name)}`));
  const res = await q.query<{ r: string }>(
    `SELECT row_to_json(x)::text AS r FROM (SELECT ${exprs.join(', ')} FROM ${qi(table.name)}) x ORDER BY 1`,
  );
  return res.rows.map((row) => row.r);
}

async function migrationInfo(q: Queryable): Promise<PortableManifest['schemaVersion']> {
  try {
    const res = await q.query<{ n: number; last: string | number | null }>(
      'SELECT COUNT(*)::int AS n, MAX(created_at) AS last FROM drizzle.__drizzle_migrations',
    );
    const row = res.rows[0];
    return { migrations: row?.n ?? 0, lastMigrationAt: row?.last == null ? null : Number(row.last) };
  } catch {
    return { migrations: 0, lastMigrationAt: null };
  }
}

/** Row count + SHA-256 of every table's canonical dump. */
export async function computeTableDigests(
  db: DB,
): Promise<Record<string, { rows: number; columns: string[]; sha256: string }>> {
  const client = rawClient(db);
  return client.transaction(async (tx) => {
    const out: Record<string, { rows: number; columns: string[]; sha256: string }> = {};
    for (const t of await listTables(tx)) {
      const lines = await dumpTable(tx, t);
      out[t.name] = { rows: lines.length, columns: t.columns.map((c) => c.name), sha256: sha256(lines.join('\n')) };
    }
    return out;
  });
}

/** Trial balance + cached balances per account, for every company in the database. */
export async function computeLedgerChecksums(db: DB): Promise<Record<string, CompanyLedgerChecksum>> {
  const out: Record<string, CompanyLedgerChecksum> = {};
  const cos = await db.select({ id: companies.id, name: companies.name }).from(companies).orderBy(asc(companies.id));
  for (const co of cos) {
    const tb = await trialBalance({ db, companyId: co.id, userId: null });
    const accts = await db
      .select({ code: accounts.code, id: accounts.id, balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.companyId, co.id))
      .orderBy(asc(accounts.code), asc(accounts.id));
    const accountBalances: Record<string, string> = {};
    for (const a of accts) {
      const key = accountBalances[a.code] === undefined ? a.code : `${a.code}#${a.id}`;
      accountBalances[key] = Money.of(a.balance).toFixed(2);
    }
    const trial = tb.rows.map((r) => ({ code: r.code, name: r.name, debit: r.debit, credit: r.credit }));
    const body = JSON.stringify({ trial, accountBalances, totalDebit: tb.totalDebit, totalCredit: tb.totalCredit });
    out[co.id] = {
      companyName: co.name,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      balanced: tb.balanced,
      trialBalance: trial,
      accountBalances,
      sha256: sha256(body),
    };
  }
  return out;
}

/** Relative paths (posix) of every carried file under a data dir. */
function carriedFiles(dataDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(dataDir, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, name));
    } else if (st.isFile()) {
      out.push(rel);
    }
  };
  for (const p of CARRIED_PATHS) walk(p);
  return out;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface PortableFileResult {
  buffer: Buffer;
  filename: string;
  manifest: PortableManifest;
}

/** Filesystem-safe company file name (keeps spaces; strips path/reserved characters). */
export function portableFilename(companyName: string): string {
  const base = companyName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').trim() || 'Company';
  return `${base.slice(0, 120)}.${PORTABLE_EXTENSION}`;
}

/**
 * Build `<Company>.bkp` for the company file (data directory) behind `ctx`.
 * Includes users with password hashes, so it requires the owner or an admin.
 */
export async function createPortableCompanyFile(
  ctx: ServiceContext,
  opts: { dataDir?: string } = {},
): Promise<PortableFileResult> {
  if (ctx.role && ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new ServiceError(
      'FORBIDDEN',
      'Only the company owner or an admin can create a portable company file (it contains every user and password).',
    );
  }
  const dataDir = resolveDataDir(opts.dataDir);
  const db = ctx.db;
  const client = rawClient(db);
  const [current] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId));
  if (!current) throw new ServiceError('NOT_FOUND', 'Company not found');

  const zip = new AdmZip();
  const checksums: Array<[string, string]> = [];
  const add = (entry: string, data: Buffer) => {
    zip.addFile(entry, data);
    checksums.push([sha256(data), entry]);
  };

  // One snapshot: the PGlite transaction holds the connection, so no other request can
  // commit between table dumps. The ledger + log are read inside the same window.
  const snapshot = await client.transaction(async (tx) => {
    const tables: PortableManifest['tables'] = {};
    for (const t of await listTables(tx)) {
      const lines = await dumpTable(tx, t);
      const text = lines.join('\n');
      tables[t.name] = { rows: lines.length, columns: t.columns.map((c) => c.name), sha256: sha256(text) };
      add(`data/${t.name}.jsonl`, Buffer.from(text, 'utf8'));
    }
    const schemaVersion = await migrationInfo(tx);
    const cos = await tx.query<{ id: string; name: string }>('SELECT id::text AS id, name FROM companies ORDER BY name, id');
    // Files are copied while the connection is held, so the log cannot grow mid-copy.
    const files: PortableManifest['files'] = {};
    for (const rel of carriedFiles(dataDir)) {
      const bytes = fs.readFileSync(path.join(dataDir, rel));
      files[rel] = { bytes: bytes.length, sha256: sha256(bytes) };
      add(`files/${rel}`, bytes);
    }
    return { tables, schemaVersion, companies: cos.rows, files };
  });

  const ledger = await computeLedgerChecksums(db);
  const logFile = transactionLogPath(dataDir);
  const tlog = snapshot.files[TRANSACTION_LOG_FILE];
  let transactionLog: PortableManifest['transactionLog'] = null;
  if (tlog && fs.existsSync(logFile)) {
    const parsed = readAllTransactionLog(dataDir);
    const last = parsed.records[parsed.records.length - 1];
    transactionLog = { records: parsed.records.length, headHash: last?.hash ?? null, sha256: tlog.sha256 };
  }

  const manifest: PortableManifest = {
    app: 'bookkeeper-ai',
    kind: 'portable',
    formatVersion: PORTABLE_FORMAT_VERSION,
    appVersion: process.env.BKA_APP_VERSION || pkg.version,
    createdAt: new Date().toISOString(),
    companyName: current.name,
    companies: snapshot.companies,
    schemaVersion: snapshot.schemaVersion,
    tables: snapshot.tables,
    rowCounts: Object.fromEntries(Object.entries(snapshot.tables).map(([k, v]) => [k, v.rows])),
    ledger,
    files: snapshot.files,
    transactionLog,
  };
  add(PORTABLE_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.addFile(
    PORTABLE_CHECKSUMS_ENTRY,
    Buffer.from(checksums.map(([h, e]) => `${h}  ${e}`).join('\n') + '\n', 'utf8'),
  );

  return { buffer: zip.toBuffer(), filename: portableFilename(current.name), manifest };
}

// ---------------------------------------------------------------------------
// Read / validate
// ---------------------------------------------------------------------------

const notPortable = (detail: string) =>
  new ServiceError('VALIDATION', `Not a BookKeeper portable company file (${detail}).`);

interface OpenedPortable {
  zip: AdmZip;
  manifest: PortableManifest;
}

/**
 * Open a .bkp buffer and verify its integrity: the manifest identifies a supported portable
 * file, and EVERY entry listed in checksums.sha256 is present and matches its SHA-256 (so a
 * truncated download or an edited row is refused before anything is written).
 */
export function openPortableFile(buffer: Buffer): OpenedPortable {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
    zip.getEntries();
  } catch {
    throw notPortable('could not read the file');
  }
  const manifestEntry = zip.getEntry(PORTABLE_MANIFEST_ENTRY);
  const sumsEntry = zip.getEntry(PORTABLE_CHECKSUMS_ENTRY);
  if (!manifestEntry || !sumsEntry) {
    if (zip.getEntry('bookkeeper-manifest.json')) {
      throw new ServiceError('VALIDATION', 'This is a backup (.bka), not a portable company file. Restore it from Backup & Restore.');
    }
    throw notPortable('manifest is missing');
  }
  let manifest: PortableManifest;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry));
  } catch {
    throw notPortable('manifest is unreadable');
  }
  if (manifest.app !== 'bookkeeper-ai' || manifest.kind !== 'portable') {
    throw notPortable('manifest does not identify a portable company file');
  }
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > PORTABLE_FORMAT_VERSION) {
    throw new ServiceError(
      'VALIDATION',
      'This portable company file was created by a newer version of BookKeeper. Update the app, then open it.',
    );
  }

  const listed = new Map<string, string>();
  for (const line of zip.readAsText(sumsEntry).split('\n')) {
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (m) listed.set(m[2], m[1]);
  }
  if (!listed.has(PORTABLE_MANIFEST_ENTRY)) throw notPortable('checksum list is incomplete');
  for (const [entryName, expected] of listed) {
    const entry = zip.getEntry(entryName);
    if (!entry) {
      throw new ServiceError('VALIDATION', `The portable file is damaged: "${entryName}" is missing. Nothing was restored.`);
    }
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      throw new ServiceError('VALIDATION', `The portable file is damaged: "${entryName}" cannot be read. Nothing was restored.`);
    }
    if (sha256(data) !== expected) {
      throw new ServiceError(
        'VALIDATION',
        `The portable file failed its integrity check ("${entryName}" does not match its checksum). Nothing was restored.`,
      );
    }
  }
  // Every table and file the manifest promises must be covered by a verified checksum.
  for (const t of Object.keys(manifest.tables ?? {})) {
    if (!listed.has(`data/${t}.jsonl`)) throw notPortable(`table "${t}" is not covered by a checksum`);
  }
  for (const f of Object.keys(manifest.files ?? {})) {
    if (!listed.has(`files/${f}`)) throw notPortable(`file "${f}" is not covered by a checksum`);
  }
  return { zip, manifest };
}

/** Manifest summary for the UI ("You are about to open … created … N entries"). */
export function readPortableManifest(buffer: Buffer): PortableManifest {
  return openPortableFile(buffer).manifest;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface PortableRestoreResult {
  dataDir: string;
  companyName: string;
  companies: Array<{ id: string; name: string }>;
  rowCounts: Record<string, number>;
  verified: {
    tables: number;
    rows: number;
    files: number;
    ledgersBalanced: boolean;
    transactionLogRecords: number;
  };
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true; // missing
  }
}

/** Safe relative path inside the data dir (no absolute paths / traversal from the archive). */
function safeRelative(rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) {
    throw notPortable(`unsafe file path "${rel}"`);
  }
  return norm;
}

const JSON_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Recreate the company file from a .bkp into `targetDir`, which must not exist or be empty.
 * Verifies checksums before writing, then verifies the restored database against the manifest
 * (row counts + content hashes per table, ledger checksums, balanced trial balance, carried
 * files, transaction log). Any mismatch removes the new directory and throws VALIDATION.
 */
export async function restorePortableCompanyFile(
  buffer: Buffer,
  targetDir: string,
): Promise<PortableRestoreResult> {
  const { zip, manifest } = openPortableFile(buffer);
  const dir = path.resolve(targetDir);
  if (!isEmptyDir(dir)) {
    throw new ServiceError('CONFLICT', 'The destination folder is not empty. Choose a new location for the restored company file.');
  }
  const createdDir = !fs.existsSync(dir);

  const fail = async (message: string): Promise<never> => {
    await closeDb(dir).catch(() => undefined);
    try {
      if (createdDir) fs.rmSync(dir, { recursive: true, force: true });
      else for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw new ServiceError('VALIDATION', message);
  };

  let db: DB;
  try {
    db = await getDb(dir); // creates the database and applies this app's migrations
  } catch (err) {
    return fail(`Could not create the company database: ${(err as Error).message}`);
  }

  try {
    const client = rawClient(db);
    const target = await migrationInfo(client);
    if (
      manifest.schemaVersion?.lastMigrationAt != null &&
      (target.lastMigrationAt == null || manifest.schemaVersion.lastMigrationAt > target.lastMigrationAt)
    ) {
      return await fail(
        'This portable company file was created by a newer version of BookKeeper (its database layout is newer than this app). Update the app, then open it.',
      );
    }

    // --- Load every table (FK checks deferred via replica role; the source was consistent). ---
    const loadError = await client.transaction(async (tx) => {
      const targetTables = new Map((await listTables(tx)).map((t) => [t.name, t]));
      for (const [name, info] of Object.entries(manifest.tables)) {
        const t = targetTables.get(name);
        if (!t) return `table "${name}" does not exist in this version of the app`;
        const missing = info.columns.filter((c) => !t.columns.some((tc) => tc.name === c));
        if (missing.length) return `table "${name}" is missing column(s) ${missing.join(', ')} in this version of the app`;
      }
      await tx.exec('SET LOCAL session_replication_role = replica');
      if (targetTables.size) {
        // A brand-new database is empty apart from migration seed rows; the file's own copies replace them.
        await tx.exec(`TRUNCATE ${[...targetTables.keys()].map(qi).join(', ')}`);
      }
      for (const [name, info] of Object.entries(manifest.tables)) {
        if (!info.rows) continue;
        const text = zip.readAsText(`data/${name}.jsonl`, 'utf8');
        const lines = text ? text.split('\n') : [];
        if (lines.length !== info.rows) return `table "${name}" has ${lines.length} rows, expected ${info.rows}`;
        const colList = info.columns.map(qi).join(', ');
        let batch: string[] = [];
        let bytes = 0;
        const flush = async () => {
          if (!batch.length) return;
          await tx.query(
            `INSERT INTO ${qi(name)} (${colList}) SELECT ${colList} FROM json_populate_recordset(NULL::${qi(name)}, $1::text::json)`,
            [`[${batch.join(',')}]`],
          );
          batch = [];
          bytes = 0;
        };
        for (const line of lines) {
          batch.push(line);
          bytes += line.length;
          if (bytes >= JSON_CHUNK_BYTES) await flush();
        }
        await flush();
      }
      // Advance any serial/identity sequences past the restored ids.
      const seqs = await tx.query<{ tbl: string; col: string; seq: string }>(
        `SELECT c.relname AS tbl, a.attname AS col, pg_get_serial_sequence(quote_ident(c.relname), a.attname) AS seq
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND pg_get_serial_sequence(quote_ident(c.relname), a.attname) IS NOT NULL`,
      );
      for (const s of seqs.rows) {
        await tx.query(
          `SELECT setval($1, COALESCE((SELECT MAX(${qi(s.col)}) FROM ${qi(s.tbl)}), 1), (SELECT MAX(${qi(s.col)}) FROM ${qi(s.tbl)}) IS NOT NULL)`,
          [s.seq],
        );
      }
      return null;
    });
    if (loadError) return await fail(`The portable file cannot be opened: ${loadError}.`);

    // --- Carried files (attachments, transaction log). ---
    for (const [rel, info] of Object.entries(manifest.files ?? {})) {
      const safe = safeRelative(rel);
      const bytes = zip.getEntry(`files/${rel}`)!.getData();
      if (bytes.length !== info.bytes || sha256(bytes) !== info.sha256) {
        return await fail(`The portable file is damaged: "${rel}" does not match its checksum.`);
      }
      const out = path.join(dir, ...safe.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, bytes);
    }

    // --- Prove the copy is exact. ---
    const verifyError = await client.transaction(async (tx) => {
      const targetTables = new Map((await listTables(tx)).map((t) => [t.name, t]));
      for (const [name, info] of Object.entries(manifest.tables)) {
        const lines = await dumpTable(tx, targetTables.get(name)!, info.columns);
        if (lines.length !== info.rows) return `table "${name}" restored ${lines.length} rows, expected ${info.rows}`;
        if (sha256(lines.join('\n')) !== info.sha256) return `table "${name}" content does not match the original`;
      }
      return null;
    });
    if (verifyError) return await fail(`Restore refused — verification failed: ${verifyError}. Nothing was kept.`);

    const ledger = await computeLedgerChecksums(db);
    for (const [companyId, expected] of Object.entries(manifest.ledger ?? {})) {
      const got = ledger[companyId];
      if (!got || got.sha256 !== expected.sha256) {
        return await fail(
          `Restore refused — the trial balance of "${expected.companyName}" does not match the original. Nothing was kept.`,
        );
      }
    }
    const unbalanced = Object.values(ledger).find((l) => !l.balanced);
    if (unbalanced) {
      return await fail(`Restore refused — the trial balance of "${unbalanced.companyName}" is out of balance. Nothing was kept.`);
    }

    let tlogRecords = 0;
    if (manifest.transactionLog) {
      const parsed = readAllTransactionLog(dir);
      tlogRecords = parsed.records.length;
      const last = parsed.records[parsed.records.length - 1];
      if (tlogRecords !== manifest.transactionLog.records || (last?.hash ?? null) !== manifest.transactionLog.headHash) {
        return await fail('Restore refused — the transaction log does not match the original. Nothing was kept.');
      }
    }

    // Make the folder a self-describing desktop company file.
    fs.writeFileSync(
      path.join(dir, COMPANY_FILE_MANIFEST),
      JSON.stringify(
        {
          schema: COMPANY_FILE_SCHEMA,
          name: manifest.companyName,
          createdAt: new Date().toISOString(),
          restoredFromPortable: { createdAt: manifest.createdAt, appVersion: manifest.appVersion },
        },
        null,
        2,
      ),
      'utf8',
    );

    await closeDb(dir);
    return {
      dataDir: dir,
      companyName: manifest.companyName,
      companies: manifest.companies,
      rowCounts: manifest.rowCounts,
      verified: {
        tables: Object.keys(manifest.tables).length,
        rows: Object.values(manifest.rowCounts).reduce((a, b) => a + b, 0),
        files: Object.keys(manifest.files ?? {}).length,
        ledgersBalanced: true,
        transactionLogRecords: tlogRecords,
      },
    };
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    return fail(`The portable file could not be restored: ${(err as Error).message}. Nothing was kept.`);
  }
}

/**
 * Default destination for a restore requested from the browser UI: a new sibling folder of
 * the active company file, e.g. `<parent>/Acme Corp (restored 2026-10-10 1405).bookkeeper`.
 */
export function defaultPortableRestoreDir(companyName: string, activeDataDir?: string): string {
  const parent = path.dirname(resolveDataDir(activeDataDir));
  const safe = companyName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').trim() || 'Company';
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  let candidate = path.join(parent, `${safe} (restored ${stamp}).bookkeeper`);
  for (let i = 2; !isEmptyDir(candidate); i++) {
    candidate = path.join(parent, `${safe} (restored ${stamp} ${i}).bookkeeper`);
  }
  return candidate;
}
