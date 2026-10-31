// Electron main process for the DOM tests (test/domHarness.ts): opens the bundled test page in a
// hidden window, presses keys through DevTools input (Input.dispatchKeyEvent — real, trusted key
// events that move focus with Tab and type into fields, never Windows' own keyboard) when the page
// asks, and writes the page's results to a JSON file.
//
//   electron test/dom/runner.cjs <page.html> <results.json>
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [pageFile, resultsFile] = process.argv.slice(-2);
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
const log = process.env.IB_DOM_DEBUG ? (m) => process.stderr.write(`[runner] ${m}\n`) : () => {};
// A throwaway profile: never the real app's settings or another test run's.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dom-')));
app.commandLine.appendSwitch('disable-gpu');

/** Windows virtual-key codes for the named keys the tests press. */
const VK = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34,
  End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  '+': 187, '=': 187, '-': 189, ';': 186, "'": 222, '[': 219, ']': 221, '?': 191, '/': 191,
};
const CODES = {
  ' ': 'Space', '+': 'Equal', '=': 'Equal', '-': 'Minus', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft',
  ']': 'BracketRight', '?': 'Slash', '/': 'Slash',
};

function finish(results) {
  fs.writeFileSync(resultsFile, JSON.stringify(results));
  app.exit(0);
}

app.whenReady().then(async () => {
  log('ready');
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    // A hidden window draws no frames (animation frames about once a second), which made every
    // key press wait a second: render offscreen at 60 frames a second instead — never shown,
    // never taking the focus from what is on the screen.
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  const wc = win.webContents;
  wc.setFrameRate(60);
  // DevTools input needs a live page: attach on a blank one, then load the tests.
  await win.loadURL('about:blank');
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  log('debugger attached');

  ipcMain.handle('dom:press', async (_e, key, mods = {}) => {
    const single = key.length === 1;
    const shifted = Boolean(mods.shift) || (single && /[A-Z+?]/.test(key));
    const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (shifted ? 8 : 0);
    const code = mods.code || CODES[key] || (single && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : single && /\d/.test(key) ? `Digit${key}` : key);
    const vk = VK[key] ?? (single ? key.toUpperCase().charCodeAt(0) : 0);
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (single && !mods.ctrl && !mods.alt && !mods.meta) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: key, unmodifiedText: key, ...base });
    }
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return true;
  });
  ipcMain.handle('dom:type', async (_e, text) => {
    await wc.debugger.sendCommand('Input.insertText', { text });
    return true;
  });
  ipcMain.handle('dom:done', (_e, results) => {
    finish(results);
    return true;
  });
  wc.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') process.stderr.write(`[page] ${e.message}\n`);
  });
  wc.on('render-process-gone', (_e, d) => finish([{ name: 'renderer', ok: false, error: `renderer gone: ${d.reason}` }]));
  setTimeout(() => finish([{ name: 'timeout', ok: false, error: 'the DOM tests did not finish in 120 s' }]), 120_000);
  log(`loading ${pageFile}`);
  await win.loadFile(pageFile);
  log('loaded');
});
