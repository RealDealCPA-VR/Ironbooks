// A small modal that asks for the password of a file protected with one (filecrypto): a portable
// company file (.bkp) or an Accountant's Copy transfer file (.ibac) being opened from the File
// menu. Self-contained like electron/connectPrompt.js (inline HTML + the same minimal preload),
// so the password never passes through the app's pages; `onSubmit` tries it (the app server
// checks it, rate-limited) and keeps the prompt open with a message when it is wrong.

'use strict';

const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

/** The window that currently owns the prompt's IPC channels. */
let owner = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function page({ title, message }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  body{font:14px system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:20px;color:#0b1f3a;background:#f8fafc}
  h1{font-size:16px;margin:0 0 6px} p{margin:0 0 12px;color:#475569;font-size:13px}
  label{display:block;font-size:12px;font-weight:600;margin-bottom:4px}
  input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}
  .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  button{padding:7px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;font-weight:600;cursor:pointer}
  button.primary{background:#2563eb;color:#fff;border-color:#2563eb}
  #err{color:#dc2626;font-size:12px;min-height:16px;margin-top:6px}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<form id="f"><label for="pw">Password</label><input id="pw" type="password" autofocus autocomplete="off" spellcheck="false">
<div id="err" role="alert"></div>
<div class="row"><button type="button" id="cancel">Cancel</button><button class="primary" id="ok" type="submit">Open</button></div></form>
<script>
  const pw=document.getElementById('pw'),err=document.getElementById('err'),ok=document.getElementById('ok');
  document.getElementById('cancel').onclick=()=>window.connectPrompt.cancel();
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') window.connectPrompt.cancel(); });
  document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();if(!pw.value)return;ok.disabled=true;err.textContent='Checking…';
    const r=await window.connectPrompt.submit(pw.value);ok.disabled=false;err.textContent=r&&r.error?r.error:'';if(r&&r.error){pw.value='';pw.focus();}};
</script></body></html>`;
}

/**
 * Ask for a file's password. `onSubmit(password)` resolves { ok: true, value } to close the prompt
 * (the promise then resolves with `value`) or { ok: false, error } to show a message and ask
 * again. Resolves null when the person cancels.
 */
function promptForFilePassword(parent, { title, message, onSubmit }) {
  return new Promise((resolve) => {
    let outcome = null;
    const win = new BrowserWindow({
      parent: parent || undefined,
      modal: Boolean(parent),
      width: 460,
      height: 270,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title,
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
      'connect-prompt:initial': () => '',
      'connect-prompt:cancel': (e) => {
        if (fromThisWindow(e)) win.close();
      },
      'connect-prompt:submit': async (e, value) => {
        if (!fromThisWindow(e)) return { ok: false, error: 'Not allowed.' };
        let result;
        try {
          result = await onSubmit(String(value || ''));
        } catch (err) {
          result = { ok: false, error: String((err && err.message) || err) };
        }
        if (result && result.ok) {
          outcome = result.value === undefined ? true : result.value;
          setImmediate(() => !win.isDestroyed() && win.close());
          return { ok: true };
        }
        return { ok: false, error: (result && result.error) || 'That password does not open this file.' };
      },
    };
    for (const [ch, fn] of Object.entries(handlers)) {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, fn);
    }
    owner = win;
    win.on('closed', () => {
      // Only if no newer prompt took the channels over: closing this one must not leave that one
      // without its handlers.
      if (owner === win) {
        owner = null;
        for (const ch of Object.keys(handlers)) ipcMain.removeHandler(ch);
      }
      resolve(outcome);
    });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page({ title, message })));
  });
}

module.exports = { promptForFilePassword };
