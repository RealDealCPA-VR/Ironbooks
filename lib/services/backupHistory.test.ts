/**
 * Backup schedule decisions (team backups): due / not due, skip when nothing changed, rotation
 * keeps the last N versions, the 7-day warning threshold and settings validation. Pure functions
 * over history records, plus the on-disk history/settings store in a throwaway folder.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUP_WARNING_DAYS,
  DEFAULT_BACKUP_SETTINGS,
  backupHealth,
  isBackupDue,
  nextBackupDueAt,
  normalizeBackupSettings,
  planRotation,
  readBackupHistory,
  readBackupSettings,
  recordBackup,
  saveBackupSettings,
  shouldSkipUnchanged,
  type BackupRecord,
  type BackupSettings,
} from './backupHistory';
import { bannerDismissed, formatAge, indicatorText, BANNER_DISMISS_MS } from '@/lib/backupStatusText';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-15T12:00:00.000Z');

let seq = 0;
function rec(partial: Partial<BackupRecord> & { ageMs: number }): BackupRecord {
  const { ageMs, ...rest } = partial;
  seq++;
  return {
    id: `r${seq}`,
    at: new Date(NOW.getTime() - ageMs).toISOString(),
    source: 'scheduled',
    kind: 'full',
    filename: `auto-${seq}.bka`,
    path: `/backups/auto-${seq}.bka`,
    sizeBytes: 100,
    fingerprint: `fp-${seq}`,
    ...rest,
  };
}

const daily: BackupSettings = { ...DEFAULT_BACKUP_SETTINGS };
const every6h: BackupSettings = { ...DEFAULT_BACKUP_SETTINGS, schedule: 'hours', everyHours: 6 };
const off: BackupSettings = { ...DEFAULT_BACKUP_SETTINGS, schedule: 'off' };

describe('defaults', () => {
  it('backs up daily and keeps 14 versions in the default folder', () => {
    expect(DEFAULT_BACKUP_SETTINGS).toEqual({ schedule: 'daily', everyHours: 24, keep: 14, folder: null });
  });
});

describe('isBackupDue', () => {
  it('is never due when the schedule is off', () => {
    expect(isBackupDue(off, [], NOW)).toBe(false);
    expect(nextBackupDueAt(off, [], NOW)).toBeNull();
  });

  it('is due right away when the file was never backed up automatically', () => {
    expect(isBackupDue(daily, [], NOW)).toBe(true);
    // A manual download or a safety copy does not start the automatic schedule's clock.
    expect(isBackupDue(daily, [rec({ ageMs: HOUR, source: 'manual', path: null }), rec({ ageMs: HOUR, source: 'pre-op' })], NOW)).toBe(true);
  });

  it('daily: not due 23 hours after the last version, due at 24 hours', () => {
    expect(isBackupDue(daily, [rec({ ageMs: 23 * HOUR })], NOW)).toBe(false);
    expect(isBackupDue(daily, [rec({ ageMs: 24 * HOUR })], NOW)).toBe(true);
    expect(nextBackupDueAt(daily, [rec({ ageMs: 23 * HOUR })], NOW)!.getTime()).toBe(NOW.getTime() + HOUR);
  });

  it('every N hours counts from the newest scheduled or quit-time version', () => {
    expect(isBackupDue(every6h, [rec({ ageMs: 5 * HOUR })], NOW)).toBe(false);
    expect(isBackupDue(every6h, [rec({ ageMs: 7 * HOUR }), rec({ ageMs: 2 * HOUR, source: 'quit' })], NOW)).toBe(false);
    expect(isBackupDue(every6h, [rec({ ageMs: 6 * HOUR })], NOW)).toBe(true);
  });
});

describe('shouldSkipUnchanged', () => {
  it('skips when the books have the same fingerprint as the newest saved version', () => {
    const records = [rec({ ageMs: DAY, fingerprint: 'log:7:abc' }), rec({ ageMs: 2 * DAY, fingerprint: 'log:5:old' })];
    expect(shouldSkipUnchanged('log:7:abc', records)).toBe(true);
    expect(shouldSkipUnchanged('log:8:def', records)).toBe(false);
  });

  it('a "Back up now" copy in the folder also counts as the latest version', () => {
    expect(shouldSkipUnchanged('fp', [rec({ ageMs: HOUR, source: 'manual', fingerprint: 'fp' })])).toBe(true);
  });

  it('never skips on an unknown fingerprint, a download or a safety copy', () => {
    expect(shouldSkipUnchanged(null, [rec({ ageMs: DAY, fingerprint: null })])).toBe(false);
    expect(shouldSkipUnchanged('fp', [rec({ ageMs: DAY, fingerprint: null })])).toBe(false);
    expect(shouldSkipUnchanged('fp', [rec({ ageMs: HOUR, source: 'manual', path: null, fingerprint: 'fp' })])).toBe(false);
    expect(shouldSkipUnchanged('fp', [rec({ ageMs: HOUR, source: 'pre-op', fingerprint: 'fp' })])).toBe(false);
    expect(shouldSkipUnchanged('fp', [])).toBe(false);
  });
});

describe('planRotation', () => {
  it('keeps the newest N scheduled/quit versions and returns the rest, oldest last', () => {
    const versions = Array.from({ length: 6 }, (_, i) => rec({ ageMs: (i + 1) * DAY, source: i % 2 ? 'quit' : 'scheduled' }));
    const stale = planRotation(versions, 4);
    expect(stale.map((r) => r.id)).toEqual([versions[4].id, versions[5].id]);
  });

  it('never rotates manual copies, safety copies, downloads or already-pruned versions', () => {
    const records = [
      rec({ ageMs: 1 * HOUR }),
      rec({ ageMs: 2 * HOUR, source: 'manual' }),
      rec({ ageMs: 3 * HOUR, source: 'pre-op' }),
      rec({ ageMs: 4 * HOUR, source: 'quit', path: null }),
      rec({ ageMs: 5 * HOUR, prunedAt: NOW.toISOString() }),
      rec({ ageMs: 6 * HOUR }),
    ];
    expect(planRotation(records, 1).map((r) => r.id)).toEqual([records[5].id]);
  });

  it('always keeps at least one version', () => {
    expect(planRotation([rec({ ageMs: HOUR }), rec({ ageMs: 2 * HOUR })], 0)).toHaveLength(1);
  });
});

describe('backupHealth (7-day warning)', () => {
  it('warns when the file was never backed up', () => {
    const h = backupHealth([], NOW, 'fp');
    expect(h).toMatchObject({ state: 'never', warn: true, lastBackupAt: null });
  });

  it(`is fine just under ${BACKUP_WARNING_DAYS} days, warns at ${BACKUP_WARNING_DAYS} days when the books changed`, () => {
    const under = backupHealth([rec({ ageMs: BACKUP_WARNING_DAYS * DAY - HOUR, fingerprint: 'old' })], NOW, 'new');
    expect(under).toMatchObject({ state: 'ok', warn: false, daysSince: BACKUP_WARNING_DAYS - 1 });
    const at = backupHealth([rec({ ageMs: BACKUP_WARNING_DAYS * DAY, fingerprint: 'old' })], NOW, 'new');
    expect(at).toMatchObject({ state: 'warning', warn: true, daysSince: BACKUP_WARNING_DAYS, upToDate: false });
  });

  it('does not warn about an old backup when nothing changed since', () => {
    const h = backupHealth([rec({ ageMs: 30 * DAY, fingerprint: 'same' })], NOW, 'same');
    expect(h).toMatchObject({ state: 'ok', warn: false, upToDate: true, daysSince: 30 });
  });

  it('any full backup counts (download, safety copy) but a one-company copy does not', () => {
    const viaDownload = backupHealth([rec({ ageMs: HOUR, source: 'manual', path: null })], NOW, 'x');
    expect(viaDownload.lastBackupSource).toBe('manual');
    const viaPreOp = backupHealth([rec({ ageMs: 2 * HOUR, source: 'pre-op' })], NOW, 'x');
    expect(viaPreOp.warn).toBe(false);
    const companyOnly = backupHealth([rec({ ageMs: HOUR, kind: 'company', source: 'manual' })], NOW, 'x');
    expect(companyOnly.state).toBe('never');
  });
});

describe('settings validation', () => {
  it('accepts off / daily / every N hours with keep 1-365', () => {
    expect(normalizeBackupSettings({ schedule: 'hours', everyHours: 4, keep: 30 })).toMatchObject({
      schedule: 'hours',
      everyHours: 4,
      keep: 30,
    });
    expect(normalizeBackupSettings({ schedule: 'off' }).schedule).toBe('off');
  });

  it('rejects bad values with plain-language messages', () => {
    expect(() => normalizeBackupSettings({ schedule: 'weekly' })).toThrow(/how often/i);
    expect(() => normalizeBackupSettings({ everyHours: 0 })).toThrow(/1 to 168/);
    expect(() => normalizeBackupSettings({ everyHours: 2.5 })).toThrow(/whole number/);
    expect(() => normalizeBackupSettings({ keep: 0 })).toThrow(/1 to 365/);
    expect(() => normalizeBackupSettings({ folder: 'relative/folder' })).toThrow(/full path/);
  });
});

describe('history + settings files', () => {
  const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-backup-history-store');
  const DATA = path.join(ROOT, 'data');

  beforeAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
  });
  afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('records backups newest first and survives a corrupt file', () => {
    recordBackup({ source: 'manual', kind: 'full', filename: 'a.bka', path: null, sizeBytes: 1, fingerprint: null, at: '2026-10-01T00:00:00.000Z' }, DATA);
    recordBackup({ source: 'quit', kind: 'full', filename: 'b.bka', path: null, sizeBytes: 2, fingerprint: 'f', at: '2026-10-02T00:00:00.000Z' }, DATA);
    expect(readBackupHistory(DATA).map((r) => r.filename)).toEqual(['b.bka', 'a.bka']);
    fs.writeFileSync(path.join(DATA, '.backup-history.json'), '{not json');
    expect(readBackupHistory(DATA)).toEqual([]);
  });

  it('saves settings, test-writes a custom folder and refuses one inside the company file', () => {
    expect(readBackupSettings(DATA)).toEqual(DEFAULT_BACKUP_SETTINGS);
    const folder = path.join(ROOT, 'elsewhere');
    const saved = saveBackupSettings({ schedule: 'hours', everyHours: 3, keep: 5, folder }, DATA);
    expect(saved).toEqual({ schedule: 'hours', everyHours: 3, keep: 5, folder });
    expect(readBackupSettings(DATA)).toEqual(saved);
    expect(fs.readdirSync(folder)).toEqual([]); // the write test cleaned up after itself
    expect(() => saveBackupSettings({ folder: path.join(DATA, 'inside') }, DATA)).toThrow(/cannot be inside/);
    expect(saveBackupSettings({ folder: null }, DATA).folder).toBeNull();
  });
});

describe('indicator text', () => {
  it('says how long ago in plain words', () => {
    expect(formatAge(new Date(NOW.getTime() - 30 * 1000).toISOString(), NOW)).toBe('just now');
    expect(formatAge(new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(), NOW)).toBe('5 minutes ago');
    expect(formatAge(new Date(NOW.getTime() - 2 * HOUR).toISOString(), NOW)).toBe('2 hours ago');
    expect(formatAge(new Date(NOW.getTime() - 30 * HOUR).toISOString(), NOW)).toBe('yesterday');
    expect(formatAge(new Date(NOW.getTime() - 9 * DAY).toISOString(), NOW)).toBe('9 days ago');
    const status = { ...backupHealth([rec({ ageMs: 2 * HOUR })], NOW, null), schedule: 'daily' as const, nextDueAt: null, running: false };
    expect(indicatorText(status, NOW)).toBe('Last backup: 2 hours ago');
  });

  it('a dismissed banner stays hidden for a day', () => {
    const until = String(NOW.getTime() + BANNER_DISMISS_MS);
    expect(bannerDismissed(null, NOW)).toBe(false);
    expect(bannerDismissed(until, new Date(NOW.getTime() + 23 * HOUR))).toBe(true);
    expect(bannerDismissed(until, new Date(NOW.getTime() + 25 * HOUR))).toBe(false);
  });
});
