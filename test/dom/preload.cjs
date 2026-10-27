// Preload for the DOM test window (test/dom/runner.cjs): key presses and the result hand-off.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__domTest', {
  press: (key, mods) => ipcRenderer.invoke('dom:press', String(key), mods || {}),
  type: (text) => ipcRenderer.invoke('dom:type', String(text)),
  done: (results) => ipcRenderer.invoke('dom:done', results),
});
