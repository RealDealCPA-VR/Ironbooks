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

module.exports = {
  MANIFEST,
  readManifest,
  writeManifest,
  companyName,
  looksLikeCompany,
  ensureManifest,
};
