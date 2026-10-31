// Secure bridge between the renderer (React UI) and Electron main.
// Exposes a minimal, audited API on window.bookkeeper — no direct Node access in the renderer.
const { contextBridge, ipcRenderer } = require('electron');

// Whether this window draws its own title bar (the main window has no system frame). Asked
// synchronously so the page's first paint already reserves the title bar (lib/theme.ts).
let chromeInfo = { frameless: false, platform: 'unknown' };
try {
  const info = ipcRenderer.sendSync('chrome:info');
  if (info && typeof info === 'object') chromeInfo = { frameless: Boolean(info.frameless), platform: String(info.platform) };
} catch {
  /* keep the defaults: a normal framed window */
}

contextBridge.exposeInMainWorld('bookkeeper', {
  /** Open a native file picker; returns { filePath, content } or null. */
  openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
  /** Save content to a user-chosen path; returns the path or null. */
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  /** Save binary data (ArrayBuffer) to a user-chosen path; returns the path or null. */
  saveBytes: (opts) => ipcRenderer.invoke('file:saveBytes', opts),
  /**
   * Back Up and Restore: the backup chosen in File > Open or Restore Company (or double-clicked),
   * handed over once for the token in /backup?restore=<token>. Resolves { name, data } or null.
   */
  backup: {
    takePending: (token) => ipcRenderer.invoke('backup:takePending', String(token)),
  },
  /** Portable Company File (.bkp): open/restore flow runs in the main process. */
  portable: {
    open: () => ipcRenderer.invoke('portable:open'),
  },
  /** Active company data directory. */
  dataDir: () => ipcRenderer.invoke('app:dataDir'),
  /** Subscribe to main->renderer messages (menu actions, navigation). Returns an unsubscribe. */
  onMenu: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('menu', handler);
    return () => ipcRenderer.removeListener('menu', handler);
  },
  onNavigate: (cb) => {
    const handler = (_e, route) => cb(route);
    ipcRenderer.on('navigate', handler);
    return () => ipcRenderer.removeListener('navigate', handler);
  },
  /** App updates: current state, subscribe to changes, and the user's choices. */
  updates: {
    status: () => ipcRenderer.invoke('app:updateStatus'),
    onChange: (cb) => {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('update', handler);
      return () => ipcRenderer.removeListener('update', handler);
    },
    check: () => ipcRenderer.invoke('app:checkForUpdates'),
    download: () => ipcRenderer.invoke('app:downloadUpdate'),
  },
  /** Apply a downloaded update now (quit, install, relaunch). Resolves false if none is staged. */
  quitAndInstall: () => ipcRenderer.invoke('app:quitAndInstall'),
  /** Company-file management (the "file lives wherever you put it" model). */
  company: {
    current: () => ipcRenderer.invoke('company:current'),
    recent: () => ipcRenderer.invoke('company:recent'),
    newFile: () => ipcRenderer.invoke('company:new'),
    open: () => ipcRenderer.invoke('company:open'),
    switch: (dir) => ipcRenderer.invoke('company:switch', dir),
    setProtected: (val) => ipcRenderer.invoke('company:setProtected', val),
    /** Show the open company file's folder in Explorer / Finder. */
    reveal: () => ipcRenderer.invoke('company:reveal'),
    /** File > Close Company: release the file and show "No Company Open". */
    close: () => ipcRenderer.invoke('company:close'),
    /** Record the open company's name in the file (shown in recent-file lists). */
    setDisplayName: (name) => ipcRenderer.invoke('company:displayName', String(name)),
    /** Tell the shell who is signed in (other workstations see it; the sign-in screen pre-fills it). */
    signedIn: (name) => ipcRenderer.invoke('company:signedIn', String(name)),
    /** The user name last used to sign in to this company file on this computer, or null. */
    lastUser: () => ipcRenderer.invoke('company:lastUser'),
    /** File > Save Company File Now. */
    saveNow: () => ipcRenderer.invoke('company:saveNow'),
    /** File > Save Copy As… ({ convert: true } turns an older company folder into a single file). */
    saveCopyAs: (opts) => ipcRenderer.invoke('company:saveCopyAs', opts || {}),
  },
  /**
   * Sandbox mode ("Try it on a copy"): after the local server made the copy (POST /api/sandbox)
   * or left it, tell the shell so it relaunches into the right company file with its sandbox flag.
   * Resolve false when the shell refused (the page then just reloads).
   */
  sandbox: {
    entered: (dir) => ipcRenderer.invoke('sandbox:entered', dir),
    left: (opts) => ipcRenderer.invoke('sandbox:left', opts || {}),
  },
  /** Multi-user hosting (QB Enterprise "Host multi-user access") — see electron/hosting.js. */
  hosting: {
    status: () => ipcRenderer.invoke('hosting:status'),
    setEnabled: (enable, mode) => ipcRenderer.invoke('hosting:setEnabled', enable, mode),
    openConnect: () => ipcRenderer.invoke('hosting:openConnect'),
    disconnect: () => ipcRenderer.invoke('hosting:disconnect'),
  },
  /** My Preferences > Spelling: turn the (local-only) spell checker on or off. */
  spellcheck: {
    setEnabled: (enabled) => ipcRenderer.invoke('spellcheck:setEnabled', Boolean(enabled)),
  },
  /** Window frame: theme colors, and the menu bar drawn in the page's title bar. */
  chrome: {
    frameless: chromeInfo.frameless,
    platform: chromeInfo.platform,
    setTheme: (theme) => ipcRenderer.invoke('chrome:theme', theme),
    menus: () => ipcRenderer.invoke('chrome:menus'),
    popupMenu: (index, x, y) => ipcRenderer.invoke('chrome:popupMenu', Number(index), Number(x), Number(y)),
    // The Favorites menu's pages (components/FavoritesMenu.tsx): [{ label, route }].
    setFavorites: (items) =>
      ipcRenderer.invoke(
        'chrome:setFavorites',
        Array.isArray(items) ? items.map((f) => ({ label: String(f && f.label), route: String(f && f.route) })) : [],
      ),
  },
  isDesktop: true,
});
