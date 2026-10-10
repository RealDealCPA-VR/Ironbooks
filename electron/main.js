// Electron main process for BookKeeper AI (desktop).
//
// Architecture: the React/Next.js UI and the accounting engine (PGlite local DB) run inside a
// Next.js server. In production we launch the Next standalone server as a child process on a free
// local port and point a BrowserWindow at it; in dev we attach to `next dev` on :3000.
//
// The active company file is a local data directory; we set BKA_DATA_DIR before starting the
// server so lib/db persists there. This keeps all financial data on the user's machine (offline).

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const companyFile = require('./companyFile');

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
//   backupIntervalHours  scheduled auto-backup cadence while the app runs
//                        (default 24; 0/negative disables the timer — the
//                        on-quit backup still runs)
//   dataDir              active company data directory (multi-company support);
//                        the BKA_DATA_DIR env var overrides it for one launch
//   recentCompanies      most-recently-opened company directories (File menu)
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
  saveConfig({ dataDir: dir });
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
// Quit-time auto-backup (rotating, keep last N in userData/backups)
//
// The main process has no session cookie, so it authenticates with the per-launch
// internal token against POST /api/dashboard/auto-backup (same trusted-local pattern
// as the launch-time recurring run). In dev the server was not spawned by us, the
// token will not match, and the backup is skipped with a log line.
// ---------------------------------------------------------------------------

const AUTO_BACKUP_KEEP = 10;

function backupsDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runAutoBackup() {
  if (!serverUrl) return;
  const res = await fetch(`${serverUrl}/api/dashboard/auto-backup`, {
    method: 'POST',
    headers: { 'x-bka-internal': internalToken },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body}`.trim());
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = backupsDir();
  const file = path.join(dir, `auto-backup-${ts}.bka`);
  fs.writeFileSync(file, bytes);
  rotateAutoBackups(dir);
  console.log(`[auto-backup] wrote ${file} (${bytes.length} bytes)`);
}

function rotateAutoBackups(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^auto-backup-.*\.bka$/.test(f))
      .sort(); // timestamped names sort chronologically
    for (const f of files.slice(0, Math.max(files.length - AUTO_BACKUP_KEEP, 0))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch (err) {
    console.error('[auto-backup] rotation failed:', err);
  }
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
// Scheduled auto-backups (same endpoint/rotation as the on-quit backup)
// ---------------------------------------------------------------------------

const DEFAULT_BACKUP_INTERVAL_HOURS = 24;
let backupTimer = null;

function scheduleAutoBackups() {
  const cfg = loadConfig();
  const hours = Number.isFinite(cfg.backupIntervalHours)
    ? cfg.backupIntervalHours
    : DEFAULT_BACKUP_INTERVAL_HOURS;
  if (!(hours > 0)) {
    console.log('[auto-backup] scheduled backups disabled (backupIntervalHours <= 0)');
    return;
  }
  backupTimer = setInterval(() => {
    runAutoBackup().catch((err) =>
      console.error('[auto-backup] scheduled run failed:', err?.message || err),
    );
  }, hours * 60 * 60 * 1000);
  console.log(`[auto-backup] scheduled every ${hours}h of uptime`);
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
      BKA_MIGRATIONS_DIR: path.join(process.resourcesPath, 'app', 'drizzle'),
      // Offline desktop build: the server is bound to 127.0.0.1 only, so it is safe to
      // surface a password-reset token directly in the local HTTP response.
      BKA_OFFLINE: '1',
      BKA_INTERNAL_TOKEN: internalToken,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: 'inherit',
  });

  // wait until the port is accepting connections
  const url = `http://127.0.0.1:${port}`;
  await waitForServer(port);
  return url;
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
// manifest, and relaunch into the fresh (empty) file — onboarding then sets up the chart of
// accounts. The "file" is a self-contained folder the user can place anywhere (incl. a server
// or network drive).
async function createCompanyFlow() {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'New Company File',
    message: 'Choose a name and location for the new company file',
    buttonLabel: 'Create',
    defaultPath: path.join(app.getPath('documents'), 'My Company.bookkeeper'),
    filters: [{ name: 'BookKeeper Company', extensions: ['bookkeeper'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (res.canceled || !res.filePath) return;
  const target = res.filePath;
  const name = path.basename(target).replace(/\.bookkeeper$/i, '');
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
  if (isDev) {
    // `next dev` was not spawned by us and does not know the internal token — use the in-app
    // upload flow on the Company File page instead.
    navigate('/company-file?restore=portable');
    return;
  }
  if (!filePath) {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Portable Company File',
      filters: [{ name: 'BookKeeper Portable Company File', extensions: ['bkp'] }],
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
    defaultPath: path.join(app.getPath('documents'), `${base}.bookkeeper`),
    filters: [{ name: 'BookKeeper Company', extensions: ['bookkeeper'] }],
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
        { label: 'Import Bank File…', click: () => mainWindow?.webContents.send('menu', 'import') },
        { label: 'Backup Company…', click: () => mainWindow?.webContents.send('menu', 'backup') },
        { type: 'separator' },
        { label: 'Create Portable Company File…', click: () => mainWindow?.webContents.send('menu', 'portable-create') },
        { label: 'Open/Restore Portable Company File…', click: () => { openPortableFlow(); } },
        {
          label: 'Export Shareable Ledger',
          submenu: [
            { label: 'Excel Workbook (.xlsx)…', click: () => mainWindow?.webContents.send('menu', 'shareable-xlsx') },
            { label: 'PDF Summary (.pdf)…', click: () => mainWindow?.webContents.send('menu', 'shareable-pdf') },
          ],
        },
        { label: 'View Transaction Log', click: () => navigate('/transaction-log') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    // Reload on F5 (not the default Ctrl+R): Ctrl+R is the QB "Registers" shortcut in the app.
    { label: 'View', submenu: [{ role: 'reload', accelerator: 'F5' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    {
      label: 'Reports',
      submenu: [
        { label: 'Profit & Loss', click: () => navigate('/reports/profit-loss') },
        { label: 'Balance Sheet', click: () => navigate('/reports/balance-sheet') },
        { label: 'Trial Balance', click: () => navigate('/reports/trial-balance') },
        { label: 'General Ledger', click: () => navigate('/reports/general-ledger') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'BookKeeper AI on the web', click: () => shell.openExternal('https://github.com/') },
        { label: 'About', click: () => dialog.showMessageBox(mainWindow, { message: 'BookKeeper AI', detail: 'Open-source desktop accounting with AI error correction.' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function navigate(route) {
  mainWindow?.webContents.send('navigate', route);
}

async function createWindow() {
  const url = await startNextServer();
  serverUrl = url;

  // Restore the last window size/position; ignore positions that are no longer
  // on any connected display (e.g. an unplugged external monitor).
  const state = loadWindowState();
  const usePosition = state && boundsVisible(state);
  mainWindow = new BrowserWindow({
    width: state ? state.width : 1440,
    height: state ? state.height : 900,
    ...(usePosition ? { x: state.x, y: state.y } : {}),
    minWidth: 1024,
    minHeight: 700,
    title: 'BookKeeper AI',
    backgroundColor: '#0b1f3a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (state?.maximized) mainWindow.maximize();
  trackWindowState(mainWindow);

  await mainWindow.loadURL(url);
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  // Ensure the active file is self-describing (manifest) and stamp its last-opened time.
  const activeDir = activeCompanyDir();
  companyFile.ensureManifest(activeDir);
  companyFile.writeManifest(activeDir, { lastOpenedAt: new Date().toISOString() });
  rememberRecentCompany(activeDir);
  buildMenu();
  runDueRecurring(url);
  scheduleAutoBackups();

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

// --- IPC for native dialogs the renderer needs ---
ipcMain.handle('dialog:openFile', async (_e, filters) => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: filters || [] });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  return { filePath, content: fs.readFileSync(filePath, 'utf8') };
});

ipcMain.handle('dialog:saveFile', async (_e, { defaultName, content }) => {
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, content);
  return res.filePath;
});

// Binary save (portable company file, shareable ledger): native Save dialog with a file-type
// filter; the renderer fetched the bytes from the local server with its session.
ipcMain.handle('file:saveBytes', async (_e, opts) => {
  const { defaultName, filters, data } = opts || {};
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), path.basename(String(defaultName || 'export'))),
    filters: Array.isArray(filters) ? filters : [],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(new Uint8Array(data)));
  return res.filePath;
});

ipcMain.handle('portable:open', () => { openPortableFlow(); return true; });

ipcMain.handle('app:dataDir', () => activeCompanyDir());

// ---------------------------------------------------------------------------
// Company-file management (drives the in-app "Company File" screen)
// ---------------------------------------------------------------------------
ipcMain.handle('company:current', () => {
  const dir = activeCompanyDir();
  const m = companyFile.readManifest(dir) || {};
  return { dir, name: companyFile.companyName(dir), passwordProtected: Boolean(m.passwordProtected) };
});
ipcMain.handle('company:recent', () => {
  const cfg = loadConfig();
  const current = activeCompanyDir();
  return (Array.isArray(cfg.recentCompanies) ? cfg.recentCompanies : [])
    .filter((d) => typeof d === 'string')
    .map((dir) => ({ dir, name: companyFile.companyName(dir), current: dir === current }));
});
ipcMain.handle('company:new', () => { createCompanyFlow(); return true; });
ipcMain.handle('company:open', () => { openCompanyFlow(); return true; });
ipcMain.handle('company:switch', (_e, dir) => {
  if (typeof dir === 'string' && dir) openCompanyDir(dir);
  return true;
});
// Keep the manifest's display hint in sync after the file password is toggled in the UI, so
// Open/Recent can show a lock icon without opening the database.
ipcMain.handle('company:setProtected', (_e, val) => {
  companyFile.writeManifest(activeCompanyDir(), { passwordProtected: Boolean(val) });
  return true;
});

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

// Held so the 'app:quitAndInstall' IPC handler can apply a downloaded update on demand.
let autoUpdater = null;

function checkForUpdates() {
  if (isDev) return;
  try {
    // electron-updater reads the publish config baked in at build time. No-ops if none is set.
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('menu', 'update-ready');
    });
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {
    // electron-updater not available / no feed configured — ignore.
    autoUpdater = null;
  }
}

// Renderer "Restart & install now" button -> apply the downloaded update immediately.
// Returns false if no update is staged (the UI then tells the user to restart manually).
ipcMain.handle('app:quitAndInstall', () => {
  if (!autoUpdater) return false;
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
  await createWindow();
  checkForUpdates();
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
    if (backupTimer) clearInterval(backupTimer);
    runAutoBackup()
      .catch((err) => console.error('[auto-backup] skipped:', err?.message || err))
      .finally(() => app.quit());
    return;
  }
  // Second pass: backup done (or skipped) — shut the server down for real.
  if (serverProcess) serverProcess.kill();
});
