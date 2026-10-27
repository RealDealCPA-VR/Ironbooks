/**
 * Review round 5 — working copies of single company files (electron/companySession.js) and the
 * access-request protocol (electron/companyLock.js).
 *
 *  - Pruning old working copies removes only the cache (the database copy and its state). The
 *    server keeps other things beside a working copy's database folder — condense archive copies
 *    (the only way back after Condense Data), safety copies made before a restore, scheduled
 *    report exports — and those must never be deleted with it.
 *  - Asking for access to a file whose holder has just closed it must not re-create the "in use"
 *    lock folder (which made the free file look open, and later "stopped responding").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const session = require('../electron/companySession.js');
const lock = require('../electron/companyLock.js');

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-session5-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('pruning old working copies', () => {
  it('removes the cached database but never the archive copies, safety copies or report exports beside it', () => {
    const wr = path.join(root, 'Working');
    const withSideFiles = path.join(wr, 'acme-aaaaaaaaaaaa');
    session.writeState(withSideFiles, { lastUsedAt: '2020-01-01T00:00:00Z', unsavedSince: null });
    fs.mkdirSync(path.join(withSideFiles, 'data', 'base'), { recursive: true });
    fs.writeFileSync(path.join(withSideFiles, 'data', 'PG_VERSION'), '17\n');
    const keep = [
      path.join(withSideFiles, 'archives', 'condense-archive-acme-2026-01-01.bka'),
      path.join(withSideFiles, 'pre-op-backups', 'preop-restore-1-1.bka'),
      path.join(withSideFiles, 'Report Exports', 'data', 'Monthly P&L.csv'),
    ];
    for (const f of keep) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'keep me');
    }
    const cacheOnly = path.join(wr, 'other-bbbbbbbbbbbb');
    session.writeState(cacheOnly, { lastUsedAt: '2020-01-01T00:00:00Z', unsavedSince: null });
    fs.mkdirSync(path.join(cacheOnly, 'data'), { recursive: true });
    fs.writeFileSync(path.join(cacheOnly, 'data', 'PG_VERSION'), '17\n');

    session.pruneWorkingCopies(wr);

    for (const f of keep) expect(fs.existsSync(f), f).toBe(true);
    expect(fs.existsSync(path.join(withSideFiles, 'data'))).toBe(false); // the cache itself is gone
    expect(fs.existsSync(cacheOnly)).toBe(false);
  });
});

describe('asking for access', () => {
  it('to a file its holder just closed does not make it look open again', () => {
    const file = path.join(root, 'Closed Meanwhile.ironbooks');
    fs.writeFileSync(file, 'x');
    const held = lock.acquire(file, { appUser: 'Mary' });
    expect(held.ok).toBe(true);
    const holder = lock.readHolder(file);
    expect(holder).not.toBeNull();
    // Bob reads "Mary has it open… Ask to Come In?" while Mary closes the file.
    lock.release(held.lock);
    let err: (Error & { code?: string }) | null = null;
    try {
      lock.requestAccess(file, { appUser: 'Bob' });
    } catch (e) {
      err = e as Error & { code?: string };
    }
    expect(err?.code).toBe('NOT_IN_USE');
    expect(fs.existsSync(lock.lockDirFor(file))).toBe(false);
    expect(lock.readHolder(file)).toBeNull();
    expect(lock.acquire(file).ok).toBe(true); // anyone can open it right away
  });
});

describe('desktop wiring (source pins)', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');

  it('a file that was closed while the person was deciding to ask is simply opened', () => {
    const at = main.indexOf('id = companyLock.requestAccess(filePath');
    expect(at).toBeGreaterThan(0);
    expect(main.slice(at, at + 400)).toMatch(/err\.code === 'NOT_IN_USE'\) \{\s*openCompany\(filePath\);/);
  });

  it("scheduled report exports of a single company file go next to it, not into this computer's working copy", () => {
    expect(main).toMatch(
      /BKA_REPORT_EXPORT_DIR:\s*process\.env\.BKA_REPORT_EXPORT_DIR \|\|\s*\(openFile \? path\.join\(path\.dirname\(openFile\.path\), 'Report Exports', companyFileFormat\.companyFileBaseName\(openFile\.path\)\) : ''\)/,
    );
  });
});

describe('a company file saved by a newer Ironbooks (source pins)', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');
  it("the shell tells the working copy which database layout this app knows", () => {
    expect(main).toMatch(/knownSchemaAt: companySession\.latestMigrationAt\(migrationsDir\(\)\)/);
    expect(main).toMatch(/BKA_MIGRATIONS_DIR: migrationsDir\(\)/);
  });
  it('the layout this app knows is the newest migration in its journal', () => {
    const journal = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'drizzle', 'meta', '_journal.json'), 'utf8'));
    const newest = Math.max(...journal.entries.map((e: { when: number }) => e.when));
    expect(session.latestMigrationAt(path.resolve(__dirname, '..', 'drizzle'))).toBe(newest);
    expect(session.latestMigrationAt(path.join(root, 'no-such-folder'))).toBeNull();
    expect(session.savedByNewerVersion({ dbSchema: { lastMigrationAt: newest + 1 } }, newest)).toBe(true);
    expect(session.savedByNewerVersion({ dbSchema: { lastMigrationAt: newest } }, newest)).toBe(false);
    expect(session.savedByNewerVersion({}, newest)).toBe(false); // saved before files carried it
    expect(session.savedByNewerVersion({ dbSchema: { lastMigrationAt: newest + 1 } }, null)).toBe(false);
  });
});

describe('Save Copy As (source pins)', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const route = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'api', 'company-file', 'save-as', 'route.ts'), 'utf8');
  it('only converting a folder to a single file keeps its backup history', () => {
    expect(main).toMatch(/body: JSON\.stringify\(\{ companyName: name, convert \}\)/);
    expect(route).toMatch(/keepBackupHistory: body\?\.convert === true/);
  });
});
