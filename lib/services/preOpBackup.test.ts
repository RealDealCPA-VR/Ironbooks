/**
 * Tests for backup-before-destructive: ensurePreOpBackup rotation and its
 * integration into restoreBackup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb } from '@/lib/db';
import {
  createBackup,
  ensurePreOpBackup,
  preOpBackupDir,
  restoreBackup,
  PRE_OP_BACKUP_KEEP,
} from './backup';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-preop');
const DATA_DIR = path.join(TEST_ROOT, 'data');

describe('ensurePreOpBackup', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    // Boot a real PGlite dir so there is something to zip.
    await getDb(DATA_DIR);
  });

  afterAll(async () => {
    await closeDb(DATA_DIR);
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('returns null when the data dir does not exist', () => {
    expect(ensurePreOpBackup(null, 'noop', path.join(TEST_ROOT, 'missing'))).toBeNull();
  });

  it('writes a .bka into the sibling pre-op-backups dir', () => {
    const result = ensurePreOpBackup(null, 'unit test', DATA_DIR);
    expect(result).not.toBeNull();
    // The folder tag (8 hex) keeps each company folder's rotation to its own copies.
    expect(result!.filename).toMatch(/^preop-unit-test-[0-9a-f]{8}-\d{13}-\d+\.bka$/);
    expect(fs.existsSync(result!.path)).toBe(true);
    // Sibling of the data dir, never inside it (no recursive backup-of-backups).
    expect(path.dirname(result!.path)).toBe(preOpBackupDir(DATA_DIR));
    expect(result!.path.startsWith(DATA_DIR + path.sep)).toBe(false);
  });

  it(`rotates to the newest ${PRE_OP_BACKUP_KEEP} pre-op backups`, () => {
    const made: string[] = [];
    for (let i = 0; i < PRE_OP_BACKUP_KEEP + 3; i++) {
      made.push(ensurePreOpBackup(null, 'rotate', DATA_DIR)!.filename);
    }
    const files = fs
      .readdirSync(preOpBackupDir(DATA_DIR))
      .filter((f) => f.startsWith('preop-') && f.endsWith('.bka'));
    expect(files.length).toBe(PRE_OP_BACKUP_KEEP);
    // The newest PRE_OP_BACKUP_KEEP files survive (the 'unit-test' file from the
    // previous test plus the oldest rotate files were pruned).
    expect(files.sort()).toEqual(made.slice(-PRE_OP_BACKUP_KEEP).sort());
  });

  it('restoreBackup writes a pre-op snapshot before swapping the data dir', async () => {
    const { buffer } = createBackup('preop test co', DATA_DIR);
    const before = fs
      .readdirSync(preOpBackupDir(DATA_DIR))
      .filter((f) => f.startsWith('preop-restore-'));

    const result = await restoreBackup(buffer, DATA_DIR);
    expect(result.restored).toBe(true);

    const after = fs
      .readdirSync(preOpBackupDir(DATA_DIR))
      .filter((f) => f.startsWith('preop-restore-'));
    expect(after.length).toBe(before.length + 1);
    // The restored dir is a working PGlite data dir again.
    expect(fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))).toBe(true);
  });
});
