/**
 * Automatic, versioned backups of the company file, run by the server process.
 *
 *  - `runVersionedBackup(source)` writes one .bka into the backup folder, records it in the
 *    backup history and rotates the folder down to the last N versions. It never overlaps with
 *    itself: a second call while one is running waits for that run and shares its result. A
 *    scheduled or quit-time run is skipped when nothing changed since the newest version
 *    (backupFingerprint.ts).
 *  - `startBackupScheduler()` starts a timer (once per process) that checks every few minutes
 *    whether the schedule (off / daily / every N hours) says a backup is due. It is started by
 *    the backup status route BEFORE its permission check (the sidebar indicator calls it on every
 *    page load, whatever the user's role), and by the desktop shell at launch
 *    (POST /api/dashboard/auto-backup?start=1) — so it runs while the app is open, in the desktop
 *    app and in plain web mode alike. The desktop shell's
 *    quit-time backup goes through the same function (POST /api/dashboard/auto-backup?save=1).
 *
 * Sandbox mode (sandboxState.ts): a sandbox / training copy carries a copy of the real file's
 * backup history and settings (same backup folder), so a versioned backup or rotation run on it
 * could delete the REAL file's versions. Versioned backups of such a copy are refused, and the
 * scheduler skips its ticks while the active file (or the timer's file) is a copy.
 *
 * State lives on globalThis so a hot reload in `next dev` cannot start a second timer or lose
 * the in-flight lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { asc } from 'drizzle-orm';
import { getDb, resolveDataDir, withDamagedFileAccess } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import { ServiceError } from './errors';
import { createBackup } from './backup';
import { currentFingerprint } from './backupFingerprint';
import { readSandboxMarker, sandboxBlockedError } from './sandboxState';
import {
  backupFolder,
  backupHealth,
  findBackupRecord,
  isBackupDue,
  markPruned,
  nextBackupDueAt,
  planRotation,
  readBackupHistory,
  readBackupSettings,
  recordBackup,
  shouldSkipUnchanged,
  type BackupHealth,
  type BackupRecord,
  type BackupSettings,
  type BackupSource,
} from './backupHistory';

/** How often the timer checks whether a scheduled backup is due. */
export const SCHEDULER_TICK_MS = 5 * 60 * 1000;

export type VersionedSource = Extract<BackupSource, 'manual' | 'scheduled' | 'quit'>;

export type VersionedBackupResult =
  | { status: 'created'; record: BackupRecord; pruned: number }
  | { status: 'unchanged'; lastBackupAt: string | null };

interface SchedulerState {
  inflight: Map<string, Promise<VersionedBackupResult>>;
  timer: ReturnType<typeof setInterval> | null;
  kickoff: ReturnType<typeof setTimeout> | null;
  timerDir: string | null;
}

const g = globalThis as typeof globalThis & { __ironbooksBackupScheduler?: SchedulerState };
function state(): SchedulerState {
  g.__ironbooksBackupScheduler ??= { inflight: new Map(), timer: null, kickoff: null, timerDir: null };
  return g.__ironbooksBackupScheduler;
}

/** Filename for a versioned backup: `auto-backup-<company>-<timestamp>.bka`. */
function versionFilename(source: VersionedSource, companyName: string | null, at: Date): string {
  const ts = at.toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const slug = companyName
    ? `-${companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`
    : '';
  const prefix = source === 'manual' ? 'backup' : 'auto-backup';
  return `${prefix}${slug}-${ts}.bka`;
}

/**
 * Delete versioned backups beyond `keep` (oldest first), and "Back up now" copies beyond
 * MANUAL_VERSIONS_KEEP. Only files this company file recorded
 * in its own history are ever deleted, so other company files sharing the folder and the
 * person's own files there are never touched.
 */
