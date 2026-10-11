// Preload for the "Open company on host…" prompt (electron/connectPrompt.js) only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connectPrompt', {
  initial: () => ipcRenderer.invoke('connect-prompt:initial'),
  submit: (value) => ipcRenderer.invoke('connect-prompt:submit', value),
  cancel: () => ipcRenderer.invoke('connect-prompt:cancel'),
});
