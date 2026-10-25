// Company-file helpers for the desktop shell.
//
// A company file is a single file, "ABC Company.ironbooks" (electron/companyFileFormat.js), that
// the user can put anywhere — a local disk, a USB drive, or the office file server. Older
// versions stored it as a self-contained folder holding the embedded database plus a small
// manifest (`bookkeeper-company.json`) that gives it a human name; those folders still open, and
// the manifest still lives inside the database folder of every company file. The file password
// and the users live inside the database (server-enforced); the manifest only carries a
// `passwordProtected` display hint so Open/Recent can show a lock icon without starting the server.
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'bookkeeper-company.json';
const SCHEMA = 'bookkeeper-company/v1';

function manifestPath(dir) {
  return path.join(dir, MANIFEST);
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
    if (m && m.schema === SCHEMA) return m;
  } catch {
    /* missing / unreadable / not ours */
  }
  return null;
}

function writeManifest(dir, data) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const merged = { schema: SCHEMA, ...(readManifest(dir) || {}), ...data };
    fs.writeFileSync(manifestPath(dir), JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch {
    return null;
  }
}

/** Human name for a company file: manifest name, else folder basename (sans an .ironbooks / legacy .bookkeeper suffix). */
function companyName(dir) {
  const m = readManifest(dir);
  // The company's own name (recorded by the app when the file is open) beats the folder name:
  // a first-run file lives in a folder called "default".
  if (m && typeof m.displayName === 'string' && m.displayName.trim()) return m.displayName.trim();
  if (m && typeof m.name === 'string' && m.name.trim()) return m.name.trim();
  return path.basename(dir).replace(/\.(ironbooks|bookkeeper)$/i, '');
}

/** True if the folder is (or could become) a usable company file. */
function looksLikeCompany(dir) {
  if (readManifest(dir)) return true;
  try {
    const entries = fs.readdirSync(dir);
    // PGlite data dirs contain PG_VERSION/base/global; existing files also have .auth-secret.
    return (
      entries.includes('PG_VERSION') ||
      entries.includes('base') ||
      entries.includes('.auth-secret')
    );
  } catch {
    return false;
  }
}

/** Backfill a manifest for legacy folders created before manifests existed. */
function ensureManifest(dir) {
  if (!readManifest(dir)) {
    writeManifest(dir, {
      name: path.basename(dir).replace(/\.(ironbooks|bookkeeper)$/i, ''),
      createdAt: new Date().toISOString(),
    });
  }
  return readManifest(dir);
}

// Sandbox mode ("Try it on a copy", lib/services/sandboxState.ts): a sandbox / training copy of
// a company file carries this marker at its root. The shell reads it to know it is running a
// practice copy (no auto-backups, scheduled reports, hosting, Recent Companies or update prompts).
const SANDBOX_MARKER = '.ironbooks-sandbox.json';
const SANDBOX_SCHEMA = 'ironbooks-sandbox/v1';

/** The sandbox marker of a company-file folder, or null for a real company file. */
function readSandboxMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, SANDBOX_MARKER), 'utf8'));
    if (m && m.schema === SANDBOX_SCHEMA && (m.kind === 'sandbox' || m.kind === 'training') && typeof m.realDataDir === 'string') {
      return m;
    }
  } catch {
    /* missing / unreadable: a real company file */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Company file locations: a single company file ("ABC Company.ironbooks", the current format —
// electron/companyFileFormat.js) or a company folder (the older format, still fully supported).
// Recent-file lists, menus and the No Company Open screen hold either kind.
// ---------------------------------------------------------------------------

const format = require('./companyFileFormat');

/** True when `location` is a single company file (not a folder). */
function isSingleFile(location) {
  try {
    return fs.statSync(location).isFile();
  } catch {
    return /\.ironbooks$/i.test(String(location || '')) && !String(location).endsWith(path.sep);
  }
}

/** Whether the company file / folder is there (a file server that is offline reads as missing). */
function locationExists(location) {
  try {
    const st = fs.statSync(location);
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

/** Display name for either kind: the company name saved in it, else the file / folder name. */
function locationName(location) {
  if (isSingleFile(location)) {
    const m = format.readCompanyManifest(location);
    if (m && typeof m.companyName === 'string' && m.companyName.trim()) return m.companyName.trim();
    return format.companyFileBaseName(location);
  }
  return companyName(location);
}

/** Manifest-ish details for lists: { lastOpenedAt|savedAt, passwordProtected }. */
function locationDetails(location) {
  if (isSingleFile(location)) {
    const m = format.readCompanyManifest(location) || {};
    return {
      lastOpenedAt: typeof m.savedAt === 'string' ? m.savedAt : null,
      passwordProtected: Boolean(m.passwordProtected),
    };
  }
  const m = readManifest(location) || {};
  return {
    lastOpenedAt: typeof m.lastOpenedAt === 'string' ? m.lastOpenedAt : null,
    passwordProtected: Boolean(m.passwordProtected),
  };
}

module.exports = {
  isSingleFile,
  locationExists,
  locationName,
  locationDetails,
  SANDBOX_MARKER,
  readSandboxMarker,
  MANIFEST,
  readManifest,
  writeManifest,
  companyName,
  looksLikeCompany,
  ensureManifest,
};
