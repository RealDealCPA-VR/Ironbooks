// Electron main process for Ironbooks (desktop).
//
// Architecture: the React/Next.js UI and the accounting engine (PGlite local DB) run inside a
// Next.js server. In production we launch the Next standalone server as a child process on a free
// local port and point a BrowserWindow at it; in dev we attach to `next dev` on :3000.
//
// The active company file is a local data directory; we set BKA_DATA_DIR before starting the
// server so lib/db persists there. This keeps all financial data on the user's machine (offline).

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell, session } = require('electron');

// --- legacy userData location (product rename BookKeeper AI -> Ironbooks) ---
// Electron derives app.getPath('userData') from the app name: build.productName for packaged
// builds (%APPDATA%\BookKeeper AI before the rename, %APPDATA%\Ironbooks after) and the
// package.json "name" in dev runs (bookkeeper-ai before, ironbooks after). That folder holds
// config.json (active company), the default companies/ folder, quit-time backups, TLS certs and
// window state. If the new folder doesn't exist yet but a legacy one does, keep using the legacy
// folder so existing users don't lose their companies/config/backups on upgrade. This must run
// before anything reads userData, including requestSingleInstanceLock() (its lock lives there),
// and app.setPath is allowed before 'ready'.
(function useLegacyUserDataIfPresent() {
  const fs = require('node:fs');
  const path = require('node:path');
  // IRONBOOKS_USER_DATA: keep this app's settings (recent files, window, backups folder) in a
  // folder of your choosing — IT deployments, a portable setup, and the desktop tests.
  if (process.env.IRONBOOKS_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.IRONBOOKS_USER_DATA));
    return;
  }
  try {
    if (fs.existsSync(app.getPath('userData'))) return;
    const appData = app.getPath('appData');
    for (const legacyName of ['BookKeeper AI', 'bookkeeper-ai']) {
      const legacyDir = path.join(appData, legacyName);
      if (fs.existsSync(legacyDir)) {
        app.setPath('userData', legacyDir);
        return;
      }
    }
  } catch {
    // Fall back to the default (new) userData location.
  }
})();
const { buildSectionMenus } = require('./menuRoutes');
const spelling = require('./spelling');
const windowTheme = require('./windowTheme');
const startScreen = require('./startScreen');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const companyFile = require('./companyFile');
const companyFileFormat = require('./companyFileFormat');
const companyLock = require('./companyLock');
const companySession = require('./companySession');
const selfSignedCert = require('./selfSignedCert');
const hostingCore = require('./hostingCore');
const hosting = require('./hosting');
const security = require('./security');
const { promptForHost } = require('./connectPrompt');
const { pruneLegacyAutoBackups } = require('./legacyBackups');

const isDev = !app.isPackaged;
let mainWindow = null;
/** File > Close Company: the window shows "No Company Open" and no company file is loaded. */
let startScreenMode = false;
let serverProcess = null;
let serverUrl = null;
/** Set once the quit-time auto-backup has run (or been skipped) so app.quit() proceeds. */
let quittingAfterBackup = false;
/** Relaunch once the quit has finished (set by relaunchApp; a cancelled quit cancels it too). */
let relaunchAfterQuit = false;
/**
 * Config for the next launch (which company file, or No Company Open), written only once the
 * open company file has been saved and closed. If that save fails and the person keeps working,
 * it is dropped: the next launch still opens the file they kept working in.
 */
let configAfterClose = null;

/**
 * Restart into another company file / mode: quit (the open company file is backed up, saved and
 * released on the way out — before-quit), then start again with `nextConfig` applied. If the save
 * fails and the person chooses to keep working, nothing restarts and nothing is changed.
 */
function relaunchApp(nextConfig = null) {
  relaunchAfterQuit = true;
  if (nextConfig) configAfterClose = { ...(configAfterClose || {}), ...nextConfig };
  app.quit();
}

/** The main window for a dialog's parent, if it is still there. */
function parentWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}
/** A .bka file the OS asked us to open (double-click / "Open with" / argv). */
let pendingBkaPath = null;
/** A .bkp portable company file the OS asked us to open. */
let pendingBkpPath = null;
/**
 * Multi-user: when set, this app is a CLIENT showing a company hosted on another machine
 * (File > Open company on host…) — no local server is started, and local-only chores
 * (auto-backup, recurring run, updates, hosting) are skipped.
 */
let remoteHostOrigin = null;
/** Multi-user: this app is HOSTING its company file for the tailnet (electron/hosting.js). */
let hostingState = null;
let hostingError = null;
/**
 * The single company file this window has open ("ABC Company.ironbooks", QuickBooks .QBW style):
 * { path, lock, workDir, dataDir, plan, appUser }. The app server runs on the private working
 * copy (dataDir) and saves it back to `path` (lib/services/companyFileSave.ts); `lock` is this
 * computer's hold on the file (electron/companyLock.js). Null for an older company folder, a
 * multi-user client, or No Company Open.
 */
let openFile = null;
/** A .ironbooks company file the OS asked us to open (double-click / "Open with" / argv). */
let pendingCompanyPath = null;
/**
 * Multi-user client of a company file on the shared drive: the host's certificate fingerprint
 * (office-network hosting serves its own certificate, which we accept only when it matches).
 */
let remotePin = null;

// Per-launch secret shared with the local Next server so the main process can make
// authenticated "system" calls (e.g. the launch-time recurring run). The server is bound to
// 127.0.0.1 and the token never leaves this machine.
const internalToken = crypto.randomBytes(32).toString('hex');

// --- single instance lock ---
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------------------------------------------------------------------------
// .bka file association handling
//
// electron-builder registers the .bka extension at install time (package.json "build"
// fileAssociations); the two OS entry points are handled here:
//  - macOS: the 'open-file' app event (fires before 'ready' on cold start, so register early)
//  - Windows/Linux: a .bka path in process.argv (first launch) or in the second instance's
//    argv (forwarded to us via 'second-instance' thanks to the single-instance lock above)
// The Backup page is opened with a one-time token (/backup?restore=<token>) and asks for the file
// by it (backup:takePending), then shows the backup's preview and the usual restore confirmation.
// ---------------------------------------------------------------------------

function extractBkaPath(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg === 'string' && !arg.startsWith('-') && arg.toLowerCase().endsWith('.bka')) {
      return arg;
    }
  }
  return null;
}

/** A backup to restore into the open company file, until the Backup page takes it (once). */
let backupToRestore = null;

function deliverPendingBka() {
  if (!pendingBkaPath || !mainWindow) return;
  const filePath = pendingBkaPath;
  pendingBkaPath = null;
  // No company open: there is nothing to restore into, so restore it as a new company file.
  if (startScreenMode) {
    restoreBackupAsNewFileFlow(filePath).catch((err) => console.error('[restore] backup:', err));
    return;
  }
  // Only this one file, and only once: the page names it by a token, never by a path.
  backupToRestore = { token: crypto.randomBytes(12).toString('hex'), path: filePath };
  navigate(`/backup?restore=${backupToRestore.token}`);
}

// The Backup page picks up the backup chosen in File > Open or Restore Company (or double-clicked):
// { name, data } (or { name, error }) for the token deliverPendingBka gave it; null otherwise.
ipcMain.handle('backup:takePending', (e, token) => {
  if (!fromLocalApp(e) || !backupToRestore || typeof token !== 'string' || token !== backupToRestore.token) return null;
  const filePath = backupToRestore.path;
  backupToRestore = null;
  try {
    const buf = fs.readFileSync(filePath);
    return { name: path.basename(filePath), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (err) {
    return { name: path.basename(filePath), error: openErrorText(err) };
  }
});

pendingBkaPath = extractBkaPath(process.argv);

// .bkp (Portable Company File) association: same OS entry points as .bka, but the file is
// restored into a NEW company file (see openPortableFlow) instead of the backup page.
function extractBkpPath(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg === 'string' && !arg.startsWith('-') && arg.toLowerCase().endsWith('.bkp')) {
      return arg;
    }
  }
  return null;
}

function deliverPendingBkp() {
  if (!pendingBkpPath || !mainWindow) return;
  const filePath = pendingBkpPath;
  pendingBkpPath = null;
  openPortableFlow(filePath);
}

pendingBkpPath = extractBkpPath(process.argv);

// .ironbooks (single company file) association: open it as the company file, like double-clicking
// a .QBW. A second launch (the app is running) forwards it through 'second-instance'.
function extractCompanyPath(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg === 'string' && !arg.startsWith('-') && arg.toLowerCase().endsWith('.ironbooks')) {
      return path.resolve(arg);
    }
  }
  return null;
}

pendingCompanyPath = extractCompanyPath(process.argv);

app.on('open-file', (event, filePath) => {
  const lower = (filePath || '').toLowerCase();
  if (lower.endsWith('.ironbooks')) {
    event.preventDefault();
    if (app.isReady() && mainWindow) openCompanyFromOs(filePath);
    else pendingCompanyPath = path.resolve(filePath);
    return;
  }
  if (lower.endsWith('.bkp')) {
    event.preventDefault();
    pendingBkpPath = filePath;
    deliverPendingBkp();
    return;
  }
  if (!filePath || !lower.endsWith('.bka')) return;
  event.preventDefault();
  pendingBkaPath = filePath;
  deliverPendingBka();
});

// ---------------------------------------------------------------------------
// App config (JSON in userData/config.json)
//
//   backupIntervalHours  initial scheduled auto-backup cadence for a company file that has no
//                        backup settings yet (passed to the server as BKA_BACKUP_INTERVAL_HOURS;
//                        0/negative = off). The schedule itself now lives with each company
//                        file and is changed on the Back Up & Restore page; the server process
//                        runs it (lib/services/backupSchedule.ts).
//   companyFile          the active single company file ("ABC Company.ironbooks"); while set it
//                        wins over dataDir. Opened into a working copy on this computer
//                        (electron/companySession.js) and saved back to the file.
//   dataDir              active company folder (older format), used when companyFile is not set;
//                        the BKA_DATA_DIR env var overrides both for one launch
//   recentCompanies      most-recently-opened company files and folders (File menu)
//   lastUsers            { <company file path>: user name } — the sign-in screen pre-fills the
//                        user name last used for that file on this computer, like QuickBooks
//   remotePin / remoteFile  multi-user client of a company file on the shared drive: the host's
//                        certificate fingerprint and the company file it is hosting
//   hosting              multi-user hosting { enabled, port, tls, bindAll } — bindAll (listen
//                        on every interface instead of only the Tailscale address) is never
//                        set by the UI; it must be edited in deliberately
//   remoteHost           when set, open the company hosted at this tailnet/LAN URL instead of a
//                        local company file (File > Open company on host… / Disconnect)
//   sandbox              { dir, realDir } while the active file (dataDir) is a "Try it on a copy"
//                        sandbox copy of realDir (see the sandbox section below)
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {}; // missing/corrupt config: defaults
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    // Temp file + rename: a crash or power cut mid-write must not leave a cut-off config.json
    // (it would read as empty: which company file was open, recent files, hosting… all gone).
    const tmp = `${configPath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, configPath());
  } catch (err) {
    console.error('[config] save failed:', err);
  }
  return next;
}

const RECENT_COMPANIES_KEEP = 8;

/** Put `dir` at the front of the recent-companies list (deduped, capped). */
function rememberRecentCompany(dir) {
  const cfg = loadConfig();
  const recents = [dir, ...(Array.isArray(cfg.recentCompanies) ? cfg.recentCompanies : [])]
    .filter((d, i, arr) => typeof d === 'string' && arr.indexOf(d) === i)
    .slice(0, RECENT_COMPANIES_KEEP);
  saveConfig({ recentCompanies: recents });
  return recents;
}

/**
 * Make `location` (a single company file, or an older company folder) the active company file and
 * relaunch into it. The one open now is saved, backed up and released on the way out (before-quit).
 */
function openCompany(location, extra = {}) {
  // Opening a local file leaves any remote host, and ends "No Company Open" — once the file open
  // now has closed (relaunchApp).
  const single = companyFile.isSingleFile(location);
  rememberRecentCompany(location);
  relaunchApp({
    ...(single ? { companyFile: location } : { dataDir: location, companyFile: null }),
    remoteHost: null,
    remotePin: null,
    remoteFile: null,
    companyClosed: false,
    ...extra,
  });
}

/** The user name last used to sign in to `location` on this computer (sign-in screen pre-fill). */
function lastUserFor(location) {
  const users = loadConfig().lastUsers;
  const v = users && typeof users === 'object' ? users[location] : null;
  return typeof v === 'string' && v ? v : null;
}

function rememberLastUser(location, name) {
  const users = loadConfig().lastUsers;
  const next = { ...(users && typeof users === 'object' ? users : {}), [location]: name };
  // Keep it small: the most recent dozen files.
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - 12))) delete next[k];
  saveConfig({ lastUsers: next });
}

// ---------------------------------------------------------------------------
// Window-state persistence (size/position/maximized) via JSON in userData
// ---------------------------------------------------------------------------

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (
      raw &&
      Number.isFinite(raw.width) && Number.isFinite(raw.height) &&
      raw.width >= 400 && raw.height >= 300
    ) {
      return raw;
    }
  } catch {
    // missing/corrupt state file — fall back to defaults
  }
  return null;
}

/** Is the saved rectangle at least partially on a connected display? */
function boundsVisible(state) {
  if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) return false;
  try {
    const { screen } = require('electron');
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return (
        state.x < a.x + a.width && state.x + state.width > a.x &&
        state.y < a.y + a.height && state.y + state.height > a.y
      );
    });
  } catch {
    return false;
  }
}

function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // getNormalBounds = the restored rectangle even while maximized/fullscreen.
    const bounds = win.getNormalBounds();
    fs.writeFileSync(
      windowStatePath(),
      JSON.stringify({ ...bounds, maximized }, null, 2),
    );
  } catch (err) {
    console.error('[window-state] save failed:', err);
  }
}

/** Debounced save on move/resize so we survive crashes, not just clean closes. */
function trackWindowState(win) {
  let timer = null;
  const queueSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveWindowState(win), 500);
  };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    saveWindowState(win);
  });
}

// ---------------------------------------------------------------------------
// Quit-time auto-backup (versioned, keep last N in the company file's backup folder)
//
// The main process has no session cookie, so it authenticates with the per-launch
// internal token against POST /api/dashboard/auto-backup?save=1 (same trusted-local pattern
// as the launch-time recurring run). The SERVER writes the .bka into the backup folder
// (default userData/backups, passed as BKA_BACKUP_DIR), records it in the backup history,
// rotates to the configured number of versions and skips when nothing changed since the
// last backup. In dev the server was not spawned by us, the token will not match, and the
// backup is skipped with a log line.
// ---------------------------------------------------------------------------

/** The existing backups folder: default destination for versioned backups. */
function backupsDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runAutoBackup() {
  // Pre-history versions wrote `auto-backup-<ts>.bka` here and rotated them in this process;
  // the server's rotation only touches files in a company file's history, so keep pruning
  // those legacy files to the newest 10 (as the old AUTO_BACKUP_KEEP did).
  const legacyRemoved = pruneLegacyAutoBackups(backupsDir());
  if (legacyRemoved.length) console.log(`[auto-backup] removed ${legacyRemoved.length} old-style backup(s)`);
  if (!serverUrl || remoteHostOrigin) return; // a client never backs up the host's file
  // Sandbox mode: auto-backups are of the REAL file only, never of a practice copy (the server
  // refuses too). The real file is backed up as usual once the user leaves the sandbox.
  if (sandboxActive()) return;
  const res = await fetch(`${serverUrl}/api/dashboard/auto-backup?save=1`, {
    method: 'POST',
    headers: { 'x-bka-internal': internalToken },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body}`.trim());
  }
  const result = await res.json().catch(() => ({}));
  if (result.status === 'created') console.log(`[auto-backup] wrote ${result.path} (${result.sizeBytes} bytes)`);
  else console.log('[auto-backup] skipped: nothing changed since the last backup');
}

