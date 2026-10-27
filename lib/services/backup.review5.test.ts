/**
 * Review round 5 — a company file upgraded by a NEWER Ironbooks (its database has migrations this
 * app does not know) must never be opened by this one.
 *
 * Offices update their PCs at different times. Before, an older app opened such a file anyway:
 * drizzle skipped the unknown migrations, then the ledger-guard check re-installed this app's
 * older guard definitions and DROPPED the newer version's ledger triggers as "unexpected" — and
 * the older code went on writing into a database layout it does not understand, which was then
 * saved back into the shared company file. QuickBooks refuses a file upgraded by a newer version;
 * so do we, on every path: opening the database, restoring a backup made by a newer version, and
 * opening a single company file whose last save was made by a newer version.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { closeDb, getDb, MIGRATIONS_FOLDER, openDb } from '@/lib/db';
import { createBackup, restoreBackup } from './backup';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-newer5-'));
const latestKnown = (): number =>
  Math.max(...JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')).entries.map((e: { when: number }) => e.when));

/** A company database last opened by a newer Ironbooks: one migration this app has never seen. */
async function upgradedByNewerVersion(dir: string) {
  await getDb(dir);
  await openDb(dir).client.exec(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('from-a-newer-version', ${latestKnown() + 86_400_000})`,
  );
  await closeDb(dir);
}

beforeAll(() => {
  fs.mkdirSync(ROOT, { recursive: true });
});
afterAll(async () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('a company file upgraded by a newer Ironbooks', () => {
  it('is refused when opened, before anything in it is changed', async () => {
    const dir = path.join(ROOT, 'newer');
    await upgradedByNewerVersion(dir);
    await expect(getDb(dir)).rejects.toThrow(/newer version of Ironbooks/);
    await closeDb(dir);
  }, 120_000);

  it('is refused as a backup to restore, and the open company file stays as it was', async () => {
    const newer = path.join(ROOT, 'newer-backup-src');
    await upgradedByNewerVersion(newer);
    const backup = createBackup('Newer Co', newer).buffer;
    const live = path.join(ROOT, 'live');
    await getDb(live);
    await closeDb(live);
    const before = fs.readdirSync(live).sort();
    await expect(restoreBackup(backup, live)).rejects.toThrow(/newer version of Ironbooks/);
    // (The safety copy made before the restore is recorded in the backup history.)
    expect(fs.readdirSync(live).filter((n) => n !== '.backup-history.json').sort()).toEqual(before);
    await closeDb(live).catch(() => undefined);
  }, 180_000);

  it('saved as a single company file by a newer version is refused before its working copy is touched', async () => {
    const src = path.join(ROOT, 'single-src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    const file = path.join(ROOT, 'Newer Single.ironbooks');
    await format.writeCompanyFile(file, {
      manifest: {
        formatVersion: 1,
        fileId: 'n1',
        companyName: 'Newer Single',
        saveId: 's1',
        savedAt: 'x',
        dbSchema: { lastMigrationAt: latestKnown() + 86_400_000 },
      },
      entries: format.snapshotDir(src),
    });
    const wr = path.join(ROOT, 'Working');
    let err: (Error & { code?: string }) | null = null;
    try {
      await sessionMod.prepareWorkingCopy(file, { root: wr, knownSchemaAt: sessionMod.latestMigrationAt(MIGRATIONS_FOLDER) });
    } catch (e) {
      err = e as Error & { code?: string };
    }
    expect(err?.code).toBe('NEWER_FORMAT');
    expect(err?.message).toMatch(/newer version of Ironbooks/);
    expect(fs.existsSync(sessionMod.workingDirFor(file, wr))).toBe(false);

    // A file this version (or an older one) saved opens as usual.
    const ok = path.join(ROOT, 'Current Single.ironbooks');
    await format.writeCompanyFile(ok, {
      manifest: { formatVersion: 1, fileId: 'n2', companyName: 'Current', saveId: 's1', savedAt: 'x', dbSchema: { lastMigrationAt: latestKnown() } },
      entries: format.snapshotDir(src),
    });
    const prep = await sessionMod.prepareWorkingCopy(ok, { root: wr, knownSchemaAt: sessionMod.latestMigrationAt(MIGRATIONS_FOLDER) });
    expect(prep.plan).toBe('extract');
  }, 60_000);
});

describe('backups made by a newer Ironbooks', () => {
  it('a one-company backup is refused instead of silently dropping what this version does not know', async () => {
    const { createCompanyBackup, readCompanyBackup } = await import('./backup');
    const { seedRichCompany } = await import('./companyFile.fixture');
    const AdmZip = (await import('adm-zip')).default;
    const dir = path.join(ROOT, 'company-backup-src');
    const db = await getDb(dir);
    const { ctx } = await seedRichCompany(db, dir, 'Export Co');
    const { buffer } = await createCompanyBackup(db, ctx.companyId, { dataDir: dir });
    await closeDb(dir);
    // Made here: it says which database layout it holds, and restores.
    const zip = new AdmZip(buffer);
    const manifest = JSON.parse(zip.readAsText('bookkeeper-manifest.json'));
    expect(manifest.dbSchemaAt).toBe(latestKnown());
    expect(() => readCompanyBackup(buffer)).not.toThrow();
    // The same backup as a newer version would have made it.
    zip.updateFile('bookkeeper-manifest.json', Buffer.from(JSON.stringify({ ...manifest, dbSchemaAt: latestKnown() + 86_400_000 })));
    expect(() => readCompanyBackup(zip.toBuffer())).toThrow(/newer version of Ironbooks/);
  }, 180_000);

  it('a whole-file backup is refused before anything is extracted', async () => {
    const { validateBackupZip } = await import('./backup');
    const AdmZip = (await import('adm-zip')).default;
    const dir = path.join(ROOT, 'full-backup-src');
    await getDb(dir);
    await closeDb(dir);
    const zip = new AdmZip(createBackup('Full Co', dir).buffer);
    const manifest = JSON.parse(zip.readAsText('bookkeeper-manifest.json'));
    expect(manifest.dbSchemaAt).toBe(latestKnown());
    expect(() => validateBackupZip(zip.toBuffer())).not.toThrow();
    zip.updateFile('bookkeeper-manifest.json', Buffer.from(JSON.stringify({ ...manifest, dbSchemaAt: latestKnown() + 1 })));
    expect(() => validateBackupZip(zip.toBuffer())).toThrow(/newer version of Ironbooks/);
  }, 120_000);
});
