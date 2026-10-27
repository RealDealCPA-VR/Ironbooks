/**
 * Review round 5 — versioned backups of a company file that several computers open.
 *
 * The backup history (.backup-history.json) travels inside a single company file, so it lists the
 * versions every computer made, each in its own backup folder. Rotation on one computer used to
 * treat another computer's versions like its own: it could not delete them (they are not on this
 * disk) but marked them deleted, so on the computer that has them they vanished from the list —
 * never restorable from it, never rotated again. Rotation now only touches versions whose files
 * this computer can see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordBackup, readBackupHistory } from './backupHistory';
import { rotateVersions } from './backupSchedule';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-rot5-'));
const DATA = path.join(ROOT, 'data');
const HERE = path.join(ROOT, 'backups-here');

beforeAll(() => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(HERE, { recursive: true });
});
afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function version(at: string, dir: string, name: string, onDisk: boolean) {
  const p = path.join(dir, name);
  if (onDisk) fs.writeFileSync(p, 'bka');
  return recordBackup({ at, source: 'scheduled', kind: 'full', filename: name, path: p, sizeBytes: 3, fingerprint: name }, DATA);
}

describe('rotating the versions of a company file opened on several computers', () => {
  it("rotates this computer's versions and leaves the other computer's versions alone", () => {
    const otherPc = path.join(ROOT, 'not-on-this-computer'); // FRONT-DESK's backup folder
    const theirs = [
      version('2026-10-01T10:00:00.000Z', otherPc, 'auto-backup-acme-a.bka', false),
      version('2026-10-02T10:00:00.000Z', otherPc, 'auto-backup-acme-b.bka', false),
    ];
    const mine = [
      version('2026-10-03T10:00:00.000Z', HERE, 'auto-backup-acme-c.bka', true),
      version('2026-10-04T10:00:00.000Z', HERE, 'auto-backup-acme-d.bka', true),
      version('2026-10-05T10:00:00.000Z', HERE, 'auto-backup-acme-e.bka', true),
    ];
    const pruned = rotateVersions(2, DATA, new Date('2026-10-05T11:00:00.000Z'));
    const after = new Map(readBackupHistory(DATA).map((r) => [r.id, r]));
    // Keep 2 of the versions on this computer: the oldest one here goes.
    expect(pruned).toBe(1);
    expect(fs.existsSync(mine[0].path!)).toBe(false);
    expect(after.get(mine[0].id)?.prunedAt).toBeTruthy();
    expect(fs.existsSync(mine[1].path!) && fs.existsSync(mine[2].path!)).toBe(true);
    // The other computer's versions are still listed as they are (not "deleted").
    for (const r of theirs) expect(after.get(r.id)?.prunedAt).toBeUndefined();
  });
});

describe('the backup folder chosen on another computer', () => {
  it('when it cannot be reached here, the backup goes to this computer\'s default folder instead of failing', async () => {
    const { runVersionedBackup } = await import('./backupSchedule');
    const data = path.join(ROOT, 'data-moved');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'PG_VERSION'), '17\n');
    // Chosen on FRONT-DESK: a folder that cannot exist here (its parent is a file on this disk,
    // like a drive letter or user profile this computer does not have).
    const blocker = path.join(ROOT, 'blocker');
    fs.writeFileSync(blocker, 'not a folder');
    const chosen = path.join(blocker, 'Ironbooks Backups');
    fs.writeFileSync(path.join(data, '.backup-settings.json'), JSON.stringify({ schedule: 'daily', everyHours: 24, keep: 14, folder: chosen }));
    const fallback = path.join(ROOT, 'this-computer-backups');
    const prev = process.env.BKA_BACKUP_DIR;
    process.env.BKA_BACKUP_DIR = fallback;
    try {
      const r = await runVersionedBackup('scheduled', { dataDir: data, companyName: 'Moved Co' });
      expect(r.status).toBe('created');
      if (r.status !== 'created') return;
      expect(path.dirname(r.record.path!)).toBe(fallback);
      expect(fs.existsSync(r.record.path!)).toBe(true);
      expect(r.record.note).toMatch(/could not be reached/);
    } finally {
      if (prev === undefined) delete process.env.BKA_BACKUP_DIR;
      else process.env.BKA_BACKUP_DIR = prev;
    }
  });
});
