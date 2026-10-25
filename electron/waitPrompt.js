// "Waiting for Mary on FRONT-DESK to answer…" — a small modal with a Cancel button, shown while
// this computer asks the person who has a company file open to let it in (electron/main.js).
//
// Self-contained like electron/connectPrompt.js: inline HTML (text set with textContent only)
// and a preload that exposes nothing but Cancel. The main process closes it when the answer
// comes (or the wait times out) and can update the message meanwhile.
'use strict';

const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Ironbooks</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;padding:22px 24px;display:flex;gap:16px;align-items:flex-start}
  .spin{flex:none;width:22px;height:22px;border-radius:50%;border:2.5px solid rgba(128,128,128,.25);border-top-color:#0a84ff;animation:s 1s linear infinite;margin-top:2px}
  @keyframes s{to{transform:rotate(360deg)}}
  h1{font-size:15px;margin:0 0 6px;font-weight:650}
  p{margin:0;color:GrayText;font-size:13px;line-height:1.45}
  .row{display:flex;justify-content:flex-end;margin-top:18px}
  button{font:inherit;font-size:13px;padding:6px 16px;border-radius:7px}
</style></head><body>
<div class="spin" aria-hidden="true"></div>
<div style="flex:1">
<h1 id="t"></h1><p id="m" role="status" aria-live="polite"></p>
<div class="row"><button id="cancel" autofocus>Cancel</button></div>
</div>
<script>
  const q=new URLSearchParams(location.hash.slice(1));
  document.getElementById('t').textContent=q.get('t')||'';
  document.getElementById('m').textContent=q.get('m')||'';
  document.getElementById('cancel').onclick=()=>window.waitPrompt.cancel();
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') window.waitPrompt.cancel(); });
  window.waitPrompt.onMessage((m)=>{ document.getElementById('m').textContent=m; });
</script></body></html>`;

/**
 * Show the waiting window. Returns { cancelled: Promise<void> (resolves if the person cancels),
 * setMessage(text), close() }.
 */
function showWaiting(parent, { title, message }) {
  const win = new BrowserWindow({
    parent: parent || undefined,
    modal: Boolean(parent),
    width: 460,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Ironbooks',
    webPreferences: {
      preload: path.join(__dirname, 'waitPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  let onCancel;
  const cancelled = new Promise((resolve) => {
    onCancel = resolve;
  });
  const channel = 'wait-prompt:cancel';
  const handler = (e) => {
    if (e.sender !== win.webContents) return false;
    onCancel();
    if (!win.isDestroyed()) win.close();
    return true;
  };
  ipcMain.handle(channel, handler);
  let closedByUs = false;
  win.on('closed', () => {
    ipcMain.removeHandler(channel);
    if (!closedByUs) onCancel(); // closed with the window's X
  });
  const hash = new URLSearchParams({ t: title || '', m: message || '' }).toString();
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}#${hash}`);
  return {
    cancelled,
    setMessage(text) {
      if (!win.isDestroyed()) win.webContents.send('wait-prompt:message', String(text || ''));
    },
    close() {
      closedByUs = true;
      if (!win.isDestroyed()) win.close();
    },
  };
}

module.exports = { showWaiting };
