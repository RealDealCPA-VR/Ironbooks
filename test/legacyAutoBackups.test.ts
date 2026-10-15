/**
 * Upgrade cleanup: quit-time backups written before the backup history existed
 * (`auto-backup-<YYYY-MM-DDTHH-MM-SS>.bka`, no company slug) are not in any company file's
 * history, so the server rotation never deletes them. electron/legacyBackups.js keeps them
 * pruned to the newest 10 and never touches current-format or unrelated files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pruneLegacyAutoBackups, LEGACY_AUTO_BACKUP_RE } = require('../electron/legacyBackups.js');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-legacy-bk-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function legacyName(i: number): string {
  // Old format: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const d = new Date(Date.UTC(2025, 0, 1, 0, 0, 0) + i * 3_600_000);
  return `auto-backup-${d.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.bka`;
}

describe('legacy auto-backup cleanup', () => {
  it('matches only the old slug-less name format', () => {
    expect(LEGACY_AUTO_BACKUP_RE.test('auto-backup-2025-03-04T05-06-07.bka')).toBe(true);
    // Current formats (company slug and/or millisecond timestamp) are history-managed.
    expect(LEGACY_AUTO_BACKUP_RE.test('auto-backup-acme-co-2025-03-04T05-06-07-123.bka')).toBe(false);
    expect(LEGACY_AUTO_BACKUP_RE.test('auto-backup-2025-03-04T05-06-07-123.bka')).toBe(false);
    expect(LEGACY_AUTO_BACKUP_RE.test('backup-2025-03-04T05-06-07.bka')).toBe(false);
    expect(LEGACY_AUTO_BACKUP_RE.test('auto-backup-2025-03-04T05-06-07.bka.tmp')).toBe(false);
  });

  it('deletes old-style files beyond the newest 10 and leaves everything else alone', () => {
    const legacy = Array.from({ length: 14 }, (_, i) => legacyName(i));
    // Write in shuffled order so the result does not depend on directory order.
    for (const f of [...legacy].reverse()) fs.writeFileSync(path.join(dir, f), 'x');
    const keepOthers = [
      'auto-backup-acme-co-2024-01-01T00-00-00-000.bka',
      'auto-backup-2024-01-01T00-00-00-000.bka',
      'backup-acme-co-2024-01-01T00-00-00-000.bka',
      'notes.txt',
    ];
    for (const f of keepOthers) fs.writeFileSync(path.join(dir, f), 'x');

    const removed: string[] = pruneLegacyAutoBackups(dir);
    expect(removed.sort()).toEqual(legacy.slice(0, 4));

    const left = fs.readdirSync(dir).sort();
    expect(left).toEqual([...legacy.slice(4), ...keepOthers].sort());

    // Idempotent: a second run removes nothing.
    expect(pruneLegacyAutoBackups(dir)).toEqual([]);
  });

  it('keeps everything when there are 10 or fewer, and tolerates a missing folder', () => {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, legacyName(i)), 'x');
    expect(pruneLegacyAutoBackups(dir)).toEqual([]);
    expect(fs.readdirSync(dir)).toHaveLength(10);
    expect(pruneLegacyAutoBackups(path.join(dir, 'does-not-exist'))).toEqual([]);
  });
});
