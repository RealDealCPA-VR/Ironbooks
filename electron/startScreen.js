// "No Company Open" (QuickBooks parity): what the window shows after File > Close Company.
// No company file is loaded (the local server is not started), so the file is released and can
// be moved, copied or backed up. The screen lists the recent company files with their full
// folder paths, and opens, creates or browses for one. Self-contained page (a data: URL with
// its own preload, electron/startPreload.js); it never talks to a server.
'use strict';

/** Accent colors for the screen, matching the app's (app/globals.css): [light, dark]. */
const ACCENT_RGB = {
  blue: ['0 113 227', '10 132 255'],
  purple: ['137 68 171', '191 90 242'],
  pink: ['214 40 98', '255 55 95'],
  red: ['215 0 21', '255 69 58'],
  orange: ['201 82 0', '255 159 10'],
  green: ['36 138 61', '48 209 88'],
  teal: ['0 149 255', '64 170 255'],
  graphite: ['99 99 104', '152 152 157'],
};

/**
 * The recent company files as the screen lists them, most recent first.
 * @param {unknown} recents   config.recentCompanies
 * @param {{ exists: (dir: string) => boolean, readManifest: (dir: string) => any, companyName: (dir: string) => string }} io
 */
function recentEntries(recents, io) {
  return (Array.isArray(recents) ? recents : [])
    .filter((d, i, arr) => typeof d === 'string' && d && arr.indexOf(d) === i)
    .map((dir) => {
      const exists = io.exists(dir);
      const m = (exists && io.readManifest(dir)) || {};
      return {
        dir,
        name: io.companyName(dir),
        exists,
        lastOpenedAt: typeof m.lastOpenedAt === 'string' ? m.lastOpenedAt : null,
        passwordProtected: Boolean(m.passwordProtected),
      };
    });
}

