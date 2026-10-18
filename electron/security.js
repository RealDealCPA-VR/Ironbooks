// Electron hardening for Ironbooks (local-only data guarantee).
//
//  - Renderer windows can only load the app's own origin (the local server, or the multi-user
//    host the user explicitly connected to). Navigation / new windows to any other origin are
//    blocked; ordinary https links the user clicks open in the system browser instead.
//  - Every network request the renderer makes is filtered: same-origin and internal schemes
//    (data:, blob:, devtools:, the built-in PDF viewer) only. Everything else is cancelled and
//    logged — no CDNs, web fonts, analytics, telemetry or third-party bank widgets.
//  - No <webview>, no permission prompts (camera, mic, geolocation, notifications…), and the
//    spellchecker never downloads dictionaries: Windows/macOS use the OS checker, elsewhere the
//    download URL points at localhost (electron/spelling.js).
//
// The page itself also ships a strict Content-Security-Policy (next.config.js headers()).

'use strict';

const { app, session, shell } = require('electron');
const { configureSpellChecker } = require('./spelling');

const INTERNAL_PROTOCOLS = new Set(['data:', 'blob:', 'devtools:', 'chrome-extension:', 'chrome:', 'about:']);
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

/**
 * @param {object} opts
 * @param {() => string|null} opts.getAppOrigin   origin the windows may load
 * @param {boolean} opts.isDev
 * @param {(msg: string) => void} [opts.log]
 */
function install(opts) {
  const log = opts.log || ((m) => console.warn(m));

  const appOrigin = () => {
    try {
      const o = opts.getAppOrigin();
      return o ? new URL(o).origin : null;
    } catch {
      return null;
    }
  };

  const parse = (url) => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  };

  const isAppUrl = (url) => {
    const u = parse(url);
    const origin = appOrigin();
    return Boolean(u && origin && u.origin === origin);
  };

  function requestAllowed(url) {
    const u = parse(url);
    if (!u) return false;
    if (INTERNAL_PROTOCOLS.has(u.protocol)) return true;
    const origin = appOrigin();
    if (origin && u.origin === origin) return true;
    if (origin) {
      // Same host:port over ws(s) — `next dev` hot reload only.
      const o = new URL(origin);
      if (opts.isDev && (u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === o.host) return true;
    }
    return false;
  }

  function openExternally(url) {
    const u = parse(url);
    // Only plain https links (e.g. "Upload at fire.irs.gov") — the user's own browser, not ours.
    if (u && u.protocol === 'https:') shell.openExternal(u.toString()).catch(() => {});
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAppUrl(url)) {
        // Same-origin pop-ups (PDF preview, printable forms): allowed, without the preload bridge.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
          },
        };
      }
      openExternally(url);
      return { action: 'deny' };
    });

    const guard = (event, url) => {
      if (isAppUrl(url)) return;
      const u = parse(url);
      if (u && INTERNAL_PROTOCOLS.has(u.protocol)) return;
      event.preventDefault();
      log(`[security] blocked navigation to ${u ? u.origin : 'invalid URL'}`);
      openExternally(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Local-only spell check (on by default; My Preferences > Spelling can turn it off).
  configureSpellChecker(ses, process.platform, true);
  ses.webRequest.onBeforeRequest((details, callback) => {
    // Requests made by the main process itself (electron `net`, e.g. the updater — which only
    // runs when the policy allows it) carry no webContents; renderer traffic is filtered.
    if (details.webContentsId === undefined) return callback({});
    if (requestAllowed(details.url)) return callback({});
    const u = parse(details.url);
    log(`[security] blocked renderer request to ${u ? u.origin : 'invalid URL'} (local-only policy)`);
    callback({ cancel: true });
  });

  return { requestAllowed, isAppUrl };
}

module.exports = { install };
