// Company-file helpers for the desktop shell.
//
// A "company file" is a self-contained folder (the user can place it anywhere — a local disk,
// an external drive, or a mapped network/server share) holding one embedded database plus a small
// manifest that gives the file a human name. The actual file password lives inside the database
// (server-enforced); the manifest only carries a `passwordProtected` display hint so Open/Recent
// can show a lock icon without spinning up the server.
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

module.exports = {
  SANDBOX_MARKER,
  readSandboxMarker,
  MANIFEST,
  readManifest,
  writeManifest,
  companyName,
  looksLikeCompany,
  ensureManifest,
};
