// Where a company file lives, as far as keeping it safe goes (electron/main.js asks before opening):
//  - 'temp':  a temporary folder — typically an email attachment opened straight from Outlook or a
//             browser download cache. Work saved there is lost when the folder is cleaned, so the
//             app offers to save a copy to Documents first.
//  - 'cloud': a folder a sync service (OneDrive, Dropbox, Google Drive, iCloud) copies between
//             computers. One computer at a time works; two computers opening it at once can each
//             take the lock before the other's lock syncs, and conflicted copies appear. QuickBooks
//             gives the same advice: share through a file server or multi-user hosting instead.
// Pure (no Electron), so it is unit-tested (test/fileLocation.test.ts).
'use strict';

const path = require('node:path');

/** Folder names sync clients use for their roots, matched as whole path segments. */
const CLOUD_SEGMENTS = [
  { re: /^onedrive( - .+)?$/i, service: 'OneDrive' },
  { re: /^dropbox( \(.+\))?$/i, service: 'Dropbox' },
  { re: /^(google drive|my drive)$/i, service: 'Google Drive' },
  { re: /^(icloud ?drive|icloud~.*|mobile documents)$/i, service: 'iCloud Drive' },
];

/** Temporary folders an attachment or download is opened from. */
const TEMP_SEGMENTS = [/^inetcache$/i, /^content\.outlook$/i, /^temporary internet files$/i];

function normalize(p) {
  return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function isInside(file, folder) {
  if (!folder) return false;
  const f = normalize(file);
  const d = normalize(folder);
  return f === d || f.startsWith(d + path.sep) || f.startsWith(d + '/') || f.startsWith(d + '\\');
}

/**
 * Classify a company file's location.
 * @param {string} filePath
 * @param {{ env?: Record<string, string | undefined>, tmpdir?: string }} [opts]
 * @returns {{ kind: 'temp' } | { kind: 'cloud', service: string } | null}
 */
function classifyCompanyFileLocation(filePath, opts = {}) {
  const env = opts.env || {};
  const segments = path.resolve(String(filePath || '')).split(/[\\/]+/).slice(0, -1);
  if (opts.tmpdir && isInside(filePath, opts.tmpdir)) return { kind: 'temp' };
  if (segments.some((s) => TEMP_SEGMENTS.some((re) => re.test(s)))) return { kind: 'temp' };
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (env[key] && isInside(filePath, env[key])) return { kind: 'cloud', service: 'OneDrive' };
  }
  for (const s of segments) {
    const hit = CLOUD_SEGMENTS.find((c) => c.re.test(s));
    if (hit) return { kind: 'cloud', service: hit.service };
  }
  return null;
}

module.exports = { classifyCompanyFileLocation };
