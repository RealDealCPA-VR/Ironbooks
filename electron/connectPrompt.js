// "File > Open company on host…" — a small modal that asks for the host computer's address.
//
// Self-contained (inline HTML via a data: URL + a dedicated preload) so it works whether this
// app is currently showing a local company or another host's. The address is validated in the
// main process (hostingCore.normalizeHostAddress: tailnet/LAN only) and the host is probed
// before the app relaunches into it.

'use strict';

const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Open company on host</title>
<style>
  body{font:14px system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:20px;color:#0b1f3a;background:#f8fafc}
  h1{font-size:16px;margin:0 0 6px} p{margin:0 0 12px;color:#475569;font-size:13px}
  input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}
  .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  button{padding:7px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;font-weight:600;cursor:pointer}
  button.primary{background:#2563eb;color:#fff;border-color:#2563eb}
  #err{color:#dc2626;font-size:12px;min-height:16px;margin-top:6px}
</style></head><body>
<h1>Open company on host</h1>
<p>Enter the address shown on the host computer under <b>Multi-user</b> (for example <code>office-pc.tail1234.ts.net</code> or <code>100.101.102.103:47800</code>).</p>
<form id="f"><input id="addr" autofocus placeholder="host address" autocomplete="off" spellcheck="false">
<div id="err"></div>
<div class="row"><button type="button" id="cancel">Cancel</button><button class="primary" id="ok" type="submit">Connect</button></div></form>
<script>
  const addr=document.getElementById('addr'),err=document.getElementById('err'),ok=document.getElementById('ok');
  window.connectPrompt.initial().then(v=>{ if(v) addr.value=v; addr.select(); });
  document.getElementById('cancel').onclick=()=>window.connectPrompt.cancel();
  document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();ok.disabled=true;err.textContent='Connecting…';
    const r=await window.connectPrompt.submit(addr.value);ok.disabled=false;err.textContent=r&&r.error?r.error:'';};
</script></body></html>`;

/**
 * Show the prompt. `onSubmit(value)` resolves { ok: true } to close the prompt or
 * { ok: false, error } to show a message. Resolves when the window closes.
 */
function promptForHost(parent, { initial, onSubmit }) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: parent || undefined,
      modal: Boolean(parent),
      width: 480,
      height: 270,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Open company on host',
      webPreferences: {
        preload: path.join(__dirname, 'promptPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setMenu(null);

    const fromThisWindow = (e) => e.sender === win.webContents;
    const handlers = {
      'connect-prompt:initial': (e) => (fromThisWindow(e) ? initial || '' : ''),
      'connect-prompt:cancel': (e) => {
        if (fromThisWindow(e)) win.close();
      },
      'connect-prompt:submit': async (e, value) => {
        if (!fromThisWindow(e)) return { ok: false, error: 'Not allowed.' };
        const result = await onSubmit(String(value || ''));
        if (result && result.ok) setImmediate(() => !win.isDestroyed() && win.close());
        return result;
      },
    };
    for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);
    win.on('closed', () => {
      for (const ch of Object.keys(handlers)) ipcMain.removeHandler(ch);
      resolve();
    });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  });
}

module.exports = { promptForHost };