export function rotateVersions(keep: number, dataDir?: string, now: Date = new Date()): number {
  const dir = resolveDataDir(dataDir);
  // Only versions whose files this computer can see. A single company file carries its history to
  // every computer that opens it, and each backs up into its own folder: another computer's
  // versions are neither deleted nor marked deleted here (that hid them from the list on the
  // computer that has them, where they were then never rotated again).
  const visible = readBackupHistory(dir).filter((r) => !r.path || fs.existsSync(r.path));
  const stale = planRotation(visible, keep);
  const pruned: string[] = [];
  for (const rec of stale) {
    try {
      if (rec.path && fs.existsSync(rec.path)) fs.rmSync(rec.path, { force: true });
      pruned.push(rec.id);
    } catch (err) {
      console.warn('[backup] could not delete old version (will retry next time):', err);
    }
  }
  markPruned(pruned, dir, now);
  return pruned.length;
}

export interface VersionedBackupOptions {
  dataDir?: string;
  companyName?: string | null;
  /** Make the backup even when nothing changed (manual "Back up now"). */
  force?: boolean;
  now?: Date;
}

async function doVersionedBackup(source: VersionedSource, opts: VersionedBackupOptions): Promise<VersionedBackupResult> {
  const dir = resolveDataDir(opts.dataDir);
  const now = opts.now ?? new Date();
  const settings = readBackupSettings(dir);
  const records = readBackupHistory(dir);
  const fingerprint = currentFingerprint(dir);

  if (!opts.force && source !== 'manual' && shouldSkipUnchanged(fingerprint, records)) {
    return { status: 'unchanged', lastBackupAt: records[0]?.at ?? null };
  }

  const folder = backupFolder(settings, dir);
  fs.mkdirSync(folder, { recursive: true });
  const { buffer } = createBackup(opts.companyName ?? undefined, dir);
  const filename = versionFilename(source, opts.companyName ?? null, now);
  const outPath = path.join(folder, filename);
  // Write to a temp name first so a half-written file never looks like a version.
  const tmp = `${outPath}.partial`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, outPath);

  const record = recordBackup(
    {
      at: now.toISOString(),
      source,
      kind: 'full',
      filename,
      path: outPath,
      sizeBytes: buffer.byteLength,
      fingerprint,
      note:
        source === 'scheduled'
          ? 'Automatic backup'
          : source === 'quit'
            ? 'Automatic backup when the app closed'
            : 'Backed up now',
    },
    dir,
  );
  const pruned = rotateVersions(settings.keep, dir, now);
  return { status: 'created', record, pruned };
}

/** Make one versioned backup (never overlapping another run for the same company file). */
export function runVersionedBackup(
  source: VersionedSource,
  opts: VersionedBackupOptions = {},
): Promise<VersionedBackupResult> {
  const dir = resolveDataDir(opts.dataDir);
  const marker = readSandboxMarker(dir);
  if (marker) return Promise.reject(sandboxBlockedError('Backing up to the backup folder', marker.kind));
  const s = state();
  const running = s.inflight.get(dir);
  if (running) return running;
  const p = doVersionedBackup(source, { ...opts, dataDir: dir }).finally(() => {
    s.inflight.delete(dir);
  });
  s.inflight.set(dir, p);
  return p;
}

/** True while a versioned backup of this company file is being written. */
export function isBackupRunning(dataDir?: string): boolean {
  return state().inflight.has(resolveDataDir(dataDir));
}

/**
 * One scheduler tick: back up when the schedule says a backup is due (and something changed).
 * Returns what happened, for logs and tests.
 */
export async function runScheduledBackupIfDue(
  opts: { dataDir?: string; now?: Date; companyName?: string | null } = {},
): Promise<'off' | 'not-due' | 'busy' | VersionedBackupResult['status']> {
  const dir = resolveDataDir(opts.dataDir);
  if (!fs.existsSync(dir)) return 'not-due';
  // Never from a sandbox / training copy, nor while the server is switched to one (the real
  // file's handle is held closed until the user leaves the sandbox).
  if (readSandboxMarker(dir) || readSandboxMarker()) return 'off';
  const now = opts.now ?? new Date();
  const settings = readBackupSettings(dir);
  if (settings.schedule === 'off') return 'off';
  if (!isBackupDue(settings, readBackupHistory(dir), now)) return 'not-due';
  if (isBackupRunning(dir)) return 'busy';
  const result = await runVersionedBackup('scheduled', { dataDir: dir, now, companyName: opts.companyName });
  return result.status;
}

