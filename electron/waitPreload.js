// Preload for the "Waiting for … to answer" window (electron/waitPrompt.js) only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waitPrompt', {
  cancel: () => ipcRenderer.invoke('wait-prompt:cancel'),
  onMessage: (cb) => {
    ipcRenderer.on('wait-prompt:message', (_e, text) => cb(String(text || '')));
  },
});
