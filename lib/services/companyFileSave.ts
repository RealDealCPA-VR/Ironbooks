/**
 * Saving the open single-file company file ("ABC Company.ironbooks", electron/companyFileFormat.js).
 *
 * The desktop shell opens a company file into a private working copy on this computer
 * (electron/companySession.js) and starts this server on it with:
 *   BKA_COMPANY_FILE        the company file itself (local disk, USB drive or office file server)
 *   BKA_COMPANY_STATE       the working copy's state.json (crash recovery bookkeeping)
 *   BKA_COMPANY_LOCK        the "in use" lock folder next to the company file (electron/companyLock.js)
 *   BKA_COMPANY_LOCK_TOKEN  this computer's token in that lock
 *
 * Every change lands in the working copy first and is saved back to the company file:
 *  - a few seconds after the books change (the running transaction log's head moves), at the
 *    latest SAVE_WITHIN_MS after the first unsaved change while someone keeps working;
 *  - every HOUSEKEEPING_SAVE_MS when only housekeeping changed (sign-ins, …);
 *  - when the file is closed or the app quits (the shell calls saveCompanyFile({ final: true })).
 *
 * A save never writes over someone else's work: it checks that this computer still holds the
 * lock and that the company file is still the save this working copy started from. Otherwise
 * the changes go to a separate copy next to the company file and the status says so.
 *
 * The status (saved / saving / unsaved / error / lost) is shown in the app's title bar
 * (components/CompanyFileStatus.tsx via GET /api/company-file/status).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import format from '@/electron/companyFileFormat';
import lockFormat from '@/electron/companyLock';
import { closeDb, firstOpenWalPosition, getDb, holdDbOpen, isDbOpen, resolveDataDir, withDamagedFileAccess, type DB } from '@/lib/db';
import { currentFingerprint } from './backupFingerprint';
import { BACKUP_HISTORY_FILE } from './backupHistory';
import { APP_VERSION } from '@/lib/appVersion';

/** How often the autosave timer looks for changes. */
export const AUTOSAVE_TICK_MS = 2_000;
/** Save this long after the books last changed (typing a batch of entries saves once, at the end). */
export const SAVE_AFTER_QUIET_MS = 3_000;
/** …but never let unsaved book changes wait longer than this. */
export const SAVE_WITHIN_MS = 30_000;
/** Housekeeping-only changes (sign-ins, session heartbeats) are saved at this pace. */
export const HOUSEKEEPING_SAVE_MS = 5 * 60_000;
/** A CHECKPOINT before a save at most this often (keeps the file compact and quick to open). */
const CHECKPOINT_EVERY_MS = 10 * 60_000;

export type SaveStatusKind = 'saved' | 'unsaved' | 'saving' | 'error' | 'lost';

export interface CompanyFileSaveStatus {
  /** False when the open file is a folder (older format) or this is not the desktop app. */
  singleFile: boolean;
  /** The company file's full path (null when not single-file). */
  path: string | null;
  status: SaveStatusKind;
  lastSavedAt: string | null;
  /** First change not yet in the company file. */
  unsavedSince: string | null;
  /** Plain-language problem for the user (unreachable server, lost lock, …). */
  error: string | null;
  /** Unsaved changes that could not go into the company file were saved here instead. */
  conflictCopy: string | null;
}

export interface SaveResult {
  saved: boolean;
  /** 'not-single-file' | 'unchanged' | 'saved' | 'conflict' */
  outcome: 'not-single-file' | 'unchanged' | 'saved' | 'conflict';
  path?: string;
  bytes?: number;
  durationMs?: number;
}

interface SaveState {
  file: string;
  /**
   * The working copy's database folder — the ONLY folder ever saved into the company file. Fixed
   * when the server starts: a sandbox ("Try it on a copy") switches the server's active folder to
   * a practice copy, which must never be written into the real company file.
   */
  dataDir: string;
  statePath: string | null;
  lockDir: string | null;
  lockToken: string | null;
  cache: Map<string, unknown>;
  savedFingerprint: string | null;
  savedLsn: string | null;
  lastSeenFingerprint: string | null;
  lastChangeAt: number | null;
  unsavedSince: number | null;
  booksUnsaved: boolean;
  lastSavedAt: string | null;
  lastCheckpointAt: number;
  lastSaveMs: number;
  lastSaveEndedAt: number;
  inflight: Promise<SaveResult> | null;
  status: SaveStatusKind;
  error: string | null;
  conflictCopy: string | null;
  /** The save this process last wrote into `conflictCopy` (later work goes into the same copy). */
  conflictSaveId: string | null;
  /** The database layout the working copy has (its newest migration), stamped into every save. */
  dbSchema: DbSchemaStamp | null;
  timer: ReturnType<typeof setInterval> | null;
  closed: boolean;
}

