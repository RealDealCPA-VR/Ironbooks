// What kinds of file Ironbooks writes to disk for a page: the native Save dialog the app's pages
// use (file:saveBytes in main.js, an allow-list: every caller names the export's type) and
// ordinary downloads (security.js will-download, a deny-list: people's own attachments come back
// out with whatever type they had). A page — the app's own, or a multi-user host's in client
// mode — names the file, so the type is checked on the path that is finally written, never only
// on what the page asked for: "Invoice.exe" must not reach the disk under a "PDF Document"
// filter, and "Invoice.exe." is refused too (Windows drops trailing dots and spaces, so it would
// be saved as Invoice.exe).
//
// Pure helpers so they can be unit-tested without Electron.

'use strict';

/** The kinds of file the app's pages save through the Save dialog (exports, copies, codes). */
const SAVE_TYPES = new Set(['bkp', 'csv', 'ibac', 'ibcx', 'ofx', 'qfx', 'pdf', 'qbo', 'txt', 'xlsx', 'iif', 'json', 'zip', 'xml', 'html']);

/**
 * Ordinary downloads may be any kind of file except one Windows runs or that carries code: the
 * Doc Center keeps attachments with any extension (lib/services/attachments.ts), and people must
 * get their own .pptx, .dwg or .mov back out. Refused: programs and installers, scripts, shortcuts
 * and system handlers, disk images, macro-enabled Office documents and add-ins, and other
 * platforms' packages.
 */
const RUNNABLE_TYPES = new Set([
  // programs and installers
  'exe', 'com', 'scr', 'pif', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller',
  'application', 'gadget', 'cpl', 'msc', 'dll', 'sys', 'drv', 'ocx', 'jar', 'jnlp',
  // scripts
  'bat', 'cmd', 'ps1', 'ps1xml', 'ps2', 'psc1', 'psc2', 'psm1', 'psd1', 'vb', 'vbs', 'vbe', 'js', 'jse', 'ws', 'wsf',
  'wsc', 'wsh', 'hta', 'sct', 'py', 'pyw', 'rb', 'pl', 'sh', 'bash', 'command',
  // shortcuts and system handlers
  'lnk', 'url', 'scf', 'inf', 'reg', 'shb', 'shs', 'chm', 'hlp', 'website', 'settingcontent-ms', 'library-ms',
  'search-ms', 'diagcab', 'appref-ms',
  // disk images
  'iso', 'img', 'vhd', 'vhdx',
  // macro-enabled Office documents and add-ins
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'xll', 'wll', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm', 'ade', 'adp', 'mde', 'accde',
  // other platforms' packages
  'app', 'dmg', 'pkg', 'deb', 'rpm', 'apk',
]);

/** Windows drops trailing dots and spaces from a file name: "Invoice.exe. " is Invoice.exe. */
function trimTrailingDotsAndSpaces(p) {
  return String(p ?? '').replace(/[. ]+$/, '');
}

/**
 * The extension the file really gets ('' for none), from a name or a full path; null when the
 * name is unusable: empty, or with a ':' (on Windows, "a.pdf:x.exe" writes a hidden stream).
 */
function effectiveExtension(nameOrPath) {
  const base = trimTrailingDotsAndSpaces(nameOrPath).split(/[\\/]/).pop() || '';
  if (!base || base.includes(':')) return null;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * May a download with this name (or chosen path) be written? Anything but a kind of file that runs
 * or carries code (RUNNABLE_TYPES, checked after Windows' own clean-up of the name) or an unusable
 * name. A name with no extension is allowed.
 */
function downloadAllowed(nameOrPath) {
  const ext = effectiveExtension(nameOrPath);
  return ext !== null && !RUNNABLE_TYPES.has(ext);
}

/**
 * The Save dialog for file:saveBytes, from what the page asked for: the suggested name (an
 * extension outside SAVE_TYPES is dropped), the filters (only SAVE_TYPES extensions), the
 * extensions the saved file may end up with, and the one added when the chosen name has another
 * (null: refuse instead).
 */
function planSave({ defaultName, filters } = {}) {
  const safeFilters = (Array.isArray(filters) ? filters : [])
    .map((f) => ({
      name: String((f && f.name) || 'File').slice(0, 80),
      extensions: (Array.isArray(f && f.extensions) ? f.extensions : []).map((x) => String(x).toLowerCase()).filter((x) => SAVE_TYPES.has(x)),
    }))
    .filter((f) => f.extensions.length > 0);
  let base = trimTrailingDotsAndSpaces(String(defaultName || 'export').split(/[\\/]/).pop()) || 'export';
  const ext = effectiveExtension(base);
  if (ext === null) base = 'export';
  else if (ext && !SAVE_TYPES.has(ext)) base = base.slice(0, -(ext.length + 1)) || 'export';
  const allowed = safeFilters.length ? new Set(safeFilters.flatMap((f) => f.extensions)) : SAVE_TYPES;
  const fallback = safeFilters.length ? safeFilters[0].extensions[0] : ext && SAVE_TYPES.has(ext) ? ext : null;
  return { base, filters: safeFilters, allowed, fallback };
}

/**
 * The path file:saveBytes writes for the one chosen in the dialog, or null to refuse: trailing
 * dots and spaces removed, and an extension outside `allowed` replaced by adding `fallback`
 * ("Invoice.exe" → "Invoice.exe.pdf"), as the dialog's filter promised.
 */
function finalSavePath(chosen, { allowed, fallback }) {
  if (!chosen) return null;
  const trimmed = trimTrailingDotsAndSpaces(chosen);
  const ext = effectiveExtension(trimmed);
  if (ext === null) return null;
  if (ext && allowed.has(ext) && SAVE_TYPES.has(ext)) return trimmed;
  if (fallback && SAVE_TYPES.has(fallback)) return `${trimmed}.${fallback}`;
  return null;
}

module.exports = { SAVE_TYPES, RUNNABLE_TYPES, trimTrailingDotsAndSpaces, effectiveExtension, downloadAllowed, planSave, finalSavePath };
