/**
 * Second security review of the company-file safeguards (2026-11):
 *
 *  1. Saving the backup schedule never approves a backup folder that came in with the company file.
 *  2. After the upgrade a folder this file already backed up into on this computer keeps being used;
 *     a network folder (UNC or a mapped drive) is never trusted or even looked at by itself; an
 *     ignored folder shows up in the attention list.
 *  4. Portable files and in-memory archives are size-capped too.
 *  5. A chosen-folders list that cannot be read for a moment is neither trusted nor overwritten.
 *  6. A portable file of a database layout this app does not know is refused in plain words.
 *  7. A holder that finds its lock missing for a moment (another process is putting it back) keeps
 *     it; a lock put back where hard links are not supported is still put back.
 *  8. Books kept by a restore whose safety backup failed get a name the cleanup never removes.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { sql } from 'drizzle-orm';

import fmt from '@/electron/companyFileFormat';
import fileCrypto from '@/electron/fileCrypto';
import { closeDb, getDb } from '@/lib/db';
import { LOCK_FILE, acquireDirLock, assertDirLockHeld, dirLockTestHooks, releaseDirLock, CompanyFileInUseError } from '@/lib/db/dirLock';
import { makeStartableFolder } from '@/lib/db/damage.fixture';
import {
  BACKUP_HISTORY_FILE,
  BACKUP_SETTINGS_FILE,
  backupFolder,
  backupFolderIgnoredHere,
  isNetworkPath,
  readBackupSettings,
  saveBackupSettings,
  setMappedDrivesForTests,
} from './backupHistory';
import { runVersionedBackup } from './backupSchedule';
import { createBackup, restoreBackup } from './backup';
import { openPortableFile, restorePortableCompanyFile, createPortableCompanyFile } from './portableFile';
import { getAttention } from './attention';
import { makeTestCompany } from './testkit.prefs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-security2-'));

afterAll(() => {
  setMappedDrivesForTests(null);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

async function withBackupDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BKA_BACKUP_DIR;
  process.env.BKA_BACKUP_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BKA_BACKUP_DIR;
    else process.env.BKA_BACKUP_DIR = prev;
  }
}

function setFolderInFile(data: string, folder: string) {
  fs.writeFileSync(path.join(data, BACKUP_SETTINGS_FILE), JSON.stringify({ schedule: 'daily', everyHours: 24, keep: 3, folder }));
}

describe('1. saving the backup schedule', () => {
  it('never approves the folder that came in with the company file; setting it on purpose does', async () => {
    const data = path.join(ROOT, 'schedule-only');
    await makeStartableFolder(data);
    await withBackupDir(path.join(ROOT, 'defaults-1'), async () => {
      const theirs = path.join(ROOT, 'their-folder');
      fs.mkdirSync(theirs, { recursive: true });
      // This computer already had its first look (it keeps a list of the folders chosen here).
      fs.mkdirSync(path.join(ROOT, 'defaults-1'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'defaults-1', '.ironbooks-backup-folders.json'), JSON.stringify({ folders: [] }));
      setFolderInFile(data, theirs); // came in with the next file
      expect(backupFolderIgnoredHere(readBackupSettings(data), data)).toBe(true);
      // "Backups to keep" changed (the form leaves the folder out unless it was edited).
      saveBackupSettings({ keep: 5 }, data);
      expect(readBackupSettings(data).keep).toBe(5);
      expect(backupFolderIgnoredHere(readBackupSettings(data), data)).toBe(true);
      // The person sets it on this computer ("Use this folder on this computer").
      saveBackupSettings({ folder: theirs }, data);
      expect(backupFolder(readBackupSettings(data), data)).toBe(path.resolve(theirs));
    });
  });
});

describe('2. backup folders after the upgrade', () => {
  it('a local folder this file already backed up into here keeps being used, for every company file', async () => {
    await withBackupDir(path.join(ROOT, 'defaults-2'), async () => {
      const first = path.join(ROOT, 'company-a');
      const second = path.join(ROOT, 'company-b');
      await makeStartableFolder(first);
      await makeStartableFolder(second);
      const folderA = path.join(ROOT, 'folder-a');
      const folderB = path.join(ROOT, 'folder-b');
      // Before the upgrade each company backed up into its own folder (made directly, as then).
      for (const [data, folder] of [[first, folderA], [second, folderB]] as const) {
        fs.mkdirSync(folder, { recursive: true });
        const name = `auto-backup-co-2026-01-0${data === first ? 1 : 2}T10-00-00-000.bka`;
        fs.writeFileSync(path.join(folder, name), 'bka-bytes');
        fs.writeFileSync(
          path.join(data, BACKUP_HISTORY_FILE),
          JSON.stringify({ version: 1, records: [{ id: `r-${name}`, at: '2026-01-01T10:00:00.000Z', source: 'scheduled', kind: 'full', filename: name, path: path.join(folder, name), sizeBytes: 9 }] }),
        );
        setFolderInFile(data, folder);
      }
      // The first company looked at takes the "first look" on this computer; the second keeps its
      // folder too, because its own backups are already there.
      expect(backupFolder(readBackupSettings(first), first)).toBe(path.resolve(folderA));
      expect(backupFolder(readBackupSettings(second), second)).toBe(path.resolve(folderB));
    });
  });

  it('a network folder (UNC or a mapped drive) is never trusted, nor looked at, by itself — and the attention list says so', async () => {
    setMappedDrivesForTests(['Z']);
    try {
      expect(isNetworkPath('Z:\\Backups')).toBe(true);
      expect(isNetworkPath('\\\\server\\share')).toBe(true);
      expect(isNetworkPath('C:\\Backups')).toBe(false);
      const t = await makeTestCompany('netfolder');
      await withBackupDir(path.join(ROOT, 'defaults-3'), async () => {
        const share = process.platform === 'win32' ? 'Z:\\Ironbooks Backups' : '//server/share';
        setFolderInFile(t.dir, share);
        const stat = vi.spyOn(fs, 'statSync');
        const real = vi.spyOn(fs, 'realpathSync');
        try {
          expect(backupFolder(readBackupSettings(t.dir), t.dir)).toBe(path.resolve(path.join(ROOT, 'defaults-3')));
          const touched = [...stat.mock.calls, ...real.mock.calls].some(([p]) => String(p).includes('Ironbooks Backups') || String(p).includes('//server'));
          expect(touched).toBe(false);
        } finally {
          stat.mockRestore();
          real.mockRestore();
        }
        const r = await getAttention(t.ctx, { dataDir: t.dir } as Parameters<typeof getAttention>[1]);
        const item = r.items.find((i) => i.key === `backup_folder:${share}`);
        expect(item?.title).toMatch(/Check where backups go on this computer/);
      });
      await closeDb(t.dir);
    } finally {
      setMappedDrivesForTests(null);
    }
  }, 120_000);
});

describe('5. a chosen-folders list that cannot be read for a moment', () => {
  it('is neither trusted nor rewritten', async () => {
    const data = path.join(ROOT, 'busy-list');
    await makeStartableFolder(data);
    const defaults = path.join(ROOT, 'defaults-5');
    fs.mkdirSync(defaults, { recursive: true });
    const folder = path.join(ROOT, 'some-folder');
    fs.mkdirSync(folder, { recursive: true });
    setFolderInFile(data, folder);
    // Not a readable file (EISDIR here; EBUSY / EPERM on a busy share): not "missing".
    const list = path.join(defaults, '.ironbooks-backup-folders.json');
    fs.mkdirSync(list, { recursive: true });
    await withBackupDir(defaults, async () => {
      expect(backupFolder(readBackupSettings(data), data)).toBe(path.resolve(defaults));
    });
    expect(fs.statSync(list).isDirectory()).toBe(true); // left as it was
  });
});

/** Patch the declared uncompressed size of the zip entry `name` (local and central headers). */
function patchDeclaredSize(buf: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(buf);
  const nameBuf = Buffer.from(name, 'utf8');
  for (let i = out.indexOf(nameBuf); i !== -1; i = out.indexOf(nameBuf, i + 1)) {
    if (i >= 30 && out.readUInt32LE(i - 30) === 0x04034b50) out.writeUInt32LE(size, i - 30 + 22);
    else if (i >= 46 && out.readUInt32LE(i - 46) === 0x02014b50) out.writeUInt32LE(size, i - 46 + 24);
  }
  return out;
}

