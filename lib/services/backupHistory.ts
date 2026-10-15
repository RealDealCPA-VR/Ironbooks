/**
 * Backup history + automatic-backup settings for a company FILE (one PGlite data directory,
 * which may hold several companies).
 *
 * Both are small JSON files at the root of the data directory:
 *   - `.backup-history.json`  every backup made of this file (manual download, versioned
 *                             "back up now", quit-time, scheduled, pre-operation safety copy)
 *   - `.backup-settings.json` schedule (off / daily / every N hours), how many versions to keep,
 *                             and the folder versioned backups are written to
 *
 * Why files and not database tables: the history must describe the file *location*, not the
 * data. Rows in the database would travel inside every backup and be rolled back by a restore
 * (the "Last backup" indicator would jump back to the restored copy's age), writing a history
 * row after each backup would itself be a change (so "skip when nothing changed" could never
 * skip), and a damaged company file that the database layer refuses to open must still show
 * when it was last backed up. Like `.auth-secret` / `.file-id`, these files never go into a
 * backup and a restore keeps the current ones (FILE_LOCAL_FILES in backup.ts).
 *
 * Everything that decides (is a backup due, which versions to prune, should we warn) is a pure
 * function over the records so it can be unit-tested without timers or disks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataDir } from '@/lib/db';
import { ServiceError } from './errors';

export const BACKUP_HISTORY_FILE = '.backup-history.json';
export const BACKUP_SETTINGS_FILE = '.backup-settings.json';

/** How many history records are kept (oldest dropped first). */
export const BACKUP_HISTORY_LIMIT = 500;
/** No backup for this long (and changes since) → warning banner + warning indicator. */
export const BACKUP_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Where a backup came from. */
export type BackupSource = 'manual' | 'scheduled' | 'quit' | 'pre-op';
/** 'full' = the whole company file; 'company' = one company's rows (Restore Company as New). */
export type BackupRecordKind = 'full' | 'company';

export interface BackupRecord {
  id: string;
  /** ISO time the backup was made. */
  at: string;
  source: BackupSource;
  kind: BackupRecordKind;
  /** File name of the .bka. */
  filename: string;
  /** Absolute path when the app saved it to disk; null for a browser download. */
  path: string | null;
  sizeBytes: number;
  /** State of the books when the backup was made (see backupSchedule.ts); null = unknown. */
  fingerprint: string | null;
  /** Plain-language note, e.g. "Before restoring a backup". */
  note?: string;
  /** Set when rotation deleted the file (the record stays for the history list). */
  prunedAt?: string;
}

export type BackupSchedule = 'off' | 'daily' | 'hours';

export interface BackupSettings {
  schedule: BackupSchedule;
  /** Used when schedule = 'hours' (1–168). */
  everyHours: number;
  /** Versions kept in the folder (scheduled + quit-time backups), 1–365. */
  keep: number;
  /** Absolute folder for versioned backups; null = the default folder. */
  folder: string | null;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  schedule: 'daily',
  everyHours: 24,
  keep: 14,
  folder: null,
};

/** Sources whose files are versions in the backup folder and are rotated (keep last N). */
export const ROTATED_SOURCES: readonly BackupSource[] = ['scheduled', 'quit'];
/**
 * "Back up now" copies saved in the backup folder are rotated separately, under this larger cap,
 * so they never pile up without limit but a person's own copies outlast the automatic ones.
 */
export const MANUAL_VERSIONS_KEEP = 30;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function historyPath(dataDir?: string): string {
  return path.join(resolveDataDir(dataDir), BACKUP_HISTORY_FILE);
}

export function settingsPath(dataDir?: string): string {
  return path.join(resolveDataDir(dataDir), BACKUP_SETTINGS_FILE);
}

/**
 * The existing backups folder: the desktop app passes its userData/backups folder as
 * BKA_BACKUP_DIR; plain web mode uses a `backups` folder next to the company data directory
 * (never inside it, so backups never include older backups).
 */
export function defaultBackupFolder(dataDir?: string): string {
  if (process.env.BKA_BACKUP_DIR) return path.resolve(process.env.BKA_BACKUP_DIR);
  return path.join(path.dirname(resolveDataDir(dataDir)), 'backups');
}

