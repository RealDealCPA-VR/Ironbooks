/**
 * Review round 5 leftover (P2): pre-op safety copies rotate PER COMPANY FILE. Older-format company
 * folders all live under one parent (userData/companies/<name>), so their pre-op folder
 * (dirname(dataDir)/pre-op-backups) is shared: the keep-5 rotation used to count every company
 * file's safety copies together, so five restores / condenses / year-end closes in file B deleted
 * file A's copy — the one A made before a bad restore — while A's backup history still listed it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb } from '@/lib/db';
import { PRE_OP_BACKUP_KEEP, ensurePreOpBackup, preOpBackupDir } from './backup';
import { readBackupHistory } from './backupHistory';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-preop-perfile');
const A = path.join(ROOT, 'A Company');
const B = path.join(ROOT, 'B Company');

describe('pre-op safety copies of sibling company folders', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    await getDb(A);
    await getDb(B);
  }, 120_000);

  afterAll(async () => {
    await closeDb(A);
    await closeDb(B);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("share a folder, but B's rotation never deletes A's copy", () => {
    expect(preOpBackupDir(A)).toBe(preOpBackupDir(B));
    const aCopy = ensurePreOpBackup(null, 'restore', A)!;
    for (let i = 0; i < PRE_OP_BACKUP_KEEP + 2; i++) ensurePreOpBackup(null, 'condense', B);
    expect(fs.existsSync(aCopy.path)).toBe(true);
    const listed = readBackupHistory(A).find((r) => r.filename === aCopy.filename);
    expect(listed?.prunedAt ?? null).toBeNull();
    // B kept its own newest five.
    const bFiles = readBackupHistory(B).filter((r) => r.source === 'pre-op' && r.path && fs.existsSync(r.path));
    expect(bFiles).toHaveLength(PRE_OP_BACKUP_KEEP);
  });

  it("a file's own rotation marks the copies it removes as pruned in its history", () => {
    for (let i = 0; i < PRE_OP_BACKUP_KEEP + 1; i++) ensurePreOpBackup(null, 'restore', A);
    const own = readBackupHistory(A).filter((r) => r.source === 'pre-op');
    const present = own.filter((r) => r.path && fs.existsSync(r.path));
    expect(present).toHaveLength(PRE_OP_BACKUP_KEEP);
    for (const r of own.filter((x) => !present.includes(x))) expect(r.prunedAt).toBeTruthy();
  });
});