/** The page. Theme colors are baked in; names and paths are filled in with textContent only. */
function startScreenHtml({ dark, accent, platform }) {
  const [light, darkAccent] = ACCENT_RGB[accent] || ACCENT_RGB.blue;
  const pad = platform === 'darwin' ? '80px' : '14px';
  return `<!doctype html>
<html lang="en" data-scheme="${dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>Ironbooks — No Company Open</title>
<style>
  :root { --ink: 29 29 31; --canvas: 245 245 247; --surface: 255 255 255; --chrome: 236 236 240; --line: 222 222 227; --muted: 110 110 115; --accent: ${light}; color-scheme: light; }
  [data-scheme='dark'] { --ink: 245 245 247; --canvas: 18 18 20; --surface: 30 30 32; --chrome: 40 40 43; --line: 62 62 66; --muted: 160 160 165; --accent: ${darkAccent}; color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif; color: rgb(var(--ink)); background: rgb(var(--canvas)); -webkit-font-smoothing: antialiased; display: flex; flex-direction: column; }
  .titlebar { height: env(titlebar-area-height, 36px); flex: none; display: flex; align-items: center; padding-left: ${pad}; gap: 8px; background: rgb(var(--chrome)); border-bottom: 1px solid rgb(var(--line) / .8); font-size: 13px; font-weight: 600; -webkit-app-region: drag; user-select: none; }
  .mark { width: 20px; height: 20px; border-radius: 6px; background: linear-gradient(rgb(var(--accent) / .85), rgb(var(--accent))); display: grid; place-items: center; }
  main { flex: 1; overflow: auto; display: flex; flex-direction: column; align-items: center; padding: 48px 24px; background: radial-gradient(1200px 600px at 50% -10%, rgb(var(--accent) / .12), transparent); }
  .card { width: min(760px, 100%); background: rgb(var(--surface)); border: 1px solid rgb(var(--line) / .7); border-radius: 16px; box-shadow: 0 1px 2px rgb(0 0 0 / .05), 0 8px 28px rgb(0 0 0 / .07); overflow: hidden; }
  .head { display: flex; gap: 14px; align-items: center; padding: 22px 24px 18px; }
  .icon { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(rgb(var(--accent) / .85), rgb(var(--accent))); display: grid; place-items: center; flex: none; }
  h1 { font-size: 20px; margin: 0; font-weight: 650; letter-spacing: -.01em; }
  .sub { margin: 2px 0 0; color: rgb(var(--muted)); }
  .cols { display: grid; grid-template-columns: 1fr 140px; padding: 8px 24px; font-size: 12px; font-weight: 600; color: rgb(var(--muted)); border-top: 1px solid rgb(var(--line) / .7); border-bottom: 1px solid rgb(var(--line) / .7); }
  ul { list-style: none; margin: 0; padding: 6px; max-height: 360px; overflow: auto; outline: none; }
  li { display: grid; grid-template-columns: 1fr 140px; gap: 12px; align-items: center; padding: 10px 18px; border-radius: 10px; cursor: default; }
  li:hover { background: rgb(var(--ink) / .04); }
  li[aria-selected='true'] { background: rgb(var(--accent) / .13); }
  .name { font-weight: 600; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path { font: 12px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; color: rgb(var(--muted)); margin-top: 2px; word-break: break-all; user-select: text; cursor: text; }
  .when { font-size: 12px; color: rgb(var(--muted)); }
  .badge { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 6px; flex: none; }
  .missing { background: rgb(255 69 58 / .14); color: rgb(215 0 21); }
  [data-scheme='dark'] .missing { color: rgb(255 120 110); }
  .lock { background: rgb(var(--ink) / .07); color: rgb(var(--muted)); }
  .empty { padding: 28px 24px; color: rgb(var(--muted)); text-align: center; }
  .actions { display: flex; gap: 8px; align-items: center; padding: 14px 18px; border-top: 1px solid rgb(var(--line) / .7); }
  .spacer { flex: 1; }
  button { font: inherit; font-size: 13px; font-weight: 500; color: rgb(var(--ink)); background: rgb(var(--surface)); border: 1px solid rgb(var(--line)); border-radius: 8px; padding: 7px 14px; box-shadow: 0 1px 2px rgb(0 0 0 / .05); cursor: default; }
  button:hover:not(:disabled) { background: rgb(var(--ink) / .04); }
  button:disabled { opacity: .45; }
  button:focus-visible { outline: none; box-shadow: 0 0 0 4px rgb(var(--accent) / .25); }
  button.primary { background: rgb(var(--accent)); border-color: transparent; color: #fff; }
  button.primary:hover:not(:disabled) { background: rgb(var(--accent)); filter: brightness(1.1); }
  .foot { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; justify-content: center; }
</style>
</head>
<body>
<div class="titlebar"><span class="mark"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></span>Ironbooks</div>
<main>
  <section class="card" aria-labelledby="title">
    <div class="head">
      <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></div>
      <div><h1 id="title">No company open</h1><p class="sub">Choose a company file to open, or create a new one.</p></div>
    </div>
    <div class="cols" aria-hidden="true"><span>Company file and location</span><span>Last opened</span></div>
    <ul id="list" role="listbox" tabindex="0" aria-label="Recent company files"></ul>
    <div id="empty" class="empty" hidden>No recent company files yet. Open one from its folder, or create a new company.</div>
    <div class="actions">
      <button id="reveal" disabled>Show in folder</button>
      <button id="remove" disabled>Remove from list</button>
      <span class="spacer"></span>
      <button id="open" class="primary" disabled>Open</button>
    </div>
  </section>
  <div class="foot">
    <button id="new">Create a new company…</button>
    <button id="browse">Open another company file…</button>
  </div>
</main>
<script>
(function () {
  var api = window.startScreen;
  var list = document.getElementById('list');
  var rows = [];
  var selected = -1;
  var fmt = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function select(i) {
    selected = i;
    Array.prototype.forEach.call(list.children, function (li, j) { li.setAttribute('aria-selected', String(j === i)); });
    var r = rows[i];
    document.getElementById('open').disabled = !r || !r.exists;
    document.getElementById('remove').disabled = !r;
    document.getElementById('reveal').disabled = !r || !r.exists;
    if (list.children[i]) list.children[i].scrollIntoView({ block: 'nearest' });
  }
  function open() {
    var r = rows[selected];
    if (r && r.exists) api.open(r.dir);
  }
  function render() {
    list.textContent = '';
    rows.forEach(function (r, i) {
      var li = el('li');
      li.setAttribute('role', 'option');
      li.dataset.dir = r.dir;
      var left = el('div');
      var name = el('div', 'name');
      name.appendChild(el('span', null, r.name));
      if (!r.exists) name.appendChild(el('span', 'badge missing', 'Not found'));
      if (r.passwordProtected) name.appendChild(el('span', 'badge lock', 'Password'));
      left.appendChild(name);
      var p = el('div', 'path', r.dir);
      p.title = r.dir;
      left.appendChild(p);
      li.appendChild(left);
      li.appendChild(el('div', 'when', fmt(r.lastOpenedAt)));
      li.addEventListener('click', function () { select(i); });
      li.addEventListener('dblclick', function () { select(i); open(); });
      list.appendChild(li);
    });
    document.getElementById('empty').hidden = rows.length > 0;
    list.hidden = rows.length === 0;
    select(rows.length ? Math.max(0, Math.min(selected, rows.length - 1)) : -1);
  }
  function load() {
    api.list().then(function (r) { rows = Array.isArray(r) ? r : []; render(); });
  }
  list.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(selected + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(selected - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); open(); }
  });
  document.getElementById('open').addEventListener('click', open);
  document.getElementById('remove').addEventListener('click', function () {
    var r = rows[selected];
    if (r) api.remove(r.dir).then(load);
  });
  document.getElementById('reveal').addEventListener('click', function () {
    var r = rows[selected];
    if (r) api.reveal(r.dir);
  });
  document.getElementById('new').addEventListener('click', function () { api.newCompany(); });
  document.getElementById('browse').addEventListener('click', function () { api.browse(); });
  load();
  list.focus();
})();
</script>
</body>
</html>`;
}

module.exports = { ACCENT_RGB, recentEntries, startScreenHtml };
