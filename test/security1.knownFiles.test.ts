/**
 * Security plan 1.5, row 3 — desktop shell side: company files this computer already knew before
 * files needed its approval for internet services keep working at the upgrade.
 *
 * electron/knownFiles.js notes them once (the first time this version starts) and tells the company
 * server of such a file (BKA_FILE_KNOWN_HERE = its data folder), which stamps it at open
 * (lib/net/fileTrust.ts). A single company file's entry is dropped once the file was saved after the
 * hand-over. The pure helper is tested with an injected config; the two main.js wiring points by
 * reading the source, as in test/security1.shell.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { KNOWN_HERE_ENV } from '../lib/net/fileTrust';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const knownFiles = require('../electron/knownFiles.js');
/* eslint-enable @typescript-eslint/no-require-imports */

/** How the shell compares company file paths on Windows (electron/companySession.js pathKey). */
const shellKey = (p: string) => path.resolve(p).toLowerCase();

const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (signature: string) => {
  const at = main.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const rest = main.slice(at + signature.length);
  const end = rest.search(/\n(?:async function |function |const |let |ipcMain\.|app\.on\()/);
  return main.slice(at, at + signature.length + (end < 0 ? rest.length : end));
};

const ROOT = path.resolve('C:/Users/Pat/AppData/Roaming/Ironbooks/companies');
const docs = (name: string) => path.resolve(`C:/Users/Pat/Documents/${name}`);
const NOW = () => '2026-11-18T10:00:00.000Z';

describe('the snapshot of files known before this version', () => {
  const cfg = {
    recentCompanies: [docs('ABC Company.ironbooks'), docs('Old Folder Co'), docs('ABC Company.ironbooks')],
    companyFile: docs('ABC Company.ironbooks'),
    dataDir: docs('Legacy Co'),
    lastUsers: { [docs('Signed In Once.ironbooks')]: 'Admin' },
    sandbox: { dir: path.resolve('C:/Users/Pat/AppData/Local/Ironbooks/Sandboxes/s1'), realDir: docs('Legacy Co') },
    hosting: { enabled: false },
  };

  it('records every place this computer knew a company file, once, as the shell compares paths', () => {
    const patch = knownFiles.snapshotPatch(cfg, { companiesRoot: ROOT, listDir: () => ['default', 'Second Co'], now: NOW, platform: 'win32' });
    const rec = patch[knownFiles.CONFIG_KEY];
    expect(rec.v).toBe(1);
    expect(rec.takenAt).toBe(NOW());
    const paths = rec.files.map((f: { path: string }) => f.path);
    for (const p of [
      docs('ABC Company.ironbooks'),
      docs('Old Folder Co'),
      docs('Legacy Co'),
      docs('Signed In Once.ironbooks'),
      path.resolve('C:/Users/Pat/AppData/Local/Ironbooks/Sandboxes/s1'),
      path.join(ROOT, 'default'),
      path.join(ROOT, 'Second Co'),
    ]) {
      expect(paths).toContain(shellKey(p));
    }
    // No duplicates; lower case on Windows like companySession.pathKey.
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((p: string) => p === p.toLowerCase())).toBe(true);
  });

  it('is taken exactly once: a second start (with new recent files) changes nothing', () => {
    const first = knownFiles.snapshotPatch(cfg, { companiesRoot: ROOT, listDir: () => [], now: NOW, platform: 'win32' });
    const after = { ...cfg, ...first, recentCompanies: [docs('Sent By Email.ironbooks'), ...cfg.recentCompanies] };
    expect(knownFiles.snapshotPatch(after, { companiesRoot: ROOT, listDir: () => ['Later Co'], now: NOW, platform: 'win32' })).toBeNull();
  });

  it('a fresh install records an empty list (nothing is known before), and odd config is ignored', () => {
    expect(knownFiles.snapshotPatch({}, { now: NOW })[knownFiles.CONFIG_KEY].files).toEqual([]);
    expect(knownFiles.snapshotPatch(null, { now: NOW })[knownFiles.CONFIG_KEY].files).toEqual([]);
    const odd = knownFiles.snapshotPatch(
      { recentCompanies: [42, null, '', '  '], companyFile: {}, lastUsers: ['x'] },
      { companiesRoot: ROOT, listDir: () => { throw new Error('locked'); }, now: NOW, platform: 'win32' },
    );
    expect(odd[knownFiles.CONFIG_KEY].files.map((f: { path: string }) => f.path)).toEqual([shellKey(path.join(ROOT, 'default'))]);
  });

  it('keeps at most MAX_KNOWN entries', () => {
    const many = Array.from({ length: knownFiles.MAX_KNOWN + 50 }, (_, i) => docs(`File ${i}.ironbooks`));
    const patch = knownFiles.snapshotPatch({ recentCompanies: many }, { now: NOW, platform: 'win32' });
    expect(patch[knownFiles.CONFIG_KEY].files).toHaveLength(knownFiles.MAX_KNOWN);
  });
});

