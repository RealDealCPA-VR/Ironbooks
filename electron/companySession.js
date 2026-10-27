// The working copy of an open single-file company file (electron/companyFileFormat.js).
//
// QuickBooks writes straight into the .QBW on the server, which is why a dropped network
// connection can damage a QuickBooks file. Ironbooks instead works in a private copy of the
// company file on this computer and saves it back to the company file a few seconds after each
// change, and when the file is closed (lib/services/companyFileSave.ts). The working copy lives
// under this Windows user's local application data, never in a roaming profile:
//
//   %LOCALAPPDATA%\Ironbooks\Working\<name>-<hash of the company file's path>\
//     data\          the database folder the app server runs on (BKA_DATA_DIR)
//     state.json     which company file it belongs to, the save it was opened from, and whether
//                    it holds changes not yet saved to the company file (crash recovery)
//
// On the next open of the same company file from this computer, the working copy is reused when
// the company file hasn't changed since (quick to open, even over a slow network), recovered when
// it holds changes the app could not save before it stopped, or replaced by a fresh copy when
// someone else has saved the file since.
//
// Pure Node so the open decisions can be unit-tested (test/companySession.test.ts).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const format = require('./companyFileFormat');

const STATE_FILE = 'state.json';
const STATE_SCHEMA = 'ironbooks-working-copy/v1';
/** Working copies of files not opened for this long are removed (they are only caches). */
const WORKING_COPY_MAX_AGE_MS = 45 * 24 * 3600 * 1000;

/** Where working copies live: Windows %LOCALAPPDATA%, elsewhere next to the app's other data. */
function workingRoot({ platform = process.platform, env = process.env, userData } = {}) {
  if (platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'Ironbooks', 'Working');
  return path.join(userData || path.join(require('node:os').homedir(), '.ironbooks'), 'Working');
}

/** Same path, same key — case-insensitively on Windows and macOS. */
function pathKey(filePath, platform = process.platform) {
  const abs = path.resolve(filePath);
  return platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs;
}

function workingDirFor(companyFile, root) {
  const slug =
    format
      .companyFileBaseName(companyFile)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
      .toLowerCase() || 'company';
  const hash = crypto.createHash('sha256').update(pathKey(companyFile)).digest('hex').slice(0, 12);
  return path.join(root, `${slug}-${hash}`);
}

function readState(workDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(workDir, STATE_FILE), 'utf8'));
    return s && s.schema === STATE_SCHEMA ? s : null;
  } catch {
    return null;
  }
}

