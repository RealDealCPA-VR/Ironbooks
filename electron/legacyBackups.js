'use strict';
// One-time-ish cleanup of quit-time backups written by versions before the backup history
// existed. Those files were named `auto-backup-<YYYY-MM-DDTHH-MM-SS>.bka` (no company slug)
// and rotated by the main process to the newest 10. The server-side rotation only deletes
// files recorded in a company file's backup history, so without this they would stay on disk
// forever after an upgrade. Current files (`auto-backup-<company>-<ts>.bka`) never match.
const fs = require('node:fs');
const path = require('node:path');

const LEGACY_AUTO_BACKUP_RE = /^auto-backup-\d{4}-\d{2}-\d{2}T[\d-]{8}\.bka$/;
const LEGACY_AUTO_BACKUP_KEEP = 10;

/**
 * Delete legacy (pre-history) auto-backups in `dir` beyond the newest `keep`.
 * Returns the deleted file names. Never throws.
 */
function pruneLegacyAutoBackups(dir, keep = LEGACY_AUTO_BACKUP_KEEP) {
  const removed = [];
  try {
    if (!fs.existsSync(dir)) return removed;
    const files = fs
      .readdirSync(dir)
      .filter((f) => LEGACY_AUTO_BACKUP_RE.test(f))
      .sort(); // timestamped names sort chronologically
    for (const f of files.slice(0, Math.max(files.length - keep, 0))) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        removed.push(f);
      } catch (err) {
        console.error(`[auto-backup] could not remove legacy backup ${f}:`, err);
      }
    }
  } catch (err) {
    console.error('[auto-backup] legacy cleanup failed:', err);
  }
  return removed;
}

module.exports = { pruneLegacyAutoBackups, LEGACY_AUTO_BACKUP_RE, LEGACY_AUTO_BACKUP_KEEP };
