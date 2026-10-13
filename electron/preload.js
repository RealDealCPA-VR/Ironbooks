// Secure bridge between the renderer (React UI) and Electron main.
// Exposes a minimal, audited API on window.bookkeeper — no direct Node access in the renderer.
const { contextBridge, ipcRenderer } = require('electron');

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
  /** Multi-user hosting (QB Enterprise "Host multi-user access") — see electron/hosting.js. */
  hosting: {
    status: () => ipcRenderer.invoke('hosting:status'),
    setEnabled: (enable) => ipcRenderer.invoke('hosting:setEnabled', enable),
    openConnect: () => ipcRenderer.invoke('hosting:openConnect'),
    disconnect: () => ipcRenderer.invoke('hosting:disconnect'),
  },
  /** Re-read the Privacy & Network policy for what the window may load (after saving it). */
  network: {
    refresh: () => ipcRenderer.invoke('network:refresh'),
  },
  /** My Preferences > Spelling: turn the (local-only) spell checker on or off. */
  spellcheck: {
    setEnabled: (enabled) => ipcRenderer.invoke('spellcheck:setEnabled', Boolean(enabled)),
  },
  isDesktop: true,
});