function companiesRoot() {
  return path.join(app.getPath('userData'), 'companies');
}

/**
 * Active company data directory, in priority order:
 *  1. BKA_DATA_DIR env var (one-shot override, e.g. scripted/portable launches)
 *  2. config.json dataDir (set by File > Open/New Company / Recent Companies)
 *  3. userData/companies/default (first run)
 */
function activeCompanyDir() {
  const cfg = loadConfig();
  const singleFile = !process.env.BKA_DATA_DIR && typeof cfg.companyFile === 'string' && cfg.companyFile ? cfg.companyFile : null;
  const dir =
    process.env.BKA_DATA_DIR ||
    (openFile && openFile.dataDir) ||
    // A single company file runs on its working copy on this computer (electron/companySession.js).
    (singleFile && companySession.dataDirOf(companySession.workingDirFor(singleFile, workingRoot()))) ||
    (typeof cfg.dataDir === 'string' && cfg.dataDir) ||
    path.join(companiesRoot(), 'default');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The database migrations this app ships (packaged: resources/app/drizzle). */
function migrationsDir() {
  return isDev ? path.join(__dirname, '..', 'drizzle') : path.join(process.resourcesPath, 'app', 'drizzle');
}

/** Where working copies of open company files live (never a roaming profile). */
function workingRoot() {
  return companySession.workingRoot({ userData: app.getPath('userData') });
}

/**
 * The open company file as people know it: the .ironbooks file (or, for an older company, its
 * folder). This is what Recent Companies, Show in Folder and the title bar refer to.
 */
function currentCompanyLocation() {
  if (openFile) return openFile.path;
  const cfg = loadConfig();
  if (!process.env.BKA_DATA_DIR && typeof cfg.companyFile === 'string' && cfg.companyFile) return cfg.companyFile;
  return activeCompanyDir();
}

// ---------------------------------------------------------------------------
// Sandbox mode ("Try it on a copy" - lib/services/sandbox.ts)
//
// The local server makes the copy (POST /api/sandbox: PGlite closed, data dir copied) and
// switches itself to it; the renderer then calls sandbox:entered and the shell relaunches into
// the copy like File > Open Company, with config.sandbox = { dir, realDir } as its flag. While the
// active file is a sandbox / training copy (marker file, electron/companyFile.js) the shell skips
// auto-backups, scheduled reports, multi-user hosting, Recent Companies and update prompts.
// Leaving (discard / keep as training file) is done by the server; sandbox:left relaunches into
// the real file recorded in config.sandbox.realDir - never a path supplied by the renderer.
// ---------------------------------------------------------------------------

function sandboxRoot() {
  return path.join(app.getPath('userData'), 'sandboxes');
}

/** The active company file's sandbox marker (null for a real company file). */
function sandboxActive() {
  if (remoteHostOrigin) return null;
  try {
    return companyFile.readSandboxMarker(activeCompanyDir());
  } catch {
    return null;
  }
}

/**
 * Before anything opens the active dir: a sandbox copy that no longer exists (discarded while the
 * app was not running it, or deleted by hand) sends the shell back to the real file instead of
 * re-creating an empty folder; a stale flag for a different active file is dropped.
 */
function reconcileSandboxConfig() {
  const cfg = loadConfig();
  const sb = cfg.sandbox;
  if (!sb || typeof sb !== 'object') return;
  if (typeof sb.dir !== 'string' || typeof sb.realDir !== 'string' || cfg.dataDir !== sb.dir) {
    saveConfig({ sandbox: null });
    return;
  }
  if (!fs.existsSync(sb.dir) || !companyFile.readSandboxMarker(sb.dir)) {
    saveConfig({ ...realCompanyConfig(sb), sandbox: null });
  }
}

/** Config that points back at the real company file a sandbox was made from. */
function realCompanyConfig(sb) {
  return typeof sb.realFile === 'string' && sb.realFile ? { companyFile: sb.realFile } : { dataDir: sb.realDir, companyFile: null };
}

function samePath(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

ipcMain.handle('sandbox:entered', (e, dir) => {
  if (!fromLocalApp(e) || typeof dir !== 'string' || !dir) return false;
  const marker = companyFile.readSandboxMarker(dir);
  // Only a sandbox copy of the file this shell has open (the server just made it).
  if (!marker || marker.kind !== 'sandbox') return false;
  if (!isDev && !samePath(marker.realDataDir, activeCompanyDir())) return false;
  // From a single company file, the sandbox runs on a copy of its working copy; leaving goes
  // back to the company file itself (realFile).
  saveConfig({
    dataDir: dir,
    companyFile: null,
    sandbox: { dir, realDir: marker.realDataDir, realFile: openFile ? openFile.path : null },
  });
  setImmediate(() => {
    relaunchApp();
  });
  return true;
});

ipcMain.handle('sandbox:left', (e, opts) => {
  if (!fromLocalApp(e)) return false;
  const sb = loadConfig().sandbox;
  if (!sb || typeof sb.realDir !== 'string') return false;
  saveConfig({ ...realCompanyConfig(sb), sandbox: null });
  const trainingDir = opts && typeof opts.trainingDir === 'string' ? opts.trainingDir : null;
  const kept = trainingDir ? companyFile.readSandboxMarker(trainingDir) : null;
  // A kept training file shows up under File > Recent Companies (it opens like any other file).
  if (kept && kept.kind === 'training') rememberRecentCompany(trainingDir);
  rememberRecentCompany(sb.realFile || sb.realDir);
  setImmediate(() => {
    relaunchApp();
  });
  return true;
});

/** File / Help menu: one click "Try it on a copy" (or "Leave the sandbox" while in one). */
/**
 * File > Close Company (QuickBooks parity): release the company file and show "No Company Open"
 * with the recent files and their locations. The app restarts without loading a file (the usual
 * on-quit auto-backup runs on the way out), so the file can be moved, copied or backed up.
 * Connected to a host, it disconnects.
 */
async function closeCompanyFlow({ skipConfirm = false } = {}) {
  if (sandboxActive()) {
    await dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'info',
      message: 'Leave the sandbox first',
      detail: 'This is a practice copy. Leave the sandbox (File menu), then close the company file.',
    });
    return;
  }
  if (hostingState && !skipConfirm) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'warning',
      message: 'Close the company file?',
      detail: 'You are hosting multi-user access. Teammates who have this company file open will be disconnected.',
      buttons: ['Close Company', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  // The company file is saved and released on the way out (before-quit).
  relaunchApp({ companyClosed: true, remoteHost: null, remotePin: null, remoteFile: null });
}

function sandboxMenuItem() {
  const sb = sandboxActive();
  if (sb && sb.kind === 'sandbox') return { label: 'Leave the Sandbox…', click: () => navigate('/sandbox') };
  if (sb) return { label: 'About This Training File…', click: () => navigate('/sandbox') };
  return {
    label: 'Try It on a Copy (Sandbox)',
    enabled: !remoteHostOrigin,
    click: () => mainWindow?.webContents.send('menu', 'sandbox-start'),
  };
}

// ---------------------------------------------------------------------------
// Single company file ("ABC Company.ironbooks" — QuickBooks .QBW style)
//
// Opening: take the "in use" lock next to the file (electron/companyLock.js), then prepare the
// working copy on this computer (electron/companySession.js) and start the app server on it with
// the company file's location, so it saves back there (lib/services/companyFileSave.ts).
// While open: a heartbeat keeps the lock fresh (and shows who is signed in), and requests from
// other workstations to come in are put to the person here: let them in (multi-user mode on the
// office network), hand the file over, or not now.
// Closing / quitting: the server saves everything to the company file, then the lock is released.
// ---------------------------------------------------------------------------

const LOCK_BEAT_MS = companyLock.HEARTBEAT_MS;
const REQUEST_POLL_MS = 3000;
let lockTimer = null;
let requestTimer = null;
/** Set when another computer took the file over while this one was asleep / off the network. */
let lockLostNoticeShown = false;
/** A company file that was in use when this launch tried to open it: ask for access once the window is up. */
let pendingAccessRequest = null;

function timeOfDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function agoText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'less than a minute ago';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Plain-language reason a company file could not be opened. */
function openErrorText(err) {
  if (err && err.code === 'NEWER_FORMAT') return err.message;
  if (err && err.code === 'READ_ONLY_LOCATION') return err.message;
  if (err && err.name === 'NotACompanyFileError') return err.message;
  if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
    return 'The file or the folder it is in can no longer be found. If it is on a file server, check the connection.';
  }
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
    return 'Windows did not allow Ironbooks to read or write the company file or its folder. Check that you have permission to change files in that folder.';
  }
  return String((err && err.message) || err);
}

/** The person who opens a file after its holder stopped responding: open it here anyway? */
async function confirmTakeOver(filePath, holder) {
  const owner = holder.owner || {};
  // Our own crash on this computer: the working copy here has everything; just carry on.
  if (holder.sameComputer && owner.osUser === companyLock.whoAmI().osUser) return true;
  const name = companyFile.locationName(filePath);
  const unsaved = owner.unsavedSince
    ? `Changes made there after ${timeOfDay(owner.unsavedSince)} may not have reached the company file yet. They are kept on ${owner.computer || 'that computer'}: open the company file there first and Ironbooks will save them.\n\n`
    : '';
  const { response } = await dialog.showMessageBox(parentWindow(), {
    noLink: true,
    type: 'warning',
    message: `${name} was open on ${companyLock.describeOwner(owner)}, but that computer stopped responding ${agoText(holder.ageMs)}.`,
    detail:
      unsaved +
      'If that computer crashed, lost its network connection or was turned off, you can open the company file here. If someone is still working in it there, their next changes will be kept as a separate copy instead of being saved into the file.',
    buttons: ['Open It Here', 'Cancel'],
    defaultId: owner.unsavedSince ? 1 : 0,
    cancelId: 1,
  });
  return response === 0;
}

