// Bridge for the "No Company Open" screen (electron/startScreen.js). Only these calls; the main
// process accepts them only from that window, and only for folders on the recent list.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('startScreen', {
  /** Recent company files: [{ dir, name, exists, lastOpenedAt, passwordProtected }]. */
  list: () => ipcRenderer.invoke('start:list'),
  open: (dir) => ipcRenderer.invoke('start:open', String(dir)),
  remove: (dir) => ipcRenderer.invoke('start:remove', String(dir)),
  reveal: (dir) => ipcRenderer.invoke('start:reveal', String(dir)),
  newCompany: () => ipcRenderer.invoke('start:new'),
  browse: () => ipcRenderer.invoke('start:browse'),
});