describe('4. size caps for portable files and in-memory archives', () => {
  it('a portable file claiming more than a company file can hold is refused before anything is unpacked', () => {
    const zip = new AdmZip();
    zip.addFile('bookkeeper-portable.json', Buffer.from('{}'));
    zip.addFile('data/accounts.jsonl', Buffer.alloc(8 * 1024 * 1024));
    const crafted = patchDeclaredSize(zip.toBuffer(), 'data/accounts.jsonl', 3 * 1024 * 1024 * 1024);
    expect(() => openPortableFile(crafted)).toThrow(/more than any company file can hold/);
  });

  it('a protected backup opened in memory is capped in total', () => {
    const fileKey = fileCrypto.generateFileKey();
    const protection = { fileKey, keyCheck: fileCrypto.keyCheckOf(fileKey), lookupSalt: fileCrypto.newLookupSalt(), slots: [] };
    const buffer = fmt.buildBackupArchive({
      backupManifest: { app: 'bookkeeper-ai', formatVersion: 2, kind: 'full', companyName: 'Big', createdAt: new Date().toISOString() },
      entries: [1, 2, 3].map((i) => ({ name: `base/1/${i}`, data: Buffer.alloc(1024 * 1024) })),
      protection,
    });
    process.env.BKA_MAX_UNPACKED_BYTES = String(2 * 1024 * 1024);
    try {
      expect(() => fmt.unsealArchiveSync(buffer, fileKey)).toThrow(/larger than any company file can be/);
    } finally {
      delete process.env.BKA_MAX_UNPACKED_BYTES;
    }
    expect(fmt.unsealArchiveSync(buffer, fileKey).entries.filter((e: { data?: Buffer }) => e.data).length).toBeGreaterThanOrEqual(3);
  });
});