/** Unsaved changes on this computer can't be combined with a newer save: keep them apart? */
async function confirmConflict(filePath, state, manifest) {
  const name = companyFile.locationName(filePath);
  const sb = manifest && manifest.savedBy;
  const by = sb ? ` from ${sb.appUser ? `${sb.appUser} on ` : ''}${sb.computer || 'another computer'}` : '';
  const when = state.unsavedSince ? ` around ${timeOfDay(state.unsavedSince)} on ${new Date(state.unsavedSince).toLocaleDateString()}` : '';
  const { response } = await dialog.showMessageBox(parentWindow(), {
    noLink: true,
    type: 'warning',
    message: `This computer has changes to ${name} that were never saved into the company file.`,
    detail:
      `They were made${when}. Since then the company file was saved${by}, so the two can't be combined automatically.\n\n` +
      'Ironbooks will keep your unsaved changes as a separate company file next to this one (its name says "unsaved changes"), then open the company file as it is now. Compare the two and re-enter what is missing.',
    buttons: ['Keep My Changes as a Copy and Open', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

/**
 * Open the single company file `filePath` for this launch: lock it (asking what to do when the
 * holder stopped responding), and prepare the working copy. Returns true when it is open; false
 * when not (the reason already shown, or pendingAccessRequest set to ask the holder for access).
 */
async function openSingleFileForLaunch(filePath) {
  if (!fs.existsSync(filePath)) {
    await dialog.showMessageBox({
      noLink: true,
      type: 'warning',
      message: `Ironbooks can't find ${path.basename(filePath)}`,
      detail: `It was at:\n${filePath}\n\nIf it is on a file server or a USB drive, check that it is connected. Otherwise it may have been moved or renamed: use File > Open or Restore Company to find it.`,
      buttons: ['OK'],
    });
    return false;
  }
  const info = { appVersion: app.getVersion(), appUser: lastUserFor(filePath) };
  let res;
  try {
    res = companyLock.acquire(filePath, info);
    if (!res.ok && res.holder && res.holder.stale) {
      if (!(await confirmTakeOver(filePath, res.holder))) return false;
      res = companyLock.takeOver(filePath, res.holder, info);
    }
  } catch (err) {
    dialog.showErrorBox('Ironbooks could not open the company file', openErrorText(err));
    return false;
  }
  if (!res.ok) {
    pendingAccessRequest = { filePath, holder: res.holder };
    return false;
  }
  const lock = res.lock;
  let prep;
  try {
    prep = await companySession.prepareWorkingCopy(filePath, {
      root: workingRoot(),
      appVersion: app.getVersion(),
      // A file a newer Ironbooks saved is refused before its working copy is touched.
      knownSchemaAt: companySession.latestMigrationAt(migrationsDir()),
      onConflict: ({ state, manifest }) => confirmConflict(filePath, state, manifest),
    });
  } catch (err) {
    companyLock.release(lock);
    dialog.showErrorBox(`Ironbooks could not open ${path.basename(filePath)}`, openErrorText(err));
    return false;
  }
  if (prep.plan === 'cancelled') {
    companyLock.release(lock);
    return false;
  }
  openFile = {
    path: filePath,
    lock,
    workDir: prep.workDir,
    dataDir: prep.dataDir,
    plan: prep.plan,
    appUser: info.appUser,
    conflictCopy: prep.conflictCopy || null,
  };
  try {
    companySession.pruneWorkingCopies(workingRoot(), [prep.workDir]);
  } catch {
    /* housekeeping only */
  }
  return true;
}

/** Server-side save status, asked with the internal token (null when unknown). */
async function companySaveStatus() {
  if (!serverUrl || remoteHostOrigin) return null;
  try {
    const res = await fetch(`${serverUrl}/api/company-file/status`, {
      headers: { 'x-bka-internal': internalToken },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Keep the lock fresh and tell the shared drive who is in the file and whether it is saved. */
async function lockHeartbeat() {
  if (!openFile || openFile.lost) return;
  const status = await companySaveStatus();
  const lan = Boolean(hostingState && hostingState.lan);
  const patch = {
    appUser: openFile.appUser || null,
    mode: lan ? 'multi' : 'single',
    host: lan ? { urls: hostingState.urls, fingerprint: hostingState.fingerprint } : null,
    ...(lan ? {} : { joinPolicy: 'ask' }),
    ...(status ? { unsavedSince: status.unsavedSince || null, lastSavedAt: status.lastSavedAt || null } : {}),
  };
  const beat = companyLock.heartbeat(openFile.lock, patch);
  if (beat.lost) {
    openFile.lost = beat.holder || { owner: null };
    showLockLost(beat.holder);
  }
}

async function showLockLost(holder) {
  if (lockLostNoticeShown || !mainWindow) return;
  lockLostNoticeShown = true;
  const name = companyFile.locationName(openFile ? openFile.path : '');
  const { response } = await dialog.showMessageBox(mainWindow, {
    noLink: true,
    type: 'warning',
    message: `${companyLock.describeOwner(holder && holder.owner)} has opened ${name}.`,
    detail:
      'This computer stopped responding for a while (it may have been asleep or off the network), so the company file was opened somewhere else. To protect their work, Ironbooks stopped saving here. ' +
      'Changes you made here since the last save are kept on this computer; when you open the company file again, Ironbooks keeps them as a separate copy so nothing is lost.',
    buttons: ['Close Company', 'Keep This Window Open'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) closeCompanyFlow({ skipConfirm: true });
}

/** Start the heartbeat and the request watch for the open company file. */
function startLockMaintenance() {
  if (!openFile || lockTimer) return;
  lockTimer = setInterval(() => {
    lockHeartbeat().catch((err) => console.warn('[lock] heartbeat failed:', err && err.message));
  }, LOCK_BEAT_MS);
  requestTimer = setInterval(() => {
    serviceAccessRequests().catch((err) => console.warn('[lock] access requests:', err && err.message));
  }, REQUEST_POLL_MS);
  lockHeartbeat().catch(() => {});
}

function stopLockMaintenance() {
  if (lockTimer) clearInterval(lockTimer);
  if (requestTimer) clearInterval(requestTimer);
  lockTimer = null;
  requestTimer = null;
}

const answeredRequests = new Set();
let answeringRequest = false;

/** "Bob on BACK-OFFICE" for a request. */
function describeRequester(req) {
  return companyLock.describeOwner({ appUser: req.appUser, osUser: req.osUser, computer: req.computer });
}

async function serviceAccessRequests() {
  if (!openFile || openFile.lost || answeringRequest || !mainWindow) return;
  const req = companyLock.pendingRequests(openFile.lock).find((r) => !answeredRequests.has(r.id));
  if (!req) return;
  answeredRequests.add(req.id);
  // Already letting people on the network join without asking: answer at once.
  const owner = openFile.lock.owner || {};
  if (hostingState && hostingState.lan && owner.joinPolicy === 'open') {
    companyLock.respond(openFile.lock, req.id, {
      decision: 'multi',
      host: { urls: hostingState.urls, fingerprint: hostingState.fingerprint },
    });
    return;
  }
  answeringRequest = true;
  try {
    await answerAccessRequest(req);
  } finally {
    answeringRequest = false;
  }
}

async function answerAccessRequest(req) {
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.flashFrame(true);
  mainWindow.focus();
  const name = companyFile.locationName(openFile.path);
  // The person asking can give up (Cancel, or the request runs out): the question closes then, so
  // nobody hands the company file over to a computer that is no longer waiting for it.
  const lock = openFile.lock;
  const stillAsking = () => companyLock.pendingRequests(lock).some((r) => r.id === req.id);
  const asking = new AbortController();
  const watch = setInterval(() => {
    if (!openFile || !stillAsking()) asking.abort();
  }, 2000);
  let answer;
  try {
    answer = await dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'question',
      message: `${describeRequester(req)} wants to open ${name}.`,
      detail:
        'Let them in: you both work in the company file at the same time (multi-user mode). They sign in with their own user name and password, and this computer serves the file to them, so keep Ironbooks open here while they work.\n\n' +
        'Hand it over: Ironbooks saves the company file, closes it here and opens it on their computer.',
      buttons: ['Let Them In', 'Hand It Over', 'Not Now'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: 'Let others on this network join without asking until I close the company file',
      signal: asking.signal,
    });
  } finally {
    clearInterval(watch);
  }
  const { response, checkboxChecked } = answer;
  mainWindow.flashFrame(false);
  if (!openFile) return;
  if (asking.signal.aborted || !stillAsking()) return; // they stopped waiting
  if (response === 0) {
    const st = await setHosting(true, { quiet: true, lan: true });
    if (!st.hosting || !st.lan) {
      companyLock.respond(openFile.lock, req.id, { decision: 'deny', message: 'Multi-user mode could not be turned on.' });
      dialog.showErrorBox('Could not turn on multi-user mode', st.error || 'Multi-user access could not be started on this computer.');
      return;
    }
    companyLock.respond(openFile.lock, req.id, { decision: 'multi', host: { urls: st.urls, fingerprint: st.fingerprint } });
    companyLock.heartbeat(openFile.lock, {
      mode: 'multi',
      host: { urls: st.urls, fingerprint: st.fingerprint },
      joinPolicy: checkboxChecked ? 'open' : 'ask',
    });
  } else if (response === 1) {
    companyLock.respond(openFile.lock, req.id, { decision: 'handoff' });
    closeCompanyFlow({ skipConfirm: true });
  } else {
    companyLock.respond(openFile.lock, req.id, { decision: 'deny' });
  }
}

/**
 * Probe a host that serves its own certificate: reachable, and the certificate is the pinned one.
 * Resolves true/false.
 */
function probePinnedHost(origin, pin) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(origin);
    } catch {
      resolve(false);
      return;
    }
    const req = require('node:https').request(
      { host: u.hostname, port: u.port || 443, path: '/login', method: 'GET', rejectUnauthorized: false, timeout: 4000 },
      (res) => {
        const cert = res.socket.getPeerCertificate();
        const fp = cert && cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : '';
        res.resume();
        resolve(fp === pin);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Connect to the computer hosting `filePath` (multi-user mode) and relaunch as its client. */
async function joinHostedFile(filePath, host) {
  const urls = (host && Array.isArray(host.urls) ? host.urls : []).filter((u) => typeof u === 'string');
  const pin = host && typeof host.fingerprint === 'string' ? host.fingerprint.toLowerCase() : '';
  for (const url of urls) {
    const n = hostingCore.normalizeHostAddress(url);
    if (!n.ok || !pin) continue;
    if (await probePinnedHost(n.origin, pin)) {
      saveConfig({ remoteHost: n.origin, remotePin: pin, remoteFile: filePath, lastRemoteHost: n.origin, companyClosed: false });
      rememberRecentCompany(filePath);
      relaunchApp();
      return true;
    }
  }
  await dialog.showMessageBox(parentWindow(), {
    noLink: true,
    type: 'warning',
    message: "Couldn't connect to the computer that has the company file open",
    detail:
      `Tried ${urls.join(', ') || 'no address'}.\n\nBoth computers must be on the same network, and the other computer's firewall must allow Ironbooks (Windows asks the first time multi-user mode is turned on there; choose Allow on private networks).`,
    buttons: ['OK'],
  });
  return false;
}

/**
 * Someone else has `filePath` open: offer to ask them to let this computer in, wait for the
 * answer, and act on it (join in multi-user mode, open after they hand it over, or explain).
 */
async function askForAccessFlow(filePath, holder) {
  const owner = (holder && holder.owner) || {};
  const name = companyFile.locationName(filePath);
  const since = owner.openedAt ? ` since ${timeOfDay(owner.openedAt)}` : '';
  const canJoin = owner.mode === 'multi' && owner.joinPolicy === 'open' && owner.host && Array.isArray(owner.host.urls);
  const { response } = await dialog.showMessageBox(parentWindow(), {
    noLink: true,
    type: 'info',
    message: `${name} is open on another computer.`,
    detail:
      `${companyLock.describeOwner(owner)} has had it open${since}.\n\n` +
      (canJoin
        ? 'They have turned on multi-user mode, so you can join now. You will sign in with your own user name and password.'
        : 'Only one computer works in a company file at a time unless the person using it lets others in. Ask them now: they will see your request on their screen and can let you in or hand the file over.'),
    buttons: canJoin ? ['Join', 'Cancel'] : ['Ask to Come In', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  if (canJoin) {
    await joinHostedFile(filePath, owner.host);
    return;
  }
  let id;
  try {
    id = companyLock.requestAccess(filePath, { appUser: lastUserFor(filePath) });
  } catch (err) {
    // They closed it while the question was on screen: it is free, open it.
    if (err && err.code === 'NOT_IN_USE') {
      openCompany(filePath);
      return;
    }
    dialog.showErrorBox('Could not send the request', openErrorText(err));
    return;
  }
  const who = companyLock.describeOwner(owner);
  const waiting = require('./waitPrompt').showWaiting(mainWindow, {
    title: `Asking ${who}…`,
    message: `Your request to open ${name} is on their screen. This window closes when they answer.`,
  });
  let cancelled = false;
  waiting.cancelled.then(() => {
    cancelled = true;
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 3 * 60_000;
  let outcome = 'timeout';
  let answer = null;
  while (!cancelled && Date.now() < deadline) {
    await sleep(1000);
    answer = companyLock.readResponse(filePath, id);
    if (answer) {
      outcome = answer.decision;
      break;
    }
    if (!companyLock.readHolder(filePath)) {
      outcome = 'free'; // they closed the company file meanwhile
      break;
    }
  }
  if (!cancelled && outcome === 'handoff') {
    waiting.setMessage(`${who} is saving and closing ${name}…`);
    const until = Date.now() + 2 * 60_000;
    while (!cancelled && Date.now() < until && companyLock.readHolder(filePath)) await sleep(1000);
    outcome = companyLock.readHolder(filePath) ? 'stuck' : 'free';
  }
  waiting.close();
  companyLock.cancelRequest(filePath, id);
  if (cancelled) return;
  if (outcome === 'multi') {
    await joinHostedFile(filePath, answer.host);
  } else if (outcome === 'free') {
    openCompany(filePath);
  } else if (outcome === 'deny') {
    await dialog.showMessageBox(parentWindow(), {
      noLink: true,
      type: 'info',
      message: `${who} can't let you in right now.`,
      detail: answer && answer.message ? answer.message : 'Try again later, or ask them to close the company file when they are done.',
      buttons: ['OK'],
    });
  } else {
    await dialog.showMessageBox(parentWindow(), {
      noLink: true,
      type: 'info',
      message: outcome === 'stuck' ? `${name} is still open on ${owner.computer || 'the other computer'}.` : `${who} hasn't answered.`,
      detail: 'They may be away from their desk. Try again in a little while, or ask them directly.',
      buttons: ['OK'],
    });
  }
}

/**
 * Save the open company file into itself and close it (quitting, switching files, Close
 * Company). Resolves true to go on; false when the person chose to keep working because the
 * save failed. With unsaved changes left behind, the lock is kept (it goes stale), so the next
 * person to open the file is told that changes may still be on this computer.
 */
async function closeOpenCompanyFile() {
  if (!openFile) return true;
  stopLockMaintenance();
  if (openFile.lost) {
    // Someone else has it now: nothing of ours to release or save into it. The server still
    // records what is only here as unsaved (the next open here keeps it as a separate copy).
    if (serverUrl && !isDev) {
      await fetch(`${serverUrl}/api/company-file/close`, {
        method: 'POST',
        headers: { 'x-bka-internal': internalToken },
        signal: AbortSignal.timeout(60_000),
      }).catch(() => {});
    }
    return true;
  }
  if (!serverUrl || isDev) {
    companyLock.release(openFile.lock);
    return true;
  }
  for (;;) {
    let data = {};
    let ok = false;
    try {
      const res = await fetch(`${serverUrl}/api/company-file/close`, {
        method: 'POST',
        headers: { 'x-bka-internal': internalToken },
        signal: AbortSignal.timeout(10 * 60_000),
      });
      data = await res.json().catch(() => ({}));
      ok = res.ok && data.ok !== false;
    } catch (err) {
      data = { error: String((err && err.message) || err) };
    }
    if (ok) {
      companyLock.release(openFile.lock);
      return true;
    }
    const { response } = await dialog.showMessageBox(parentWindow(), {
      noLink: true,
      type: 'warning',
      message: `Ironbooks couldn't save ${companyFile.locationName(openFile.path)} to the company file.`,
      detail:
        `${data.error || 'The save did not finish.'}\n\n` +
        'Try Again after checking the connection to the file server. If you close anyway, your changes stay on this computer and are saved the next time you open the company file here.',
      buttons: parentWindow() ? ['Try Again', 'Close Anyway', 'Keep Working'] : ['Try Again', 'Close Anyway'],
      defaultId: 0,
      cancelId: parentWindow() ? 2 : 1,
    });
    if (response === 0) continue;
    if (response === 1) {
      // Leave the lock in place (it goes stale): whoever opens the file next is warned.
      companyLock.heartbeat(openFile.lock, { unsavedSince: new Date().toISOString() });
      return true;
    }
    startLockMaintenance();
    return false;
  }
}

/** The OS asked us to open a .ironbooks file while the app is running. */
async function openCompanyFromOs(filePath) {
  const target = path.resolve(filePath);
  if (openFile && samePath(openFile.path, target)) {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    return;
  }
  if (!startScreenMode && (openFile || remoteHostOrigin || serverUrl)) {
    const { response } = await dialog.showMessageBox(parentWindow(), {
      noLink: true,
      type: 'question',
      message: `Close ${companyFile.locationName(currentCompanyLocation())} and open ${companyFile.locationName(target)}?`,
      detail: 'The company file that is open now is saved first.',
      buttons: ['Open', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  openCompany(target);
}

/** File > Save Copy As… (and converting an older company folder to a single company file). */
async function saveCopyAsFlow({ convert = false } = {}) {
  if (!serverUrl || remoteHostOrigin) return;
  if (isDev) {
    dialog.showErrorBox('Not available in development', 'Run the packaged app to save a copy of the company file.');
    return;
  }
  const name = companyFile.locationName(currentCompanyLocation());
  const res = await dialog.showSaveDialog(mainWindow, {
    title: convert ? 'Save as a Single Company File' : 'Save a Copy of the Company File',
    message: convert
      ? 'Choose where to keep the company file. You can copy it, back it up and share it like any other file.'
      : 'The copy is a separate company file: changes in one do not appear in the other.',
    buttonLabel: 'Save',
    defaultPath: path.join(
      convert ? path.dirname(currentCompanyLocation()) : app.getPath('documents'),
      `${name.replace(/[\\/:*?"<>|]/g, '-')}${convert ? '' : ' (copy)'}.ironbooks`,
    ),
    filters: [{ name: 'Ironbooks Company File', extensions: ['ironbooks'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (res.canceled || !res.filePath) return;
  let target = res.filePath;
  if (!/\.ironbooks$/i.test(target)) target += '.ironbooks';
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    /* new file */
  }
  if (isDir || samePath(target, currentCompanyLocation())) {
    dialog.showErrorBox('Choose another name', 'That name belongs to the company file that is open, or to a folder. Choose a new name for the copy.');
    return;
  }
  try {
    const r = await fetch(`${serverUrl}/api/company-file/save-as?target=${encodeURIComponent(target)}`, {
      method: 'POST',
      headers: { 'x-bka-internal': internalToken, 'content-type': 'application/json' },
      body: JSON.stringify({ companyName: name, convert }),
      signal: AbortSignal.timeout(30 * 60_000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  } catch (err) {
    dialog.showErrorBox('Could not save the company file', openErrorText(err));
    return;
  }
  rememberRecentCompany(target);
  const { response } = await dialog.showMessageBox(mainWindow, {
    noLink: true,
    type: 'info',
    message: convert ? `${name} is now a single company file.` : 'The copy is saved.',
    detail: convert
      ? `Location: ${target}\n\nOpen it now to work in it from here on. The old company folder is left as it was; once you have checked the new file you can keep the folder as an extra backup or delete it.`
      : `Location: ${target}`,
    buttons: convert ? ['Open It Now', 'Later'] : ['OK', 'Show in Folder'],
    defaultId: 0,
    cancelId: convert ? 1 : 0,
  });
  if (convert && response === 0) openCompany(target);
  else if (!convert && response === 1) shell.showItemInFolder(target);
  else buildMenu();
}

/** File > Save Company File Now: write everything to the company file right away. */
async function saveNowFlow() {
  if (!openFile || !serverUrl) return;
  try {
    const r = await fetch(`${serverUrl}/api/company-file/save`, {
      method: 'POST',
      headers: { 'x-bka-internal': internalToken },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.saved === false) throw new Error(data.error || `HTTP ${r.status}`);
    mainWindow?.webContents.send('menu', 'company-file-saved');
  } catch (err) {
    dialog.showErrorBox('Could not save the company file', openErrorText(err));
  }
}

// ---------------------------------------------------------------------------
// Scheduled auto-backups run inside the server process (lib/services/backupSchedule.ts) on the
// company file's own schedule (Back Up & Restore page). The legacy config.json
// backupIntervalHours only seeds that schedule for files that have none yet.
// Not from a sandbox / training file: createWindow does not start the scheduler there, and the
// server skips scheduled backups of such a copy (backupSchedule.ts) whoever starts the timer.
// ---------------------------------------------------------------------------

/** BKA_BACKUP_INTERVAL_HOURS for the server ('' when config.json does not set one). */
function legacyBackupIntervalEnv() {
  const hours = loadConfig().backupIntervalHours;
  return Number.isFinite(hours) ? String(hours) : '';
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startNextServer() {
  if (isDev) return 'http://localhost:3000';

  const port = await findFreePort();
  const serverEntry = path.join(process.resourcesPath, 'app', 'server.js'); // .next/standalone/server.js
  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      BKA_DATA_DIR: activeCompanyDir(),
      // A single company file: the server saves its working copy back to it
      // (lib/services/companyFileSave.ts) and checks this computer still holds its lock.
      BKA_COMPANY_FILE: openFile ? openFile.path : '',
      BKA_COMPANY_STATE: openFile ? path.join(openFile.workDir, companySession.STATE_FILE) : '',
      BKA_COMPANY_LOCK: openFile ? openFile.lock.dir : '',
      BKA_COMPANY_LOCK_TOKEN: openFile ? openFile.lock.token : '',
      // Where the real company file lives (training copies are kept next to it), also in the sandbox.
      BKA_REAL_COMPANY_FILE: openFile ? openFile.path : (loadConfig().sandbox && loadConfig().sandbox.realFile) || '',
      // Scheduled report exports of a single company file go next to the company file, as they do
      // next to a company folder ("Report Exports/<name>") — never into its working copy in this
      // computer's local app data, which nobody looks in and which is cleared when unused.
      BKA_REPORT_EXPORT_DIR:
        process.env.BKA_REPORT_EXPORT_DIR ||
        (openFile ? path.join(path.dirname(openFile.path), 'Report Exports', companyFileFormat.companyFileBaseName(openFile.path)) : ''),
      // Sandbox mode: where "Try it on a copy" puts copies, and the PDF "SANDBOX" stamp flag.
      BKA_SANDBOX_ROOT: sandboxRoot(),
      BKA_SANDBOX: sandboxActive() ? '1' : '',
      BKA_MIGRATIONS_DIR: migrationsDir(),
      // Offline desktop build: the server is bound to 127.0.0.1 only, so it is safe to
      // surface a password-reset token directly in the local HTTP response.
      BKA_OFFLINE: '1',
      BKA_INTERNAL_TOKEN: internalToken,
      // Versioned automatic backups go to the existing backups folder unless the company file
      // chooses another one (Back Up & Restore page).
      BKA_BACKUP_DIR: backupsDir(),
      BKA_BACKUP_INTERVAL_HOURS: legacyBackupIntervalEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      // Local-only: no Next.js telemetry (it is build/CLI-time, but make sure).
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: 'inherit',
  });

  // wait until the port is accepting connections
  await waitForServer(port);
  // The window (and every origin check against serverUrl) uses "localhost", not 127.0.0.1: Next.js
  // spells loopback as "localhost" in the URLs middleware sees (NextURL), so its /unlock and /login
  // redirects point at http://localhost:<port>/. Loaded from 127.0.0.1, that first redirect is a
  // different origin, the navigation guard (security.js) cancels it, and the window stays blank.
  // The server itself still listens on 127.0.0.1 only.
  return `http://localhost:${port}`;
}

function waitForServer(port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error('Next server did not start in time'));
        else setTimeout(tryConnect, 250);
      });
    };
    tryConnect();
  });
}

// New Company (QuickBooks "Create a new company"): ask for a name and location, write a new,
// empty single company file there ("My Company.ironbooks"), and relaunch into it. The relaunch
// opens the Admin setup for the new file (/signup — its user name and password live inside the
// file), then the setup interview (/onboarding). The file can live anywhere: a local folder, a
// USB drive or the office file server.
async function createCompanyFlow() {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'New Company File',
    message: 'Choose a name and location for the new company file',
    buttonLabel: 'Create',
    defaultPath: path.join(app.getPath('documents'), 'My Company.ironbooks'),
    filters: [{ name: 'Ironbooks Company File', extensions: ['ironbooks'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (res.canceled || !res.filePath) return;
  let target = res.filePath;
  if (!/\.ironbooks$/i.test(target)) target += '.ironbooks';
  const name = companyFileFormat.companyFileBaseName(target);
  if (fs.existsSync(target)) {
    // Never replace a company file (or a folder) with an empty one.
    dialog.showErrorBox(
      'That name is taken',
      `${path.basename(target)} already exists in that folder. Choose another name for the new company file, or open the existing one with File > Open or Restore Company.`,
    );
    return;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fileId = crypto.randomUUID();
    const now = new Date().toISOString();
    // An empty company file: the database is created the first time it opens, then saved here.
    await companyFileFormat.writeCompanyFile(target, {
      manifest: {
        formatVersion: companyFileFormat.COMPANY_FILE_FORMAT_VERSION,
        fileId,
        companyName: name,
        saveId: crypto.randomUUID(),
        previousSaveId: null,
        savedAt: now,
        appVersion: app.getVersion(),
      },
      entries: [
        { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name, createdAt: now }, null, 2)) },
        { name: '.file-id', data: Buffer.from(fileId) },
      ],
    });
  } catch (e) {
    dialog.showErrorBox('Could not create the company file', openErrorText(e));
    return;
  }
  // First page of the new file: set up its Admin user, then the setup interview (only once the
  // file open now has closed — never for that file if the person keeps working in it).
  openCompany(target, { startRoute: '/signup' });
}

// Open or Restore Company (QuickBooks File > Open or Restore Company): browse to a company file
// anywhere — this computer, a USB drive, the office file server — and relaunch into it.
async function openCompanyFlow() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Company File',
    message: 'Choose the company file to open',
    filters: [
      { name: 'Ironbooks Company File', extensions: ['ironbooks'] },
      { name: 'Ironbooks Backup or Portable File', extensions: ['bka', 'bkp'] },
    ],
    properties: ['openFile'],
    defaultPath: app.getPath('documents'),
  });
  if (res.canceled || !res.filePaths[0]) return;
  const chosen = res.filePaths[0];
  const lower = chosen.toLowerCase();
  if (lower.endsWith('.bkp')) {
    openPortableFlow(chosen);
    return;
  }
  if (lower.endsWith('.bka')) {
    await restoreBackupChoiceFlow(chosen);
    return;
  }
  if (!companyFileFormat.isCompanyFile(chosen)) {
    dialog.showErrorBox(
      'Not a company file',
      `${path.basename(chosen)} is not an Ironbooks company file (or it is damaged). If you have a backup of it, choose the backup (.bka) instead.`,
    );
    return;
  }
  openCompany(chosen);
}

/**
 * A backup (.bka) chosen in Open or Restore Company: with a company open, restore it into that
 * company (the Back Up and Restore page, with its preview and safety copy) or as a new company
 * file; with none open, as a new company file.
 */
async function restoreBackupChoiceFlow(bkaPath) {
  if (!startScreenMode && serverUrl && !remoteHostOrigin) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'question',
      message: `Restore ${path.basename(bkaPath)}`,
      detail:
        'As a new company file: the backup becomes its own company file and the open one is not touched.\n\n' +
        `Into ${companyFile.locationName(currentCompanyLocation())}: replaces what is in the open company file with the backup (a safety copy is made first).`,
      buttons: ['As a New Company File…', 'Into the Open Company…', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 1) {
      pendingBkaPath = bkaPath;
      deliverPendingBka();
      return;
    }
    if (response !== 0) return;
  }
  await restoreBackupAsNewFileFlow(bkaPath);
}

/** QuickBooks "Restore a backup copy": a .bka becomes a new company file where you choose. */
async function restoreBackupAsNewFileFlow(bkaPath) {
  const base = path.basename(bkaPath).replace(/\.bka$/i, '').replace(/^(auto-)?backup-/i, '');
  const save = await dialog.showSaveDialog(parentWindow(), {
    title: 'Restore Backup as a Company File',
    message: 'Choose a name and location for the restored company file',
    buttonLabel: 'Restore',
    defaultPath: path.join(app.getPath('documents'), `${base}.ironbooks`),
    filters: [{ name: 'Ironbooks Company File', extensions: ['ironbooks'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (save.canceled || !save.filePath) return;
  let target = save.filePath;
  if (!/\.ironbooks$/i.test(target)) target += '.ironbooks';
  if (fs.existsSync(target)) {
    dialog.showErrorBox('That name is taken', `${path.basename(target)} already exists there. Choose a new name for the restored company file.`);
    return;
  }
  const scratchWork = path.join(workingRoot(), `restore-${crypto.randomBytes(6).toString('hex')}`);
  const scratch = companySession.dataDirOf(scratchWork);
  try {
    const info = await companyFileFormat.extractBackupArchive(bkaPath, scratch, {
      knownSchemaAt: companySession.latestMigrationAt(migrationsDir()),
    });
    await companySession.writeWorkingCopyAs(scratchWork, target, {
      companyName: info.companyName || companyFileFormat.companyFileBaseName(target),
      appVersion: app.getVersion(),
    });
    rememberRecentCompany(target);
    const { response } = await dialog.showMessageBox(parentWindow(), {
      noLink: true,
      type: 'info',
      message: 'The backup was restored as a company file.',
      detail:
        `Location: ${target}\n\nIronbooks checks the books when it opens the file. Sign in with the user names and passwords that were in the company file when the backup was made.`,
      buttons: ['Open It Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) openCompany(target);
    else if (startScreenMode) mainWindow?.webContents.reload();
    else buildMenu();
  } catch (err) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* nothing written */
    }
    dialog.showErrorBox('Could not restore the backup', openErrorText(err));
  } finally {
    fs.rm(scratchWork, { recursive: true, force: true }, () => {});
  }
}

// Company files made by older versions are folders. Open one (it keeps working as it is; the File
// menu then offers to save it as a single company file).
async function openCompanyFolderFlow() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Company Folder (Older Format)',
    message: 'Choose the company folder made by an older version of Ironbooks',
    properties: ['openDirectory'],
    defaultPath: app.getPath('documents'),
  });
  if (res.canceled || !res.filePaths[0]) return;
  const dir = res.filePaths[0];
  if (!companyFile.looksLikeCompany(dir)) {
    dialog.showErrorBox('Not a company folder', `${dir} doesn't hold an Ironbooks company.`);
    return;
  }
  companyFile.ensureManifest(dir);
  openCompany(dir);
}

// Open/Restore Portable Company File: pick the .bkp (unless the OS handed us one), pick where
// the NEW company file goes, have the local server restore + verify it (authenticated with the
// per-launch internal token — the main process has no session), then offer to open it.
// Entirely local: the file is read from disk and posted to 127.0.0.1.
async function openPortableFlow(filePath) {
  if (remoteHostOrigin) {
    // Client mode: there is no local server to restore into (and the host's file is not ours).
    dialog.showErrorBox(
      'Not available while connected to a host',
      'Disconnect from the host (File menu) to restore a portable company file on this computer.',
    );
    return;
  }
  if (isDev) {
    // `next dev` was not spawned by us and does not know the internal token — use the in-app
    // upload flow on the Company File page instead.
    navigate('/company-file?restore=portable');
    return;
  }
  if (!filePath) {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Portable Company File',
      filters: [{ name: 'Ironbooks Portable Company File', extensions: ['bkp'] }],
      properties: ['openFile'],
      defaultPath: app.getPath('documents'),
    });
    if (res.canceled || !res.filePaths[0]) return;
    filePath = res.filePaths[0];
  }
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (e) {
    dialog.showErrorBox('Could not read the portable company file', String((e && e.message) || e));
    return;
  }
  const base = path.basename(filePath).replace(/\.bkp$/i, '');
  const save = await dialog.showSaveDialog(mainWindow, {
    title: 'Restore Portable Company File',
    message: 'Choose a name and location for the restored company file',
    buttonLabel: 'Restore',
    defaultPath: path.join(app.getPath('documents'), `${base}.ironbooks`),
    filters: [{ name: 'Ironbooks Company File', extensions: ['ironbooks'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (save.canceled || !save.filePath) return;
  let target = save.filePath;
  if (!/\.ironbooks$/i.test(target)) target += '.ironbooks';
  if (fs.existsSync(target)) {
    dialog.showErrorBox(
      'That name is taken',
      `${path.basename(target)} already exists there. Choose a new name for the restored company file.`,
    );
    return;
  }
  // The server restores (and verifies) into a scratch folder on this computer; that folder is then
  // packed into the single company file the person chose.
  const scratch = path.join(workingRoot(), `restore-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const res = await fetch(`${serverUrl}/api/portable/restore?target=${encodeURIComponent(scratch)}`, {
      method: 'POST',
      headers: { 'x-bka-internal': internalToken, 'content-type': 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      dialog.showErrorBox('Could not open the portable company file', data.error || `HTTP ${res.status}`);
      return;
    }
    const scratchWork = path.dirname(scratch);
    await companySession.writeWorkingCopyAs(scratchWork, target, {
      companyName: data.companyName || base,
      appVersion: app.getVersion(),
      dataDir: scratch,
    });
    rememberRecentCompany(target);
    const choice = await dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'info',
      buttons: ['Open it now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `"${data.companyName}" was restored and verified.`,
      detail:
        `Location: ${target}

Every table, the trial balance, attachments and the transaction log ` +
        'match the original file. Sign in with the user names and passwords from that file.',
    });
    if (choice.response === 0) openCompany(target);
    else buildMenu(); // refresh Recent Companies
  } catch (e) {
    dialog.showErrorBox('Could not open the portable company file', openErrorText(e));
  } finally {
    fs.rm(scratch, { recursive: true, force: true }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Multi-user hosting (QB Enterprise "Host multi-user access") and client mode
// ---------------------------------------------------------------------------

function hostingConfig() {
  const h = loadConfig().hosting;
  return {
    enabled: false,
    port: hostingCore.DEFAULT_HOSTING_PORT,
    tls: true,
    bindAll: false,
    ...(h && typeof h === 'object' ? h : {}),
  };
}

function hostingStatus() {
  return {
    available: !remoteHostOrigin,
    hosting: Boolean(hostingState),
    lan: Boolean(hostingState && hostingState.lan),
    companyFile: Boolean(openFile),
    fingerprint: hostingState ? hostingState.fingerprint || null : null,
    urls: hostingState ? hostingState.urls : [],
    tls: hostingState ? hostingState.tls : false,
    dnsName: hostingState ? hostingState.dnsName : null,
    tailnetIp: hostingState ? hostingState.tailnetIp : null,
    port: hostingState ? hostingState.port : hostingConfig().port,
    bindAll: hostingConfig().bindAll === true,
    error: hostingError,
    remoteHost: remoteHostOrigin,
  };
}

/**
 * QuickBooks: File > Switch to Multi-user Mode. Others on the office network can open this company
 * file from the shared drive at the same time (each signs in with their own user name) until it is
 * closed here or switched back. Also the Multi-user page's button.
 */
async function switchToMultiUserFlow() {
  const st = await setHosting(true, { lan: true, quiet: true });
  if (st.hosting && st.lan && openFile) {
    companyLock.heartbeat(openFile.lock, {
      mode: 'multi',
      host: { urls: st.urls, fingerprint: st.fingerprint },
      joinPolicy: 'open',
    });
    dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'info',
      message: 'Multi-user mode is on',
      detail:
        'People on this network can now open this company file from the shared drive at the same time as you. They sign in with their own user name and password (add users in Company > Users and Roles). Keep Ironbooks open on this computer while they work.\n\n' +
        'If Windows asks whether Ironbooks may use the network, choose Allow on private networks.',
    });
  } else if (st.error) {
    dialog.showErrorBox('Could not turn on multi-user mode', st.error);
  }
  return hostingStatus();
}

/**
 * File > Switch to Single-user Mode: stop letting others in (they have to ask again). Like
 * QuickBooks, it doesn't silently drop people who are working: it asks first while another
 * computer has used the file in the last few minutes.
 */
async function switchToSingleUserFlow() {
  const active = hosting.activePeerCount(hostingState);
  if (active > 0 && mainWindow) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'warning',
      message: 'Others are working in this company file',
      detail:
        `${active === 1 ? 'Another computer has' : `${active} other computers have`} used it in the last few minutes and will be disconnected. ` +
        'Ask them to finish what they are entering first: anything they have not saved is lost.',
      buttons: ['Switch to Single-user Mode', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return hostingStatus();
  }
  return setHosting(false);
}

/**
 * Start/stop sharing this company file. Two ways:
 *  - tailnet (File > Host multi-user access): on this computer's Tailscale address, remembered
 *    for the next launch;
 *  - office network (`lan`: someone on the same network was let into a company file on the shared
 *    drive, or File > Switch to Multi-user Mode): every private address, HTTPS with this
 *    computer's own certificate, which teammates pin (electron/selfSignedCert.js). Only for this
 *    session: closing the company file ends it.
 * Never available in client mode.
 */
async function setHosting(enable, { quiet = false, lan = false } = {}) {
  if (remoteHostOrigin) return hostingStatus();
  if (enable && sandboxActive()) {
    if (!quiet) dialog.showErrorBox('Not available in the sandbox', 'Leave the sandbox to share your company file with other people.');
    return hostingStatus();
  }
  const cfg = hostingConfig();
  // Moving from tailnet-only to office-network hosting: restart the proxy (it also serves the tailnet).
  if (enable && lan && hostingState && !hostingState.lan) {
    await hosting.stopHosting(hostingState);
    hostingState = null;
  }
  if (enable && !hostingState) {
    try {
      const upstreamPort = Number(new URL(serverUrl).port);
      const certDir = path.join(app.getPath('userData'), 'tls');
      const lanCert = lan
        ? selfSignedCert.loadOrCreate(certDir, {
            names: [require('node:os').hostname()],
            ips: hostingCore.lanIPv4s(require('node:os').networkInterfaces()),
          })
        : null;
      hostingState = await hosting.startHosting({
        upstreamPort,
        port: cfg.port,
        tls: cfg.tls !== false,
        bindAll: cfg.bindAll === true,
        certDir,
        lan,
        lanCert,
      });
      hostingError = null;
      if (!lan) saveConfig({ hosting: { ...cfg, enabled: true } });
      if (!quiet && mainWindow) {
        dialog.showMessageBox(mainWindow, {
          noLink: true,
          type: 'info',
          message: 'Multi-user access is on',
          detail:
            `People on your tailnet can now open this company file.\n\nOn their computer: File > Open company on host…, then enter:\n${hostingState.urls.join('\n')}\n\n` +
            'Each person signs in with their own user account (add users under Settings first). ' +
            'Your data stays on this computer.',
        });
      }
    } catch (err) {
      hostingState = null;
      hostingError = String((err && err.message) || err);
      if (!quiet) dialog.showErrorBox('Could not host multi-user access', hostingError);
      else console.error('[hosting] could not start:', hostingError);
    }
  } else if (!enable) {
    if (hostingState) await hosting.stopHosting(hostingState);
    hostingState = null;
    hostingError = null;
    saveConfig({ hosting: { ...cfg, enabled: false } });
  }
  // Tell the shared drive right away (not at the next heartbeat): after switching back to
  // single-user mode, other computers must stop being offered "Join" to a host that is gone.
  if (openFile && !openFile.lost) lockHeartbeat().catch(() => {});
  buildMenu();
  mainWindow?.webContents.send('menu', 'hosting-changed');
  return hostingStatus();
}

/** Probe a host before switching to it (any HTTP answer means a server is there). */
async function probeHost(origin) {
  try {
    const res = await fetch(`${origin}/login`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** File > Open company on host… — ask for the address, verify it, relaunch as a client. */
async function openOnHostFlow() {
  await promptForHost(mainWindow, {
    initial: loadConfig().lastRemoteHost || '',
    onSubmit: async (value) => {
      const n = hostingCore.normalizeHostAddress(value);
      if (!n.ok) return { ok: false, error: n.error };
      if (!(await probeHost(n.origin))) {
        return {
          ok: false,
          error: `Couldn't reach ${n.origin}. Check that the host computer is on, Ironbooks there is hosting multi-user access, and both computers are signed in to Tailscale.`,
        };
      }
      saveConfig({ remoteHost: n.origin, lastRemoteHost: value.trim(), companyClosed: false });
      setImmediate(() => {
        relaunchApp();
      });
      return { ok: true };
    },
  });
}

/** Leave client mode and reopen the local company file. */
function disconnectFromHost() {
  saveConfig({ remoteHost: null, companyClosed: false });
  relaunchApp();
}

/** True when an IPC call comes from the LOCAL app (not a remote host's pages). */
function fromLocalApp(event) {
  if (remoteHostOrigin || !serverUrl) return false;
  try {
    return new URL(event.senderFrame.url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/** True when an IPC call comes from the app's own pages (local server or connected host). */
function fromAppOrigin(event) {
  if (!serverUrl) return false;
  try {
    return new URL(event.senderFrame.url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

function buildMenu() {
  const cfg = loadConfig();
  const current = remoteHostOrigin ? cfg.remoteFile || null : currentCompanyLocation();
  const recents = (Array.isArray(cfg.recentCompanies) ? cfg.recentCompanies : []).filter(
    (d) => typeof d === 'string',
  );
  const isCurrent = (loc) => Boolean(current) && samePath(loc, current);
  const recentItems = recents.map((loc) => ({
    label: isCurrent(loc) ? `${companyFile.locationName(loc)} (open)` : companyFile.locationName(loc),
    sublabel: loc,
    enabled: !isCurrent(loc),
    click: () => openCompany(loc),
  }));
  const folderFormat = !remoteHostOrigin && !openFile && !sandboxActive();
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Company…', accelerator: 'CmdOrCtrl+Shift+N', click: () => { createCompanyFlow(); } },
        { label: 'Open or Restore Company…', accelerator: 'CmdOrCtrl+O', click: () => { openCompanyFlow(); } },
        {
          label: 'Open Previous Company',
          submenu: recentItems.length
            ? recentItems
            : [{ label: 'No recent companies', enabled: false }],
        },
        { label: 'Open Company Folder (Older Format)…', click: () => { openCompanyFolderFlow(); } },
        { label: 'Close Company', click: () => { closeCompanyFlow(); } },
        { type: 'separator' },
        { label: 'Save Company File Now', enabled: Boolean(openFile), click: () => { saveNowFlow(); } },
        { label: 'Save Copy As…', enabled: !remoteHostOrigin && !sandboxActive(), click: () => { saveCopyAsFlow(); } },
        ...(folderFormat
          ? [{ label: 'Save as a Single Company File…', click: () => { saveCopyAsFlow({ convert: true }); } }]
          : []),
        { label: 'Company File Details…', enabled: !remoteHostOrigin, click: () => navigate('/company-file') },
        { type: 'separator' },
        // QuickBooks: File > Switch to Multi-user Mode. Others on the office network can join this
        // company file (each signs in with their own user name) until it is closed here.
        ...(openFile
          ? [
              hostingState && hostingState.lan
                ? { label: 'Switch to Single-user Mode', click: () => { switchToSingleUserFlow(); } }
                : { label: 'Switch to Multi-user Mode', click: () => { switchToMultiUserFlow(); } },
            ]
          : []),
        // Multi-user (QB Enterprise parity): share this file on the tailnet, or open one shared
        // by another computer.
        {
          label: 'Host multi-user access',
          type: 'checkbox',
          checked: Boolean(hostingState),
          enabled: !remoteHostOrigin && !sandboxActive(),
          click: (item) => { setHosting(item.checked); },
        },
        { label: 'Open company on host…', click: () => { openOnHostFlow(); } },
        ...(remoteHostOrigin
          ? [{ label: `Disconnect from ${new URL(remoteHostOrigin).hostname}`, click: () => disconnectFromHost() }]
          : []),
        { label: 'Multi-user status…', click: () => navigate('/multi-user') },
        { type: 'separator' },
        sandboxMenuItem(),
        { type: 'separator' },
        { label: 'Import Bank File…', click: () => mainWindow?.webContents.send('menu', 'import') },
        { label: 'Migrate from QuickBooks…', click: () => navigate('/qb-import') },
        { label: 'Backup Company…', click: () => mainWindow?.webContents.send('menu', 'backup') },
        { type: 'separator' },
        { label: 'Create Portable Company File…', click: () => mainWindow?.webContents.send('menu', 'portable-create') },
        { label: 'Open/Restore Portable Company File…', enabled: !remoteHostOrigin, click: () => { openPortableFlow(); } },
        {
          label: 'Export Shareable Ledger',
          submenu: [
            { label: 'Excel Workbook (.xlsx)…', click: () => mainWindow?.webContents.send('menu', 'shareable-xlsx') },
            { label: 'PDF Summary (.pdf)…', click: () => mainWindow?.webContents.send('menu', 'shareable-pdf') },
          ],
        },
        { label: 'View Transaction Log', click: () => navigate('/transaction-log') },
        // QB File > Send Company File > Accountant's Copy (I1) and File > Create Copy > Period Copy (I7).
        { label: "Accountant's Copy…", click: () => navigate('/accountant/accountants-copy') },
        { label: 'Create Period Copy…', click: () => navigate('/accountant/period-copy') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    // Native menu shortcuts reach the window before the page, so none may take a QuickBooks key:
    // Redo stays on Ctrl+Shift+Z here (fields still redo with Ctrl+Y; Ctrl+Y is QB's Transaction
    // Journal) and Minimize has no shortcut on Windows / Linux (Ctrl+M is QB's Memorize).
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo', accelerator: process.platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    // Reload on F5 (not the default Ctrl+R): Ctrl+R is the QB "Registers" shortcut in the app.
    { label: 'View', submenu: [{ role: 'reload', accelerator: 'F5' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    // QB menus: Company, Customers, Vendors, Employees, Banking, Reports, Lists (electron/menuRoutes.js).
    ...buildSectionMenus(navigate),
    {
      label: 'Window',
      submenu: [
        process.platform === 'darwin' ? { role: 'minimize' } : { label: 'Minimize', click: () => mainWindow?.minimize() },
        ...(process.platform === 'darwin' ? [{ role: 'zoom' }, { role: 'front' }] : []),
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Back', accelerator: 'Alt+Left', click: () => mainWindow?.webContents.navigationHistory?.goBack?.() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => mainWindow?.webContents.navigationHistory?.goForward?.() },
        { type: 'separator' },
        { label: 'Home', click: () => navigate('/dashboard') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Run Setup Interview…', click: () => navigate('/onboarding') },
        sandboxMenuItem(),
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => { checkForUpdates({ manual: true }); } },
        { label: 'Ironbooks on the web', click: () => shell.openExternal('https://github.com/RealDealCPA-VR/Ironbooks') },
        { label: 'About', click: () => dialog.showMessageBox(mainWindow, { noLink: true, message: 'Ironbooks', detail: `Version ${app.getVersion()}\nOpen-source desktop accounting with AI error correction.` }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function navigate(route) {
  mainWindow?.webContents.send('navigate', route);
}

/**
 * A brand-new install: nothing has ever been opened (no company file, no company folder, no
 * recent files, and no company in the old default location). Like QuickBooks, start on the
 * No Company Open window with Create / Open rather than an empty company nobody chose.
 */
function isFirstRun() {
  if (process.env.BKA_DATA_DIR) return false;
  const cfg = loadConfig();
  if (cfg.companyFile || cfg.dataDir || cfg.remoteHost) return false;
  if (Array.isArray(cfg.recentCompanies) && cfg.recentCompanies.length) return false;
  return !companyFile.looksLikeCompany(path.join(companiesRoot(), 'default'));
}

/** The "No Company Open" window (electron/startScreen.js): no server, no company file loaded. */
async function createStartWindow({ firstRun = false } = {}) {
  startScreenMode = true;
  const theme = windowTheme.normalizeTheme(loadConfig().theme);
  nativeTheme.themeSource = theme.mode;
  const state = loadWindowState();
  const usePosition = state && boundsVisible(state);
  mainWindow = new BrowserWindow({
    width: state ? state.width : 1440,
    height: state ? state.height : 900,
    ...(usePosition ? { x: state.x, y: state.y } : {}),
    minWidth: 760,
    minHeight: 560,
    title: 'Ironbooks — No Company Open',
    ...windowTheme.frameOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(__dirname, 'startPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  if (state?.maximized) mainWindow.maximize();
  trackWindowState(mainWindow);
  buildStartMenu();
  const html = startScreen.startScreenHtml({
    dark: nativeTheme.shouldUseDarkColors,
    accent: theme.accent,
    platform: process.platform,
    firstRun,
  });
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/** Menus while no company is open: open or create one, and the basics. */
function buildStartMenu() {
  const recents = (Array.isArray(loadConfig().recentCompanies) ? loadConfig().recentCompanies : []).filter(
    (d) => typeof d === 'string',
  );
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Company…', accelerator: 'CmdOrCtrl+Shift+N', click: () => { createCompanyFlow(); } },
        { label: 'Open or Restore Company…', accelerator: 'CmdOrCtrl+O', click: () => { openCompanyFlow(); } },
        {
          label: 'Open Previous Company',
          submenu: recents.length
            ? recents.map((loc) => ({ label: companyFile.locationName(loc), sublabel: loc, click: () => openCompany(loc) }))
            : [{ label: 'No recent companies', enabled: false }],
        },
        { label: 'Open Company Folder (Older Format)…', click: () => { openCompanyFolderFlow(); } },
        { label: 'Open company on host…', click: () => { openOnHostFlow(); } },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload', accelerator: 'F5' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'Ironbooks on the web', click: () => shell.openExternal('https://github.com/RealDealCPA-VR/Ironbooks') },
        { label: 'About', click: () => dialog.showMessageBox(mainWindow, { noLink: true, message: 'Ironbooks', detail: `Version ${app.getVersion()}\nOpen-source desktop accounting with AI error correction.` }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** After opening: say so when unsaved work from last time was recovered or kept as a copy. */
function noteRecoveredWork() {
  if (!openFile || !mainWindow) return;
  const name = companyFile.locationName(openFile.path);
  if (openFile.plan === 'recover') {
    dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'info',
      message: `Ironbooks recovered your unsaved work in ${name}.`,
      detail:
        'The last time this company file was open on this computer, Ironbooks closed before it could save everything into the file (the computer may have restarted or lost its connection to the file server). Nothing was lost: those changes are here and are being saved into the company file now.',
      buttons: ['OK'],
    });
  } else if (openFile.conflictCopy) {
    const copy = openFile.conflictCopy;
    dialog
      .showMessageBox(mainWindow, {
        noLink: true,
        type: 'info',
        message: 'Your unsaved changes were kept as a separate company file.',
        detail: `${copy}\n\nOpen it later (File > Open or Restore Company) to compare it with ${name} and re-enter anything that is missing.`,
        buttons: ['OK', 'Show in Folder'],
      })
      .then(({ response }) => {
        if (response === 1) shell.showItemInFolder(copy);
      });
  }
}

/**
 * Multi-user client of a company file on the shared drive: accept the host's own certificate, and
 * only that one (its fingerprint came through the company file's lock folder).
 */
function installPinnedCertificate(origin, pin) {
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return;
  }
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    try {
      if (request.hostname === host && selfSignedCert.fingerprintOf(request.certificate.data) === pin) {
        callback(0);
        return;
      }
    } catch {
      /* fall through to the normal checks */
    }
    callback(-3); // Chromium's own verification
  });
}

async function createWindow() {
  // A company file the OS asked us to open (double-click, Open with) wins over the last one used.
  if (pendingCompanyPath) {
    const p = pendingCompanyPath;
    pendingCompanyPath = null;
    saveConfig({ companyFile: p, remoteHost: null, remotePin: null, remoteFile: null, companyClosed: false, sandbox: null });
    rememberRecentCompany(p);
  }
  // File > Close Company: show "No Company Open" instead of loading a file. A scripted launch
  // that names a company folder (BKA_DATA_DIR) always opens it.
  if (loadConfig().companyClosed === true && !process.env.BKA_DATA_DIR) {
    await createStartWindow();
    return;
  }
  if (isFirstRun()) {
    await createStartWindow({ firstRun: true });
    return;
  }
  // Client mode: show the company hosted on another machine instead of starting a local server.
  const remote = (() => {
    const r = loadConfig().remoteHost;
    if (typeof r !== 'string' || !r) return null;
    const n = hostingCore.normalizeHostAddress(r);
    return n.ok ? n : null;
  })();
  remoteHostOrigin = remote ? remote.origin : null;
  const pinCfg = loadConfig().remotePin;
  remotePin = remote && typeof pinCfg === 'string' && pinCfg ? pinCfg : null;
  if (!remoteHostOrigin) {
    reconcileSandboxConfig();
    // A single company file: lock it and prepare its working copy before the server starts on it.
    const cfg = loadConfig();
    if (!process.env.BKA_DATA_DIR && typeof cfg.companyFile === 'string' && cfg.companyFile && !cfg.sandbox) {
      const opened = await openSingleFileForLaunch(cfg.companyFile);
      if (!opened) {
        await createStartWindow();
        if (pendingAccessRequest) {
          const r = pendingAccessRequest;
          pendingAccessRequest = null;
          askForAccessFlow(r.filePath, r.holder).catch((err) => console.error('[lock] access request:', err));
        }
        return;
      }
    }
  }
  if (remotePin) installPinnedCertificate(remoteHostOrigin, remotePin);
  const url = remote ? remote.url : await startNextServer();
  serverUrl = url;

  // Restore the last window size/position; ignore positions that are no longer
  // on any connected display (e.g. an unplugged external monitor).
  const state = loadWindowState();
  const usePosition = state && boundsVisible(state);
  // Appearance (light / dark / auto): the window has no system frame and paints its title bar
  // and background in the theme's colors from the first frame (electron/windowTheme.js).
  const theme = windowTheme.normalizeTheme(loadConfig().theme);
  nativeTheme.themeSource = theme.mode;
  mainWindow = new BrowserWindow({
    width: state ? state.width : 1440,
    height: state ? state.height : 900,
    ...(usePosition ? { x: state.x, y: state.y } : {}),
    minWidth: 1024,
    minHeight: 700,
    title: 'Ironbooks',
    ...windowTheme.frameOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      // Local-only spell check for memos/descriptions (electron/spelling.js: OS checker on
      // Windows/macOS, no dictionary downloads anywhere).
      spellcheck: true,
      navigateOnDragDrop: false,
    },
  });
  if (state?.maximized) mainWindow.maximize();
  trackWindowState(mainWindow);
  // Closing the window with a company file open: keep it on screen while the file is saved into
  // the company file (before-quit), so any question about that save has a window to appear on.
  mainWindow.on('close', (e) => {
    if (openFile && !quittingAfterBackup) {
      e.preventDefault();
      app.quit();
    }
  });
  // The page reads its theme from a cookie; hand it the saved one so the first paint matches
  // the frame (the local server's port, and so its origin, changes every launch).
  try {
    await session.defaultSession.cookies.set(windowTheme.themeCookie(url, theme));
  } catch (err) {
    console.error('[theme] could not set the theme cookie:', err?.message || err);
  }
  spelling.attachContextMenu(mainWindow, Menu);

  if (remoteHostOrigin) {
    buildMenu();
    // Like QuickBooks, joining a company file asks for your user name and password every time.
    for (const name of ['bka_session', 'bka_unlock']) {
      await session.defaultSession.cookies.remove(url, name).catch(() => {});
    }
    try {
      await mainWindow.loadURL(url);
    } catch (err) {
      const remoteFile = loadConfig().remoteFile;
      const { response } = await dialog.showMessageBox(mainWindow, {
        noLink: true,
        type: 'warning',
        message: remoteFile
          ? `Can't reach the computer that has ${companyFile.locationName(remoteFile)} open`
          : `Can't reach the host at ${remoteHostOrigin}`,
        detail:
          (remoteFile
            ? 'It may have closed the company file or left multi-user mode. Open the company file again to ask for access.\n\n'
            : 'Make sure the host computer is on, Ironbooks there has "Host multi-user access" turned on, and both computers are signed in to Tailscale.\n\n') +
          String((err && err.message) || err),
        buttons: ['Try Again', 'Open My Local Company Instead', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) {
        relaunchApp();
      } else if (response === 1) disconnectFromHost();
      else app.quit();
    }
    return; // no local server: skip local-only chores (backups, recurring, hosting, updates)
  }

  // A just-created company file opens on Create Account -> setup interview (one-shot).
  const startRoute = loadConfig().startRoute;
  if (typeof startRoute === 'string' && startRoute.startsWith('/')) saveConfig({ startRoute: null });
  try {
    await mainWindow.loadURL(typeof startRoute === 'string' && startRoute.startsWith('/') ? url + startRoute : url);
  } catch (err) {
    // ERR_ABORTED only means a newer navigation (a redirect) replaced this one. Anything else
    // would leave a blank window with no explanation, so say what happened.
    if (!/ERR_ABORTED/.test(String(err?.message || err))) {
      console.error('[startup] could not open the app page:', err?.message || err);
      dialog.showErrorBox(
        'Ironbooks could not open',
        `The app started but its page did not load.\n\n${String(err?.message || err)}\n\nClose Ironbooks and open it again. If this keeps happening, report it with this message.`,
      );
    }
  }
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  // Ensure the active file is self-describing (manifest) and stamp its last-opened time.
  const activeDir = activeCompanyDir();
  // A single company file's working folder is just "data": name it after the company file.
  if (openFile && !companyFile.readManifest(activeDir)) {
    companyFile.writeManifest(activeDir, {
      name: companyFileFormat.companyFileBaseName(openFile.path),
      createdAt: new Date().toISOString(),
    });
  }
  companyFile.ensureManifest(activeDir);
  companyFile.writeManifest(activeDir, { lastOpenedAt: new Date().toISOString() });
  const inSandbox = Boolean(sandboxActive());
  // A sandbox copy is not a company file to come back to (a kept training file is added to
  // Recent Companies when it is kept).
  if (!inSandbox) rememberRecentCompany(currentCompanyLocation());
  buildMenu();
  if (openFile) {
    startLockMaintenance();
    noteRecoveredWork();
  }
  runDueRecurring(url);
  if (!inSandbox) {
    // Sandbox mode: no auto-backups (the server-side backup scheduler is started from
    // scheduleBackgroundJobs), scheduled reports or multi-user hosting from a practice copy.
    scheduleBackgroundJobs(url);
    if (hostingConfig().enabled) setHosting(true, { quiet: true });
  }

  // Deliver a double-clicked .bka after the renderer has had a moment to mount the
  // DesktopBridge listener (loadURL resolves at load, React hydrates just after).
  if (pendingBkaPath) setTimeout(deliverPendingBka, 1200);
  if (pendingBkpPath) setTimeout(deliverPendingBkp, 1200);
}

// Generate any due recurring/memorized transactions on launch (best-effort, but loudly logged).
// Authenticates with the per-launch internal token (see app/api/recurring/run/route.ts) since
// the main process has no session cookie.
function runDueRecurring(url) {
  try {
    fetch(`${url}/api/recurring/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bka-internal': internalToken },
      body: '{}',
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`[recurring] launch-time run failed: HTTP ${res.status} ${body}`);
        } else {
          const result = await res.json().catch(() => null);
          const n = result?.generated?.length ?? 0;
          if (n > 0) console.log(`[recurring] launch-time run generated ${n} document(s)`);
        }
      })
      .catch((err) => console.error('[recurring] launch-time run failed:', err));
  } catch (err) {
    console.error('[recurring] launch-time run unavailable:', err);
  }
}

// ---------------------------------------------------------------------------
// Background jobs while the app is open (local server only):
//  - memorized transactions due (hourly; the launch-time run is above)
//  - scheduled reports (H5): the reports package's POST /api/reports/schedules/run-due, every
//    15 minutes. Until that endpoint exists the server answers 404; we stop asking after that.
// Both authenticate with the per-launch internal token, like the launch-time recurring run.
// ---------------------------------------------------------------------------

const SCHEDULED_REPORTS_EVERY_MS = 15 * 60 * 1000;
const RECURRING_EVERY_MS = 60 * 60 * 1000;
let scheduledReportsTimer = null;
let recurringTimer = null;

function runDueScheduledReports(url) {
  return fetch(`${url}/api/reports/schedules/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bka-internal': internalToken },
    body: '{}',
  })
    .then(async (res) => {
      if (res.status === 404) {
        // Scheduled reports are not available in this build: stop polling quietly.
        if (scheduledReportsTimer) clearInterval(scheduledReportsTimer);
        scheduledReportsTimer = null;
        return;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[scheduled-reports] run failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
    })
    .catch((err) => console.error('[scheduled-reports] run failed:', err?.message || err));
}

// Start the server's scheduled-backup timer at launch, whoever signs in (the backup status route
// also starts it, but only after a page load). Internal token, like the recurring run.
function startBackupScheduler(url) {
  fetch(`${url}/api/dashboard/auto-backup?start=1`, {
    method: 'POST',
    headers: { 'x-bka-internal': internalToken },
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[backup] could not start the backup schedule: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
    })
    .catch((err) => console.error('[backup] could not start the backup schedule:', err?.message || err));
}

function scheduleBackgroundJobs(url) {
  if (scheduledReportsTimer || recurringTimer) return;
  if (!remoteHostOrigin) startBackupScheduler(url);
  scheduledReportsTimer = setInterval(() => runDueScheduledReports(url), SCHEDULED_REPORTS_EVERY_MS);
  recurringTimer = setInterval(() => runDueRecurring(url), RECURRING_EVERY_MS);
  // First scheduled-reports check shortly after launch (the server is warm by then).
  setTimeout(() => runDueScheduledReports(url), 60 * 1000);
}

app.on('before-quit', () => {
  if (scheduledReportsTimer) clearInterval(scheduledReportsTimer);
  if (recurringTimer) clearInterval(recurringTimer);
});

// --- Window frame: theme colors and the in-page menu bar (components/WindowTitleBar.tsx) ---

/** Paint the title bar, window controls and background for the current light/dark state. */
function applyWindowTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow.setBackgroundColor(windowTheme.WINDOW_COLORS[dark ? 'dark' : 'light'].background);
  if (process.platform !== 'darwin') {
    try {
      mainWindow.setTitleBarOverlay(windowTheme.overlayFor(dark));
    } catch {
      /* window without an overlay */
    }
  }
}
// "Auto" follows the computer: repaint when Windows / macOS switches between light and dark.
nativeTheme.on('updated', applyWindowTheme);

// Asked once by the preload, synchronously, so the page knows before it paints whether it must
// draw its own title bar. Only the main window is frameless.
ipcMain.on('chrome:info', (e) => {
  e.returnValue = {
    frameless: Boolean(mainWindow && e.sender === mainWindow.webContents),
    platform: process.platform,
  };
});

ipcMain.handle('chrome:theme', (e, raw) => {
  if (!fromAppOrigin(e)) return false;
  const theme = windowTheme.normalizeTheme(raw);
  saveConfig({ theme });
  nativeTheme.themeSource = theme.mode; // fires 'updated' when the light/dark state changes
  applyWindowTheme();
  return true;
});

// The application menu is not shown as a bar (the window has no frame); the page lists its
// top-level labels in the title bar and opens each one as a native popup.
ipcMain.handle('chrome:menus', (e) => (fromAppOrigin(e) ? windowTheme.menuLabels(Menu.getApplicationMenu()) : []));
ipcMain.handle('chrome:popupMenu', (e, index, x, y) => {
  if (!fromAppOrigin(e) || !mainWindow) return false;
  const item = Menu.getApplicationMenu()?.items?.[Number(index)];
  if (!item?.submenu || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const zoom = mainWindow.webContents.getZoomFactor() || 1; // page pixels -> window pixels
  return new Promise((resolve) => {
    item.submenu.popup({
      window: mainWindow,
      x: Math.round(x * zoom),
      y: Math.round(y * zoom),
      callback: () => resolve(true),
    });
  });
});

// My Preferences > Spelling (sent by the renderer's DesktopBridge).
ipcMain.handle('spellcheck:setEnabled', (e, enabled) => {
  if (!fromAppOrigin(e)) return false;
  spelling.configureSpellChecker(session.defaultSession, process.platform, Boolean(enabled));
  return true;
});

// --- IPC for native dialogs the renderer needs ---
ipcMain.handle('dialog:openFile', async (e, filters) => {
  if (!fromAppOrigin(e)) return null;
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: filters || [] });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  return { filePath, content: fs.readFileSync(filePath, 'utf8') };
});

ipcMain.handle('dialog:saveFile', async (e, { defaultName, content }) => {
  if (!fromAppOrigin(e)) return null;
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, content);
  return res.filePath;
});

// Binary save (portable company file, shareable ledger): native Save dialog with a file-type
// filter; the renderer fetched the bytes from the local server with its session.
ipcMain.handle('file:saveBytes', async (e, opts) => {
  if (!fromAppOrigin(e)) return null;
  const { defaultName, filters, data } = opts || {};
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), path.basename(String(defaultName || 'export'))),
    filters: Array.isArray(filters) ? filters : [],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(new Uint8Array(data)));
  return res.filePath;
});

ipcMain.handle('portable:open', (e) => { if (fromLocalApp(e)) openPortableFlow(); return true; });

ipcMain.handle('app:dataDir', (e) => (fromLocalApp(e) ? currentCompanyLocation() : null));

// ---------------------------------------------------------------------------
// Company-file management (drives the in-app "Company File" screen)
// ---------------------------------------------------------------------------
// Local company-file management is only offered to the local app's own pages — never to a
// remote host's pages when this app is connected as a multi-user client.
ipcMain.handle('company:current', (e) => {
  if (!fromLocalApp(e)) return null;
  const location = currentCompanyLocation();
  const m = companyFile.readManifest(activeCompanyDir()) || {};
  return {
    dir: location,
    name: companyFile.locationName(location),
    passwordProtected: Boolean(m.passwordProtected),
    // A single company file (the current format) or a company folder (older format).
    singleFile: Boolean(openFile),
    multiUser: Boolean(hostingState && hostingState.lan),
  };
});
ipcMain.handle('company:recent', (e) => {
  if (!fromLocalApp(e)) return [];
  const cfg = loadConfig();
  const current = currentCompanyLocation();
  return (Array.isArray(cfg.recentCompanies) ? cfg.recentCompanies : [])
    .filter((d) => typeof d === 'string')
    .map((loc) => ({ dir: loc, name: companyFile.locationName(loc), current: samePath(loc, current) }));
});
// The signed-in user (the lock shows other workstations who has the file open, and the sign-in
// screen pre-fills this name next time, like QuickBooks).
ipcMain.handle('company:signedIn', (e, name) => {
  if (!fromAppOrigin(e) || typeof name !== 'string' || !name.trim()) return false;
  const clean = name.trim().slice(0, 120);
  const location = remoteHostOrigin ? loadConfig().remoteFile : currentCompanyLocation();
  if (location) rememberLastUser(location, clean);
  if (openFile) {
    openFile.appUser = clean;
    lockHeartbeat().catch(() => {});
  }
  return true;
});
ipcMain.handle('company:lastUser', (e) => {
  if (!fromAppOrigin(e)) return null;
  const location = remoteHostOrigin ? loadConfig().remoteFile : currentCompanyLocation();
  return location ? lastUserFor(location) : null;
});
ipcMain.handle('company:saveNow', (e) => {
  if (fromLocalApp(e)) saveNowFlow();
  return true;
});
ipcMain.handle('company:saveCopyAs', (e, opts) => {
  if (fromLocalApp(e)) saveCopyAsFlow({ convert: Boolean(opts && opts.convert) });
  return true;
});
ipcMain.handle('company:new', (e) => { if (fromLocalApp(e)) createCompanyFlow(); return true; });
ipcMain.handle('company:open', (e) => { if (fromLocalApp(e)) openCompanyFlow(); return true; });
ipcMain.handle('company:switch', (e, dir) => {
  // Only to a company file on the recent list (the page shows that list).
  if (fromLocalApp(e) && typeof dir === 'string' && dir && recentCompanyDirs().some((d) => samePath(d, dir))) openCompany(dir);
  return true;
});
// Show the open company file in Explorer / Finder, and File > Close Company from the page.
ipcMain.handle('company:reveal', (e) => {
  if (!fromLocalApp(e)) return false;
  shell.showItemInFolder(currentCompanyLocation());
  return true;
});
// The open file's company name, so Recent Companies and "No Company Open" can show it.
ipcMain.handle('company:displayName', (e, name) => {
  if (!fromLocalApp(e) || typeof name !== 'string' || !name.trim()) return false;
  companyFile.writeManifest(activeCompanyDir(), { displayName: name.trim().slice(0, 200) });
  return true;
});
ipcMain.handle('company:close', (e) => {
  if (!fromAppOrigin(e)) return false;
  closeCompanyFlow();
  return true;
});

// "No Company Open" screen: only from that window, and only for folders on the recent list.
function fromStartScreen(e) {
  return Boolean(startScreenMode && mainWindow && e.sender === mainWindow.webContents);
}
function recentCompanyDirs() {
  const r = loadConfig().recentCompanies;
  return Array.isArray(r) ? r.filter((d) => typeof d === 'string' && d) : [];
}
ipcMain.handle('start:list', (e) => {
  if (!fromStartScreen(e)) return [];
  return startScreen.recentEntries(recentCompanyDirs(), {
    exists: (loc) => companyFile.locationExists(loc),
    readManifest: (loc) => companyFile.locationDetails(loc),
    companyName: (loc) => companyFile.locationName(loc),
    inUseBy: (loc) => {
      if (!companyFile.isSingleFile(loc)) return null;
      const h = companyLock.readHolder(loc);
      return h && !h.stale ? companyLock.describeOwner(h.owner) : null;
    },
  });
});
ipcMain.handle('start:open', (e, dir) => {
  if (!fromStartScreen(e) || !recentCompanyDirs().includes(dir) || !fs.existsSync(dir)) return false;
  openCompany(dir);
  return true;
});
ipcMain.handle('start:remove', (e, dir) => {
  if (!fromStartScreen(e)) return false;
  saveConfig({ recentCompanies: recentCompanyDirs().filter((d) => d !== dir) });
  buildStartMenu();
  return true;
});
ipcMain.handle('start:reveal', (e, dir) => {
  if (!fromStartScreen(e) || !recentCompanyDirs().includes(dir) || !fs.existsSync(dir)) return false;
  shell.showItemInFolder(dir);
  return true;
});
ipcMain.handle('start:new', (e) => {
  if (fromStartScreen(e)) createCompanyFlow();
  return true;
});
ipcMain.handle('start:browse', (e) => {
  if (fromStartScreen(e)) openCompanyFlow();
  return true;
});

// Keep the manifest's display hint in sync after the file password is toggled in the UI, so
// Open/Recent can show a lock icon without opening the database.
ipcMain.handle('company:setProtected', (e, val) => {
  if (!fromLocalApp(e)) return false;
  companyFile.writeManifest(activeCompanyDir(), { passwordProtected: Boolean(val) });
  return true;
});

// ---------------------------------------------------------------------------
// Multi-user + network policy bridge (Multi-user and Privacy & Network pages)
// ---------------------------------------------------------------------------
ipcMain.handle('hosting:status', (e) => (fromAppOrigin(e) ? hostingStatus() : null));
ipcMain.handle('hosting:setEnabled', (e, enable, mode) => {
  if (!fromLocalApp(e)) return hostingStatus();
  if (enable && mode === 'office') return openFile ? switchToMultiUserFlow() : hostingStatus();
  return setHosting(Boolean(enable));
});
ipcMain.handle('hosting:openConnect', (e) => {
  if (fromAppOrigin(e)) openOnHostFlow();
  return true;
});
ipcMain.handle('hosting:disconnect', (e) => {
  if (fromAppOrigin(e) && remoteHostOrigin) disconnectFromHost();
  return true;
});
// After the Privacy & Network settings change, re-read what the window may load.

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // A second launch with a .bka argument (e.g. double-clicking a backup while the
  // app is running) is forwarded here by the single-instance lock.
  const bka = extractBkaPath(argv || []);
  if (bka) {
    pendingBkaPath = bka;
    deliverPendingBka();
  }
  const bkp = extractBkpPath(argv || []);
  if (bkp) {
    pendingBkpPath = bkp;
    deliverPendingBkp();
  }
  // Double-clicking a company file while Ironbooks is running.
  const company = extractCompanyPath(argv || []);
  if (company) openCompanyFromOs(company).catch((err) => console.error('[open] company file:', err));
});

// ---- App updates (electron-updater + the GitHub Releases feed in package.json build.publish) ----
// Checks run at startup, every few hours, and from Help > Check for Updates. When a newer release
// is published the renderer shows an "Update available" banner (components/DesktopBridge.tsx);
// nothing is downloaded until the user clicks Download & install. Once downloaded they can restart
// now, or it installs the next time the app quits.
let autoUpdater = null;
/** { state: 'idle'|'checking'|'none'|'available'|'downloading'|'ready'|'error', version?, percent?, message? } */
let updateState = { state: 'idle' };
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function setUpdateState(next) {
  updateState = next;
  mainWindow?.webContents.send('update', next);
}

/** The release feed electron-updater will contact (package.json build.publish). */
function updateFeedUrl() {
  try {
    const pub = require('../package.json').build.publish[0];
    if (pub.provider === 'github') return `https://github.com/${pub.owner}/${pub.repo}/releases`;
    if (pub.url) return pub.url;
  } catch {
    /* no publish config */
  }
  return 'https://github.com/';
}

/**
 * Local-only: update checks contact the release feed on the internet (app version + platform
 * only), so they ask the company's Privacy & Network policy first. They are on by default and
 * blocked in offline mode or when the company turns them off. Never as a multi-user client
 * (the host computer updates itself). Resolves { allowed, reason }.
 */
async function updatesAllowed() {
  if (remoteHostOrigin) {
    return { allowed: false, reason: 'This computer is connected to a host; update the app on the host computer.' };
  }
  if (startScreenMode) {
    return { allowed: false, reason: "No company file is open. Update checks follow the open company file's Privacy & Network settings." };
  }
  if (!serverUrl) return { allowed: false, reason: 'The app has not finished starting.' };
  try {
    const q = new URLSearchParams({ purpose: 'updates', url: updateFeedUrl() });
    const res = await fetch(`${serverUrl}/api/network-policy/check?${q}`, {
      headers: { 'x-bka-internal': internalToken },
      signal: AbortSignal.timeout(5000),
    });
    const d = res.ok ? await res.json() : null;
    if (d && d.allowed === true) return { allowed: true, reason: '' };
    return { allowed: false, reason: (d && d.reason) || 'Update checks are not allowed right now.' };
  } catch {
    return { allowed: false, reason: 'Could not read the Privacy & Network settings.' };
  }
}

function getUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return null; // electron-updater not bundled
  }
  autoUpdater.autoDownload = false; // ask first
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    // A periodic re-check must not knock a download in progress (or a staged update) back.
    if (['downloading', 'ready'].includes(updateState.state) && updateState.version === info.version) return;
    setUpdateState({ state: 'available', version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    setUpdateState({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    // Check failures (e.g. no internet) stay quiet; a failed download is reported.
    if (updateState.state === 'downloading') {
      setUpdateState({ state: 'error', version: updateState.version, message: String(err?.message || err) });
    }
  });
  return autoUpdater;
}

function updateDialog(message, detail) {
  if (mainWindow) dialog.showMessageBox(mainWindow, { noLink: true, type: 'info', message, detail, buttons: ['OK'] });
}

/** Check the release feed. `manual` (Help menu) reports every outcome in a dialog. */
async function checkForUpdates({ manual = false } = {}) {
  if (isDev) {
    if (manual) updateDialog('Update checks are off in development builds.');
    return;
  }
  // Sandbox mode: no update prompts while practising on a copy (checked again after leaving).
  if (sandboxActive()) {
    if (manual) updateDialog('Update checks are paused in the sandbox.', 'Leave the sandbox to check for updates.');
    return;
  }
  // Already found / downloading / staged: just show the banner again.
  if (['available', 'downloading', 'ready'].includes(updateState.state)) {
    if (manual) mainWindow?.webContents.send('update', { ...updateState, reshow: true });
    return;
  }
  const policy = await updatesAllowed();
  if (!policy.allowed) {
    console.log(`[updates] skipped: ${policy.reason}`);
    if (manual) updateDialog('Update checks are turned off.', policy.reason);
    return;
  }
  const updater = getUpdater();
  if (!updater) {
    if (manual) updateDialog('Automatic updates are not available in this build.');
    return;
  }
  try {
    const result = await updater.checkForUpdates();
    // 'update-available' has already moved the state on when there is something new.
    if (manual && !result?.isUpdateAvailable) {
      updateDialog('You have the latest version.', `Ironbooks ${app.getVersion()} is up to date.`);
    }
  } catch (err) {
    console.log('[updates] check failed:', err?.message || err);
    if (manual) updateDialog('Could not check for updates.', String(err?.message || err));
  }
}

ipcMain.handle('app:updateStatus', () => updateState);
ipcMain.handle('app:checkForUpdates', () => checkForUpdates({ manual: true }));

// Renderer "Download & install" -> download the update that was found.
ipcMain.handle('app:downloadUpdate', () => {
  if (!autoUpdater || !['available', 'error'].includes(updateState.state)) return false;
  setUpdateState({ state: 'downloading', version: updateState.version, percent: 0 });
  autoUpdater.downloadUpdate().catch((err) => {
    if (updateState.state === 'downloading') {
      setUpdateState({ state: 'error', version: updateState.version, message: String(err?.message || err) });
    }
  });
  return true;
});

// Renderer "Restart & install now" -> apply the downloaded update immediately.
// Returns false if no update is staged (the UI then tells the user to restart manually).
ipcMain.handle('app:quitAndInstall', () => {
  if (!autoUpdater || updateState.state !== 'ready') return false;
  if (sandboxActive()) return false; // sandbox mode: no installs from a practice copy
  // Defer so the IPC reply is sent before the app tears down; relaunch after install.
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch {
      /* nothing staged / updater unavailable — ignore */
    }
  });
  return true;
});

app.whenReady().then(async () => {
  // Before any window exists: navigation/new-window guards, renderer request filter, no
  // permission prompts, no spellcheck downloads (electron/security.js).
  security.install({
    getAppOrigin: () => serverUrl,
    isDev,
  });
  try {
    await createWindow();
  } catch (err) {
    // Without this the app kept running with no window (and the company file locked): starting
    // it again only focused the missing window. Say what happened and quit (before-quit releases
    // the company file).
    console.error('[startup] could not start:', err);
    dialog.showErrorBox(
      'Ironbooks could not start',
      `${String((err && err.message) || err)}\n\nClose any other Ironbooks windows and start it again. If this keeps happening, restart the computer.`,
    );
    app.quit();
    return;
  }
  checkForUpdates();
  setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS).unref?.();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', (event) => {
  // First pass: hold the quit open long enough to snapshot the company file, save a single
  // company file into itself and release its lock, then re-enter quit with the flag set. Data
  // safety: a rotating local auto-backup means a bad restore / disk hiccup never costs more than
  // one session, and the company file on the server is complete when the app is gone.
  if (!quittingAfterBackup) {
    quittingAfterBackup = true;
    event.preventDefault();
    runAutoBackup()
      .catch((err) => console.error('[auto-backup] skipped:', err?.message || err))
      .then(() => closeOpenCompanyFile())
      .catch((err) => {
        console.error('[company-file] closing failed:', err?.message || err);
        return true;
      })
      .then((goOn) => {
        if (goOn === false) {
          // The person chose to keep working (the save failed): don't quit, don't relaunch, and
          // keep the config pointing at the file they are still working in.
          quittingAfterBackup = false;
          relaunchAfterQuit = false;
          configAfterClose = null;
          return;
        }
        if (configAfterClose) {
          saveConfig(configAfterClose);
          configAfterClose = null;
        }
        if (relaunchAfterQuit) app.relaunch();
        app.quit();
      });
    return;
  }
  // Second pass: backup done (or skipped) — stop hosting and shut the server down for real.
  if (hostingState) hosting.stopHosting(hostingState).catch(() => {});
  if (serverProcess) serverProcess.kill();
});