const g = globalThis as typeof globalThis & { __ironbooksCompanyFileSave?: SaveState | null };

/** The company file this server is saving to, from the shell's environment (null: folder mode). */
export function companyFilePath(): string | null {
  const f = process.env.BKA_COMPANY_FILE;
  return f ? path.resolve(f) : null;
}

function state(): SaveState | null {
  const file = companyFilePath();
  if (!file) return null;
  const cur = g.__ironbooksCompanyFileSave;
  if (cur && cur.file === file) return cur;
  const statePath = process.env.BKA_COMPANY_STATE ? path.resolve(process.env.BKA_COMPANY_STATE) : null;
  const fresh: SaveState = {
    file,
    // electron/companySession.js: <working copy>/state.json next to <working copy>/data.
    dataDir: statePath ? path.join(path.dirname(statePath), 'data') : resolveDataDir(),
    statePath,
    lockDir: process.env.BKA_COMPANY_LOCK ? path.resolve(process.env.BKA_COMPANY_LOCK) : null,
    lockToken: process.env.BKA_COMPANY_LOCK_TOKEN || null,
    cache: new Map(),
    savedFingerprint: null,
    savedLsn: null,
    lastSeenFingerprint: null,
    lastChangeAt: null,
    unsavedSince: null,
    booksUnsaved: false,
    lastSavedAt: null,
    lastCheckpointAt: 0,
    lastSaveMs: 0,
    lastSaveEndedAt: 0,
    inflight: null,
    status: 'saved',
    error: null,
    conflictCopy: null,
    conflictSaveId: null,
    dbSchema: null,
    timer: null,
    closed: false,
  };
  // What the working copy was opened from (the shell wrote it before starting this server).
  const ws = readWorkingState(fresh.statePath);
  if (ws?.unsavedSince) {
    // Recovered changes from an earlier run: save them as soon as possible.
    fresh.unsavedSince = Date.parse(ws.unsavedSince) || Date.now();
    fresh.booksUnsaved = true;
    fresh.status = 'unsaved';
  }
  fresh.lastSavedAt = ws?.base?.savedAt ?? null;
  // What the company file itself holds: the transaction-log head recorded with its last save (a
  // file saved before that was recorded falls back to the working copy as it is now). Never "the
  // working copy when this state was first made" — work done before that would never be saved.
  const base = ws?.base;
  fresh.savedFingerprint = ws?.unsavedSince
    ? null
    : base && Object.prototype.hasOwnProperty.call(base, 'fingerprint')
      ? (base.fingerprint ?? null)
      : currentFingerprint(fresh.dataDir);
  fresh.lastSeenFingerprint = currentFingerprint(fresh.dataDir);
  g.__ironbooksCompanyFileSave = fresh;
  return fresh;
}

interface WorkingState {
  companyFile?: string;
  base?: { saveId?: string | null; savedAt?: string | null; fingerprint?: string | null };
  unsavedSince?: string | null;
  companyName?: string | null;
  fileId?: string | null;
  [k: string]: unknown;
}

function readWorkingState(file: string | null): WorkingState | null {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkingState;
  } catch {
    return null;
  }
}