describe('path rule', () => {
  it('is the shell’s own (electron/companySession.js pathKey)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'companySession.js'), 'utf8');
    expect(src).toMatch(/function pathKey\(filePath, platform = process\.platform\) \{\s+const abs = path\.resolve\(filePath\);\s+return platform === 'win32' \|\| platform === 'darwin' \? abs\.toLowerCase\(\) : abs;/);
    expect(knownFiles.pathKey('/Srv/Books/A.ironbooks', 'darwin')).toBe(path.resolve('/Srv/Books/A.ironbooks').toLowerCase());
    expect(knownFiles.pathKey('/Srv/Books/A.ironbooks', 'linux')).toBe(path.resolve('/Srv/Books/A.ironbooks'));
  });
});

describe('telling the company server', () => {
  const snap = (files: string[]) => ({ [knownFiles.CONFIG_KEY]: { v: 1, takenAt: NOW(), files: files.map((p) => ({ path: knownFiles.pathKey(p, 'win32') })) } });

  it('matches a known file however its path is spelled; anything else is not known', () => {
    const cfg = snap([docs('ABC Company.ironbooks')]);
    expect(knownFiles.knownHere(cfg, docs('abc company.IRONBOOKS'), { platform: 'win32' }).known).toBe(true);
    expect(knownFiles.knownHere(cfg, path.resolve('C:/Users/Pat/Documents/./x/../ABC Company.ironbooks'), { platform: 'win32' }).known).toBe(true);
    expect(knownFiles.knownHere(cfg, docs('Sent By Email.ironbooks'), { platform: 'win32' })).toEqual({ known: false, patch: null });
    // No snapshot (it could not be taken yet): nothing is known.
    expect(knownFiles.knownHere({}, docs('ABC Company.ironbooks'), { platform: 'win32' })).toEqual({ known: false, patch: null });
    expect(knownFiles.knownHere(cfg, '', { platform: 'win32' })).toEqual({ known: false, patch: null });
  });

  it('a single company file: handed over with its save id, told again until saved, then dropped', () => {
    let cfg: Record<string, unknown> = snap([docs('ABC Company.ironbooks'), docs('Other.ironbooks')]);
    const at = (saveId: string) => knownFiles.knownHere(cfg, docs('ABC Company.ironbooks'), { saveId, platform: 'win32' });
    const first = at('save-1');
    expect(first.known).toBe(true);
    expect(first.patch).not.toBeNull();
    cfg = { ...cfg, ...first.patch };
    // Not saved since (nobody signed in, the open failed, a retry of the start): told again, nothing to save.
    expect(at('save-1')).toEqual({ known: true, patch: null });
    // Saved since: the stamp is in the file; the list no longer speaks for it.
    const later = at('save-2');
    expect(later.known).toBe(false);
    cfg = { ...cfg, ...later.patch };
    expect(at('save-3')).toEqual({ known: false, patch: null });
    // The other entry is untouched.
    expect(knownFiles.knownHere(cfg, docs('Other.ironbooks'), { saveId: 's', platform: 'win32' }).known).toBe(true);
  });

  it('a company folder (no save id) is matched by its path alone', () => {
    const cfg = snap([docs('Legacy Co')]);
    expect(knownFiles.knownHere(cfg, docs('Legacy Co'), { saveId: null, platform: 'win32' })).toEqual({ known: true, patch: null });
  });

  it('the environment variable is the one the server reads', () => {
    expect(knownFiles.KNOWN_HERE_ENV).toBe(KNOWN_HERE_ENV);
  });
});

describe('main.js wiring', () => {
  it('the snapshot is taken at start-up, before the app is ready and before anything adds a file to the config', () => {
    const helper = fnBody('function noteFilesKnownBeforeApprovals() {');
    expect(helper).toMatch(/knownFiles\.snapshotPatch\(cfg, \{/);
    // A config that is there but unreadable is never taken for "nothing known".
    expect(helper).toMatch(/catch \{\n\s+return;/);
    const call = main.indexOf('\nnoteFilesKnownBeforeApprovals();\n');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(main.indexOf('app.whenReady()'));
    expect(call).toBeLessThan(main.indexOf('function rememberRecentCompany('));
    expect(call).toBeGreaterThan(main.indexOf('function saveConfig(patch) {'));
  });

  it('the company server is told (its own data folder), only with this computer’s secret, and the scratch server never', () => {
    const helper = fnBody('function fileKnownHereEnv(dataDir) {');
    expect(helper).toMatch(/if \(!deviceVaultSecret\(\)\) return '';/);
    expect(helper).toMatch(/knownFiles\.knownHere\(loadConfig\(\), openFile \? openFile\.path : dataDir/);
    expect(helper).toMatch(/readCompanyManifest\(openFile\.path\)/);
    expect(helper).toMatch(/return r\.known \? dataDir : '';/);
    const server = fnBody('async function startNextServer() {');
    expect(server).toMatch(/BKA_FILE_KNOWN_HERE: fileKnownHereEnv\(dataDir\),/);
    expect(server).toMatch(/BKA_DATA_DIR: dataDir,/);
    const scratch = fnBody('async function startScratchServer(dataDir) {');
    expect(scratch).not.toMatch(/BKA_FILE_KNOWN_HERE/);
    expect(main.match(/BKA_FILE_KNOWN_HERE:/g)).toHaveLength(1);
  });
});