/**
 * Start the in-process timer for the active company file (idempotent). `companyName` is a
 * cosmetic lookup for file names, resolved on each run.
 */
export function startBackupScheduler(
  opts: { dataDir?: string; companyName?: () => Promise<string | null> } = {},
): void {
  const dir = resolveDataDir(opts.dataDir);
  const s = state();
  if (s.timer && s.timerDir === dir) return;
  stopBackupScheduler();
  const tick = async () => {
    try {
      let companyName: string | null = null;
      try {
        companyName = (await opts.companyName?.()) ?? null;
      } catch {
        /* the name only decorates the file name */
      }
      const result = await runScheduledBackupIfDue({ dataDir: dir, companyName });
      if (result === 'created') console.log('[backup] scheduled backup written');
    } catch (err) {
      console.error('[backup] scheduled backup failed:', err instanceof Error ? err.message : err);
    }
  };
  s.timer = setInterval(tick, SCHEDULER_TICK_MS);
  s.timer.unref?.();
  s.timerDir = dir;
  // First check shortly after start, so a backup that came due while the app was closed runs now.
  s.kickoff = setTimeout(tick, 15_000);
  s.kickoff.unref?.();
}

/**
 * Name used to label backup files of a company file: its first company (a file can hold
 * several). Cosmetic only — null when the file cannot be read.
 */
export async function fileLabel(dataDir?: string): Promise<string | null> {
  try {
    const db = await withDamagedFileAccess(() => getDb(dataDir));
    const [row] = await db.select({ name: companies.name }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
    return row?.name ?? null;
  } catch {
    return null;
  }
}

/** Start the scheduler for the active company file, labelling files with fileLabel(). */
export function ensureBackupScheduler(): void {
  startBackupScheduler({ companyName: () => fileLabel() });
}

/** Stop the timer (tests / shutdown). */
export function stopBackupScheduler(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  if (s.kickoff) clearTimeout(s.kickoff);
  s.timer = null;
  s.kickoff = null;
  s.timerDir = null;
}

export function isSchedulerRunning(): boolean {
  return state().timer !== null;
}

// ---------------------------------------------------------------------------
// Status for the indicator / banner / Backup page
// ---------------------------------------------------------------------------

export interface BackupStatus extends BackupHealth {
  schedule: BackupSettings['schedule'];
  nextDueAt: string | null;
  running: boolean;
}

export function getBackupStatus(dataDir?: string, now: Date = new Date()): BackupStatus {
  const dir = resolveDataDir(dataDir);
  const settings = readBackupSettings(dir);
  const records = readBackupHistory(dir);
  const health = backupHealth(records, now, currentFingerprint(dir));
  const due = nextBackupDueAt(settings, records, now);
  return {
    ...health,
    schedule: settings.schedule,
    nextDueAt: due ? due.toISOString() : null,
    running: isBackupRunning(dir),
  };
}

export interface BackupVersionRow extends BackupRecord {
  /** The .bka is still on disk (can be previewed / restored from the list). */
  available: boolean;
}

/** History rows for the Backup page, newest first, with whether each file is still on disk. */
export function listBackupHistory(dataDir?: string, limit = 200): BackupVersionRow[] {
  return readBackupHistory(dataDir)
    .slice(0, limit)
    .map((r) => ({
      ...r,
      available: Boolean(r.kind === 'full' && r.path && !r.prunedAt && fs.existsSync(r.path)),
    }));
}

/**
 * Bytes of a version from this company file's backup history (only files the history recorded
 * — never an arbitrary path from the request).
 */
export function readBackupVersion(id: string, dataDir?: string): Buffer {
  const rec = findBackupRecord(id, dataDir);
  if (!rec || rec.kind !== 'full' || !rec.path || rec.prunedAt || !fs.existsSync(rec.path)) {
    throw new ServiceError('NOT_FOUND', 'That backup is no longer in the backup folder.');
  }
  return fs.readFileSync(rec.path);
}
