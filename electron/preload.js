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
    setEnabled: (enable) => ipcRenderer.invoke('hosting:setEnabled', enable),
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
  },
  isDesktop: true,
});