function writeState(workDir, patch) {
  const next = { ...(readState(workDir) || {}), ...patch, schema: STATE_SCHEMA };
  fs.mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

function dataDirOf(workDir) {
  return path.join(workDir, 'data');
}

function hasData(workDir) {
  try {
    return fs.readdirSync(dataDirOf(workDir)).includes('PG_VERSION');
  } catch {
    return false;
  }
}

/**
 * What to do with the working copy when `companyFile` is opened (pure):
 *  - 'extract'  no usable working copy: make a fresh one from the company file
 *  - 'reuse'    the working copy matches the company file's last save
 *  - 'recover'  the working copy holds changes that never reached the company file, and the
 *               company file hasn't been saved by anyone else since: keep them (they are saved
 *               to the company file right away)
 *  - 'conflict' the working copy holds unsaved changes AND someone else has saved the company
 *               file since: the two can't be combined; keep the unsaved changes as a separate
 *               copy, then open the company file as it is
 */
function planOpen({ companyFile, state, manifest, dataExists }) {
  if (!dataExists || !state || !state.companyFile || pathKey(state.companyFile) !== pathKey(companyFile)) {
    return 'extract';
  }
  const baseSaveId = state.base && state.base.saveId;
  const sameSave = Boolean(baseSaveId && manifest && manifest.saveId === baseSaveId);
  if (state.unsavedSince) return sameSave ? 'recover' : 'conflict';
  return sameSave ? 'reuse' : 'extract';
}

/** "ABC Company (unsaved changes from FRONT-DESK, 2026-10-24 1032).ironbooks" next to the file. */
function conflictCopyPath(companyFile, computer, when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  const safeComputer = String(computer || 'this computer').replace(/[\\/:*?"<>|]/g, '-');
  const base = format.companyFileBaseName(companyFile);
  let candidate = path.join(path.dirname(companyFile), `${base} (unsaved changes from ${safeComputer}, ${stamp})${format.COMPANY_FILE_EXT}`);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(
      path.dirname(companyFile),
      `${base} (unsaved changes from ${safeComputer}, ${stamp}) ${i}${format.COMPANY_FILE_EXT}`,
    );
  }
  return candidate;
}

/**
 * Write a CLOSED working copy (no app server running on it) — or any closed company database
 * folder (`dataDir`) — out as a single company file at `target`. Used to keep unsaved changes
 * that can't be merged, and to pack a restored portable company file.
 */
async function writeWorkingCopyAs(workDir, target, { companyName, appVersion, fileId, dataDir } = {}) {
  const entries = format.snapshotDir(dataDir || dataDirOf(workDir), { lazyPrefixes: [] });
  const now = new Date().toISOString();
  const saveId = crypto.randomUUID();
  await format.writeCompanyFile(target, {
    manifest: {
      formatVersion: format.COMPANY_FILE_FORMAT_VERSION,
      fileId: fileId || crypto.randomUUID(),
      companyName: companyName || format.companyFileBaseName(target),
      saveId,
      previousSaveId: null,
      savedAt: now,
      appVersion: appVersion || null,
    },
    backupManifest: {
      app: 'bookkeeper-ai',
      formatVersion: 1,
      kind: 'full',
      companyName: companyName || format.companyFileBaseName(target),
      createdAt: now,
      appVersion: appVersion || undefined,
    },
    entries,
  });
  return { saveId };
}

/**
 * Prepare the working copy for opening `companyFile` (the lock is already held). Returns
 * { workDir, dataDir, plan, manifest, conflictCopy? }. `onConflict` decides a 'conflict':
 * resolve true to keep the unsaved changes as a separate copy and continue, false to stop
 * (then nothing has changed).
 */
async function prepareWorkingCopy(companyFile, { root, onConflict, appVersion } = {}) {
  const manifest = format.readCompanyManifest(companyFile);
  if (!manifest) throw new format.NotACompanyFileError('the file has no readable company information');
  const workDir = workingDirFor(companyFile, root);
  const state = readState(workDir);
  const plan = planOpen({ companyFile, state, manifest, dataExists: hasData(workDir) });
  let conflictCopy = null;
  if (plan === 'conflict') {
    const keep = onConflict ? await onConflict({ state, manifest, workDir }) : true;
    if (!keep) return { workDir, dataDir: dataDirOf(workDir), plan: 'cancelled', manifest };
    conflictCopy = conflictCopyPath(companyFile, require('node:os').hostname());
    await writeWorkingCopyAs(workDir, conflictCopy, {
      companyName: `${manifest.companyName || format.companyFileBaseName(companyFile)} (unsaved changes)`,
      appVersion,
    });
  }
  if (plan === 'extract' || plan === 'conflict') {
    fs.rmSync(dataDirOf(workDir), { recursive: true, force: true });
    await format.extractCompanyFile(companyFile, dataDirOf(workDir));
  }
  const now = new Date().toISOString();
  writeState(workDir, {
    companyFile: path.resolve(companyFile),
    fileId: manifest.fileId || null,
    companyName: manifest.companyName || null,
    // A recovered copy keeps its old base (its changes are still unsaved); a fresh or reused
    // one starts from the company file's current save.
    // `fingerprint`: the transaction-log head the company file holds (null for a new file), so the
    // server knows what is already saved whenever it starts looking (lib/services/companyFileSave.ts).
    base:
      plan === 'recover'
        ? state.base
        : { saveId: manifest.saveId || null, savedAt: manifest.savedAt || null, fingerprint: manifest.fingerprint || null },
    unsavedSince: plan === 'recover' ? state.unsavedSince : null,
    openedAt: now,
    lastUsedAt: now,
    closedCleanly: false,
  });
  return { workDir, dataDir: dataDirOf(workDir), plan, manifest, conflictCopy };
}

/**
 * What a working copy folder holds that is only a cache: the database copy, its state and
 * leftovers of writing them. Anything else in the folder was put there by the app server next to
 * the database folder — condense archive copies (the only way back after Condense Data), safety
 * copies made before a restore, scheduled report exports — and is never deleted with the cache.
 */
function isCacheEntry(name) {
  return name === 'data' || name === STATE_FILE || (name.startsWith(`${STATE_FILE}.`) && name.endsWith('.tmp')) || /^data\.(restore-tmp|pre-restore|refused-restore)-\d+$/.test(name);
}

/** Remove the cache of working copies not used for a long time, except `keep` (best effort). */
function pruneWorkingCopies(root, keep = [], now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const keepKeys = new Set(keep.map((d) => pathKey(d)));
  const removed = [];
  for (const n of names) {
    const dir = path.join(root, n);
    if (keepKeys.has(pathKey(dir))) continue;
    const st = readState(dir);
    // Never throw away unsaved work, whatever its age.
    if (!st || st.unsavedSince) continue;
    const last = Date.parse(st.lastUsedAt || st.openedAt || '') || 0;
    if (now - last < WORKING_COPY_MAX_AGE_MS) continue;
    try {
      let entries = fs.readdirSync(dir);
      if (entries.every(isCacheEntry)) {
        fs.rmSync(dir, { recursive: true, force: true });
      } else {
        // Keep the side files; drop the cache (the state last, so a failure leaves it prunable).
        entries = entries.filter(isCacheEntry).sort((a, b) => (a === STATE_FILE ? 1 : b === STATE_FILE ? -1 : 0));
        for (const n of entries) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      }
      removed.push(dir);
    } catch {
      /* in use / locked: next time */
    }
  }
  return removed;
}

module.exports = {
  STATE_FILE,
  STATE_SCHEMA,
  workingRoot,
  workingDirFor,
  readState,
  writeState,
  dataDirOf,
  hasData,
  planOpen,
  conflictCopyPath,
  writeWorkingCopyAs,
  prepareWorkingCopy,
  pruneWorkingCopies,
};
