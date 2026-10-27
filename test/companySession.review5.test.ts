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

describe('switching or closing company files (source pins)', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');
  it('the next launch\'s company file is only written once the open one has closed', () => {
    // openCompany / Close Company / New Company hand their config to relaunchApp…
    expect(main).toMatch(/function relaunchApp\(nextConfig = null\) \{[\s\S]{0,200}configAfterClose = \{ \.\.\.\(configAfterClose \|\| \{\}\), \.\.\.nextConfig \};/);
    const open = main.slice(main.indexOf('function openCompany(location, extra = {})'));
    expect(open.slice(0, 600)).toMatch(/relaunchApp\(\{\s*\.\.\.\(single \? \{ companyFile: location \}/);
    expect(open.slice(0, 600)).not.toMatch(/saveConfig\(/);
    expect(main).toMatch(/openCompany\(target, \{ startRoute: '\/signup' \}\);/);
    expect(main).not.toMatch(/saveConfig\(\{ startRoute: '\/signup' \}\)/);
    // …which before-quit applies only when the file closed (dropped on Keep Working).
    const quit = main.slice(main.indexOf("app.on('before-quit', (event) => {"));
    expect(quit).toMatch(/if \(goOn === false\) \{[\s\S]{0,400}configAfterClose = null;\s*return;/);
    expect(quit).toMatch(/if \(configAfterClose\) \{\s*saveConfig\(configAfterClose\);/);
  });

  it('config.json is replaced atomically', () => {
    const save = main.slice(main.indexOf('function saveConfig(patch) {'));
    expect(save.slice(0, 700)).toMatch(/fs\.writeFileSync\(tmp, JSON\.stringify\(next, null, 2\)\);\s*fs\.renameSync\(tmp, configPath\(\)\);/);
  });

  it('a launch that cannot start says so and quits instead of running with no window', () => {
    const ready = main.slice(main.indexOf('app.whenReady().then(async () => {'));
    expect(ready.slice(0, 900)).toMatch(/try \{\s*await createWindow\(\);\s*\} catch \(err\) \{[\s\S]*dialog\.showErrorBox\([\s\S]*app\.quit\(\);/);
  });
});

describe('switching back to single-user mode (source pins)', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');
  it('updates the lock on the shared drive at once, so nobody is offered "Join" to a host that stopped', () => {
    const fn = main.slice(main.indexOf('async function setHosting('));
    const end = fn.indexOf('\n}\n');
    expect(fn.slice(0, end)).toMatch(/if \(openFile && !openFile\.lost\) lockHeartbeat\(\)\.catch\(\(\) => \{\}\);/);
    // …and the heartbeat drops the join details when not on the office network.
    expect(main).toMatch(/mode: lan \? 'multi' : 'single',\s*host: lan \? \{ urls: hostingState\.urls, fingerprint: hostingState\.fingerprint \} : null,/);
  });
});

describe('restoring a backup into the open company file from File > Open or Restore Company (source pins)', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const page = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'backup', 'page.tsx'), 'utf8');
  it('the chosen backup reaches the Backup page (it used to be dropped: the page never read ?file=)', () => {
    expect(main).not.toMatch(/\/backup\?file=/);
    expect(main).toMatch(/backupToRestore = \{ token: crypto\.randomBytes\(12\)\.toString\('hex'\), path: filePath \};\s*navigate\(`\/backup\?restore=\$\{backupToRestore\.token\}`\);/);
    const ipc = main.slice(main.indexOf("ipcMain.handle('backup:takePending'"));
    expect(ipc.slice(0, 400)).toMatch(/!fromLocalApp\(e\) \|\| !backupToRestore \|\| typeof token !== 'string' \|\| token !== backupToRestore\.token\) return null;/);
    expect(ipc.slice(0, 500)).toMatch(/backupToRestore = null;/); // once
    expect(preload).toMatch(/takePending: \(token\) => ipcRenderer\.invoke\('backup:takePending', String\(token\)\)/);
    expect(page).toMatch(/<Suspense fallback=\{null\}>\s*<PendingBackupRestore onFile=\{startFromFile\} \/>/);
    expect(page).toMatch(/useSearchParams\(\)\.get\('restore'\)/);
    expect(page).toMatch(/onFile\(new File\(\[r\.data\], r\.name\)\)/);
  });
});

describe('closing a file another computer took over (source pins)', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');
  it('still asks the server to close, so the last changes are recorded as unsaved', () => {
    const fn = main.slice(main.indexOf('async function closeOpenCompanyFile()'));
    expect(fn.slice(0, 900)).toMatch(/if \(openFile\.lost\) \{[\s\S]*?\/api\/company-file\/close[\s\S]*?return true;\s*\}/);
  });
});

describe('a crash before the first autosave check', () => {
  it('still keeps the work that only the working copy has (its transaction log moved on since the last save)', async () => {
    const format = require('../electron/companyFileFormat.js');
    const src = path.join(root, 'crash-src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    fs.writeFileSync(path.join(src, 'transactions.bktlg'), JSON.stringify({ seq: 1, hash: 'h1' }) + '\n');
    const cf = path.join(root, 'Crashed.ironbooks');
    const manifest = { formatVersion: 1, fileId: 'c', companyName: 'Crashed Co', saveId: 's1', savedAt: 'x', fingerprint: 'log:1:h1' };
    await format.writeCompanyFile(cf, { manifest, entries: format.snapshotDir(src) });
    const wr = path.join(root, 'Working-crash');
    const prep = await session.prepareWorkingCopy(cf, { root: wr });
    expect(session.readState(prep.workDir).base.fingerprint).toBe('log:1:h1');
    // An invoice is saved in the working copy (transaction log moves on), then the power goes
    // before any autosave check noted it: state says nothing is unsaved, and it never closed.
    fs.appendFileSync(path.join(prep.dataDir, 'transactions.bktlg'), JSON.stringify({ seq: 2, hash: 'h2' }) + '\n');
    expect(session.readState(prep.workDir)).toMatchObject({ unsavedSince: null, closedCleanly: false });

    // Same company file, nobody saved meanwhile: recovered (and saved right away).
    const rec = await session.prepareWorkingCopy(cf, { root: wr });
    expect(rec.plan).toBe('recover');
    expect(session.readState(rec.workDir).unsavedSince).toBeTruthy();

    // Someone else saved meanwhile: the work is kept as a separate copy, never thrown away.
    session.writeState(rec.workDir, { unsavedSince: null, closedCleanly: false });
    await format.writeCompanyFile(cf, { manifest: { ...manifest, saveId: 's2', fingerprint: 'log:1:h1' }, entries: format.snapshotDir(src) });
    const conf = await session.prepareWorkingCopy(cf, { root: wr, onConflict: async () => true });
    expect(conf.plan).toBe('conflict');
    const kept = path.join(root, 'crash-kept');
    await format.extractCompanyFile(conf.conflictCopy, kept);
    expect(fs.readFileSync(path.join(kept, 'transactions.bktlg'), 'utf8')).toContain('"seq":2');

    // A copy that was closed cleanly (or only housekeeping changed) is simply reused / refreshed.
    session.writeState(conf.workDir, { closedCleanly: true });
    expect((await session.prepareWorkingCopy(cf, { root: wr })).plan).toBe('reuse');
  });
});

describe('Save Copy As in the sandbox (source pins)', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');
  it('is refused from the Company File page too, not only greyed out in the File menu', () => {
    expect(main).toMatch(/label: 'Save Copy As…', enabled: !remoteHostOrigin && !sandboxActive\(\)/);
    const fn = main.slice(main.indexOf('async function saveCopyAsFlow('));
    expect(fn.slice(0, 500)).toMatch(/if \(sandboxActive\(\)\) \{\s*dialog\.showErrorBox\('Not available in the sandbox'/);
  });
});
