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
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const companyFile = require('./companyFile');
const hostingCore = require('./hostingCore');
const hosting = require('./hosting');
const security = require('./security');
const { promptForHost } = require('./connectPrompt');
const { pruneLegacyAutoBackups } = require('./legacyBackups');

const isDev = !app.isPackaged;
let mainWindow = null;
let serverProcess = null;
let serverUrl = null;
/** Set once the quit-time auto-backup has run (or been skipped) so app.quit() proceeds. */
let quittingAfterBackup = false;
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
// The path is delivered to the renderer as /backup?file=<path> so the backup/restore page
// can prefill the restore flow.
// ---------------------------------------------------------------------------

function extractBkaPath(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg === 'string' && !arg.startsWith('-') && arg.toLowerCase().endsWith('.bka')) {
      return arg;
    }
  }
  return null;
}

function deliverPendingBka() {
  if (!pendingBkaPath || !mainWindow) return;
  const filePath = pendingBkaPath;
  pendingBkaPath = null;
  navigate(`/backup?file=${encodeURIComponent(filePath)}`);
}

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

app.on('open-file', (event, filePath) => {
  const lower = (filePath || '').toLowerCase();
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
//   dataDir              active company data directory (multi-company support);
//                        the BKA_DATA_DIR env var overrides it for one launch
//   recentCompanies      most-recently-opened company directories (File menu)
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
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
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

/** Persist `dir` as the active company folder and relaunch into it. */
function openCompanyDir(dir) {
  saveConfig({ dataDir: dir, remoteHost: null }); // opening a local file leaves any remote host
  rememberRecentCompany(dir);
  app.relaunch();
  app.quit(); // before-quit still snapshots the current company on the way out
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
  const dir =
    process.env.BKA_DATA_DIR ||
    (typeof cfg.dataDir === 'string' && cfg.dataDir) ||
    path.join(companiesRoot(), 'default');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
    saveConfig({ dataDir: sb.realDir, sandbox: null });
  }
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
  saveConfig({ dataDir: dir, sandbox: { dir, realDir: marker.realDataDir } });
  setImmediate(() => {
    app.relaunch();
    app.quit();
  });
  return true;
});

ipcMain.handle('sandbox:left', (e, opts) => {
  if (!fromLocalApp(e)) return false;
  const sb = loadConfig().sandbox;
  if (!sb || typeof sb.realDir !== 'string') return false;
  saveConfig({ dataDir: sb.realDir, sandbox: null });
  const trainingDir = opts && typeof opts.trainingDir === 'string' ? opts.trainingDir : null;
  const kept = trainingDir ? companyFile.readSandboxMarker(trainingDir) : null;
  // A kept training file shows up under File > Recent Companies (it opens like any other file).
  if (kept && kept.kind === 'training') rememberRecentCompany(trainingDir);
  rememberRecentCompany(sb.realDir);
  setImmediate(() => {
    app.relaunch();
    app.quit();
  });
  return true;
});

/** File / Help menu: one click "Try it on a copy" (or "Leave the sandbox" while in one). */
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
      // Sandbox mode: where "Try it on a copy" puts copies, and the PDF "SANDBOX" stamp flag.
      BKA_SANDBOX_ROOT: sandboxRoot(),
      BKA_SANDBOX: sandboxActive() ? '1' : '',
      BKA_MIGRATIONS_DIR: path.join(process.resourcesPath, 'app', 'drizzle'),
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