export function backupFolder(settings: BackupSettings, dataDir?: string): string {
  return settings.folder ? path.resolve(settings.folder) : defaultBackupFolder(dataDir);
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const SOURCES = new Set<BackupSource>(['manual', 'scheduled', 'quit', 'pre-op']);

function isRecord(v: unknown): v is BackupRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<BackupRecord>;
  return (
    typeof r.id === 'string' &&
    typeof r.at === 'string' &&
    !Number.isNaN(Date.parse(r.at)) &&
    typeof r.source === 'string' &&
    SOURCES.has(r.source as BackupSource) &&
    typeof r.filename === 'string'
  );
}

/** Every recorded backup of this company file, newest first. A missing/corrupt file reads as []. */
export function readBackupHistory(dataDir?: string): BackupRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(historyPath(dataDir), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray((raw as { records?: unknown })?.records)
    ? ((raw as { records: unknown[] }).records)
    : [];
  return list
    .filter(isRecord)
    .map((r) => ({
      ...r,
      kind: r.kind === 'company' ? 'company' : 'full',
      path: typeof r.path === 'string' ? r.path : null,
      sizeBytes: Number.isFinite(r.sizeBytes) ? r.sizeBytes : 0,
      fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint : null,
    }) as BackupRecord)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * Trim the history to BACKUP_HISTORY_LIMIT records, oldest first — but never drop a record whose
 * file is still on disk (it could then never be found, previewed or rotated again). Only records
 * without a file (downloads, pruned or deleted versions) make room.
 */
export function trimHistory(
  records: BackupRecord[],
  limit: number = BACKUP_HISTORY_LIMIT,
  fileExists: (p: string) => boolean = fs.existsSync,
): BackupRecord[] {
  const sorted = [...records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (sorted.length <= limit) return sorted;
  const keep = new Set<BackupRecord>();
  for (const r of sorted) if (r.path && !r.prunedAt && fileExists(r.path)) keep.add(r);
  for (const r of sorted) {
    if (keep.size >= limit) break;
    keep.add(r);
  }
  return sorted.filter((r) => keep.has(r));
}

function writeBackupHistory(records: BackupRecord[], dataDir?: string): void {
  writeJsonAtomic(historyPath(dataDir), { version: 1, records: trimHistory(records) });
}

export type NewBackupRecord = Omit<BackupRecord, 'id' | 'at'> & { at?: string };

/**
 * Record a backup. Never throws: a backup that was made must not be reported as failed just
 * because its history line could not be written (the error is logged).
 */
export function recordBackup(rec: NewBackupRecord, dataDir?: string): BackupRecord {
  const record: BackupRecord = {
    id: randomUUID(),
    at: rec.at ?? new Date().toISOString(),
    source: rec.source,
    kind: rec.kind,
    filename: rec.filename,
    path: rec.path,
    sizeBytes: rec.sizeBytes,
    fingerprint: rec.fingerprint,
    ...(rec.note ? { note: rec.note } : {}),
    ...(rec.prunedAt ? { prunedAt: rec.prunedAt } : {}),
  };
  try {
    const dir = resolveDataDir(dataDir);
    if (fs.existsSync(dir)) writeBackupHistory([record, ...readBackupHistory(dir)], dir);
  } catch (err) {
    console.warn('[backup] could not record backup history:', err);
  }
  return record;
}

/** Mark records as pruned (their files were deleted by rotation). */
export function markPruned(ids: string[], dataDir?: string, now: Date = new Date()): void {
  if (!ids.length) return;
  const set = new Set(ids);
  const records = readBackupHistory(dataDir).map((r) =>
    set.has(r.id) ? { ...r, prunedAt: now.toISOString() } : r,
  );
  writeBackupHistory(records, dataDir);
}

export function findBackupRecord(id: string, dataDir?: string): BackupRecord | null {
  return readBackupHistory(dataDir).find((r) => r.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Initial schedule for a file with no saved settings (desktop config.json backupIntervalHours). */
function envDefaultSettings(): BackupSettings {
  const raw = process.env.BKA_BACKUP_INTERVAL_HOURS;
  if (raw === undefined || raw === '') return { ...DEFAULT_BACKUP_SETTINGS };
  const hours = Number(raw);
  if (!Number.isFinite(hours)) return { ...DEFAULT_BACKUP_SETTINGS };
  if (hours <= 0) return { ...DEFAULT_BACKUP_SETTINGS, schedule: 'off' };
  if (hours === 24) return { ...DEFAULT_BACKUP_SETTINGS };
  return { ...DEFAULT_BACKUP_SETTINGS, schedule: 'hours', everyHours: Math.min(168, Math.max(1, Math.round(hours))) };
}

export function readBackupSettings(dataDir?: string): BackupSettings {
  let raw: Partial<BackupSettings>;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'));
  } catch {
    return envDefaultSettings();
  }
  try {
    return normalizeBackupSettings(raw);
  } catch {
    return envDefaultSettings();
  }
}

/** Validate a settings patch into complete settings (throws VALIDATION with a plain message). */
export function normalizeBackupSettings(
  input: Partial<Record<keyof BackupSettings, unknown>>,
  base: BackupSettings = DEFAULT_BACKUP_SETTINGS,
): BackupSettings {
  const out: BackupSettings = { ...base };
  if (input.schedule !== undefined) {
    if (input.schedule !== 'off' && input.schedule !== 'daily' && input.schedule !== 'hours') {
      throw new ServiceError('VALIDATION', 'Choose how often to back up: off, daily or every few hours.');
    }
    out.schedule = input.schedule;
  }
  if (input.everyHours !== undefined) {
    const n = Number(input.everyHours);
    if (!Number.isInteger(n) || n < 1 || n > 168) {
      throw new ServiceError('VALIDATION', '"Every how many hours" must be a whole number from 1 to 168.');
    }
    out.everyHours = n;
  }
  if (input.keep !== undefined) {
    const n = Number(input.keep);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      throw new ServiceError('VALIDATION', '"Backups to keep" must be a whole number from 1 to 365.');
    }
    out.keep = n;
  }
  if (input.folder !== undefined) {
    if (input.folder === null || input.folder === '') {
      out.folder = null;
    } else if (typeof input.folder !== 'string' || input.folder.length > 1000) {
      throw new ServiceError('VALIDATION', 'The backup folder must be a folder path.');
    } else {
      const folder = input.folder.trim();
      if (!path.isAbsolute(folder)) {
        throw new ServiceError(
          'VALIDATION',
          'Enter the full path of the backup folder (for example C:\\Users\\you\\Documents\\Ironbooks Backups).',
        );
      }
      out.folder = path.resolve(folder);
    }
  }
  return out;
}

/**
 * Save settings. A custom folder is created and test-written first so a typo or a read-only
 * drive is reported now instead of silently breaking every scheduled backup.
 */
export function saveBackupSettings(
  patch: Partial<Record<keyof BackupSettings, unknown>>,
  dataDir?: string,
): BackupSettings {
  const dir = resolveDataDir(dataDir);
  const next = normalizeBackupSettings(patch, readBackupSettings(dir));
  if (next.folder) {
    // Check BEFORE creating anything: a folder made inside the data directory would travel inside
    // every backup.
    const inside = path.relative(dir, next.folder);
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
      throw new ServiceError('VALIDATION', 'The backup folder cannot be inside the company file folder.');
    }
    const probe = path.join(next.folder, `.ironbooks-write-test-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(next.folder, { recursive: true });
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
    } catch {
      throw new ServiceError('VALIDATION', 'Ironbooks cannot save files in that folder. Choose a folder you can write to.');
    }
  }
  writeJsonAtomic(settingsPath(dir), next);
  return next;
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** Interval between scheduled backups (null = off). */
export function scheduleIntervalMs(settings: BackupSettings): number | null {
  if (settings.schedule === 'off') return null;
  if (settings.schedule === 'daily') return DAY_MS;
  return Math.max(1, settings.everyHours) * HOUR_MS;
}

/** Newest versioned backup (scheduled or quit-time) — the clock the schedule runs from. */
export function lastVersionedBackup(records: BackupRecord[]): BackupRecord | null {
  return newest(records.filter((r) => r.kind === 'full' && ROTATED_SOURCES.includes(r.source)));
}

/** Newest backup of the whole file from any source (what the "Last backup" indicator shows). */
export function lastFullBackup(records: BackupRecord[]): BackupRecord | null {
  return newest(records.filter((r) => r.kind === 'full'));
}

function newest(records: BackupRecord[]): BackupRecord | null {
  let best: BackupRecord | null = null;
  for (const r of records) if (!best || Date.parse(r.at) > Date.parse(best.at)) best = r;
  return best;
}

/** When the next scheduled backup is due (null = schedule off). Never backed up = due now. */
export function nextBackupDueAt(settings: BackupSettings, records: BackupRecord[], now: Date): Date | null {
  const interval = scheduleIntervalMs(settings);
  if (interval === null) return null;
  const last = lastVersionedBackup(records);
  if (!last) return now;
  return new Date(Date.parse(last.at) + interval);
}

export function isBackupDue(settings: BackupSettings, records: BackupRecord[], now: Date): boolean {
  const due = nextBackupDueAt(settings, records, now);
  return due !== null && due.getTime() <= now.getTime();
}

/**
 * Skip a backup when the books have not changed since the newest backup saved in the backup
 * folder (scheduled, quit-time or "Back up now"): same fingerprint. An unknown fingerprint on
 * either side never skips.
 */
export function shouldSkipUnchanged(currentFingerprint: string | null, records: BackupRecord[]): boolean {
  const last = newest(
    records.filter((r) => r.kind === 'full' && r.path && !r.prunedAt && r.source !== 'pre-op'),
  );
  return Boolean(currentFingerprint && last?.fingerprint && last.fingerprint === currentFingerprint);
}

/**
 * Rotation: of the versioned backups (scheduled + quit-time) that still have files, keep the
 * newest `keep`; of the "Back up now" copies saved in the folder, keep the newest
 * `manualKeep` (MANUAL_VERSIONS_KEEP). Returns the older ones to delete. Downloads (no path)
 * and pre-operation backups are never rotated here (pre-op copies rotate on their own in
 * backup.ts).
 */
export function planRotation(
  records: BackupRecord[],
  keep: number,
  manualKeep: number = MANUAL_VERSIONS_KEEP,
): BackupRecord[] {
  const saved = (r: BackupRecord) => r.kind === 'full' && Boolean(r.path) && !r.prunedAt;
  const byNewest = (a: BackupRecord, b: BackupRecord) => Date.parse(b.at) - Date.parse(a.at);
  const versions = records.filter((r) => saved(r) && ROTATED_SOURCES.includes(r.source)).sort(byNewest);
  const manual = records.filter((r) => saved(r) && r.source === 'manual').sort(byNewest);
  return [...versions.slice(Math.max(1, keep)), ...manual.slice(Math.max(1, manualKeep))];
}

export type BackupHealthState = 'ok' | 'warning' | 'never';

export interface BackupHealth {
  state: BackupHealthState;
  lastBackupAt: string | null;
  lastBackupSource: BackupSource | null;
  /** Whole days since the last backup (null when never). */
  daysSince: number | null;
  /** True when the books have not changed since the last backup (fingerprints match). */
  upToDate: boolean;
  /** Show the "no backup in 7 days" banner. */
  warn: boolean;
}

/**
 * Health of the company file's backups. Warning when there has never been a backup, or the
 * newest backup is BACKUP_WARNING_DAYS or more old and the books changed since — a file
 * nobody touched for a month is still fully protected by its last backup.
 */
export function backupHealth(
  records: BackupRecord[],
  now: Date,
  currentFingerprint: string | null,
  warningDays: number = BACKUP_WARNING_DAYS,
): BackupHealth {
  const last = lastFullBackup(records);
  if (!last) {
    return { state: 'never', lastBackupAt: null, lastBackupSource: null, daysSince: null, upToDate: false, warn: true };
  }
  const ageMs = Math.max(0, now.getTime() - Date.parse(last.at));
  const upToDate = Boolean(currentFingerprint && last.fingerprint === currentFingerprint);
  const stale = ageMs >= warningDays * DAY_MS;
  const warn = stale && !upToDate;
  return {
    state: warn ? 'warning' : 'ok',
    lastBackupAt: last.at,
    lastBackupSource: last.source,
    daysSince: Math.floor(ageMs / DAY_MS),
    upToDate,
    warn,
  };
}
