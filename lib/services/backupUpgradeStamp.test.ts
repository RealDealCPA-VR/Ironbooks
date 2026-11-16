/**
 * The safety copy made before a company file is upgraded (lib/db/index.ts openDb) holds the books
 * as they were BEFORE the upgrade, so it is stamped with their own layout (newest applied
 * migration), not the newest one this app ships. Otherwise the version used before — after a
 * reinstall — refused to restore its own safety copy as "made with a newer version".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PGlite } from '@electric-sql/pglite';
import { closeDb, getDb, latestShippedMigrationAt } from '@/lib/db';
import { ensurePreOpBackup, preOpBackupDir } from './backup';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-upgrade-stamp-'));
const DATA_DIR = path.join(ROOT, 'company', 'data');
const savedDataDir = process.env.BKA_DATA_DIR;

function manifestOf(file: string): { dbSchemaAt?: number } {
  return JSON.parse(new AdmZip(file).readAsText('bookkeeper-manifest.json'));
}

beforeAll(async () => {
  await getDb(DATA_DIR);
}, 120_000);

afterAll(async () => {
  await closeDb(DATA_DIR).catch(() => undefined);
  if (savedDataDir === undefined) delete process.env.BKA_DATA_DIR;
  else process.env.BKA_DATA_DIR = savedDataDir;
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort on Windows */
  }
});

describe('the safety copy made before an upgrade', () => {
  it('is stamped with the layout the caller measured, else with the newest shipped one', () => {
    const shipped = latestShippedMigrationAt();
    expect(shipped).not.toBeNull();
    const older = shipped! - 86_400_000;
    const made = ensurePreOpBackup(null, 'upgrade', DATA_DIR, null, { dbSchemaAt: older });
    expect(made).not.toBeNull();
    expect(manifestOf(made!.path).dbSchemaAt).toBe(older);
    // Nothing half-written is left beside it.
    expect(fs.readdirSync(preOpBackupDir(DATA_DIR)).filter((f) => f.endsWith('.partial'))).toEqual([]);

    const plain = ensurePreOpBackup(null, 'restore', DATA_DIR, null);
    expect(manifestOf(plain!.path).dbSchemaAt).toBe(shipped);
  });

  it('opening a file from an earlier version stamps its copy with the pre-upgrade layout', async () => {
    const shipped = latestShippedMigrationAt()!;
    await closeDb(DATA_DIR);
    // Make the books look like an earlier version's: the newest migration was never applied.
    const pg = new PGlite(DATA_DIR);
    let before: number;
    try {
      const rows = (await pg.query<{ created_at: string }>('select created_at::text as created_at from drizzle.__drizzle_migrations order by created_at desc')).rows;
      expect(Number(rows[0].created_at)).toBe(shipped);
      before = Number(rows[1].created_at);
      await pg.query('delete from drizzle.__drizzle_migrations where created_at = $1', [shipped]);
    } finally {
      await pg.close();
    }
    for (const f of fs.readdirSync(preOpBackupDir(DATA_DIR))) fs.rmSync(path.join(preOpBackupDir(DATA_DIR), f), { force: true });

    // Only the company file being opened gets a safety copy (the active data dir).
    process.env.BKA_DATA_DIR = DATA_DIR;
    // The last migration is re-run on open; whether or not it applies cleanly a second time, the
    // safety copy is made before it.
    await getDb(DATA_DIR).catch(() => undefined);
    const copies = fs.readdirSync(preOpBackupDir(DATA_DIR)).filter((f) => f.startsWith('preop-upgrade-'));
    expect(copies).toHaveLength(1);
    expect(manifestOf(path.join(preOpBackupDir(DATA_DIR), copies[0])).dbSchemaAt).toBe(before);
    expect(before).toBeLessThan(shipped);
  }, 120_000);
});