// New Company: always ask for a name + location (a Save dialog), create the folder, seed a
// manifest, and relaunch into the fresh (empty) file. The relaunch opens Create Account
// (startRoute below), which then runs the setup interview (/onboarding) for the new company. The "file" is a self-contained folder the user can place anywhere (incl. a server
// or network drive).
async function createCompanyFlow() {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'New Company File',
    message: 'Choose a name and location for the new company file',
    buttonLabel: 'Create',
    defaultPath: path.join(app.getPath('documents'), 'My Company.ironbooks'),
    filters: [{ name: 'Ironbooks Company', extensions: ['ironbooks', 'bookkeeper'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (res.canceled || !res.filePath) return;
  const target = res.filePath;
  const name = path.basename(target).replace(/\.(ironbooks|bookkeeper)$/i, '');
  try {
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      dialog.showErrorBox(
        'Folder not empty',
        'That location already contains files. Choose a new name or an empty folder for the company file.',
      );
      return;
    }
    fs.mkdirSync(target, { recursive: true });
  } catch (e) {
    dialog.showErrorBox('Could not create company file', String((e && e.message) || e));
    return;
  }
  companyFile.writeManifest(target, { name, createdAt: new Date().toISOString() });
  // First page of the new file: create its first user, then the setup interview.
  saveConfig({ startRoute: '/signup' });
  openCompanyDir(target);
}

// Open Company: browse to an existing company-file folder anywhere and relaunch into it.
async function openCompanyFlow() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Company File',
    message: 'Choose a company file folder to open',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('documents'),
  });
  if (res.canceled || !res.filePaths[0]) return;
  const dir = res.filePaths[0];
  companyFile.ensureManifest(dir);
  openCompanyDir(dir);
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
    filters: [{ name: 'Ironbooks Company', extensions: ['ironbooks', 'bookkeeper'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (save.canceled || !save.filePath) return;
  const target = save.filePath;
  try {
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      dialog.showErrorBox(
        'Folder not empty',
        'That location already contains files. Choose a new name or an empty folder for the restored company file.',
      );
      return;
    }
  } catch {
    /* unreadable target — let the server report it */
  }
  try {
    const res = await fetch(`${serverUrl}/api/portable/restore?target=${encodeURIComponent(target)}`, {
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
    rememberRecentCompany(target);
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Open it now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `"${data.companyName}" was restored and verified.`,
      detail:
        `Location: ${target}\n\nEvery table, the trial balance, attachments and the transaction log ` +
        'match the original file. Sign in with the user names and passwords from that file.',
    });
    if (choice.response === 0) openCompanyDir(target);
    else buildMenu(); // refresh Recent Companies
  } catch (e) {
    dialog.showErrorBox('Could not open the portable company file', String((e && e.message) || e));
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

/** Start/stop sharing this company file on the tailnet. Never available in client mode. */
async function setHosting(enable, { quiet = false } = {}) {
  if (remoteHostOrigin) return hostingStatus();
  if (enable && sandboxActive()) {
    if (!quiet) dialog.showErrorBox('Not available in the sandbox', 'Leave the sandbox to share your company file with other people.');
    return hostingStatus();
  }
  const cfg = hostingConfig();
  if (enable && !hostingState) {
    try {
      const upstreamPort = Number(new URL(serverUrl).port);
      hostingState = await hosting.startHosting({
        upstreamPort,
        port: cfg.port,
        tls: cfg.tls !== false,
        bindAll: cfg.bindAll === true,
        certDir: path.join(app.getPath('userData'), 'tls'),
      });
      hostingError = null;
      saveConfig({ hosting: { ...cfg, enabled: true } });
      if (!quiet && mainWindow) {
        dialog.showMessageBox(mainWindow, {
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
      saveConfig({ remoteHost: n.origin, lastRemoteHost: value.trim() });
      setImmediate(() => {
        app.relaunch();
        app.quit();
      });
      return { ok: true };
    },
  });
}

/** Leave client mode and reopen the local company file. */
function disconnectFromHost() {
  saveConfig({ remoteHost: null });
  app.relaunch();
  app.quit();
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
  const current = activeCompanyDir();
  const recents = (Array.isArray(cfg.recentCompanies) ? cfg.recentCompanies : []).filter(
    (d) => typeof d === 'string',
  );
  const recentItems = recents.map((dir) => ({
    label: dir === current ? `${companyFile.companyName(dir)} (current)` : companyFile.companyName(dir),
    sublabel: dir,
    enabled: dir !== current,
    click: () => openCompanyDir(dir),
  }));
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Company…', accelerator: 'CmdOrCtrl+Shift+N', click: () => { createCompanyFlow(); } },
        { label: 'Open Company…', accelerator: 'CmdOrCtrl+O', click: () => { openCompanyFlow(); } },
        {
          label: 'Recent Companies',
          submenu: recentItems.length
            ? recentItems
            : [{ label: 'No recent companies', enabled: false }],
        },
        { type: 'separator' },
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
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    // Reload on F5 (not the default Ctrl+R): Ctrl+R is the QB "Registers" shortcut in the app.
    { label: 'View', submenu: [{ role: 'reload', accelerator: 'F5' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    // QB menus: Company, Customers, Vendors, Employees, Banking, Reports, Lists (electron/menuRoutes.js).
    ...buildSectionMenus(navigate),
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
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
        { label: 'About', click: () => dialog.showMessageBox(mainWindow, { message: 'Ironbooks', detail: `Version ${app.getVersion()}\nOpen-source desktop accounting with AI error correction.` }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function navigate(route) {
  mainWindow?.webContents.send('navigate', route);
}

async function createWindow() {
  // Client mode: show the company hosted on another machine instead of starting a local server.
  const remote = (() => {
    const r = loadConfig().remoteHost;
    if (typeof r !== 'string' || !r) return null;
    const n = hostingCore.normalizeHostAddress(r);
    return n.ok ? n : null;
  })();
  remoteHostOrigin = remote ? remote.origin : null;
  if (!remoteHostOrigin) reconcileSandboxConfig();
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
    try {
      await mainWindow.loadURL(url);
    } catch (err) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: `Can't reach the host at ${remoteHostOrigin}`,
        detail:
          'Make sure the host computer is on, Ironbooks there has "Host multi-user access" turned on, and both computers are signed in to Tailscale.\n\n' +
          String((err && err.message) || err),
        buttons: ['Try Again', 'Open My Local Company Instead', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) {
        app.relaunch();
        app.quit();
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
  companyFile.ensureManifest(activeDir);
  companyFile.writeManifest(activeDir, { lastOpenedAt: new Date().toISOString() });
  const inSandbox = Boolean(sandboxActive());
  // A sandbox copy is not a company file to come back to (a kept training file is added to
  // Recent Companies when it is kept).
  if (!inSandbox) rememberRecentCompany(activeDir);
  buildMenu();
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

ipcMain.handle('app:dataDir', (e) => (fromLocalApp(e) ? activeCompanyDir() : null));

// ---------------------------------------------------------------------------
// Company-file management (drives the in-app "Company File" screen)
// ---------------------------------------------------------------------------
// Local company-file management is only offered to the local app's own pages — never to a
// remote host's pages when this app is connected as a multi-user client.
ipcMain.handle('company:current', (e) => {
  if (!fromLocalApp(e)) return null;
  const dir = activeCompanyDir();
  const m = companyFile.readManifest(dir) || {};
  return { dir, name: companyFile.companyName(dir), passwordProtected: Boolean(m.passwordProtected) };
});
ipcMain.handle('company:recent', (e) => {
  if (!fromLocalApp(e)) return [];
  const cfg = loadConfig();
  const current = activeCompanyDir();
  return (Array.isArray(cfg.recentCompanies) ? cfg.recentCompanies : [])
    .filter((d) => typeof d === 'string')
    .map((dir) => ({ dir, name: companyFile.companyName(dir), current: dir === current }));
});
ipcMain.handle('company:new', (e) => { if (fromLocalApp(e)) createCompanyFlow(); return true; });
ipcMain.handle('company:open', (e) => { if (fromLocalApp(e)) openCompanyFlow(); return true; });
ipcMain.handle('company:switch', (e, dir) => {
  if (fromLocalApp(e) && typeof dir === 'string' && dir) openCompanyDir(dir);
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
ipcMain.handle('hosting:setEnabled', (e, enable) =>
  fromLocalApp(e) ? setHosting(Boolean(enable)) : hostingStatus(),
);
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
  if (mainWindow) dialog.showMessageBox(mainWindow, { type: 'info', message, detail, buttons: ['OK'] });
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
  await createWindow();
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
  // First pass: hold the quit open long enough to snapshot the company file, then
  // re-enter quit with the flag set. Data safety: a rotating local auto-backup means
  // a bad restore / disk hiccup never costs more than one session.
  if (!quittingAfterBackup) {
    quittingAfterBackup = true;
    event.preventDefault();
    runAutoBackup()
      .catch((err) => console.error('[auto-backup] skipped:', err?.message || err))
      .finally(() => app.quit());
    return;
  }
  // Second pass: backup done (or skipped) — stop hosting and shut the server down for real.
  if (hostingState) hosting.stopHosting(hostingState).catch(() => {});
  if (serverProcess) serverProcess.kill();
});