function writeWorkingState(s: SaveState, patch: Partial<WorkingState>): void {
  if (!s.statePath) return;
  try {
    const next = { ...(readWorkingState(s.statePath) ?? {}), ...patch };
    const tmp = `${s.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, s.statePath);
  } catch (err) {
    console.warn('[company-file] could not update the working copy state:', (err as Error).message);
  }
}

/** Mark the working copy as holding changes the company file doesn't have yet (crash recovery). */
function noteUnsaved(s: SaveState, now: number, books: boolean): void {
  if (books) s.booksUnsaved = true;
  if (s.unsavedSince) return;
  s.unsavedSince = now;
  if (s.status === 'saved') s.status = 'unsaved';
  writeWorkingState(s, { unsavedSince: new Date(now).toISOString() });
}

/**
 * The database write position the company file matches: where the last save in this process took
 * its snapshot, else where the database stood once it had opened (lib/db firstOpenWalPosition).
 */
function baselineLsn(s: SaveState): string | null {
  return s.savedLsn ?? firstOpenWalPosition(s.dataDir);
}

/** The working copy is the server's active database right now (not a sandbox / practice copy). */
function workingCopyActive(s: SaveState): boolean {
  const a = path.resolve(resolveDataDir());
  const b = path.resolve(s.dataDir);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function currentLsn(s: SaveState): Promise<string | null> {
  if (!workingCopyActive(s) || !isDbOpen(s.dataDir)) return null;
  try {
    const db = await withDamagedFileAccess(() => getDb(s.dataDir));
    const res = (await db.execute(sql`select pg_current_wal_insert_lsn()::text as lsn`)) as unknown as {
      rows?: Array<{ lsn?: string }>;
    };
    return res.rows?.[0]?.lsn ?? null;
  } catch {
    return null;
  }
}

/**
 * The database layout of a company file, in its manifest: an older Ironbooks that finds a newer
 * layout there refuses to open the file (electron/companySession.js) instead of downgrading it.
 */
export interface DbSchemaStamp {
  migrations: number;
  /** `when` of the newest migration applied (drizzle journal), ms. */
  lastMigrationAt: number;
}

async function dbSchemaOf(db: DB): Promise<DbSchemaStamp | null> {
  try {
    const res = (await db.execute(
      sql`select count(*)::int as n, max(created_at)::text as last from drizzle.__drizzle_migrations`,
    )) as unknown as { rows?: Array<{ n?: number | string; last?: string | null }> };
    const row = res.rows?.[0];
    const last = row?.last == null ? NaN : Number(row.last);
    return Number.isFinite(last) ? { migrations: Number(row?.n ?? 0), lastMigrationAt: last } : null;
  } catch {
    return null;
  }
}

/** The working copy's layout right now (null when it is not the open, active database). */
async function currentDbSchema(s: SaveState): Promise<DbSchemaStamp | null> {
  if (!workingCopyActive(s) || !isDbOpen(s.dataDir)) return null;
  try {
    return await dbSchemaOf(await withDamagedFileAccess(() => getDb(s.dataDir)));
  } catch {
    return null;
  }
}

/** The company name for the manifest: what the app recorded in the working copy, else the file name. */
function companyNameFor(s: SaveState, dataDir: string): string {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dataDir, 'bookkeeper-company.json'), 'utf8'));
    const name = (typeof m?.displayName === 'string' && m.displayName.trim()) || (typeof m?.name === 'string' && m.name.trim());
    if (name) return name;
  } catch {
    /* no manifest */
  }
  return format.companyFileBaseName(s.file);
}

function readOwner(lockDir: string): { token?: string; computer?: string; appUser?: string; osUser?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function friendlyIoError(err: unknown, file: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  const where = path.dirname(file);
  if (code === 'ENOENT' || code === 'ENOTDIR') return `Ironbooks can't reach ${where}. Check the network connection to the file server; your changes are kept on this computer and will be saved as soon as it is back.`;
  if (code === 'EACCES' || code === 'EPERM') return `Ironbooks doesn't have permission to write to ${where}. Your changes are kept on this computer.`;
  if (code === 'ENOSPC') return `The drive holding ${where} is full. Free some space; your changes are kept on this computer.`;
  if (code === 'EBUSY') return `Another program is holding the company file open (often antivirus or a backup program). Ironbooks will keep trying.`;
  return `Ironbooks couldn't save to the company file (${(err as Error)?.message ?? String(err)}). Your changes are kept on this computer.`;
}

/**
 * Save the working copy to the company file now (when anything changed, or always with
 * `force`). `final` is the save on close: it also checkpoints and stops the autosave.
 * Concurrent calls share one save.
 */
export async function saveCompanyFile(opts: { force?: boolean; final?: boolean; reason?: string } = {}): Promise<SaveResult> {
  const s = state();
  if (!s) return { saved: false, outcome: 'not-single-file' };
  // One save at a time: several callers waiting on the same save must not then all start their
  // own side by side (each would claim to follow the same save, and the file and this working
  // copy's record of it could end up naming different saves).
  while (s.inflight) {
    await s.inflight.catch(() => undefined);
    if (!opts.final && !opts.force) return { saved: false, outcome: 'unchanged' };
  }
  const run = doSave(s, opts);
  s.inflight = run;
  try {
    return await run;
  } finally {
    if (s.inflight === run) s.inflight = null;
  }
}

async function doSave(s: SaveState, opts: { force?: boolean; final?: boolean }): Promise<SaveResult> {
  const dataDir = s.dataDir;
  const started = Date.now();

  // Still ours? (A computer that slept past the lock's stale time may have lost it.)
  if (s.lockDir && s.lockToken) {
    const owner = readOwner(s.lockDir);
    if (owner && owner.token !== s.lockToken) {
      s.status = 'lost';
      const who = owner.appUser || owner.osUser;
      s.error = `${who ? `${who} on ` : ''}${owner.computer ?? 'another computer'} has opened this company file since this computer last saved it, so Ironbooks stopped saving here to protect their work. Your changes are kept on this computer.`;
      throw Object.assign(new Error(s.error), { code: 'LOCK_LOST' });
    }
  }

  // Nothing to do? Only when it is certain: the database was never opened in this process, or its
  // write position is exactly where the last save left it (an unknown position counts as changed,
  // so work done before the first autosave check is never skipped on close).
  const lsnBefore = await currentLsn(s);
  const fpBefore = currentFingerprint(dataDir);
  const baseLsn = baselineLsn(s);
  // Not the active database (the server is on a sandbox copy): the working copy is closed. The
  // close-time save writes it anyway (what changed before the switch can't be measured any more).
  const dbUntouched = !workingCopyActive(s)
    ? !opts.final
    : lsnBefore === null
      ? !isDbOpen(dataDir)
      : baseLsn !== null && lsnBefore === baseLsn;
  const changed = opts.force || s.unsavedSince !== null || fpBefore !== s.savedFingerprint || !dbUntouched;
  if (!changed && s.status !== 'error') return { saved: false, outcome: 'unchanged' };

  s.status = 'saving';
  try {
    // A checkpoint writes the database's pending changes into its table files, so the saved
    // file opens without replaying a long write-ahead log.
    if (workingCopyActive(s) && isDbOpen(dataDir) && (opts.final || Date.now() - s.lastCheckpointAt > CHECKPOINT_EVERY_MS)) {
      try {
        const db = await withDamagedFileAccess(() => getDb(dataDir));
        await db.execute(sql`checkpoint`);
        s.lastCheckpointAt = Date.now();
      } catch (err) {
        console.warn('[company-file] checkpoint before save failed (saving anyway):', (err as Error).message);
      }
    }

    // The company file must still be the save this working copy started from.
    const ws = readWorkingState(s.statePath);
    const baseSaveId = ws?.base?.saveId ?? null;
    const onDisk = format.readCompanyManifest(s.file) as { saveId?: string; fileId?: string; dbSchema?: DbSchemaStamp | null } | null;
    if (!onDisk && fs.existsSync(path.dirname(s.file)) && fs.existsSync(s.file)) {
      throw Object.assign(new Error('The company file on disk can no longer be read (it may have been replaced by another program).'), {
        code: 'UNREADABLE',
      });
    }
    const conflict = Boolean(onDisk && baseSaveId && onDisk.saveId !== baseSaveId);
    // After a conflict, later work keeps going into the copy made for it (never a new full copy of
    // the company file on every autosave check).
    const target = conflict ? (reusableConflictCopy(s) ?? conflictCopyPath(s.file)) : s.file;

    // Consistent snapshot: the LSN first, then the files in this same synchronous turn.
    const lsn = await currentLsn(s);
    const fingerprint = currentFingerprint(dataDir);
    // A copy kept apart is a separate company file: it never carries this file's backup history
    // (its own rotation would delete this file's backup versions).
    const entries = conflict ? withoutBackupHistory(format.snapshotDir(dataDir)) : format.snapshotDir(dataDir);
    const savedAt = new Date().toISOString();
    const saveId = randomUUID();
    const companyName = companyNameFor(s, dataDir);
    let fileId = ws?.fileId ?? onDisk?.fileId ?? null;
    if (!fileId) {
      try {
        fileId = fs.readFileSync(path.join(dataDir, '.file-id'), 'utf8').trim() || null;
      } catch {
        fileId = null;
      }
    }
    const owner = s.lockDir ? readOwner(s.lockDir) : null;
    // The layout this save holds (an older Ironbooks refuses a newer one): measured while the
    // working copy is open, else the one last measured, else what the file said when it was opened.
    s.dbSchema = (await currentDbSchema(s)) ?? s.dbSchema ?? onDisk?.dbSchema ?? null;
    const result = await format.writeCompanyFile(target, {
      manifest: {
        formatVersion: format.COMPANY_FILE_FORMAT_VERSION,
        fileId: fileId ?? randomUUID(),
        companyName: conflict ? `${companyName} (unsaved changes)` : companyName,
        saveId,
        previousSaveId: baseSaveId,
        savedAt,
        savedBy: { computer: os.hostname(), appUser: owner?.appUser ?? null },
        appVersion: APP_VERSION,
        passwordProtected: Boolean(readDesktopManifest(dataDir)?.passwordProtected),
        // The transaction-log head this save holds: the next open knows exactly what is saved.
        fingerprint,
        ...(s.dbSchema ? { dbSchema: s.dbSchema } : {}),
      },
      backupManifest: {
        app: 'bookkeeper-ai',
        formatVersion: 1,
        kind: 'full',
        companyName,
        createdAt: savedAt,
        appVersion: APP_VERSION,
      },
      entries,
      cache: s.cache,
    });

    if (conflict) {
      s.conflictCopy = target;
      s.conflictSaveId = saveId;
      // Everything up to this snapshot is safe in the copy: changes are tracked from here on (and
      // saved into the same copy), and the working copy no longer counts them as unsaved — so the
      // next open of the company file does not keep them apart a second time.
      s.savedFingerprint = fingerprint;
      s.lastSeenFingerprint = fingerprint;
      s.savedLsn = lsn;
      s.booksUnsaved = false;
      s.unsavedSince = null;
      s.lastSaveMs = Date.now() - started;
      s.lastSaveEndedAt = Date.now();
      s.status = 'error';
      s.error = `Someone else saved this company file while it was open here, so your changes were saved to a separate copy instead: ${target}. Compare the two before you continue working.`;
      writeWorkingState(s, {
        unsavedSince: null,
        conflictCopy: target,
        ...(opts.final ? { closedCleanly: true, lastUsedAt: savedAt } : {}),
      });
      return { saved: true, outcome: 'conflict', path: target, bytes: result.bytes, durationMs: s.lastSaveMs };
    }

    s.savedFingerprint = fingerprint;
    s.lastSeenFingerprint = fingerprint;
    s.savedLsn = lsn;
    s.lastSavedAt = savedAt;
    s.booksUnsaved = false;
    s.error = null;
    s.lastSaveMs = Date.now() - started;
    s.lastSaveEndedAt = Date.now();
    // Changes made while the file was being written are still unsaved: the next tick sees them.
    s.unsavedSince = null;
    s.status = 'saved';
    writeWorkingState(s, {
      base: { saveId, savedAt, fingerprint },
      unsavedSince: null,
      lastSavedAt: savedAt,
      fileId,
      companyName,
      ...(opts.final ? { closedCleanly: true, lastUsedAt: savedAt } : {}),
    });
    return { saved: true, outcome: 'saved', path: s.file, bytes: result.bytes, durationMs: s.lastSaveMs };
  } catch (err) {
    s.lastSaveEndedAt = Date.now();
    noteUnsaved(s, Date.now(), true);
    s.status = 'error';
    s.error = friendlyIoError(err, s.file);
    throw err;
  }
}

function readDesktopManifest(dataDir: string): { passwordProtected?: boolean } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'bookkeeper-company.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The copy this process already saved unsaved changes into, when it is still exactly what was
 * written there: not saved since by anyone else, and not open anywhere (its own lock folder).
 * Otherwise null: a new copy is made rather than overwriting someone's work.
 */
function reusableConflictCopy(s: SaveState): string | null {
  if (!s.conflictCopy || !s.conflictSaveId) return null;
  const m = format.readCompanyManifest(s.conflictCopy) as { saveId?: string } | null;
  if (!m || m.saveId !== s.conflictSaveId) return null;
  if (fs.existsSync(lockFormat.lockDirFor(s.conflictCopy))) return null;
  return s.conflictCopy;
}

function conflictCopyPath(file: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const base = format.companyFileBaseName(file);
  const computer = os.hostname().replace(/[\\/:*?"<>|]/g, '-');
  let candidate = path.join(path.dirname(file), `${base} (unsaved changes from ${computer}, ${stamp})${format.COMPANY_FILE_EXT}`);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(path.dirname(file), `${base} (unsaved changes from ${computer}, ${stamp}) ${i}${format.COMPANY_FILE_EXT}`);
  }
  return candidate;
}

/**
 * One autosave check (the timer calls it every AUTOSAVE_TICK_MS; exported for tests).
 * Returns what it did.
 */
export async function autosaveTick(now = Date.now()): Promise<'idle' | 'waiting' | 'saved' | 'failed' | 'busy'> {
  const s = state();
  if (!s || s.closed) return 'idle';
  if (s.inflight) return 'busy';
  const dataDir = s.dataDir;
  const fp = currentFingerprint(dataDir);
  if (fp !== s.lastSeenFingerprint) {
    s.lastSeenFingerprint = fp;
    s.lastChangeAt = now;
  }
  const booksChanged = fp !== s.savedFingerprint;
  let anyChanged = booksChanged || s.unsavedSince !== null;
  if (!anyChanged) {
    const lsn = await currentLsn(s);
    const baseLsn = baselineLsn(s);
    // An open database whose starting point is unknown counts as changed (saved at the
    // housekeeping pace) rather than risk never saving it.
    if (lsn !== null && lsn !== baseLsn) anyChanged = true;
  }
  if (!anyChanged) return 'idle';
  noteUnsaved(s, now, booksChanged);
  // Another computer has the file now: never save into it, but the changes made here stay
  // recorded as unsaved (above), so the next open here keeps them as a separate copy instead of
  // replacing this working copy with the company file.
  if (s.status === 'lost') return 'idle';

  // Don't spend more than about a fifth of the time saving a big file over a slow network.
  if (now - s.lastSaveEndedAt < s.lastSaveMs * 4) return 'waiting';
  const since = s.unsavedSince ?? now;
  const due = s.booksUnsaved
    ? now - (s.lastChangeAt ?? since) >= SAVE_AFTER_QUIET_MS || now - since >= SAVE_WITHIN_MS
    : now - since >= HOUSEKEEPING_SAVE_MS;
  // After an error, retry at the "within" pace rather than every tick.
  if (s.status === 'error' && now - s.lastSaveEndedAt < SAVE_WITHIN_MS / 2) return 'waiting';
  if (!due) return 'waiting';
  try {
    const r = await saveCompanyFile();
    return r.saved ? 'saved' : 'idle';
  } catch (err) {
    console.warn('[company-file] autosave failed:', (err as Error).message);
    return 'failed';
  }
}

/** Start the autosave timer (once per process; no-op when the open file is a folder). */
export function ensureAutosave(): void {
  const s = state();
  if (!s || s.timer || s.closed) return;
  s.timer = setInterval(() => {
    autosaveTick().catch((err) => console.warn('[company-file] autosave check failed:', err));
  }, AUTOSAVE_TICK_MS);
  s.timer.unref?.();
}

/**
 * The save on close / quit: save whatever is unsaved, then close the database cleanly and keep
 * it closed (this server is about to stop). On failure the file stays open and usable so the
 * person can retry or keep working; the error says what happened.
 */
export async function closeCompanyFile(): Promise<SaveResult> {
  const s = state();
  if (!s) return { saved: false, outcome: 'not-single-file' };
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  let result: SaveResult;
  try {
    result = await saveCompanyFile({ final: true });
  } catch (err) {
    ensureAutosave(); // still open: keep saving in the background
    throw err;
  }
  s.closed = true;
  const dir = s.dataDir;
  const active = resolveDataDir();
  const lsnAtSave = baselineLsn(s);
  const lsnNow = await currentLsn(s);
  holdDbOpen(dir); // never reopened by a late request: this server is about to stop
  try {
    await closeDb(dir);
    // A sandbox copy the server switched to is closed cleanly too.
    if (path.resolve(active) !== path.resolve(dir)) await closeDb(active);
  } catch (err) {
    console.warn('[company-file] closing the database failed:', (err as Error).message);
  }
  // Something committed between the snapshot and the close: it is only in the working copy.
  if (lsnNow && lsnAtSave && lsnNow !== lsnAtSave) {
    writeWorkingState(s, { unsavedSince: new Date().toISOString(), closedCleanly: false });
  }
  return result;
}

/** Status for the title bar and the Company File page. */
export function getCompanyFileSaveStatus(): CompanyFileSaveStatus {
  const s = state();
  if (!s) {
    return { singleFile: false, path: null, status: 'saved', lastSavedAt: null, unsavedSince: null, error: null, conflictCopy: null };
  }
  // Housekeeping alone (sign-ins, session heartbeats) is saved at its slower pace without
  // showing "not saved yet": only the books' own changes are reported as waiting.
  const status: SaveStatusKind = s.inflight ? 'saving' : s.status === 'unsaved' && !s.booksUnsaved ? 'saved' : s.status;
  return {
    singleFile: true,
    path: s.file,
    status,
    lastSavedAt: s.lastSavedAt,
    unsavedSince: s.unsavedSince ? new Date(s.unsavedSince).toISOString() : null,
    error: s.error,
    conflictCopy: s.conflictCopy,
  };
}

/**
 * Write a copy of the open company (as it is right now) to `target` as a single company file —
 * File > Save Copy As…, and converting an older folder company file to a single file. The copy
 * gets its own identity (file id), so the two are independent from then on.
 */
export async function saveCopyAs(
  target: string,
  opts: { companyName?: string | null; keepBackupHistory?: boolean } = {},
): Promise<{ path: string; bytes: number }> {
  const dataDir = resolveDataDir();
  const abs = path.resolve(target);
  if (!abs.toLowerCase().endsWith(format.COMPANY_FILE_EXT)) {
    throw Object.assign(new Error(`A company file name must end in ${format.COMPANY_FILE_EXT}.`), { code: 'VALIDATION' });
  }
  // Never replace a company file someone has open (QuickBooks refuses too): their next save would
  // find a different company in its place.
  const holder = lockFormat.readHolder(abs) as { owner?: Record<string, unknown> | null; stale?: boolean } | null;
  if (holder && !holder.stale) {
    throw Object.assign(
      new Error(`${path.basename(abs)} is open on ${lockFormat.describeOwner(holder.owner ?? null)}. Choose another name for the copy, or ask them to close it first.`),
      { code: 'VALIDATION' },
    );
  }
  let dbSchema: DbSchemaStamp | null = null;
  if (isDbOpen()) {
    try {
      const db = await withDamagedFileAccess(() => getDb());
      await db.execute(sql`checkpoint`);
      dbSchema = await dbSchemaOf(db);
    } catch {
      /* the snapshot is consistent without it */
    }
  }
  // The copy is its own company file: a new identity inside (sessions bind to it) and out.
  const fileId = randomUUID();
  // Nor its backup history: the copy's rotation would otherwise delete this file's backup versions.
  // Converting a company folder into a single file continues the same company, so it keeps it.
  const snapshot = format.snapshotDir(dataDir).filter((e: { name: string }) => e.name !== '.file-id');
  const entries = [
    ...(opts.keepBackupHistory ? snapshot : withoutBackupHistory(snapshot)),
    { name: '.file-id', data: Buffer.from(fileId) },
  ];
  const now = new Date().toISOString();
  const s = state();
  const companyName = opts.companyName?.trim() || (s ? companyNameFor(s, dataDir) : readDisplayName(dataDir)) || format.companyFileBaseName(abs);
  const result = await format.writeCompanyFile(abs, {
    manifest: {
      formatVersion: format.COMPANY_FILE_FORMAT_VERSION,
      fileId,
      companyName,
      saveId: randomUUID(),
      previousSaveId: null,
      savedAt: now,
      savedBy: { computer: os.hostname(), appUser: null },
      appVersion: APP_VERSION,
      passwordProtected: Boolean(readDesktopManifest(dataDir)?.passwordProtected),
      ...(dbSchema ? { dbSchema } : {}),
    },
    backupManifest: { app: 'bookkeeper-ai', formatVersion: 1, kind: 'full', companyName, createdAt: now, appVersion: APP_VERSION },
    entries,
  });
  return { path: abs, bytes: result.bytes };
}

function withoutBackupHistory<T extends { name: string }>(entries: T[]): T[] {
  return entries.filter((e) => e.name !== BACKUP_HISTORY_FILE);
}

function readDisplayName(dataDir: string): string | null {
  const m = readDesktopManifest(dataDir) as { displayName?: string; name?: string } | null;
  return (m?.displayName?.trim() || m?.name?.trim()) ?? null;
}

/** Tests: forget the per-process state. */
export function resetCompanyFileSaveState(): void {
  const s = g.__ironbooksCompanyFileSave;
  if (s?.timer) clearInterval(s.timer);
  g.__ironbooksCompanyFileSave = null;
}
