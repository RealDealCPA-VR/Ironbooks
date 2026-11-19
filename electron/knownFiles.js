// Company files this computer already knew before company files needed its approval for internet
// services (security plan 1.5, row 3).
//
// A company file this computer has not approved may not reach the public internet, whatever its
// own settings say (lib/net/fileTrust.ts). The approval is a stamp in the file that only this
// computer can make. Files people already worked in here before this version have none yet, and
// must not lose their cloud AI and email at the upgrade. So the first time this version starts it
// notes, once, every company file this computer already knew: Recent Companies, the open company
// file or folder, the files someone signed in to here, a sandbox in use and the older company
// folders in the app's own data folder. When the shell starts a company server for one of them it
// names the server's data folder in BKA_FILE_KNOWN_HERE, and the server stamps the file when it
// first opens it. After that the stamp alone decides: a single company file's entry is dropped once
// the file has been saved since it was handed over (the stamp is then in it), so books restored
// over that file later are never approved by this list. A company folder (older format) has no save
// id and keeps its entry.
//
// Paths are kept the way the shell compares them (electron/companySession.js pathKey: resolved,
// and lower case on Windows and macOS). Pure (config and listing injected) so it is unit-tested
// without Electron.

'use strict';

const path = require('node:path');

/** Where the list lives in config.json. */
const CONFIG_KEY = 'knownBeforeApprovals';
/** The environment variable the company server reads (lib/net/fileTrust.ts KNOWN_HERE_ENV). */
const KNOWN_HERE_ENV = 'BKA_FILE_KNOWN_HERE';
/** Entries kept at most (Recent Companies keeps 8; signed-in files can be more). */
const MAX_KNOWN = 200;

function pathKey(filePath, platform = process.platform) {
  const abs = path.resolve(filePath);
  return platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs;
}

/**
 * The config patch that records the files known before this version, or null when that was done
 * already (it is done exactly once: a fresh install records an empty list). `companiesRoot` is the
 * app's own folder of older company folders; `listDir` names the folders in it.
 */
function snapshotPatch(cfg, { companiesRoot = null, listDir = () => [], now = () => new Date().toISOString(), platform = process.platform } = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (c[CONFIG_KEY] && typeof c[CONFIG_KEY] === 'object') return null;
  const found = [];
  const add = (p) => {
    if (typeof p === 'string' && p.trim()) found.push(p);
  };
  if (Array.isArray(c.recentCompanies)) c.recentCompanies.forEach(add);
  add(c.companyFile);
  add(c.dataDir);
  if (c.sandbox && typeof c.sandbox === 'object') {
    add(c.sandbox.dir);
    add(c.sandbox.realDir);
    add(c.sandbox.realFile);
  }
  if (c.lastUsers && typeof c.lastUsers === 'object' && !Array.isArray(c.lastUsers)) Object.keys(c.lastUsers).forEach(add);
  if (companiesRoot) {
    add(path.join(companiesRoot, 'default'));
    let names = [];
    try {
      names = listDir(companiesRoot) || [];
    } catch {
      names = [];
    }
    for (const name of names) if (typeof name === 'string' && name) add(path.join(companiesRoot, name));
  }
  const keys = [];
  for (const p of found) {
    let key;
    try {
      key = pathKey(p, platform);
    } catch {
      continue;
    }
    if (!keys.includes(key)) keys.push(key);
  }
  return { [CONFIG_KEY]: { v: 1, takenAt: now(), files: keys.slice(0, MAX_KNOWN).map((p) => ({ path: p })) } };
}

/**
 * Whether the company server for `location` (the .ironbooks file, or a company folder) is told the
 * file was known here before this version, and the config patch to save with that answer (null:
 * nothing to save). `saveId`: the single company file's current save id (its manifest), or null
 * for a folder. The first hand-over records the save id; while the file still has that save, the
 * server may not have stamped it yet (nobody signed in, the open failed), so it is told again; once
 * the file was saved since, its stamp is in it and the entry is dropped.
 */
function knownHere(cfg, location, { saveId = null, platform = process.platform } = {}) {
  const rec = cfg && typeof cfg === 'object' ? cfg[CONFIG_KEY] : null;
  if (!rec || typeof rec !== 'object' || !Array.isArray(rec.files) || typeof location !== 'string' || !location) {
    return { known: false, patch: null };
  }
  let key;
  try {
    key = pathKey(location, platform);
  } catch {
    return { known: false, patch: null };
  }
  const i = rec.files.findIndex((f) => f && typeof f === 'object' && f.path === key);
  if (i < 0) return { known: false, patch: null };
  if (typeof saveId !== 'string' || !saveId) return { known: true, patch: null };
  const entry = rec.files[i];
  const files = rec.files.slice();
  if (typeof entry.handedOver !== 'string') {
    files[i] = { ...entry, handedOver: saveId };
    return { known: true, patch: { [CONFIG_KEY]: { ...rec, files } } };
  }
  if (entry.handedOver === saveId) return { known: true, patch: null };
  files.splice(i, 1);
  return { known: false, patch: { [CONFIG_KEY]: { ...rec, files } } };
}

module.exports = { CONFIG_KEY, KNOWN_HERE_ENV, MAX_KNOWN, pathKey, snapshotPatch, knownHere };