describe('6. a portable file of an unknown database layout', () => {
  it('is refused in plain words, not as "made by a newer version"', async () => {
    const t = await makeTestCompany('layout');
    const { buffer } = await createPortableCompanyFile(t.ctx, { dataDir: t.dir });
    // The same file, claiming a layout between two of this app's migrations (a custom build).
    const zip = new AdmZip(buffer);
    const manifest = JSON.parse(zip.readAsText('bookkeeper-portable.json'));
    manifest.schemaVersion.lastMigrationAt -= 1;
    const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
    zip.updateFile('bookkeeper-portable.json', manifestBuf);
    const sumsName = zip.getEntries().map((e) => e.entryName).find((n) => /checksum|sha256/i.test(n))!;
    const sums = zip
      .readAsText(sumsName)
      .split('\n')
      .map((l) => (l.endsWith('  bookkeeper-portable.json') ? `${createHash('sha256').update(manifestBuf).digest('hex')}  bookkeeper-portable.json` : l))
      .join('\n');
    zip.updateFile(sumsName, Buffer.from(sums, 'utf8'));
    await closeDb(t.dir);
    await expect(restorePortableCompanyFile(zip.toBuffer(), path.join(ROOT, 'unknown-layout'))).rejects.toThrow(/database layout this version of Ironbooks does not know/);
  }, 180_000);
});

describe('7. the folder lock while another process puts it back', () => {
  it('a holder that finds its lock missing for a moment keeps it', async () => {
    const dir = path.join(ROOT, 'lock-blink');
    fs.mkdirSync(dir, { recursive: true });
    acquireDirLock(dir);
    const file = path.join(dir, LOCK_FILE);
    const content = fs.readFileSync(file, 'utf8');
    // Another process moves it aside and puts it back 80 ms later (removeStaleLock).
    fs.rmSync(file);
    const child = spawn(process.execPath, ['-e', `process.stdout.write('ready'); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)}), 80)`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((r) => child.stdout.once('data', () => r()));
    expect(() => assertDirLockHeld(dir)).not.toThrow();
    await new Promise((r) => child.once('exit', r));
    releaseDirLock(dir);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a fresh lock moved aside by mistake is put back even where hard links are not supported', () => {
    const dir = path.join(ROOT, 'lock-nolink');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOCK_FILE);
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 54321, hostname: os.hostname(), startedAt: 'x', heartbeatAt: 'x' }));
    const theirs = JSON.stringify({ pid: process.ppid, hostname: os.hostname(), startedAt: 'y', heartbeatAt: 'y' });
    dirLockTestHooks.afterStaleCheck = () => {
      fs.rmSync(file);
      fs.writeFileSync(file, theirs, { flag: 'wx' });
    };
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
    });
    try {
      expect(() => acquireDirLock(dir)).toThrow(CompanyFileInUseError);
    } finally {
      link.mockRestore();
      dirLockTestHooks.afterStaleCheck = undefined;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(theirs);
  });
});

describe('8. books kept by a restore whose safety backup failed', () => {
  it('get a name the working-copy cleanup never removes', async () => {
    const parent = path.join(ROOT, 'restore-name');
    const dir = path.join(parent, 'books');
    fs.mkdirSync(parent, { recursive: true });
    const db = await getDb(dir);
    await db.execute(sql`create table keep_probe (id int primary key)`);
    await closeDb(dir);
    const { buffer } = createBackup('Keep Co', dir);
    fs.writeFileSync(path.join(parent, 'pre-op-backups'), 'not a folder'); // no safety backup
    // Filing them away fails too.
    const rename = vi.spyOn(fmt, 'renameWithRetry').mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    let result: Awaited<ReturnType<typeof restoreBackup>>;
    try {
      result = await restoreBackup(buffer, dir);
    } finally {
      rename.mockRestore();
    }
    expect((result.notices ?? []).join(' ')).toMatch(/kept them instead: .*books kept before restore \d+/);
    const kept = fs.readdirSync(parent).filter((n) => n.startsWith('books kept before restore '));
    expect(kept).toHaveLength(1);
    expect(fs.readdirSync(parent).filter((n) => /^books\.pre-restore-\d+$/.test(n))).toEqual([]);
    await closeDb(dir);
  }, 180_000);
});

void runVersionedBackup;
